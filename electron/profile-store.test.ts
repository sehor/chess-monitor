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
    expect(reopened.schemaVersion).toBe(2)
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

  it('rolls back disabling the active profile when clearing the active setting fails', async () => {
    const path = await databasePath()
    const seed = new ProfileStore(path)
    const active = seed.save(input)
    seed.setActive(active.id)
    seed.close()
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TRIGGER fail_active_profile_clear
      BEFORE DELETE ON app_settings
      WHEN OLD.key = 'active_profile_id'
      BEGIN
        SELECT RAISE(ABORT, 'simulated active setting failure');
      END;
    `)
    database.close()

    const store = new ProfileStore(path)
    expect(() => store.setEnabled(active.id, false)).toThrow('simulated active setting failure')
    expect(store.get(active.id)?.isEnabled).toBe(true)
    expect(store.getActiveId()).toBe(active.id)
    store.close()
  })

  it('rolls back deleting the active profile when clearing the active setting fails', async () => {
    const path = await databasePath()
    const seed = new ProfileStore(path)
    const active = seed.save(input)
    seed.setActive(active.id)
    seed.close()
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TRIGGER fail_active_profile_clear
      BEFORE DELETE ON app_settings
      WHEN OLD.key = 'active_profile_id'
      BEGIN
        SELECT RAISE(ABORT, 'simulated active setting failure');
      END;
    `)
    database.close()

    const store = new ProfileStore(path)
    expect(() => store.delete(active.id)).toThrow('simulated active setting failure')
    expect(store.get(active.id)).not.toBeNull()
    expect(store.getActiveId()).toBe(active.id)
    store.close()
  })

  it('rolls back the entire v1 to v2 migration when a row update fails', async () => {
    const path = await databasePath()
    const seed = new ProfileStore(path)
    seed.save(input)
    seed.close()
    const database = new DatabaseSync(path)
    database.exec(`
      DROP TABLE profile_versions;
      PRAGMA user_version = 1;
      CREATE TRIGGER fail_profile_migration
      BEFORE UPDATE OF payload ON profiles
      BEGIN
        SELECT RAISE(ABORT, 'simulated migration failure');
      END;
    `)
    database.close()

    expect(() => new ProfileStore(path)).toThrow('simulated migration failure')
    const inspected = new DatabaseSync(path)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_versions'").get()).toBeUndefined()
    inspected.close()
  })

  it('refuses a database created by a newer application schema', async () => {
    const path = await databasePath()
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    expect(() => new ProfileStore(path)).toThrow('newer than supported')
  })

  it('keeps version history, supports rollback, duplicate and disable without losing the active record', async () => {
    const path = await databasePath()
    const store = new ProfileStore(path)
    const first = store.save(input)
    const second = store.save({ ...input, id: first.id, name: '第二版', priority: 10 })
    const third = store.save({ ...input, id: first.id, name: '第三版', theme: '深色' })

    expect([first.profileVersion, second.profileVersion, third.profileVersion]).toEqual([1, 2, 3])
    expect(store.listVersions(first.id).map((item) => item.profileVersion)).toEqual([3, 2, 1])

    const rolledBack = store.rollback(first.id, 1)
    expect(rolledBack.profileVersion).toBe(4)
    expect(rolledBack.name).toBe(input.name)

    const duplicate = store.duplicate(first.id)
    expect(duplicate.id).not.toBe(first.id)
    expect(duplicate.profileVersion).toBe(1)
    expect(duplicate.name).toContain('副本')

    store.setEnabled(first.id, false)
    expect(store.get(first.id)?.isEnabled).toBe(false)
    store.close()
  })

  it('imports a validated package as a new local profile version', async () => {
    const path = await databasePath()
    const store = new ProfileStore(path)
    const saved = store.save(input)
    const imported = store.importPackage({
      kind: 'chess-monitor-profile',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      profile: saved,
    })
    expect(imported.id).not.toBe(saved.id)
    expect(imported.profileVersion).toBe(1)
    expect(imported.name).toBe(saved.name)
    store.close()
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
