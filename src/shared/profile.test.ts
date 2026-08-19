import { describe, expect, it } from 'vitest'
import {
  evaluateProfileCompatibility,
  matchProfileCandidates,
  parseCaptureProfile,
  parseCaptureProfileInput,
  parseProfilePackage,
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

const managedFields = {
  client: { name: '天天象棋', version: 'unknown' },
  compatibility: {
    dpi: { min: 100, max: 150 },
    frameScale: { min: 0.5, max: 2 },
    clientVersion: { min: null, max: null },
  },
  priority: 0,
  isEnabled: true,
  matchRules: [{ mode: 'exact' as const, value: '整个屏幕' }],
  model: { strategy: 'shared' as const, modelVersion: null },
}

const profile: CaptureProfile = {
  ...input,
  ...managedFields,
  id: 'profile-1',
  schemaVersion: 2,
  profileVersion: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
}

describe('capture profile contract', () => {
  it('normalizes valid renderer input', () => {
    expect(parseCaptureProfileInput({ ...input, name: '  天天象棋 125%  ' })).toEqual({
      ok: true,
      value: {
        ...input,
        client: { name: '天天象棋 125%', version: 'unknown' },
        compatibility: {
          dpi: { min: 125, max: 125 },
          frameScale: { min: 0.5, max: 2 },
          clientVersion: { min: null, max: null },
        },
        priority: 0,
        isEnabled: true,
        matchRules: [{ mode: 'exact', value: '整个屏幕' }],
        model: { strategy: 'shared', modelVersion: null },
      },
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

  it('migrates schema v1 records and rejects newer versions or corrupt timestamps', () => {
    const legacy = {
      ...input,
      id: 'legacy-profile',
      schemaVersion: 1,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
    const migrated = parseCaptureProfile(legacy)
    expect(migrated.ok).toBe(true)
    if (migrated.ok) {
      expect(migrated.value).toMatchObject({
        schemaVersion: 2,
        profileVersion: 1,
        isEnabled: true,
        priority: 0,
        matchRules: [{ mode: 'exact', value: input.source.name }],
      })
    }
    expect(parseCaptureProfile({ ...profile, schemaVersion: 99 }).ok).toBe(false)
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

  it('uses declared DPI and scale ranges while still rejecting aspect-ratio drift', () => {
    expect(evaluateProfileCompatibility(profile, { width: 1600, height: 900, dpi: 100 }).state).toBe('compatible')
    expect(evaluateProfileCompatibility(profile, { width: 1600, height: 900, dpi: 151 })).toEqual({
      state: 'recalibration-required',
      reasons: ['显示缩放超出 Profile 的 DPI 兼容范围'],
    })
    expect(evaluateProfileCompatibility(profile, { width: 1600, height: 800, dpi: 125 })).toEqual({
      state: 'recalibration-required',
      reasons: ['捕获来源宽高比发生变化'],
    })
  })

  it('returns explainable candidates without auto-binding and ignores disabled profiles', () => {
    const candidates = matchProfileCandidates([
      profile,
      { ...profile, id: 'profile-2', name: '候选 2', priority: 5, matchRules: [{ mode: 'prefix', value: '整个' }] },
      { ...profile, id: 'disabled', name: '禁用项', isEnabled: false, priority: 99 },
    ], {
      source: { kind: 'screen', name: '整个屏幕' },
      frame: { width: 1600, height: 900, dpi: 125 },
    })

    expect(candidates.map((candidate) => candidate.profile.id)).toEqual(['profile-2', 'profile-1'])
    expect(candidates[0]).toMatchObject({ requiresConfirmation: true })
    expect(candidates[0].reasons).toContain('捕获来源标题满足前缀规则')
    expect(candidates[1].reasons).toContain('捕获来源标题精确匹配')
  })

  it('rejects unsafe dedicated model bindings and unsafe import packages', () => {
    const badInput = parseCaptureProfileInput({
      ...input,
      model: {
        strategy: 'dedicated',
        manifestPath: '../outside.json',
        manifestSha256: 'a'.repeat(64),
        modelVersion: 'client-v1',
      },
    })
    expect(badInput).toEqual({ ok: false, error: 'Profile fields are invalid' })

    expect(parseProfilePackage({
      kind: 'chess-monitor-profile',
      schemaVersion: 99,
      exportedAt: profile.updatedAt,
      profile,
    })).toEqual({ ok: false, error: 'Unsupported profile package version' })
  })
})
