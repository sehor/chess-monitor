import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { MoveConfirmedEvent } from '../src/domain/board-tracker'
import type { Orientation } from '../src/domain/position'
import type { AnalysisInfo, RealtimeSettings } from '../src/shared/ipc'

const DATABASE_SCHEMA_VERSION = 2

type SessionStatus = 'active' | 'paused' | 'finished' | 'error'

interface GameRow {
  id: string
  orientation: Orientation
  baseline_fen: string
  baseline_version: number
  current_fen: string
  current_version: number
  status: SessionStatus
  multi_pv: number
  analysis_depth: number
  profile_id: string | null
  profile_version: number | null
  model_version: string | null
}

interface MoveRow {
  move: string
  confirmation: MoveConfirmedEvent['confirmation']
  previous_fen: string
  fen: string
  previous_position_hash: string
  position_hash: string
  position_version: number
  captured_at: number
  confirmed_at: number
}

export interface GameProvenance {
  profileId: string | null
  profileVersion: number | null
  modelVersion: string | null
}

export interface PersistedGameSession {
  id: string
  orientation: Orientation
  baselineFen: string
  baselineVersion: number
  currentFen: string
  currentVersion: number
  status: SessionStatus
  settings: RealtimeSettings
  provenance: GameProvenance
  moves: MoveConfirmedEvent[]
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
  return typeof row.user_version === 'number' ? row.user_version : 0
}

export interface GameStoreOptions {
  busyTimeoutMs?: number
}

export interface GameDatabaseHealth {
  schemaVersion: number
  journalMode: string
  foreignKeys: boolean
  busyTimeoutMs: number
}

export class GameStore {
  private readonly database: DatabaseSync

