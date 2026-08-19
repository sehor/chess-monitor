import { describe, expect, it } from 'vitest'
import { FrameAnalyzer } from './capture-analysis'

function frame(fill = 0): Uint8ClampedArray {
  return new Uint8ClampedArray(20 * 20 * 4).fill(fill)
}

function checkerFrame(maxY = 20): Uint8ClampedArray {
  const pixels = frame()
  for (let y = 0; y < maxY; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      if ((x + y) % 2 !== 0) continue
      const offset = (y * 20 + x) * 4
      pixels.fill(255, offset, offset + 3)
    }
  }
  return pixels
}

describe('FrameAnalyzer', () => {
  it('requires three consecutive low-change frames before declaring stability', () => {
    const analyzer = new FrameAnalyzer()
    const input = {
      pixels: frame(), width: 20, height: 20,
      topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 },
    }

    expect(analyzer.analyze(input)).toMatchObject({ isStable: false, stableFrameCount: 1, changedPointCount: 0 })
    expect(analyzer.analyze(input)).toMatchObject({ isStable: false, stableFrameCount: 2, changedPointCount: 0 })
    expect(analyzer.analyze(input)).toMatchObject({ isStable: true, stableFrameCount: 3, changedPointCount: 0 })
  })

  it('detects a material change in a sampled ROI', () => {
    const analyzer = new FrameAnalyzer()
    const input = { pixels: frame(), width: 20, height: 20, topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 } }
    analyzer.analyze(input)
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        if ((x + y) % 2 === 0) input.pixels.fill(255, (y * 20 + x) * 4, (y * 20 + x) * 4 + 3)
      }
    }

    const result = analyzer.analyze(input)
    expect(result.isStable).toBe(false)
    expect(result.changedPointCount).toBeGreaterThan(0)
  })

  it('compensates for a uniform brightness shift inside every ROI', () => {
    const analyzer = new FrameAnalyzer()
    const input = { pixels: frame(), width: 20, height: 20, topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 } }
    analyzer.analyze(input)
    input.pixels.fill(80)

    expect(analyzer.analyze(input)).toMatchObject({ changedPointCount: 0, medianScore: 0 })
  })

  it('freezes the pre-occlusion reference across a board-wide transient', () => {
    const analyzer = new FrameAnalyzer({ stableFrameRequirement: 1, freezeChangedPointThreshold: 30 })
    const baseline = {
      pixels: frame(), width: 20, height: 20,
      topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 },
    }

    expect(analyzer.analyze(baseline)).toMatchObject({ isStable: true, isObscured: false })
    expect(analyzer.analyze({ ...baseline, pixels: checkerFrame() })).toMatchObject({
      isStable: false,
      isObscured: true,
    })
    expect(analyzer.analyze(baseline)).toMatchObject({
      isStable: true,
      isObscured: false,
      changedPointCount: 0,
    })
  })

  it('detects board-wide occlusion accumulated over multiple frames', () => {
    const analyzer = new FrameAnalyzer({ stableFrameRequirement: 3, freezeChangedPointThreshold: 70 })
    const baseline = {
      pixels: frame(), width: 20, height: 20,
      topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 },
    }

    analyzer.analyze(baseline)
    expect(analyzer.analyze({ ...baseline, pixels: checkerFrame(10) }).isObscured).toBe(false)
    expect(analyzer.analyze({ ...baseline, pixels: checkerFrame() })).toMatchObject({
      isStable: false,
      isObscured: true,
    })
    expect(analyzer.analyze(baseline)).toMatchObject({
      isObscured: false,
      changedPointCount: 0,
    })
  })

  it('rejects frames with an inconsistent RGBA byte length', () => {
    expect(() => new FrameAnalyzer().analyze({
      pixels: new Uint8Array(3), width: 20, height: 20,
      topLeft: { x: 2, y: 2 }, bottomRight: { x: 17, y: 17 },
    })).toThrow('RGBA')
  })
})
