import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateProfileCompatibility, type CaptureProfileInput } from '../src/shared/profile'
import { ProfileStore } from './profile-store'

const directories: string[] = []

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chess-monitor-profile-'))
  directories.push(directory)
  return join(directory, 'profiles.sqlite3')
}

const input: CaptureProfileInput = {
  name: '天天象棋 100%',
  source: { kind: 'screen', name: '整个屏幕' },
  frame: { width: 1600, height: 900, dpi: 100 },
  calibration: { topLeft: { x: 876, y: 158 }, bottomRight: { x: 1391, y: 739 } },
  orientation: 'red-bottom',
  theme: '木纹',
  roiScale: 0.6,
  thresholds: { low: 0, high: 0.0076 },
  stableFrameRequirement: 3,
  animationWaitMs: 300,
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileStore', () => {
  it('migrates, persists, updates and restores an active profile', async () => {
    const path = await databasePath()
    const first = new ProfileStore(path)
    const saved = first.save(input)
    first.setActive(saved.id)
    const updated = first.save({ ...input, id: saved.id, name: '更新后的 Profile' })
    expect(updated.createdAt).toBe(saved.createdAt)
    first.close()

    const reopened = new ProfileStore(path)
    expect(reopened.schemaVersion).toBe(1)
    expect(reopened.getActive()?.name).toBe('更新后的 Profile')
    expect(reopened.list()).toMatchObject({ activeProfileId: saved.id, issues: [] })
    reopened.close()
  })

  it('keeps corrupt records isolated and reports a recoverable issue', async () => {
    const path = await databasePath()
    const store = new ProfileStore(path)
    store.close()
    const database = new DatabaseSync(path)
    database.prepare('INSERT INTO profiles (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('corrupt', '{not json', new Date().toISOString(), new Date().toISOString())
    database.close()

    const reopened = new ProfileStore(path)
    expect(reopened.list()).toEqual({
      profiles: [],
      issues: [{ id: 'corrupt', message: 'Profile payload is not valid JSON' }],
      activeProfileId: null,
    })
    reopened.close()
  })

  it('deletes the active profile without affecting other profiles', async () => {
    const path = await databasePath()
    const store = new ProfileStore(path)
    const active = store.save(input)
    const retained = store.save({ ...input, name: '保留项' })
    store.setActive(active.id)
    expect(store.delete(active.id)).toBe(true)
    expect(store.getActive()).toBeNull()
    expect(store.get(retained.id)?.name).toBe('保留项')
    store.close()
  })

  it('refuses a database created by a newer application schema', async () => {
    const path = await databasePath()
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    expect(() => new ProfileStore(path)).toThrow('newer than supported')
  })

  it('restores compatible coordinates through 30 close-and-reopen cycles', async () => {
    const path = await databasePath()
    const first = new ProfileStore(path)
    const saved = first.save(input)
    first.setActive(saved.id)
    first.close()

    for (let cycle = 0; cycle < 30; cycle += 1) {
      const reopened = new ProfileStore(path)
      const active = reopened.getActive()
      expect(active?.id).toBe(saved.id)
      const scale = [0.5, 0.75, 1, 1.25][cycle % 4]
      const compatibility = evaluateProfileCompatibility(active!, {
        width: Math.round(input.frame.width * scale),
        height: Math.round(input.frame.height * scale),
        dpi: input.frame.dpi,
      })
      expect(compatibility.state).toBe('compatible')
      if (compatibility.state === 'compatible') {
        expect(compatibility.calibration.topLeft.x).toBeCloseTo(input.calibration.topLeft.x * scale, 6)
        expect(compatibility.calibration.bottomRight.y).toBeCloseTo(input.calibration.bottomRight.y * scale, 6)
      }
      reopened.close()
    }
  })
})
