import { describe, expect, it } from 'vitest'
import { environmentStatus } from './environment'

describe('environmentStatus', () => {
  it('reports the active platform', () => {
    expect(environmentStatus('win32')).toBe('开发环境已就绪（win32）')
  })
})
