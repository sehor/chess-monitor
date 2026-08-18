import { app, desktopCapturer, screen } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const outputDirectory = resolve(process.argv[2] ?? 'artifacts/field-validation/dpi-100/stationary')
const dpi = Number(process.argv[3] ?? 100)
const sampleCount = Number(process.argv[4] ?? 80)
const intervalMs = Number(process.argv[5] ?? 200)
const captureProfiles = {
  100: {
    boardRect: { x: 865, y: 148, width: 532, height: 600 },
    intersections: { topLeft: { x: 11, y: 10 }, bottomRight: { x: 526, y: 591 } },
  },
  125: {
    boardRect: { x: 688, y: 117, width: 582, height: 646 },
    intersections: { topLeft: { x: 39, y: 34 }, bottomRight: { x: 544, y: 602 } },
  },
}
const { boardRect, intersections } = captureProfiles[dpi] ?? {}

function assertArguments() {
  if (![100, 125, 150].includes(dpi)) throw new Error('DPI must be 100, 125, or 150')
  if (!boardRect || !intersections) throw new Error(`No capture profile is configured for ${dpi}% DPI`)
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 500) {
    throw new Error('Sample count must be an integer between 1 and 500')
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 10_000) {
    throw new Error('Interval must be an integer between 100 and 10000 milliseconds')
  }
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function captureScreen() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
    fetchWindowIcons: false,
  })
  if (sources.length !== 1) throw new Error(`Expected one screen source; found ${sources.length}`)
  return sources[0].thumbnail
}

async function run() {
  assertArguments()
  await mkdir(outputDirectory, { recursive: true })
  const display = screen.getPrimaryDisplay()
  if (Math.round(display.scaleFactor * 100) !== dpi) {
    throw new Error(`Display scale is ${Math.round(display.scaleFactor * 100)}%, expected ${dpi}%`)
  }

  const manifest = {
    schemaVersion: 1,
    labelSource: 'operator-confirmed-stationary',
    eventType: 'stationary',
    dpi,
    intervalMs,
    boardRect,
    intersections,
    display: {
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    },
    startedAt: new Date().toISOString(),
    samples: [],
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const image = await captureScreen()
    const size = image.getSize()
    if (size.width !== 1600 || size.height !== 900) {
      throw new Error(`Unexpected capture size ${size.width}x${size.height}`)
    }
    const capturedAt = new Date().toISOString()
    const fileName = `stationary-${String(index + 1).padStart(3, '0')}.png`
    await writeFile(join(outputDirectory, fileName), image.crop(boardRect).toPNG())
    manifest.samples.push({
      sampleId: `dpi-${dpi}-stationary-${String(index + 1).padStart(3, '0')}`,
      fileName,
      capturedAt,
      expectedChangedPoints: [],
      captureSucceeded: true,
    })
    process.stdout.write(`\rCaptured ${index + 1}/${sampleCount}`)
    if (index + 1 < sampleCount) await delay(intervalMs)
  }

  manifest.completedAt = new Date().toISOString()
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`\nSaved ${sampleCount} stationary samples to ${outputDirectory}\n`)
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
