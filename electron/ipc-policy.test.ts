import { describe, expect, it, vi } from 'vitest'
import type { RealtimeSnapshot } from '../src/shared/ipc'
import { completeRealtimeMutation, profileMutationGuard } from './ipc-policy'

function snapshot(monitoringState: RealtimeSnapshot['monitoringState']): RealtimeSnapshot {
  return {
    gameId: 'game-1',
    monitoringState,
    monitoringMessage: monitoringState === 'ERROR' ? 'database write failed' : 'running',
    trackerState: null,
    position: null,
    confirmedMoves: [],
    analysis: {
      state: 'STOPPED',
      message: 'stopped',
      positionVersion: null,
      isTrusted: false,
      lines: [],
      bestMove: null,
    },
    settings: { multiPv: 3, depth: 16 },
  }
}

describe('IPC mutation policy', () => {
  it('maps a realtime storage failure to the shared IPC error contract', () => {
    const select = vi.fn(() => 'unreachable')

    expect(completeRealtimeMutation(snapshot('ERROR'), select)).toEqual({
      ok: false,
      error: {
        code: 'GAME_STORAGE_ERROR',
        message: 'database write failed',
        retryable: true,
      },
    })
    expect(select).not.toHaveBeenCalled()
  })

  it('keeps the existing success shape after a successful mutation', () => {
    expect(completeRealtimeMutation(snapshot('RUNNING'), (value) => value.gameId)).toEqual({
      ok: true,
      value: 'game-1',
    })
  })

  it('blocks active Profile mutations while tracking', () => {
    expect(profileMutationGuard(false)).toBeNull()
    expect(profileMutationGuard(true)).toEqual({
      ok: false,
      error: {
        code: 'PROFILE_IN_USE',
        message: 'Stop the current game before changing the active Profile',
        retryable: false,
      },
    })
  })
})
