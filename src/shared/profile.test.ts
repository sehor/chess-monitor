import { describe, expect, it } from 'vitest'
import {
  evaluateProfileCompatibility,
  parseCaptureProfile,
  parseCaptureProfileInput,
  type CaptureProfile,
  type CaptureProfileInput,
} from './profile'

const input: CaptureProfileInput = {
  name: '天天象棋 125%',
  source: { kind: 'screen', name: '整个屏幕' },
  frame: { width: 1600, height: 900, dpi: 125 },
  calibration: { topLeft: { x: 727, y: 151 }, bottomRight: { x: 1232, y: 719 } },
  orientation: 'red-bottom',
  theme: '木纹',
  roiScale: 0.6,
  thresholds: { low: 0, high: 0.0076 },
  stableFrameRequirement: 3,
  animationWaitMs: 300,
}

const profile: CaptureProfile = {
  ...input,
  id: 'profile-1',
  schemaVersion: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
}

describe('capture profile contract', () => {
  it('normalizes valid renderer input', () => {
    expect(parseCaptureProfileInput({ ...input, name: '  天天象棋 125%  ' })).toEqual({
      ok: true,
      value: input,
    })
  })

  it('rejects calibration outside the frame and invalid thresholds', () => {
    expect(parseCaptureProfileInput({
      ...input,
      calibration: { ...input.calibration, bottomRight: { x: 1800, y: 719 } },
    }).ok).toBe(false)
    expect(parseCaptureProfileInput({
      ...input,
      thresholds: { low: 0.2, high: 0.1 },
    }).ok).toBe(false)
    expect(parseCaptureProfileInput({
      ...input,
      calibration: { topLeft: { x: 1, y: 1 }, bottomRight: { x: 801, y: 721 } },
    })).toEqual({ ok: false, error: 'Profile ROI extends outside the captured frame' })
  })

  it('rejects unsupported stored schema versions and corrupt timestamps', () => {
    expect(parseCaptureProfile({ ...profile, schemaVersion: 2 }).ok).toBe(false)
    expect(parseCaptureProfile({ ...profile, updatedAt: 'not-a-date' }).ok).toBe(false)
  })

  it('rescales calibration for compatible frame dimensions', () => {
    expect(evaluateProfileCompatibility(profile, { width: 800, height: 450, dpi: 125 })).toEqual({
      state: 'compatible',
      scaleX: 0.5,
      scaleY: 0.5,
      calibration: {
        topLeft: { x: 363.5, y: 75.5 },
        bottomRight: { x: 616, y: 359.5 },
      },
    })
  })

  it('requires recalibration after DPI or aspect-ratio changes', () => {
    expect(evaluateProfileCompatibility(profile, { width: 1600, height: 900, dpi: 100 })).toEqual({
      state: 'recalibration-required',
      reasons: ['显示缩放与 Profile 不一致'],
    })
    expect(evaluateProfileCompatibility(profile, { width: 1600, height: 800, dpi: 125 })).toEqual({
      state: 'recalibration-required',
      reasons: ['捕获来源宽高比发生变化'],
    })
  })
})
