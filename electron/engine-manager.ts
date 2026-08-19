import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { parseBestMove, parseEngineInfo } from '../src/shared/engine-protocol'
import type { AnalysisEvent, AnalysisStartInput, AnalysisState, IpcErrorCode } from '../src/shared/ipc'
import { parseFen, type Side } from '../src/domain/position'
import { RulesAdapter } from '../src/domain/game'

const MAX_OUTPUT_LINE_LENGTH = 64 * 1024
const START_TIMEOUT_MS = 10_000
const BARRIER_TIMEOUT_MS = 2_000
const RESTART_DELAYS_MS = [250, 1_000, 2_000] as const
const RESTART_WINDOW_MS = 60_000

export class EngineStartError extends Error {
  constructor(readonly code: IpcErrorCode, message: string, readonly retryable: boolean) {
    super(message)
  }
}

interface ActiveAnalysis {
  analysisId: number
  request: AnalysisStartInput
  sideToMove: Side
}

function legalPvPrefix(fen: string, pv: string[]): string[] {
  const game = new RulesAdapter(fen)
  const legal: string[] = []
  for (const move of pv) {
    try {
      game.apply(move)
      legal.push(move)
    } catch {
      break
    }
  }
  return legal
}

function legalBestMove(fen: string, move: string | null): string | null {
  if (!move) return null
  return new RulesAdapter(fen).legalMoves().includes(move as `${string}${string}${string}${string}`) ? move : null
}

export interface EngineDescriptor {
  name: string
  sha256: string
}

interface EngineConfiguration extends EngineDescriptor {
  path: string
  identity: EngineFileIdentity
}

interface EngineFileIdentity {
  size: number
  mtimeMs: number
}

export interface EngineProcess {
  stdin: {
    write(data: string): unknown
    on?(event: 'error', listener: () => void): unknown
  }
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  on(event: 'error' | 'exit', listener: () => void): unknown
  killed: boolean
  kill(): unknown
}

export interface EngineManagerDependencies {
  exists(path: string): boolean
  readFile(path: string): Uint8Array
  stat(path: string): EngineFileIdentity
  spawn(path: string, cwd: string): EngineProcess
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout
  clearTimer(timer: NodeJS.Timeout): void
  now(): number
}

const defaultDependencies: EngineManagerDependencies = {
  exists: existsSync,
  readFile: readFileSync,
  stat: (path) => {
    const value = statSync(path)
    return { size: value.size, mtimeMs: value.mtimeMs }
  },
  spawn: (path, cwd) => spawn(path, [], { cwd, shell: false, windowsHide: true, stdio: 'pipe' }),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: clearTimeout,
  now: Date.now,
}

type ProtocolPhase = 'IDLE' | 'UCI' | 'READY_BARRIER' | 'ANALYZING'

export class EngineManager {
  private sequence = 0
  private process: EngineProcess | undefined
  private active: ActiveAnalysis | undefined
  private lastRequest: AnalysisStartInput | undefined
  private engine: EngineConfiguration | undefined
  private protocolTimer: NodeJS.Timeout | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private protocolPhase: ProtocolPhase = 'IDLE'
  private acceptingInfo = false
  private isRecovering = false
  private restartFailures = 0
  private restartWindowStartedAt = 0
  private automaticRestartBlocked = false
  private readonly listeners = new Set<(event: AnalysisEvent) => void>()

  constructor(private readonly dependencies: EngineManagerDependencies = defaultDependencies) {}

