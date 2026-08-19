import {
  failure,
  success,
  type IpcResult,
  type RealtimeSnapshot,
} from '../src/shared/ipc'

export function completeRealtimeMutation<T>(
  snapshot: RealtimeSnapshot,
  select: (snapshot: RealtimeSnapshot) => T,
): IpcResult<T> {
  if (snapshot.monitoringState === 'ERROR') {
    return failure('GAME_STORAGE_ERROR', snapshot.monitoringMessage, true)
  }
  return success(select(snapshot))
}

export function profileMutationGuard(isTracking: boolean): IpcResult<never> | null {
  return isTracking
    ? failure('PROFILE_IN_USE', 'Stop the current game before changing the active Profile')
    : null
}
