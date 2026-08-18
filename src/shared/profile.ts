import type { Orientation } from '../domain/position'
import type { Point } from '../lib/calibration'

export const PROFILE_SCHEMA_VERSION = 1 as const

export type CaptureSourceKind = 'window' | 'screen'

export interface CaptureProfileInput {
  id?: string
  name: string
  source: {
    kind: CaptureSourceKind
    name: string
  }
  frame: {
    width: number
    height: number
    dpi: number
  }
  calibration: {
    topLeft: Point
    bottomRight: Point
  }
  orientation: Orientation
  theme: string
  roiScale: number
  thresholds: {
    low: number
    high: number
  }
  stableFrameRequirement: number
  animationWaitMs: number
}

export interface CaptureProfile extends Omit<CaptureProfileInput, 'id'> {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION
  id: string
  createdAt: string
  updatedAt: string
}

export interface ProfileIssue {
  id: string | null
  message: string
}

export interface ProfileListResult {
  profiles: CaptureProfile[]
  issues: ProfileIssue[]
  activeProfileId: string | null
}

export interface ProfileDiagnostics {
  exportedAt: string
  databaseSchemaVersion: number
  profileSchemaVersion: number
  activeProfileId: string | null
  profile: CaptureProfile
  issues: ProfileIssue[]
}

export type ProfileCompatibility =
  | {
      state: 'compatible'
      calibration: CaptureProfile['calibration']
      scaleX: number
      scaleY: number
    }
  | {
      state: 'recalibration-required'
      reasons: string[]
    }

export type ProfileParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function parsePoint(value: unknown): Point | null {
  if (!isRecord(value) || !finiteNumber(value.x, 0, 16_384) || !finiteNumber(value.y, 0, 16_384)) return null
  return { x: value.x, y: value.y }
}

function parseInput(value: unknown): ProfileParseResult<CaptureProfileInput> {
  if (!isRecord(value)) return { ok: false, error: 'Profile input must be an object' }
  const source = value.source
  const frame = value.frame
  const calibration = value.calibration
  const thresholds = value.thresholds
  if (
    (value.id !== undefined && (typeof value.id !== 'string' || !ID_PATTERN.test(value.id))) ||
    typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.trim().length > 128 ||
    !isRecord(source) || !['window', 'screen'].includes(source.kind as string) ||
    typeof source.name !== 'string' || source.name.length < 1 || source.name.length > 256 ||
    !isRecord(frame) || !integer(frame.width, 5, 16_384) || !integer(frame.height, 5, 16_384) ||
    !finiteNumber(frame.dpi, 50, 300) ||
    !isRecord(calibration) || !isRecord(thresholds) ||
    !['red-bottom', 'black-bottom'].includes(value.orientation as string) ||
    typeof value.theme !== 'string' || value.theme.trim().length < 1 || value.theme.trim().length > 128 ||
    !finiteNumber(value.roiScale, 0.4, 0.8) ||
    !finiteNumber(thresholds.low, 0, 1) || !finiteNumber(thresholds.high, 0, 1) ||
    thresholds.high < thresholds.low ||
    !integer(value.stableFrameRequirement, 1, 30) ||
    !integer(value.animationWaitMs, 0, 5_000)
  ) {
    return { ok: false, error: 'Profile fields are invalid' }
  }

  const topLeft = parsePoint(calibration.topLeft)
  const bottomRight = parsePoint(calibration.bottomRight)
  if (
    !topLeft || !bottomRight ||
    topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y ||
    bottomRight.x > frame.width || bottomRight.y > frame.height ||
    (bottomRight.x - topLeft.x) / 8 < 4 ||
    (bottomRight.y - topLeft.y) / 9 < 4
  ) {
    return { ok: false, error: 'Profile calibration is outside the captured frame' }
  }
  const halfRoiWidth = ((bottomRight.x - topLeft.x) / 8) * value.roiScale / 2
  const halfRoiHeight = ((bottomRight.y - topLeft.y) / 9) * value.roiScale / 2
  if (
    topLeft.x - halfRoiWidth < 0 || topLeft.y - halfRoiHeight < 0 ||
    bottomRight.x + halfRoiWidth > frame.width || bottomRight.y + halfRoiHeight > frame.height
  ) {
    return { ok: false, error: 'Profile ROI extends outside the captured frame' }
  }

  return {
    ok: true,
    value: {
      ...(value.id ? { id: value.id } : {}),
      name: value.name.trim(),
      source: { kind: source.kind as CaptureSourceKind, name: source.name },
      frame: { width: frame.width, height: frame.height, dpi: frame.dpi },
      calibration: { topLeft, bottomRight },
      orientation: value.orientation as Orientation,
      theme: value.theme.trim(),
      roiScale: value.roiScale,
      thresholds: { low: thresholds.low, high: thresholds.high },
      stableFrameRequirement: value.stableFrameRequirement,
      animationWaitMs: value.animationWaitMs,
    },
  }
}

export function parseCaptureProfileInput(value: unknown): ProfileParseResult<CaptureProfileInput> {
  return parseInput(value)
}

export function parseCaptureProfile(value: unknown): ProfileParseResult<CaptureProfile> {
  if (!isRecord(value) || value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    return { ok: false, error: 'Unsupported profile schema version' }
  }
  const parsed = parseInput(value)
  if (!parsed.ok || !parsed.value.id || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    return { ok: false, error: parsed.ok ? 'Profile metadata is invalid' : parsed.error }
  }
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    return { ok: false, error: 'Profile timestamps are invalid' }
  }
  return {
    ok: true,
    value: {
      ...parsed.value,
      id: parsed.value.id,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  }
}

export function evaluateProfileCompatibility(
  profile: CaptureProfile,
  frame: { width: number; height: number; dpi: number },
): ProfileCompatibility {
  const reasons: string[] = []
  if (!integer(frame.width, 5, 16_384) || !integer(frame.height, 5, 16_384) || !finiteNumber(frame.dpi, 50, 300)) {
    return { state: 'recalibration-required', reasons: ['当前捕获帧参数无效'] }
  }

  const scaleX = frame.width / profile.frame.width
  const scaleY = frame.height / profile.frame.height
  const aspectError = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY)
  if (Math.abs(frame.dpi - profile.frame.dpi) > 0.5) reasons.push('显示缩放与 Profile 不一致')
  if (aspectError > 0.02) reasons.push('捕获来源宽高比发生变化')
  if (scaleX < 0.5 || scaleX > 2 || scaleY < 0.5 || scaleY > 2) reasons.push('捕获来源尺寸超出已验证范围')
  if (reasons.length > 0) return { state: 'recalibration-required', reasons }

  return {
    state: 'compatible',
    scaleX,
    scaleY,
    calibration: {
      topLeft: {
        x: profile.calibration.topLeft.x * scaleX,
        y: profile.calibration.topLeft.y * scaleY,
      },
      bottomRight: {
        x: profile.calibration.bottomRight.x * scaleX,
        y: profile.calibration.bottomRight.y * scaleY,
      },
    },
  }
}
