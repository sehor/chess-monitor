export const IPC_ERROR_CODES = [
  'INVALID_INPUT',
  'SOURCE_GONE',
  'CAPTURE_DENIED',
  'FRAME_TOO_LARGE',
  'ENGINE_NOT_CONFIGURED',
  'ENGINE_START_FAILED',
  'ENGINE_PROTOCOL_ERROR',
  'ENGINE_TIMEOUT',
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcError {
  code: IpcErrorCode
  message: string
  retryable: boolean
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcError }

export interface CaptureSource {
  id: string
  name: string
  thumbnailDataUrl: string | null
}

export interface CaptureApi {
  listSources(): Promise<IpcResult<CaptureSource[]>>
  selectSource(sourceId: string): Promise<IpcResult<void>>
  clearSource(): Promise<IpcResult<void>>
}

export function success<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

export function failure(
  code: IpcErrorCode,
  message: string,
  retryable = false,
): IpcResult<never> {
  return { ok: false, error: { code, message, retryable } }
}
