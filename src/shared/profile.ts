import type { Orientation } from '../domain/position'
import type { Point } from '../lib/calibration'

export const PROFILE_SCHEMA_VERSION = 2 as const
export const PROFILE_PACKAGE_VERSION = 1 as const

export type CaptureSourceKind = 'window' | 'screen'
export type ProfileMatchMode = 'exact' | 'prefix' | 'suffix'

export interface ProfileMatchRule {
  mode: ProfileMatchMode
  value: string
}

export interface ProfileModelBindingShared {
  strategy: 'shared'
  modelVersion: string | null
}

export interface ProfileModelBindingDedicated {
  strategy: 'dedicated'
  manifestPath: string
  manifestSha256: string
  modelVersion: string
}

export type ProfileModelBinding = ProfileModelBindingShared | ProfileModelBindingDedicated

export interface ProfileCompatibilityRange {
  dpi: { min: number; max: number }
  frameScale: { min: number; max: number }
  clientVersion: { min: string | null; max: string | null }
}

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
  client?: {
    name: string
    version: string
  }
  compatibility?: ProfileCompatibilityRange
  priority?: number
  isEnabled?: boolean
  matchRules?: ProfileMatchRule[]
  model?: ProfileModelBinding
}

export interface CaptureProfile extends Omit<CaptureProfileInput, 'id' | 'client' | 'compatibility' | 'priority' | 'isEnabled' | 'matchRules' | 'model'> {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION
  profileVersion: number
  id: string
  client: { name: string; version: string }
  compatibility: ProfileCompatibilityRange
  priority: number
  isEnabled: boolean
  matchRules: ProfileMatchRule[]
  model: ProfileModelBinding
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

export interface ProfilePackage {
  kind: 'chess-monitor-profile'
  schemaVersion: typeof PROFILE_PACKAGE_VERSION
  exportedAt: string
  profile: CaptureProfile
}

export interface ProfileMatchContext {
  source: { kind: CaptureSourceKind; name: string }
  frame: { width: number; height: number; dpi: number }
}

export interface ProfileMatchCandidate {
  profile: CaptureProfile
  reasons: string[]
  requiresConfirmation: true
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
const SAFE_RELATIVE_MANIFEST = /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?![A-Za-z]:)(?![\\/])[A-Za-z0-9._/-]+\.json$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

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

function parseNullableVersionRange(value: unknown): { min: string | null; max: string | null } | null {
  if (!isRecord(value)) return null
  const valid = (candidate: unknown) => candidate === null || (typeof candidate === 'string' && candidate.length >= 1 && candidate.length <= 64)
  if (!valid(value.min) || !valid(value.max)) return null
  return { min: value.min as string | null, max: value.max as string | null }
}

function defaultCompatibility(frameDpi: number): ProfileCompatibilityRange {
  return {
    dpi: { min: frameDpi, max: frameDpi },
    frameScale: { min: 0.5, max: 2 },
    clientVersion: { min: null, max: null },
  }
}

function parseCompatibility(value: unknown, frameDpi: number): ProfileCompatibilityRange | null {
  if (value === undefined) return defaultCompatibility(frameDpi)
  if (!isRecord(value) || !isRecord(value.dpi) || !isRecord(value.frameScale)) return null
  if (
    !finiteNumber(value.dpi.min, 50, 300) || !finiteNumber(value.dpi.max, 50, 300) || value.dpi.min > value.dpi.max ||
    !finiteNumber(value.frameScale.min, 0.25, 4) || !finiteNumber(value.frameScale.max, 0.25, 4) || value.frameScale.min > value.frameScale.max
  ) return null
  const clientVersion = parseNullableVersionRange(value.clientVersion ?? { min: null, max: null })
  if (!clientVersion) return null
  return {
    dpi: { min: value.dpi.min, max: value.dpi.max },
    frameScale: { min: value.frameScale.min, max: value.frameScale.max },
    clientVersion,
  }
}

function parseMatchRules(value: unknown, sourceName: string): ProfileMatchRule[] | null {
  if (value === undefined) return [{ mode: 'exact', value: sourceName }]
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null
  const parsed: ProfileMatchRule[] = []
  for (const rule of value) {
    if (!isRecord(rule) || !['exact', 'prefix', 'suffix'].includes(rule.mode as string) || typeof rule.value !== 'string') return null
    const text = rule.value.trim()
    if (text.length < 3 || text.length > 256) return null
    parsed.push({ mode: rule.mode as ProfileMatchMode, value: text })
  }
  return parsed
}

function parseModel(value: unknown): ProfileModelBinding | null {
  if (value === undefined) return { strategy: 'shared', modelVersion: null }
  if (!isRecord(value)) return null
  if (value.strategy === 'shared') {
    if (value.modelVersion !== null && value.modelVersion !== undefined && (typeof value.modelVersion !== 'string' || value.modelVersion.length > 128)) return null
    return { strategy: 'shared', modelVersion: typeof value.modelVersion === 'string' ? value.modelVersion : null }
  }
  if (value.strategy !== 'dedicated') return null
  if (
    typeof value.manifestPath !== 'string' || value.manifestPath.length > 255 || !SAFE_RELATIVE_MANIFEST.test(value.manifestPath) ||
    typeof value.manifestSha256 !== 'string' || !SHA256_PATTERN.test(value.manifestSha256) ||
    typeof value.modelVersion !== 'string' || value.modelVersion.length < 1 || value.modelVersion.length > 128
  ) return null
  return {
    strategy: 'dedicated',
    manifestPath: value.manifestPath.replace(/\\/g, '/'),
    manifestSha256: value.manifestSha256.toLowerCase(),
    modelVersion: value.modelVersion,
  }
}

function parseInput(value: unknown): ProfileParseResult<CaptureProfileInput & Required<Pick<CaptureProfileInput, 'client' | 'compatibility' | 'priority' | 'isEnabled' | 'matchRules' | 'model'>>> {
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
    !finiteNumber(thresholds.low, 0, 1) || !finiteNumber(thresholds.high, 0, 1) || thresholds.high < thresholds.low ||
    !integer(value.stableFrameRequirement, 1, 30) || !integer(value.animationWaitMs, 0, 5_000) ||
    (value.priority !== undefined && !integer(value.priority, -100, 100)) ||
    (value.isEnabled !== undefined && typeof value.isEnabled !== 'boolean')
  ) return { ok: false, error: 'Profile fields are invalid' }

