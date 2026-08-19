import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EngineManager, EngineStartError, type EngineManagerDependencies, type EngineProcess } from './engine-manager'
import type { AnalysisEvent } from '../src/shared/ipc'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

class FakeProcess extends EventEmitter implements EngineProcess {
  readonly writes: string[] = []
  readonly stdout = new EventEmitter() as EngineProcess['stdout']
  readonly stdin = { write: (data: string) => this.writes.push(data) }
  killed = false

  output(line: string): void {
    ;(this.stdout as EventEmitter).emit('data', Buffer.from(`${line}\n`))
  }

  kill(): void {
    this.killed = true
    this.emit('exit')
  }

  crash(): void {
    this.emit('exit')
  }
}

function harness() {
  const processes: FakeProcess[] = []
  const dependencies: EngineManagerDependencies = {
    exists: () => true,
    readFile: () => Buffer.from('fixed-engine'),
    spawn: () => {
      const process = new FakeProcess()
      processes.push(process)
      return process
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: clearTimeout,
    now: Date.now,
  }
  const manager = new EngineManager(dependencies)
  const events: AnalysisEvent[] = []
  manager.onEvent((event) => events.push(event))
  manager.selectEngine('E:\\engines\\pikafish.exe')
  return { manager, events, processes }
}

function finishHandshake(process: FakeProcess): void {
  process.output('uciok')
  process.output('readyok')
}

describe('EngineManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('uses a UCI ready barrier and emits normalized info and bestmove events', () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN.replace(' w ', ' b '), positionVersion: 7, multiPv: 3 })
    const process = processes[0]

    expect(process.writes).toEqual(['uci\n'])
    process.output('uciok')
    expect(process.writes).toContain('setoption name MultiPV value 3\n')
    expect(process.writes).toContain('isready\n')

    process.output('info depth 1 score cp 99 nodes 1 pv h2e2')
    expect(events.some((event) => event.type === 'info')).toBe(false)

    process.output('readyok')
    expect(process.writes.at(-2)).toBe(`position fen ${START_FEN.replace(' w ', ' b ')}\n`)
    expect(process.writes.at(-1)).toBe('go infinite\n')
    process.output('info depth 18 multipv 1 score cp 43 nodes 90071992547409930 pv h7e7')
    process.output('bestmove h7e7')

    expect(events).toContainEqual(expect.objectContaining({
      type: 'info',
      value: expect.objectContaining({ positionVersion: 7, score: { cp: -43 }, nodes: '90071992547409930' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'bestmove', positionVersion: 7, move: 'h7e7' }))
  })

  it('drops old output across 100 rapid position switches', () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 0, multiPv: 3 })
    finishHandshake(processes[0])

    for (let version = 1; version <= 100; version += 1) {
      manager.start({ fen: START_FEN, positionVersion: version, multiPv: 3 })
      processes[0].output('info depth 1 score cp 999 nodes 1 pv a0a1')
      processes[0].output('readyok')
      processes[0].output(`info depth 2 score cp ${version} nodes ${version} pv a0a1`)
    }

    const infoEvents = events.filter((event) => event.type === 'info')
    expect(infoEvents).toHaveLength(100)
    expect(infoEvents.map((event) => event.value.positionVersion)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
  })

  it('uses a configured depth and truncates illegal PV or bestmove output', () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 3, multiPv: 2, depth: 12 })
    finishHandshake(processes[0])

    expect(processes[0].writes.at(-1)).toBe('go depth 12\n')
    processes[0].output('info depth 12 multipv 1 score cp 20 nodes 50 pv h2e2 a0a9')
    processes[0].output('bestmove a0a9')

    expect(events).toContainEqual(expect.objectContaining({
      type: 'info',
      value: expect.objectContaining({ positionVersion: 3, pv: ['h2e2'] }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'bestmove',
      positionVersion: 3,
      move: null,
    }))
  })

  it('keeps only the latest request when a switch happens before uciok', () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 1, multiPv: 1 })
    manager.start({ fen: START_FEN, positionVersion: 2, multiPv: 4 })

    expect(processes).toHaveLength(1)
    expect(processes[0].writes).toEqual(['uci\n'])
    finishHandshake(processes[0])
    expect(processes[0].writes).toContain('setoption name MultiPV value 4\n')
    processes[0].output('info depth 2 multipv 1 score cp 2 nodes 2 pv a0a1')
    expect(events.filter((event) => event.type === 'info').map((event) => event.value.positionVersion)).toEqual([2])
  })

  it('restarts after 250 ms, 1 s and 2 s, then reports FAILED', async () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 4, multiPv: 3 })
    finishHandshake(processes[0])

    processes[0].crash()
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'RESTARTING' })
    await vi.advanceTimersByTimeAsync(250)
    expect(processes).toHaveLength(2)

    processes[1].crash()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(processes).toHaveLength(3)

    processes[2].crash()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(processes).toHaveLength(4)

    processes[3].crash()
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'FAILED', positionVersion: 4 })
  })

  it('keeps the restart budget after each replacement process completes its handshake', async () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 5, multiPv: 3 })
    finishHandshake(processes[0])

    for (const [index, delay] of [250, 1_000, 2_000].entries()) {
      processes[index].crash()
      expect(events.at(-1)).toMatchObject({ type: 'state', state: 'RESTARTING' })
      await vi.advanceTimersByTimeAsync(delay)
      finishHandshake(processes[index + 1])
    }

    processes[3].crash()
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'FAILED', positionVersion: 5 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(processes).toHaveLength(4)
  })

  it('requires an explicit retry after the automatic restart limit is reached', async () => {
    const { manager, events, processes } = harness()
    manager.start({ fen: START_FEN, positionVersion: 6, multiPv: 3 })
    finishHandshake(processes[0])

    for (const [index, delay] of [250, 1_000, 2_000].entries()) {
      processes[index].crash()
      await vi.advanceTimersByTimeAsync(delay)
    }
    processes[3].crash()

    expect(() => manager.start({ fen: START_FEN, positionVersion: 7, multiPv: 3 })).toThrowError(
      expect.objectContaining<Partial<EngineStartError>>({ code: 'ENGINE_START_FAILED', retryable: true }),
    )
    expect(processes).toHaveLength(4)

    expect(manager.retry({ fen: START_FEN, positionVersion: 7, multiPv: 3 })).toBeGreaterThan(0)
    expect(processes).toHaveLength(5)
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'STARTING', positionVersion: 7 })
  })
})