  onEvent(listener: (event: AnalysisEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  selectEngine(enginePath: string): EngineDescriptor {
    if (!isAbsolute(enginePath) || extname(enginePath).toLowerCase() !== '.exe' || !this.dependencies.exists(enginePath)) {
      throw new EngineStartError('ENGINE_NOT_CONFIGURED', 'Selected Pikafish executable is unavailable', false)
    }

    const identity = this.dependencies.stat(enginePath)
    const sha256 = this.hash(enginePath)
    this.stop()
    this.disposeProcess()
    this.resetRecoveryState()
    this.engine = { path: enginePath, name: basename(enginePath), sha256, identity }
    return { name: this.engine.name, sha256: this.engine.sha256 }
  }

  getEngine(): EngineDescriptor | null {
    if (!this.engine) return null
    return { name: this.engine.name, sha256: this.engine.sha256 }
  }

  start(request: AnalysisStartInput): number {
    const { sideToMove } = parseFen(request.fen)
    this.assertEngine()
    if (this.automaticRestartBlocked) {
      throw new EngineStartError(
        'ENGINE_START_FAILED',
        'Pikafish automatic restart limit reached; retry analysis to continue',
        true,
      )
    }
    this.clearRestartTimer()

    const active: ActiveAnalysis = { analysisId: ++this.sequence, request, sideToMove }
    this.active = active
    this.lastRequest = request
    this.acceptingInfo = false
    this.emitState(active, 'STARTING')

    if (!this.process) this.spawnProcess(active)
    else if (this.protocolPhase === 'UCI') {
      this.setProtocolTimer(active, START_TIMEOUT_MS, 'Pikafish did not complete startup in time')
    } else {
      this.beginReadyBarrier(active, true)
    }
    return active.analysisId
  }

  stop(): void {
    const active = this.active
    this.active = undefined
    this.acceptingInfo = false
    this.clearProtocolTimer()
    this.clearRestartTimer()
    this.resetRecoveryState()
    if (this.process) {
      this.process.stdin.write('stop\n')
      this.protocolPhase = 'IDLE'
    }
    if (active) this.emitState(active, 'STOPPED')
  }

  dispose(): void {
    this.stop()
    this.disposeProcess()
  }

  retry(request?: AnalysisStartInput): number {
    const nextRequest = request ?? this.lastRequest
    if (!nextRequest) {
      throw new EngineStartError('ENGINE_NOT_CONFIGURED', 'No previous analysis is available to retry', false)
    }
    this.resetRecoveryState()
    return this.start(nextRequest)
  }

  private assertEngine(): EngineConfiguration {
    const engine = this.engine
    if (!engine) {
      throw new EngineStartError('ENGINE_NOT_CONFIGURED', 'Choose a Pikafish executable before starting analysis', false)
    }
    if (!this.dependencies.exists(engine.path)) {
      throw new EngineStartError('ENGINE_NOT_CONFIGURED', 'Selected Pikafish executable is unavailable', false)
    }
    const identity = this.dependencies.stat(engine.path)
    if (identity.size === engine.identity.size && identity.mtimeMs === engine.identity.mtimeMs) {
      return engine
    }
    if (this.hash(engine.path) !== engine.sha256) {
      throw new EngineStartError('ENGINE_NOT_CONFIGURED', 'Selected Pikafish executable changed after selection', false)
    }
    engine.identity = identity
    return engine
  }

  private hash(path: string): string {
    return createHash('sha256').update(this.dependencies.readFile(path)).digest('hex')
  }

  private spawnProcess(active: ActiveAnalysis): void {
    try {
      const engine = this.assertEngine()
      const child = this.dependencies.spawn(engine.path, dirname(engine.path))
      this.process = child
      this.protocolPhase = 'UCI'
      this.bindProcess(child)
      child.stdin.write('uci\n')
      this.setProtocolTimer(active, START_TIMEOUT_MS, 'Pikafish did not complete startup in time')
    } catch (error) {
      if (error instanceof EngineStartError) throw error
      this.handleFailure(active, 'Unable to start Pikafish')
    }
  }

  private bindProcess(child: EngineProcess): void {
    let outputBuffer = ''
    child.stdin.on?.('error', () => {
      if (this.process === child && this.active) this.handleFailure(this.active, 'Pikafish input stream failed')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.process !== child) return
      outputBuffer += chunk.toString('utf8')
      const lines = outputBuffer.split(/\r?\n/)
      outputBuffer = lines.pop() ?? ''
      if (outputBuffer.length > MAX_OUTPUT_LINE_LENGTH || lines.some((line) => line.length > MAX_OUTPUT_LINE_LENGTH)) {
        if (this.active) this.handleFailure(this.active, 'Pikafish produced an oversized output line')
        return
      }
      for (const line of lines) this.handleLine(line)
    })
    child.on('error', () => {
      if (this.process === child && this.active) this.handleFailure(this.active, 'Pikafish process failed')
    })
    child.on('exit', () => {
      if (this.process === child && this.active) this.handleFailure(this.active, 'Pikafish exited unexpectedly')
    })
  }

  private handleLine(line: string): void {
    if (!this.process || !this.active) return
    if (this.protocolPhase === 'UCI' && line === 'uciok') {
      this.beginReadyBarrier(this.active, false)
      return
    }
    if (this.protocolPhase === 'READY_BARRIER' && line === 'readyok') {
      this.startActiveAnalysis(this.active)
      return
    }
    if (!this.acceptingInfo || this.protocolPhase !== 'ANALYZING') return

    const active = this.active
    const rawInfo = parseEngineInfo(line)
    if (rawInfo) {
      if (rawInfo.multiPv > active.request.multiPv) return
      const sign = active.sideToMove === 'red' ? 1 : -1
      this.emit({
        type: 'info',
        value: {
          analysisId: active.analysisId,
          positionVersion: active.request.positionVersion,
          multiPv: rawInfo.multiPv,
          depth: rawInfo.depth,
          score: rawInfo.score.cp !== undefined
            ? { cp: rawInfo.score.cp * sign }
            : { mateIn: rawInfo.score.mateIn! * sign },
          nodes: rawInfo.nodes,
          pv: legalPvPrefix(active.request.fen, rawInfo.pv),
        },
      })
      return
    }

    const bestMove = parseBestMove(line)
    if (bestMove) {
      this.emit({
        type: 'bestmove',
        analysisId: active.analysisId,
        positionVersion: active.request.positionVersion,
        move: legalBestMove(active.request.fen, bestMove.move),
      })
    }
  }

  private beginReadyBarrier(active: ActiveAnalysis, stopFirst: boolean): void {
    if (!this.process || this.active?.analysisId !== active.analysisId) return
    this.clearProtocolTimer()
    this.acceptingInfo = false
    this.protocolPhase = 'READY_BARRIER'
    if (stopFirst) this.process.stdin.write('stop\n')
    this.process.stdin.write(`setoption name MultiPV value ${active.request.multiPv}\n`)
    this.process.stdin.write('isready\n')
    this.setProtocolTimer(active, BARRIER_TIMEOUT_MS, 'Pikafish did not pass the ready barrier in time')
  }

  private startActiveAnalysis(active: ActiveAnalysis): void {
    if (!this.process || this.active?.analysisId !== active.analysisId) return
    this.clearProtocolTimer()
    this.process.stdin.write(`position fen ${active.request.fen}\n`)
    this.process.stdin.write(active.request.depth ? `go depth ${active.request.depth}\n` : 'go infinite\n')
    this.protocolPhase = 'ANALYZING'
    this.acceptingInfo = true
    this.emitState(active, 'ANALYZING')
  }

  private handleFailure(active: ActiveAnalysis, message: string): void {
    if (this.active?.analysisId !== active.analysisId) return
    this.clearProtocolTimer()
    this.disposeProcess()
    this.acceptingInfo = false

    const now = this.dependencies.now()
    if (!this.isRecovering || now - this.restartWindowStartedAt > RESTART_WINDOW_MS) {
      this.isRecovering = true
      this.restartFailures = 0
      this.restartWindowStartedAt = now
    } else {
      this.restartFailures += 1
    }

    if (this.restartFailures >= RESTART_DELAYS_MS.length) {
      this.isRecovering = false
      this.automaticRestartBlocked = true
      this.emitState(active, 'FAILED', `${message}; automatic restart limit reached`)
      return
    }

    const delay = RESTART_DELAYS_MS[this.restartFailures]
    this.emitState(active, 'RESTARTING', `${message}; retrying in ${delay} ms`)
    this.restartTimer = this.dependencies.setTimer(() => {
      this.restartTimer = undefined
      if (this.active?.analysisId === active.analysisId) this.spawnProcess(active)
    }, delay)
  }

  private setProtocolTimer(active: ActiveAnalysis, delay: number, message: string): void {
    this.clearProtocolTimer()
    this.protocolTimer = this.dependencies.setTimer(() => {
      this.protocolTimer = undefined
      this.handleFailure(active, message)
    }, delay)
  }

  private emitState(active: ActiveAnalysis, state: AnalysisState, message?: string): void {
    this.emit({ type: 'state', analysisId: active.analysisId, positionVersion: active.request.positionVersion, state, message })
  }

  private emit(event: AnalysisEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private disposeProcess(): void {
    const child = this.process
    this.process = undefined
    this.protocolPhase = 'IDLE'
    if (child && !child.killed) child.kill()
  }

  private clearProtocolTimer(): void {
    if (this.protocolTimer) this.dependencies.clearTimer(this.protocolTimer)
    this.protocolTimer = undefined
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) this.dependencies.clearTimer(this.restartTimer)
    this.restartTimer = undefined
  }

  private resetRecoveryState(): void {
    this.isRecovering = false
    this.restartFailures = 0
    this.restartWindowStartedAt = 0
    this.automaticRestartBlocked = false
  }
}
