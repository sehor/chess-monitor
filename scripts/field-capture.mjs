import { app, desktopCapturer, screen } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const outputDirectory = resolve(process.argv[2] ?? 'artifacts/field-validation')
const targetTitle = process.argv[3] ?? '天天象棋'
const isScreenCapture = targetTitle === 'screen'

process.stdout.write('field-capture: starting\n')

async function captureWindow() {
  process.stdout.write('field-capture: Electron ready\n')
  const sources = await Promise.race([
    desktopCapturer.getSources({
      types: [isScreenCapture ? 'screen' : 'window'],
      thumbnailSize: { width: 1600, height: 1200 },
      fetchWindowIcons: false,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('desktopCapturer timed out after 10 seconds')), 10_000)),
  ])
  const matches = isScreenCapture ? sources : sources.filter((source) => source.name === targetTitle)
  if (matches.length !== 1) {
    throw new Error(`Expected one window titled ${targetTitle}; found ${matches.length}`)
  }

  await mkdir(outputDirectory, { recursive: true })
  const source = matches[0]
  const capturedAt = new Date().toISOString()
  const fileName = `window-${capturedAt.replaceAll(':', '-')}.png`
  const image = source.thumbnail
  await writeFile(join(outputDirectory, fileName), image.toPNG())
  const metadata = {
    capturedAt,
    fileName,
    sourceId: source.id,
    sourceName: source.name,
    thumbnailSize: image.getSize(),
    displays: screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    })),
  }
  await writeFile(join(outputDirectory, 'environment.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`)
}

app.whenReady().then(async () => {
  try {
    await captureWindow()
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    app.exit(1)
  }
})
