export interface Point {
  x: number
  y: number
}

export interface IntersectionPoint extends Point {
  file: number
  rank: number
}

export interface PixelBounds {
  left: number
  top: number
  width: number
  height: number
}

const FILE_COUNT = 9
const RANK_COUNT = 10

function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

/**
 * Derives the 9 × 10 board intersections from its top-left and bottom-right
 * intersections. The returned array is row-major, from black's side to red's.
 */
export function deriveIntersectionPoints(
  topLeft: Point,
  bottomRight: Point,
): IntersectionPoint[] {
  if (!isFinitePoint(topLeft) || !isFinitePoint(bottomRight)) {
    throw new Error('Calibration points must contain finite coordinates')
  }

  if (bottomRight.x <= topLeft.x || bottomRight.y <= topLeft.y) {
    throw new Error('The bottom-right calibration point must be below and right of the top-left point')
  }

  const fileStep = (bottomRight.x - topLeft.x) / (FILE_COUNT - 1)
  const rankStep = (bottomRight.y - topLeft.y) / (RANK_COUNT - 1)

  return Array.from({ length: FILE_COUNT * RANK_COUNT }, (_, index) => {
    const rank = Math.floor(index / FILE_COUNT)
    const file = index % FILE_COUNT

    return {
      file,
      rank,
      x: topLeft.x + file * fileStep,
      y: topLeft.y + rank * rankStep,
    }
  })
}

export function getSampleBounds(
  point: Point,
  radius: number,
  frameWidth: number,
  frameHeight: number,
): PixelBounds {
  if (
    !isFinitePoint(point) ||
    !Number.isInteger(radius) ||
    radius < 1 ||
    !Number.isInteger(frameWidth) ||
    !Number.isInteger(frameHeight) ||
    frameWidth < radius * 2 + 1 ||
    frameHeight < radius * 2 + 1
  ) {
    throw new Error('Invalid sampling bounds')
  }

  const size = radius * 2 + 1
  const left = Math.min(Math.max(Math.round(point.x) - radius, 0), frameWidth - size)
  const top = Math.min(Math.max(Math.round(point.y) - radius, 0), frameHeight - size)

  return { left, top, width: size, height: size }
}
