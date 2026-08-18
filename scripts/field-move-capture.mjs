import { app, desktopCapturer, screen } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const outputDirectory = resolve(process.argv[2] ?? 'artifacts/field-validation/dpi-100/moves')
const dpi = Number(process.argv[3] ?? 100)
const durationSeconds = Number(process.argv[4] ?? 120)
const intervalMs = 200
const stableFrameRequirement = 3
const captureProfiles = {
  100: {
    boardRect: { x: 865, y: 148, width: 532, height: 600 },
    grid: { topLeft: { x: 11, y: 10 }, bottomRight: { x: 526, y: 591 } },
  },
  125: {
    boardRect: { x: 688, y: 117, width: 582, height: 646 },
    grid: { topLeft: { x: 39, y: 34 }, bottomRight: { x: 544, y: 602 } },
  },
}
const { boardRect, grid } = captureProfiles[dpi] ?? {}
const normalizedRoiSize = 32

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function captureBoard() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
    fetchWindowIcons: false,
  })
  if (sources.length !== 1) throw new Error(`Expected one screen source; found ${sources.length}`)
  const board = sources[0].thumbnail.crop(boardRect)
  return { board, png: board.toPNG(), bitmap: board.toBitmap() }
}

function roi(bitmap, point, radius) {
  const left = Math.max(0, Math.round(point.x) - radius)
  const top = Math.max(0, Math.round(point.y) - radius)
  const right = Math.min(boardRect.width, Math.round(point.x) + radius + 1)
  const bottom = Math.min(boardRect.height, Math.round(point.y) + radius + 1)
  const values = new Float32Array(normalizedRoiSize * normalizedRoiSize)
  for (let targetY = 0; targetY < normalizedRoiSize; targetY += 1) {
    const sourceY = top + Math.min(bottom - top - 1, Math.floor((targetY + 0.5) * (bottom - top) / normalizedRoiSize))
    for (let targetX = 0; targetX < normalizedRoiSize; targetX += 1) {
      const sourceX = left + Math.min(right - left - 1, Math.floor((targetX + 0.5) * (right - left) / normalizedRoiSize))
      const index = (sourceY * boardRect.width + sourceX) * 4
      const blue = bitmap[index]
      const green = bitmap[index + 1]
      const red = bitmap[index + 2]
      values[targetY * normalizedRoiSize + targetX] = red * 0.2126 + green * 0.7152 + blue * 0.0722
    }
  }
  return values
}

function difference(current, previous) {
  let currentMean = 0
  let previousMean = 0
  for (let index = 0; index < current.length; index += 1) {
    currentMean += current[index]
    previousMean += previous[index]
  }
  currentMean /= current.length
  previousMean /= previous.length
  let total = 0
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs((current[index] - currentMean) - (previous[index] - previousMean))
  }
  return Math.min(1, total / current.length / 255)
}

function pointScores(current, previous) {
  const spacingX = (grid.bottomRight.x - grid.topLeft.x) / 8
  const spacingY = (grid.bottomRight.y - grid.topLeft.y) / 9
  const radius = Math.floor(Math.min(spacingX, spacingY) * 0.6 / 2)
  const scores = []
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const point = { x: grid.topLeft.x + file * spacingX, y: grid.topLeft.y + rank * spacingY }
      scores.push(difference(roi(current, point, radius), roi(previous, point, radius)))
    }
  }
  return scores
}

async function run() {
  if (![100, 125, 150].includes(dpi)) throw new Error('DPI must be 100, 125, or 150')
  if (!boardRect || !grid) throw new Error(`No capture profile is configured for ${dpi}% DPI`)
  const display = screen.getPrimaryDisplay()
  if (Math.round(display.scaleFactor * 100) !== dpi) {
    throw new Error(`Display scale is ${Math.round(display.scaleFactor * 100)}%, expected ${dpi}%`)
  }
  await mkdir(outputDirectory, { recursive: true })
  const startedAt = new Date()
  const deadline = startedAt.getTime() + durationSeconds * 1000
  const manifest = {
    schemaVersion: 1,
    labelSource: 'detector-proposed-pending-operator-review',
    dpi,
    intervalMs,
    stableFrameRequirement,
    boardRect,
    grid,
    startedAt: startedAt.toISOString(),
    states: [],
  }

  let accepted
  let candidate
  let candidateHash = ''
  let candidateStableCount = 0
  while (Date.now() < deadline) {
    const frame = await captureBoard()
    const hash = createHash('sha256').update(frame.png).digest('hex')
    if (hash === candidateHash) candidateStableCount += 1
    else {
      candidate = frame
      candidateHash = hash
      candidateStableCount = 1
    }

    if (candidateStableCount === stableFrameRequirement && candidate && candidateHash !== accepted?.hash) {
      const index = manifest.states.length
      const fileName = `stable-state-${String(index).padStart(3, '0')}.png`
      const scores = accepted ? pointScores(candidate.bitmap, accepted.bitmap) : Array(90).fill(0)
      const ranked = scores
        .map((score, point) => ({ point, score }))
        .sort((left, right) => right.score - left.score)
      const proposedChangedPoints = ranked.filter(({ score }) => score >= 0.015).map(({ point }) => point)
      await writeFile(join(outputDirectory, fileName), candidate.png)
      manifest.states.push({
        index,
        fileName,
        capturedAt: new Date().toISOString(),
        sha256: candidateHash,
        pointScores: scores,
        proposedChangedPoints,
        topScores: ranked.slice(0, 6),
      })
      await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      accepted = { ...candidate, hash: candidateHash }
      process.stdout.write(`Accepted stable state ${index}; proposed points: ${proposedChangedPoints.map((point) => point + 1).join(',') || 'none'}\n`)
    }
    await delay(intervalMs)
  }

  manifest.completedAt = new Date().toISOString()
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`Saved ${manifest.states.length} stable states to ${outputDirectory}\n`)
}

app.whenReady().then(async () => {
  try {
    await run()
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    app.exit(1)
  }
})
