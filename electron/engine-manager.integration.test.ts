import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EngineManager, type EngineManagerDependencies, type EngineProcess } from './engine-manager'
import type { AnalysisEvent } from '../src/shared/ipc'

const ENGINE_PATH = resolve('engines/Pikafish.2026-01-02/Windows/pikafish-bmi2.exe')
const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

function waitForEvent(
  manager: EngineManager,
  predicate: (event: AnalysisEvent) => boolean,
  timeoutMs = 5_000,
): Promise<AnalysisEvent> {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for an engine event`))
    }, timeoutMs)
    const unsubscribe = manager.onEvent((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolveEvent(event)
    })
  })
}

describe.runIf(existsSync(ENGINE_PATH))('EngineManager with official Pikafish 2026-01-02', () => {
  it('completes 100 ready-barrier switches with a valid first info event', async () => {
    const manager = new EngineManager()
    manager.selectEngine(ENGINE_PATH)
    const latencies: number[] = []
    try {
      for (let version = 1; version <= 100; version += 1) {
        const startedAt = performance.now()
        const info = waitForEvent(manager, (event) => event.type === 'info' && event.value.positionVersion === version)
        manager.start({ fen: START_FEN, positionVersion: version, multiPv: 3 })
        await info
        latencies.push(performance.now() - startedAt)
      }
      latencies.sort((left, right) => left - right)
      expect(latencies[Math.ceil(latencies.length * 0.95) - 1]).toBeLessThan(2_000)
    } finally {
      manager.dispose()
    }
  }, 60_000)

  it('recovers once, then reaches FAILED when short-lived replacements keep crashing', async () => {
    const processes: EngineProcess[] = []
    let failNextSpawns = 0
    const dependencies: EngineManagerDependencies = {
      exists: existsSync,
      readFile: readFileSync,
      stat: (path) => {
        const value = statSync(path)
        return { size: value.size, mtimeMs: value.mtimeMs }
      },
      spawn: (path, cwd) => {
        const child = spawn(path, [], { cwd, shell: false, windowsHide: true, stdio: 'pipe' })
        processes.push(child)
        if (failNextSpawns > 0) {
          failNextSpawns -= 1
          setImmediate(() => child.kill())
        }
        return child
      },
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: clearTimeout,
      now: Date.now,
    }
    const manager = new EngineManager(dependencies)
    manager.selectEngine(ENGINE_PATH)
    try {
      const firstInfo = waitForEvent(manager, (event) => event.type === 'info')
      manager.start({ fen: START_FEN, positionVersion: 1, multiPv: 3 })
      await firstInfo

      const restarting = waitForEvent(manager, (event) => event.type === 'state' && event.state === 'RESTARTING')
      const recovered = waitForEvent(manager, (event) => event.type === 'state' && event.state === 'ANALYZING' && event.positionVersion === 1)
      processes.at(-1)!.kill()
      await restarting
      await recovered

      failNextSpawns = 2
      const failed = waitForEvent(
        manager,
        (event) => event.type === 'state' && event.state === 'FAILED',
        10_000,
      )
      processes.at(-1)!.kill()
      await expect(failed).resolves.toMatchObject({ type: 'state', state: 'FAILED', positionVersion: 1 })
    } finally {
      manager.dispose()
    }
  }, 30_000)
})
