import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  PROFILE_SCHEMA_VERSION,
  parseCaptureProfile,
  parseCaptureProfileInput,
  parseProfilePackage,
  type CaptureProfile,
  type CaptureProfileInput,
  type ProfileDiagnostics,
  type ProfileIssue,
  type ProfileListResult,
} from '../src/shared/profile'

interface ProfileRow {
  id: string
  payload: string
}

const DATABASE_SCHEMA_VERSION = 2
const ACTIVE_PROFILE_KEY = 'active_profile_id'

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
  return typeof row.user_version === 'number' ? row.user_version : 0
}

export class ProfileStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2500;')
    this.migrate()
  }

  private migrate(): void {
    const currentVersion = readUserVersion(this.database)
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      this.database.close()
      throw new Error(`Profile database schema ${currentVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`)
    }
    if (currentVersion === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE profiles (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE profile_versions (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, profile_version)
        );
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;
      `)
      return
    }
    if (currentVersion === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS profile_versions (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, profile_version)
        );
        PRAGMA user_version = 2;
        COMMIT;
      `)
      const rows = this.database.prepare('SELECT id, payload, created_at FROM profiles').all() as unknown as Array<ProfileRow & { created_at: string }>
      for (const row of rows) {
        try {
          const parsed = parseCaptureProfile(JSON.parse(row.payload))
          if (!parsed.ok) continue
          const migrated = { ...parsed.value, profileVersion: 1 }
          this.database.prepare('UPDATE profiles SET payload = ? WHERE id = ?').run(JSON.stringify(migrated), row.id)
          this.database.prepare('INSERT OR IGNORE INTO profile_versions (profile_id, profile_version, payload, created_at) VALUES (?, 1, ?, ?)')
            .run(row.id, JSON.stringify(migrated), row.created_at)
        } catch {
          // Corrupt rows remain isolated and are reported by list().
        }
      }
    }
  }

  get schemaVersion(): number {
    return readUserVersion(this.database)
  }

  list(): ProfileListResult {
    const rows = this.database.prepare('SELECT id, payload FROM profiles ORDER BY updated_at DESC, id ASC').all() as unknown as ProfileRow[]
    const profiles: CaptureProfile[] = []
    const issues: ProfileIssue[] = []
    for (const row of rows) {
      try {
        const parsed = parseCaptureProfile(JSON.parse(row.payload))
        if (parsed.ok) profiles.push(parsed.value)
        else issues.push({ id: row.id, message: parsed.error })
      } catch {
        issues.push({ id: row.id, message: 'Profile payload is not valid JSON' })
      }
    }
    return { profiles, issues, activeProfileId: this.getActiveId() }
  }

  get(id: string): CaptureProfile | null {
    const row = this.database.prepare('SELECT payload FROM profiles WHERE id = ?').get(id) as { payload?: unknown } | undefined
    if (!row || typeof row.payload !== 'string') return null
    try {
      const parsed = parseCaptureProfile(JSON.parse(row.payload))
      return parsed.ok ? parsed.value : null
    } catch {
      return null
    }
  }

  listVersions(id: string): CaptureProfile[] {
    const rows = this.database.prepare('SELECT payload FROM profile_versions WHERE profile_id = ? ORDER BY profile_version DESC').all(id) as unknown as Array<{ payload: string }>
    return rows.flatMap((row) => {
      try {
        const parsed = parseCaptureProfile(JSON.parse(row.payload))
        return parsed.ok ? [parsed.value] : []
      } catch {
        return []
      }
    })
  }

  getVersion(id: string, profileVersion: number): CaptureProfile | null {
    const row = this.database.prepare('SELECT payload FROM profile_versions WHERE profile_id = ? AND profile_version = ?')
      .get(id, profileVersion) as { payload?: unknown } | undefined
    if (!row || typeof row.payload !== 'string') return null
    try {
      const parsed = parseCaptureProfile(JSON.parse(row.payload))
      return parsed.ok ? parsed.value : null
    } catch {
      return null
    }
  }

  save(value: unknown): CaptureProfile {
    const parsed = parseCaptureProfileInput(value)
    if (!parsed.ok) throw new TypeError(parsed.error)
    const input = parsed.value as CaptureProfileInput
    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const existing = this.get(id)
    const profileVersion = (existing?.profileVersion ?? 0) + 1
    const profile: CaptureProfile = {
      ...input,
      id,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileVersion,
      client: input.client!,
      compatibility: input.compatibility!,
      priority: input.priority!,
      isEnabled: input.isEnabled!,
      matchRules: input.matchRules!,
      model: input.model!,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO profiles (id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(id, JSON.stringify(profile), profile.createdAt, profile.updatedAt)
      this.database.prepare('INSERT INTO profile_versions (profile_id, profile_version, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(id, profile.profileVersion, JSON.stringify(profile), now)
      this.database.exec('COMMIT')
      return profile
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  duplicate(id: string): CaptureProfile {
    const source = this.get(id)
    if (!source) throw new Error('Profile does not exist')
    return this.save({ ...source, id: undefined, name: `${source.name} 副本` })
  }

  setEnabled(id: string, enabled: boolean): CaptureProfile {
    const profile = this.get(id)
    if (!profile) throw new Error('Profile does not exist')
    const updated = this.save({ ...profile, isEnabled: enabled })
    if (!enabled && this.getActiveId() === id) this.setActive(null)
    return updated
  }

  rollback(id: string, profileVersion: number): CaptureProfile {
    const target = this.getVersion(id, profileVersion)
    if (!target) throw new Error('Profile version does not exist or is corrupt')
    return this.save({ ...target, id })
  }

  importPackage(value: unknown): CaptureProfile {
    const parsed = parseProfilePackage(value)
    if (!parsed.ok) throw new TypeError(parsed.error)
    const imported = parsed.value.profile
    return this.save({ ...imported, id: undefined })
  }

  delete(id: string): boolean {
    const result = this.database.prepare('DELETE FROM profiles WHERE id = ?').run(id)
    if (this.getActiveId() === id) this.setActive(null)
    return result.changes > 0
  }

  setActive(id: string | null): void {
    if (id !== null) {
      const profile = this.get(id)
      if (!profile) throw new Error('Profile does not exist')
      if (!profile.isEnabled) throw new Error('Profile is disabled')
    }
    if (id === null) {
      this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(ACTIVE_PROFILE_KEY)
      return
    }
    this.database.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ACTIVE_PROFILE_KEY, id)
  }

  getActiveId(): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(ACTIVE_PROFILE_KEY) as { value?: unknown } | undefined
    return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null
  }

  getActive(): CaptureProfile | null {
    const id = this.getActiveId()
    return id ? this.get(id) : null
  }

  diagnostics(id: string): ProfileDiagnostics | null {
    const profile = this.get(id)
    if (!profile) return null
    return {
      exportedAt: new Date().toISOString(),
      databaseSchemaVersion: this.schemaVersion,
      profileSchemaVersion: PROFILE_SCHEMA_VERSION,
      activeProfileId: this.getActiveId(),
      profile,
      issues: this.list().issues,
    }
  }

  close(): void {
    this.database.close()
  }
}
