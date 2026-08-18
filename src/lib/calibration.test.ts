import { describe, expect, it } from 'vitest'
import { deriveIntersectionPoints, getSampleBounds } from './calibration'

describe('deriveIntersectionPoints', () => {
  it('derives all 90 intersections in row-major order', () => {
    const points = deriveIntersectionPoints({ x: 10, y: 20 }, { x: 170, y: 200 })

    expect(points).toHaveLength(90)
    expect(points[0]).toEqual({ file: 0, rank: 0, x: 10, y: 20 })
    expect(points[8]).toEqual({ file: 8, rank: 0, x: 170, y: 20 })
    expect(points[81]).toEqual({ file: 0, rank: 9, x: 10, y: 200 })
    expect(points[89]).toEqual({ file: 8, rank: 9, x: 170, y: 200 })
  })

  it('rejects a reversed or degenerate calibration', () => {
    expect(() => deriveIntersectionPoints({ x: 100, y: 20 }, { x: 10, y: 200 })).toThrow(
      'bottom-right',
    )
  })
})

describe('getSampleBounds', () => {
  it('keeps a fixed sampling square within the captured frame', () => {
    expect(getSampleBounds({ x: 1, y: 98 }, 2, 100, 100)).toEqual({
      left: 0,
      top: 95,
      width: 5,
      height: 5,
    })
  })
})