  constructor(path: string, options: GameStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 2_500
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000) {
      throw new Error('Game database busy timeout is invalid')
    }
    this.database = new DatabaseSync(path)
    this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${busyTimeoutMs};`)
    this.migrate()
  }

  private migrate(): void {
    const currentVersion = readUserVersion(this.database)
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      this.database.close()
      throw new Error(`Game database schema ${currentVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`)
    }
    if (currentVersion === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE games ADD COLUMN profile_id TEXT;
        ALTER TABLE games ADD COLUMN profile_version INTEGER;
        ALTER TABLE games ADD COLUMN model_version TEXT;
        PRAGMA user_version = 2;
        COMMIT;
      `)
      return
    }
    if (currentVersion !== 0) return

    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE games (
        id TEXT PRIMARY KEY NOT NULL,
        orientation TEXT NOT NULL CHECK (orientation IN ('red-bottom', 'black-bottom')),
        baseline_fen TEXT NOT NULL,
        baseline_version INTEGER NOT NULL CHECK (baseline_version >= 0),
        current_fen TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished', 'error')),
        multi_pv INTEGER NOT NULL CHECK (multi_pv BETWEEN 1 AND 5),
        analysis_depth INTEGER NOT NULL CHECK (analysis_depth BETWEEN 1 AND 128),
        profile_id TEXT,
        profile_version INTEGER,
        model_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE confirmed_moves (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        position_version INTEGER NOT NULL,
        move TEXT NOT NULL,
        confirmation TEXT NOT NULL CHECK (confirmation IN ('automatic', 'manual')),
        previous_fen TEXT NOT NULL,
        fen TEXT NOT NULL,
        previous_position_hash TEXT NOT NULL,
        position_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL,
        PRIMARY KEY (game_id, position_version)
      );
      CREATE TABLE analysis_summaries (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        position_version INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        best_move TEXT,
        lines_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, position_version)
      );
      CREATE INDEX games_status_updated ON games(status, updated_at DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }

  get schemaVersion(): number {
    return readUserVersion(this.database)
  }

  databaseHealth(): GameDatabaseHealth {
    const journal = this.database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown }
    const busyTimeout = this.database.prepare('PRAGMA busy_timeout').get() as { timeout?: unknown }
    return {
      schemaVersion: this.schemaVersion,
      journalMode: typeof journal.journal_mode === 'string' ? journal.journal_mode.toLowerCase() : 'unknown',
      foreignKeys: foreignKeys.foreign_keys === 1,
      busyTimeoutMs: typeof busyTimeout.timeout === 'number' ? busyTimeout.timeout : 0,
    }
  }

  create(
    fen: string,
    orientation: Orientation,
    settings: RealtimeSettings,
    provenance: GameProvenance = { profileId: null, profileVersion: null, modelVersion: null },
  ): PersistedGameSession {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.transaction(() => {
      this.database.prepare("UPDATE games SET status = 'finished', updated_at = ? WHERE status IN ('active', 'paused', 'error')")
        .run(now)
      this.database.prepare(`
        INSERT INTO games (
          id, orientation, baseline_fen, baseline_version, current_fen, current_version,
          status, multi_pv, analysis_depth, profile_id, profile_version, model_version, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, 0, 'active', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        orientation,
        fen,
        fen,
        settings.multiPv,
        settings.depth,
        provenance.profileId,
        provenance.profileVersion,
        provenance.modelVersion,
        now,
        now,
      )
    })
    return this.get(id)!
  }

  getActive(): PersistedGameSession | null {
    const row = this.database.prepare(`
      SELECT * FROM games WHERE status IN ('active', 'paused', 'error')
      ORDER BY updated_at DESC LIMIT 1
    `).get() as unknown as GameRow | undefined
    return row ? this.hydrate(row) : null
  }

  get(id: string): PersistedGameSession | null {
    const row = this.database.prepare('SELECT * FROM games WHERE id = ?').get(id) as unknown as GameRow | undefined
    return row ? this.hydrate(row) : null
  }

  confirmMove(gameId: string, event: MoveConfirmedEvent): PersistedGameSession {
    this.transaction(() => {
      const current = this.requireWritable(gameId)
      if (current.current_version + 1 !== event.positionVersion || current.current_fen !== event.previousFen) {
        throw new Error('Confirmed move does not extend the persisted position')
      }
      this.database.prepare(`
        INSERT INTO confirmed_moves (
          game_id, position_version, move, confirmation, previous_fen, fen,
          previous_position_hash, position_hash, captured_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        gameId,
        event.positionVersion,
        event.move,
        event.confirmation,
        event.previousFen,
        event.fen,
        event.previousPositionHash,
        event.positionHash,
        event.capturedAt,
        event.confirmedAt,
      )
      this.updateCurrent(gameId, event.fen, event.positionVersion)
    })
    return this.get(gameId)!
  }

  replaceBaseline(
    gameId: string,
    fen: string,
    positionVersion: number,
    status: SessionStatus = 'active',
  ): PersistedGameSession {
    let session: PersistedGameSession | undefined
    this.transaction(() => {
      this.requireWritable(gameId)
      const result = this.database.prepare(`
        UPDATE games SET baseline_fen = ?, baseline_version = ?, current_fen = ?,
          current_version = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(fen, positionVersion, fen, positionVersion, status, new Date().toISOString(), gameId)
      if (result.changes !== 1) throw new Error('Game session does not exist')
      session = this.get(gameId) ?? undefined
      if (!session) throw new Error('Game session does not exist')
    })
    return session!
  }

  undoLatestMove(gameId: string, fen: string, positionVersion: number): PersistedGameSession {
    this.transaction(() => {
      this.requireWritable(gameId)
      const latest = this.database.prepare(`
        SELECT position_version FROM confirmed_moves WHERE game_id = ?
        ORDER BY position_version DESC LIMIT 1
      `).get(gameId) as { position_version?: unknown } | undefined
      if (typeof latest?.position_version !== 'number') throw new Error('There is no confirmed move to undo')
      this.database.prepare('DELETE FROM confirmed_moves WHERE game_id = ? AND position_version = ?')
        .run(gameId, latest.position_version)
      this.database.prepare(`
        UPDATE games SET baseline_fen = ?, baseline_version = ?, current_fen = ?,
          current_version = ?, updated_at = ? WHERE id = ?
      `).run(fen, positionVersion, fen, positionVersion, new Date().toISOString(), gameId)
    })
    return this.get(gameId)!
  }

  setStatus(gameId: string, status: SessionStatus): PersistedGameSession {
    const result = this.database.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), gameId)
    if (result.changes !== 1) throw new Error('Game session does not exist')
    return this.get(gameId)!
  }

  updateSettings(gameId: string, settings: RealtimeSettings): PersistedGameSession {
    const result = this.database.prepare(`
      UPDATE games SET multi_pv = ?, analysis_depth = ?, updated_at = ? WHERE id = ?
    `).run(settings.multiPv, settings.depth, new Date().toISOString(), gameId)
    if (result.changes !== 1) throw new Error('Game session does not exist')
    return this.get(gameId)!
  }

  saveAnalysisSummary(
    gameId: string,
    positionVersion: number,
    depth: number,
    bestMove: string | null,
    lines: AnalysisInfo[],
  ): void {
    this.database.prepare(`
      INSERT INTO analysis_summaries (
        game_id, position_version, depth, best_move, lines_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, position_version) DO UPDATE SET
        depth = excluded.depth,
        best_move = excluded.best_move,
        lines_json = excluded.lines_json,
        created_at = excluded.created_at
    `).run(gameId, positionVersion, depth, bestMove, JSON.stringify(lines), new Date().toISOString())
  }

  close(): void {
    this.database.close()
  }

  private hydrate(row: GameRow): PersistedGameSession {
    const moveRows = this.database.prepare(`
      SELECT * FROM confirmed_moves WHERE game_id = ? ORDER BY position_version ASC
    `).all(row.id) as unknown as MoveRow[]
    return {
      id: row.id,
      orientation: row.orientation,
      baselineFen: row.baseline_fen,
      baselineVersion: row.baseline_version,
      currentFen: row.current_fen,
      currentVersion: row.current_version,
      status: row.status,
      settings: { multiPv: row.multi_pv, depth: row.analysis_depth },
      provenance: {
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        modelVersion: row.model_version,
      },
      moves: moveRows.map((move) => ({
        type: 'move-confirmed',
        move: move.move as MoveConfirmedEvent['move'],
        confirmation: move.confirmation,
        previousFen: move.previous_fen,
        fen: move.fen,
        previousPositionHash: move.previous_position_hash,
        positionHash: move.position_hash,
        positionVersion: move.position_version,
        capturedAt: move.captured_at,
        confirmedAt: move.confirmed_at,
      })),
    }
  }

  private requireWritable(gameId: string): GameRow {
    const row = this.database.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as unknown as GameRow | undefined
    if (!row || row.status === 'finished') throw new Error('Game session is not writable')
    return row
  }

  private updateCurrent(gameId: string, fen: string, positionVersion: number): void {
    const result = this.database.prepare(`
      UPDATE games SET current_fen = ?, current_version = ?, status = 'active', updated_at = ? WHERE id = ?
    `).run(fen, positionVersion, new Date().toISOString(), gameId)
    if (result.changes !== 1) throw new Error('Game session does not exist')
  }

  private transaction(action: () => void): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
