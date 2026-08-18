import { describe, expect, it } from 'vitest'
import { failure, success } from './ipc'

describe('IPC results', () => {
  it('uses a discriminated success shape', () => {
    expect(success({ sourceId: 'window:42' })).toEqual({
      ok: true,
      value: { sourceId: 'window:42' },
    })
  })

  it('uses one structured error shape', () => {
    expect(failure('SOURCE_GONE', 'The selected window is no longer available', true)).toEqual({
      ok: false,
      error: {
        code: 'SOURCE_GONE',
        message: 'The selected window is no longer available',
        retryable: true,
      },
    })
  })
})
