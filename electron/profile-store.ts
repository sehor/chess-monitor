import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  PROFILE_SCHEMA_VERSION,
  parseCaptureProfile,
  parseCaptureProfileInput,
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

const DATABASE_SCHEMA_VERSION = 1
const ACTIVE_PROFILE_KEY = 'active_profile_id'

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
  return typeof row.user_version === 'number' ? row.user_version : 0
}

export class ProfileStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
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
        CREATE TABLE IF NOT EXISTS profiles (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
      `)
    }
  }

  get schemaVersion(): number {
    return readUserVersion(this.database)
  }

  list(): ProfileListResult {
    const rows = this.database
      .prepare('SELECT id, payload FROM profiles ORDER BY updated_at DESC, id ASC')
      .all() as unknown as ProfileRow[]
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

  save(value: unknown): CaptureProfile {
    const parsed = parseCaptureProfileInput(value)
    if (!parsed.ok) throw new TypeError(parsed.error)
    const input: CaptureProfileInput = parsed.value
    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const existing = this.get(id)
    const profile: CaptureProfile = {
      ...input,
      id,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.database.prepare(`
      INSERT INTO profiles (id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(profile), profile.createdAt, profile.updatedAt)
    return profile
  }

  delete(id: string): boolean {
    const result = this.database.prepare('DELETE FROM profiles WHERE id = ?').run(id)
    if (this.getActiveId() === id) this.setActive(null)
    return result.changes > 0
  }

  setActive(id: string | null): void {
    if (id !== null && !this.get(id)) throw new Error('Profile does not exist')
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
