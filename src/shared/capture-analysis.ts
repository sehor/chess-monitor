import { deriveIntersectionPoints, getSampleBounds, type Point } from '../lib/calibration'
import type { CaptureAnalysis, CaptureFrameInput } from './ipc'

export type { CaptureAnalysis, CaptureFrameInput } from './ipc'

export const MAX_CAPTURE_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_CAPTURE_FRAME_DIMENSION = 2048
const NORMALIZED_ROI_SIZE = 32

export interface FrameAnalyzerOptions {
  lowThreshold?: number
  highThreshold?: number
  stableFrameRequirement?: number
  freezeChangedPointThreshold?: number
}

function luminance(frame: CaptureFrameInput, x: number, y: number): number {
  const index = (y * frame.width + x) * 4
  return frame.pixels[index] * 0.2126 + frame.pixels[index + 1] * 0.7152 + frame.pixels[index + 2] * 0.0722
}

function normalizedRoi(frame: CaptureFrameInput, point: Point, radius: number): Float32Array {
  const bounds = getSampleBounds(point, radius, frame.width, frame.height)
  const samples = new Float32Array(NORMALIZED_ROI_SIZE * NORMALIZED_ROI_SIZE)
  for (let targetY = 0; targetY < NORMALIZED_ROI_SIZE; targetY += 1) {
    const sourceY = bounds.top + Math.min(bounds.height - 1, Math.floor((targetY + 0.5) * bounds.height / NORMALIZED_ROI_SIZE))
    for (let targetX = 0; targetX < NORMALIZED_ROI_SIZE; targetX += 1) {
      const sourceX = bounds.left + Math.min(bounds.width - 1, Math.floor((targetX + 0.5) * bounds.width / NORMALIZED_ROI_SIZE))
      samples[targetY * NORMALIZED_ROI_SIZE + targetX] = luminance(frame, sourceX, sourceY)
    }
  }
  return samples
}

function compensatedDifference(current: Float32Array, previous: Float32Array): number {
  let currentMean = 0
  let previousMean = 0
  for (let index = 0; index < current.length; index += 1) {
    currentMean += current[index]
    previousMean += previous[index]
  }
  currentMean /= current.length
  previousMean /= previous.length

  let difference = 0
  for (let index = 0; index < current.length; index += 1) {
    difference += Math.abs((current[index] - currentMean) - (previous[index] - previousMean))
  }
  return Math.min(1, difference / current.length / 255)
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function validateFrame(frame: CaptureFrameInput): void {
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width < 5 ||
    frame.height < 5 ||
    frame.width > MAX_CAPTURE_FRAME_DIMENSION ||
    frame.height > MAX_CAPTURE_FRAME_DIMENSION
  ) {
    throw new Error('Capture frame dimensions are invalid')
  }
  if (frame.pixels.byteLength !== frame.width * frame.height * 4) {
    throw new Error('Capture frame pixels must be RGBA data')
  }
  if (frame.pixels.byteLength > MAX_CAPTURE_FRAME_BYTES) {
    throw new Error('Capture frame exceeds the maximum permitted size')
  }
  if (frame.roiScale !== undefined && (!Number.isFinite(frame.roiScale) || frame.roiScale < 0.4 || frame.roiScale > 0.8)) {
    throw new Error('ROI scale must be between 0.4 and 0.8')
  }
}

/** Retains only normalized 32×32 grayscale ROIs for the 90 intersections. */
export class FrameAnalyzer {
  private previousSamples: Float32Array[] | undefined
  private occlusionReferenceSamples: Float32Array[] | undefined
  private stableFrameCount = 0
  private unchangedFrameCount = 0
  private wasObscured = false
  private readonly lowThreshold: number
  private readonly highThreshold: number
  private readonly stableFrameRequirement: number
  private readonly freezeChangedPointThreshold: number

  constructor(options: FrameAnalyzerOptions = {}) {
    this.lowThreshold = options.lowThreshold ?? 0.015
    this.highThreshold = options.highThreshold ?? 0.05
    this.stableFrameRequirement = options.stableFrameRequirement ?? 3
    this.freezeChangedPointThreshold = options.freezeChangedPointThreshold ?? 45
    if (
      this.lowThreshold < 0 ||
      this.highThreshold < this.lowThreshold ||
      this.highThreshold > 1 ||
      !Number.isInteger(this.stableFrameRequirement) ||
      this.stableFrameRequirement < 1 ||
      !Number.isInteger(this.freezeChangedPointThreshold) ||
      this.freezeChangedPointThreshold < 1 ||
      this.freezeChangedPointThreshold > 90
    ) {
      throw new Error('Frame analyzer thresholds are invalid')
    }
  }

  analyze(frame: CaptureFrameInput): CaptureAnalysis {
    validateFrame(frame)
    const spacing = Math.min(
      (frame.bottomRight.x - frame.topLeft.x) / 8,
      (frame.bottomRight.y - frame.topLeft.y) / 9,
    )
    const radius = Math.max(1, Math.floor(spacing * (frame.roiScale ?? 0.6) / 2))
    const samples = deriveIntersectionPoints(frame.topLeft, frame.bottomRight)
      .map((point) => normalizedRoi(frame, point, radius))

    if (!this.previousSamples) {
      this.previousSamples = samples
      this.occlusionReferenceSamples = samples
      this.stableFrameCount = 1
      this.unchangedFrameCount = 1
      return {
        isStable: this.stableFrameRequirement === 1,
        isObscured: false,
        stableFrameCount: this.stableFrameCount,
        changedPointCount: 0,
        medianScore: 0,
        pointScores: samples.map(() => 0),
      }
    }

    const previousPointScores = samples.map((sample, index) => compensatedDifference(sample, this.previousSamples![index]))
    const referencePointScores = samples.map((sample, index) => compensatedDifference(sample, this.occlusionReferenceSamples![index]))
    const referenceChangedPointCount = referencePointScores.filter((score) => score >= this.highThreshold).length
    const isObscured = referenceChangedPointCount >= this.freezeChangedPointThreshold
    if (isObscured) {
      this.stableFrameCount = 0
      this.unchangedFrameCount = 0
      this.wasObscured = true
      return {
        isStable: false,
        isObscured: true,
        stableFrameCount: 0,
        changedPointCount: referenceChangedPointCount,
        medianScore: median(referencePointScores),
        pointScores: referencePointScores,
      }
    }

    const pointScores = this.wasObscured ? referencePointScores : previousPointScores
    const medianScore = median(pointScores)
    const changedPointCount = pointScores.filter((score) => score >= this.highThreshold).length
    this.previousSamples = samples
    this.wasObscured = false
    this.stableFrameCount = medianScore < this.lowThreshold ? this.stableFrameCount + 1 : 0
    this.unchangedFrameCount = changedPointCount === 0 ? this.unchangedFrameCount + 1 : 0
    if (this.unchangedFrameCount >= this.stableFrameRequirement) {
      this.occlusionReferenceSamples = samples
    }
    return {
      isStable: this.stableFrameCount >= this.stableFrameRequirement,
      isObscured: false,
      stableFrameCount: this.stableFrameCount,
      changedPointCount,
      medianScore,
      pointScores,
    }
  }

  reset(): void {
    this.previousSamples = undefined
    this.occlusionReferenceSamples = undefined
    this.stableFrameCount = 0
    this.unchangedFrameCount = 0
    this.wasObscured = false
  }
}