  const topLeft = parsePoint(calibration.topLeft)
  const bottomRight = parsePoint(calibration.bottomRight)
  if (
    !topLeft || !bottomRight || topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y ||
    bottomRight.x > frame.width || bottomRight.y > frame.height ||
    (bottomRight.x - topLeft.x) / 8 < 4 || (bottomRight.y - topLeft.y) / 9 < 4
  ) return { ok: false, error: 'Profile calibration is outside the captured frame' }

  const halfRoiWidth = ((bottomRight.x - topLeft.x) / 8) * value.roiScale / 2
  const halfRoiHeight = ((bottomRight.y - topLeft.y) / 9) * value.roiScale / 2
  if (
    topLeft.x - halfRoiWidth < 0 || topLeft.y - halfRoiHeight < 0 ||
    bottomRight.x + halfRoiWidth > frame.width || bottomRight.y + halfRoiHeight > frame.height
  ) return { ok: false, error: 'Profile ROI extends outside the captured frame' }

  const clientValue = value.client
  const client = clientValue === undefined
    ? { name: value.name.trim(), version: 'unknown' }
    : isRecord(clientValue) && typeof clientValue.name === 'string' && clientValue.name.trim().length >= 1 && clientValue.name.trim().length <= 128 && typeof clientValue.version === 'string' && clientValue.version.length >= 1 && clientValue.version.length <= 64
      ? { name: clientValue.name.trim(), version: clientValue.version }
      : null
  const compatibility = parseCompatibility(value.compatibility, frame.dpi)
  const matchRules = parseMatchRules(value.matchRules, source.name)
  const model = parseModel(value.model)
  if (!client || !compatibility || !matchRules || !model) return { ok: false, error: 'Profile fields are invalid' }

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
      client,
      compatibility,
      priority: (value.priority as number | undefined) ?? 0,
      isEnabled: (value.isEnabled as boolean | undefined) ?? true,
      matchRules,
      model,
    },
  }
}

export function parseCaptureProfileInput(value: unknown): ProfileParseResult<CaptureProfileInput> {
  return parseInput(value)
}

