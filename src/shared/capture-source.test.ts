import { describe, expect, it } from 'vitest'
import { resolveSelectedSourceId } from './capture-source'

describe('capture source recovery', () => {
  it('keeps the current source while it still exists', () => {
    expect(resolveSelectedSourceId([{ id: 'old', name: '天天象棋' }], 'old', '天天象棋')).toBe('old')
  })

  it('recovers a restarted source by an unambiguous exact name', () => {
    expect(resolveSelectedSourceId([{ id: 'new', name: '天天象棋' }], 'old', '天天象棋')).toBe('new')
  })

  it('refuses ambiguous same-name windows', () => {
    expect(resolveSelectedSourceId([
      { id: 'one', name: '天天象棋' },
      { id: 'two', name: '天天象棋' },
    ], 'old', '天天象棋')).toBeUndefined()
  })

  it('does not restore a screen profile to a same-name window source', () => {
    expect(resolveSelectedSourceId([
      { id: 'window:1', name: '整个屏幕', kind: 'window' },
      { id: 'screen:1', name: '整个屏幕', kind: 'screen' },
    ], undefined, '整个屏幕', 'screen')).toBe('screen:1')
  })
})