function parseStoredMetadata(value: Record<string, unknown>, parsed: ReturnType<typeof parseInput>): ProfileParseResult<CaptureProfile> {
  if (!parsed.ok || !parsed.value.id || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    return { ok: false, error: parsed.ok ? 'Profile metadata is invalid' : parsed.error }
  }
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    return { ok: false, error: 'Profile timestamps are invalid' }
  }
  const profileVersion = value.profileVersion === undefined ? 1 : value.profileVersion
  if (!integer(profileVersion, 1, 1_000_000)) return { ok: false, error: 'Profile metadata is invalid' }
  return {
    ok: true,
    value: {
      ...parsed.value,
      id: parsed.value.id,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  }
}

export function parseCaptureProfile(value: unknown): ProfileParseResult<CaptureProfile> {
  if (!isRecord(value) || ![1, PROFILE_SCHEMA_VERSION].includes(value.schemaVersion as number)) {
    return { ok: false, error: 'Unsupported profile schema version' }
  }
  return parseStoredMetadata(value, parseInput(value))
}

export function parseProfilePackage(value: unknown): ProfileParseResult<ProfilePackage> {
  if (!isRecord(value) || value.kind !== 'chess-monitor-profile' || value.schemaVersion !== PROFILE_PACKAGE_VERSION) {
    return { ok: false, error: 'Unsupported profile package version' }
  }
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) {
    return { ok: false, error: 'Profile package metadata is invalid' }
  }
  const profile = parseCaptureProfile(value.profile)
  if (!profile.ok) return { ok: false, error: profile.error }
  return { ok: true, value: { kind: 'chess-monitor-profile', schemaVersion: PROFILE_PACKAGE_VERSION, exportedAt: value.exportedAt, profile: profile.value } }
}

export function createProfilePackage(profile: CaptureProfile, exportedAt = new Date().toISOString()): ProfilePackage {
  return { kind: 'chess-monitor-profile', schemaVersion: PROFILE_PACKAGE_VERSION, exportedAt, profile }
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
  if (frame.dpi < profile.compatibility.dpi.min || frame.dpi > profile.compatibility.dpi.max) reasons.push('显示缩放超出 Profile 的 DPI 兼容范围')
  if (aspectError > 0.02) reasons.push('捕获来源宽高比发生变化')
  if (
    scaleX < profile.compatibility.frameScale.min || scaleX > profile.compatibility.frameScale.max ||
    scaleY < profile.compatibility.frameScale.min || scaleY > profile.compatibility.frameScale.max
  ) reasons.push('捕获来源尺寸超出已验证范围')
  if (reasons.length > 0) return { state: 'recalibration-required', reasons }

  return {
    state: 'compatible',
    scaleX,
    scaleY,
    calibration: {
      topLeft: { x: profile.calibration.topLeft.x * scaleX, y: profile.calibration.topLeft.y * scaleY },
      bottomRight: { x: profile.calibration.bottomRight.x * scaleX, y: profile.calibration.bottomRight.y * scaleY },
    },
  }
}

function matchRule(rule: ProfileMatchRule, sourceName: string): string | null {
  if (rule.mode === 'exact' && sourceName === rule.value) return '捕获来源标题精确匹配'
  if (rule.mode === 'prefix' && sourceName.startsWith(rule.value)) return '捕获来源标题满足前缀规则'
  if (rule.mode === 'suffix' && sourceName.endsWith(rule.value)) return '捕获来源标题满足后缀规则'
  return null
}

export function matchProfileCandidates(profiles: CaptureProfile[], context: ProfileMatchContext): ProfileMatchCandidate[] {
  const candidates: ProfileMatchCandidate[] = []
  for (const profile of profiles) {
    if (!profile.isEnabled || profile.source.kind !== context.source.kind) continue
    const compatibility = evaluateProfileCompatibility(profile, context.frame)
    if (compatibility.state !== 'compatible') continue
    const matchedReason = profile.matchRules.map((rule) => matchRule(rule, context.source.name)).find((reason): reason is string => Boolean(reason))
    if (!matchedReason) continue
    candidates.push({
      profile,
      reasons: [matchedReason, `DPI ${context.frame.dpi}% 位于 ${profile.compatibility.dpi.min}–${profile.compatibility.dpi.max}% 兼容范围`],
      requiresConfirmation: true,
    })
  }
  return candidates.sort((left, right) => right.profile.priority - left.profile.priority || right.profile.updatedAt.localeCompare(left.profile.updatedAt) || left.profile.id.localeCompare(right.profile.id))
}
