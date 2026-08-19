import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { MoveConfirmedEvent } from '../src/domain/board-tracker'
import { RulesAdapter } from '../src/domain/game'
import type { Orientation } from '../src/domain/position'
import type { AnalysisInfo, RealtimeSettings } from '../src/shared/ipc'
import type {
  ReviewJob,
  StudyAnalysis,
  StudyGameSummary,
  StudyMark,
  StudyNode,
  StudyNodeSource,
} from '../src/shared/study'

const DATABASE_SCHEMA_VERSION = 3

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
  created_at: string
  updated_at: string
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

interface StudyNodeRow {
  id: string
  game_id: string
  parent_id: string | null
  source: StudyNodeSource
  move: string | null
  fen: string
  ply: number
  live_position_version: number | null
  created_at: string
}

interface StudyAnalysisRow {
  cache_key: string
  node_id?: string
  fen: string
  engine_name: string
  engine_sha256: string
  settings_json: string
  best_move: string | null
  lines_json: string
  created_at: string
}

interface StudyMarkRow {
  node_id: string
  kind: StudyMark['kind']
  mover: StudyMark['mover']
  actual_move: string
  best_move: string
  loss_cp: number | null
  mate_swing: number
  explanation: string
  created_at: string
}

interface ReviewJobRow {
  game_id: string
  status: ReviewJob['status']
  depth: number
  multi_pv: number
  next_index: number
  total_nodes: number
  completed_nodes: number
  node_ids_json: string
  engine_sha256: string
  message: string
  updated_at: string
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
    let currentVersion = readUserVersion(this.database)
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      this.database.close()
      throw new Error(`Game database schema ${currentVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`)
    }

    if (currentVersion === 0) {
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
        ${this.studySchemaSql()}
        PRAGMA user_version = 3;
        COMMIT;
      `)
      currentVersion = 3
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
      currentVersion = 2
    }

    if (currentVersion === 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ${this.studySchemaSql()}
        PRAGMA user_version = 3;
        COMMIT;
      `)
      currentVersion = 3
    }

    if (currentVersion === 3) {
      this.ensureReviewJobNodeIdsColumn()
      this.backfillStudyNodes()
    }
  }

  private ensureReviewJobNodeIdsColumn(): void {
    const columns = this.database.prepare('PRAGMA table_info(review_jobs)').all() as unknown as Array<{ name?: unknown }>
    if (!columns.some((column) => column.name === 'node_ids_json')) {
      this.database.exec("ALTER TABLE review_jobs ADD COLUMN node_ids_json TEXT NOT NULL DEFAULT '[]'")
    }
  }

  private studySchemaSql(): string {
    return `
      CREATE TABLE position_nodes (
        id TEXT PRIMARY KEY NOT NULL,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES position_nodes(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('live', 'variation', 'import', 'fen', 'resync', 'undo')),
        move TEXT,
        fen TEXT NOT NULL,
        ply INTEGER NOT NULL CHECK (ply >= 0),
        live_position_version INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (game_id, live_position_version)
      );
      CREATE INDEX position_nodes_game_parent ON position_nodes(game_id, parent_id, created_at);
      CREATE INDEX position_nodes_game_live ON position_nodes(game_id, live_position_version);
      CREATE TABLE study_analysis_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        fen TEXT NOT NULL,
        engine_name TEXT NOT NULL,
        engine_sha256 TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        best_move TEXT,
        lines_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE study_node_analysis (
        node_id TEXT NOT NULL REFERENCES position_nodes(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL REFERENCES study_analysis_cache(cache_key) ON DELETE CASCADE,
        PRIMARY KEY (node_id, cache_key)
      );
      CREATE INDEX study_node_analysis_cache ON study_node_analysis(cache_key);
      CREATE TABLE study_marks (
        node_id TEXT PRIMARY KEY NOT NULL REFERENCES position_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('question', 'blunder')),
        mover TEXT NOT NULL CHECK (mover IN ('red', 'black')),
        actual_move TEXT NOT NULL,
        best_move TEXT NOT NULL,
        loss_cp INTEGER,
        mate_swing INTEGER NOT NULL CHECK (mate_swing IN (0, 1)),
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE review_jobs (
        game_id TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
        depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 128),
        multi_pv INTEGER NOT NULL CHECK (multi_pv BETWEEN 1 AND 5),
        next_index INTEGER NOT NULL CHECK (next_index >= 0),
        total_nodes INTEGER NOT NULL CHECK (total_nodes >= 0),
        completed_nodes INTEGER NOT NULL CHECK (completed_nodes >= 0),
        node_ids_json TEXT NOT NULL,
        engine_sha256 TEXT NOT NULL,
        message TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }

  private backfillStudyNodes(): void {
    const games = this.database.prepare('SELECT * FROM games ORDER BY created_at ASC').all() as unknown as GameRow[]
    this.transaction(() => {
      for (const game of games) {
        const existing = this.database.prepare('SELECT id FROM position_nodes WHERE game_id = ? LIMIT 1').get(game.id)
        if (existing) continue
        const moves = this.database.prepare(`
          SELECT * FROM confirmed_moves WHERE game_id = ? ORDER BY position_version ASC
        `).all(game.id) as unknown as MoveRow[]
        const rootFen = moves[0]?.previous_fen ?? game.baseline_fen
        const rootVersion = moves[0] ? Math.max(0, moves[0].position_version - 1) : game.baseline_version
        let parent = this.insertStudyNode({
          gameId: game.id,
          parentId: null,
          source: 'live',
          move: null,
          fen: rootFen,
          ply: 0,
          livePositionVersion: rootVersion,
        })
        for (const move of moves) {
          parent = this.insertStudyNode({
            gameId: game.id,
            parentId: parent.id,
            source: 'live',
            move: move.move,
            fen: move.fen,
            ply: parent.ply + 1,
            livePositionVersion: move.position_version,
          })
        }
        if (parent.livePositionVersion !== game.current_version || parent.fen !== game.current_fen) {
          this.insertStudyNode({
            gameId: game.id,
            parentId: parent.id,
            source: 'resync',
            move: null,
            fen: game.current_fen,
            ply: parent.ply + 1,
            livePositionVersion: game.current_version,
          })
        }
      }
    })
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
      this.insertGameRow(id, fen, orientation, settings, provenance, 'active', now)
      this.insertStudyNode({
        gameId: id,
        parentId: null,
        source: 'live',
        move: null,
        fen,
        ply: 0,
        livePositionVersion: 0,
        createdAt: now,
      })
    })
    return this.get(id)!
  }

  createStudyGame(
    fen: string,
    orientation: Orientation = 'red-bottom',
    source: Extract<StudyNodeSource, 'import' | 'fen'> = 'import',
  ): PersistedGameSession {
    const normalizedFen = new RulesAdapter(fen, orientation).snapshot().fen
    const id = randomUUID()
    const now = new Date().toISOString()
    this.transaction(() => {
      this.insertGameRow(
        id,
        normalizedFen,
        orientation,
        { multiPv: 1, depth: 16 },
        { profileId: null, profileVersion: null, modelVersion: null },
        'finished',
        now,
      )
      this.insertStudyNode({
        gameId: id,
        parentId: null,
        source,
        move: null,
        fen: normalizedFen,
        ply: 0,
        livePositionVersion: null,
        createdAt: now,
      })
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

  listGames(limit = 50): StudyGameSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Game list limit is invalid')
    const rows = this.database.prepare('SELECT * FROM games ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as GameRow[]
    return rows.map((row) => this.gameSummary(row))
  }

  getGameSummary(gameId: string): StudyGameSummary | null {
    const row = this.database.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as unknown as GameRow | undefined
    return row ? this.gameSummary(row) : null
  }

  confirmMove(gameId: string, event: MoveConfirmedEvent): PersistedGameSession {
    this.transaction(() => {
      const current = this.requireWritable(gameId)
      if (current.current_version + 1 !== event.positionVersion || current.current_fen !== event.previousFen) {
        throw new Error('Confirmed move does not extend the persisted position')
      }
      const parent = this.requireLiveStudyNode(gameId, current.current_version)
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
      this.insertStudyNode({
        gameId,
        parentId: parent.id,
        source: 'live',
        move: event.move,
        fen: event.fen,
        ply: parent.ply + 1,
        livePositionVersion: event.positionVersion,
      })
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
      const current = this.requireWritable(gameId)
      const parent = this.requireLiveStudyNode(gameId, current.current_version)
      const result = this.database.prepare(`
        UPDATE games SET baseline_fen = ?, baseline_version = ?, current_fen = ?,
          current_version = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(fen, positionVersion, fen, positionVersion, status, new Date().toISOString(), gameId)
      if (result.changes !== 1) throw new Error('Game session does not exist')
      this.insertStudyNode({
        gameId,
        parentId: parent.id,
        source: 'resync',
        move: null,
        fen,
        ply: parent.ply + 1,
        livePositionVersion: positionVersion,
      })
      session = this.get(gameId) ?? undefined
      if (!session) throw new Error('Game session does not exist')
    })
    return session!
  }

  undoLatestMove(gameId: string, fen: string, positionVersion: number): PersistedGameSession {
    this.transaction(() => {
      const current = this.requireWritable(gameId)
      const parent = this.requireLiveStudyNode(gameId, current.current_version)
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
      this.insertStudyNode({
        gameId,
        parentId: parent.id,
        source: 'undo',
        move: null,
        fen,
        ply: parent.ply + 1,
        livePositionVersion: positionVersion,
      })
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

  getStudyNode(nodeId: string): StudyNode | null {
    const row = this.database.prepare('SELECT * FROM position_nodes WHERE id = ?').get(nodeId) as unknown as StudyNodeRow | undefined
    return row ? this.hydrateStudyNode(row) : null
  }

  getStudyNodes(gameId: string): StudyNode[] {
    const rows = this.database.prepare(`
      SELECT * FROM position_nodes WHERE game_id = ? ORDER BY ply ASC, created_at ASC, id ASC
    `).all(gameId) as unknown as StudyNodeRow[]
    return rows.map((row) => this.hydrateStudyNode(row))
  }

  getLiveStudyNodes(gameId: string): StudyNode[] {
    const rows = this.database.prepare(`
      SELECT * FROM position_nodes WHERE game_id = ? AND live_position_version IS NOT NULL
      ORDER BY live_position_version ASC
    `).all(gameId) as unknown as StudyNodeRow[]
    return rows.map((row) => this.hydrateStudyNode(row))
  }

  createStudyChild(
    gameId: string,
    parentNodeId: string,
    move: string,
    source: Extract<StudyNodeSource, 'variation' | 'import'> = 'variation',
  ): StudyNode {
    const parent = this.getStudyNode(parentNodeId)
    if (!parent || parent.gameId !== gameId) throw new Error('Study parent node does not exist')
    const game = new RulesAdapter(parent.fen)
    const next = game.apply(move)
    return this.insertStudyNode({
      gameId,
      parentId: parent.id,
      source,
      move: next.lastMove,
      fen: next.fen,
      ply: parent.ply + 1,
      livePositionVersion: null,
    })
  }

  createFenNode(gameId: string, fen: string): StudyNode {
    if (!this.get(gameId)) throw new Error('Game session does not exist')
    const normalized = new RulesAdapter(fen).snapshot().fen
    return this.insertStudyNode({
      gameId,
      parentId: null,
      source: 'fen',
      move: null,
      fen: normalized,
      ply: 0,
      livePositionVersion: null,
    })
  }

  saveStudyAnalysis(nodeId: string, analysis: StudyAnalysis): StudyAnalysis {
    const node = this.getStudyNode(nodeId)
    if (!node) throw new Error('Study node does not exist')
    if (node.fen !== analysis.fen) throw new Error('Study analysis FEN does not match its node')
    const settingsJson = JSON.stringify(analysis.settings)
    const existing = this.database.prepare('SELECT * FROM study_analysis_cache WHERE cache_key = ?')
      .get(analysis.cacheKey) as unknown as StudyAnalysisRow | undefined
    if (existing) {
      if (
        existing.fen !== analysis.fen ||
        existing.engine_sha256 !== analysis.engine.sha256 ||
        existing.settings_json !== settingsJson
      ) {
        throw new Error('Study analysis cache key collision')
      }
    } else {
      this.database.prepare(`
        INSERT INTO study_analysis_cache (
          cache_key, fen, engine_name, engine_sha256, settings_json, best_move, lines_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        analysis.cacheKey,
        analysis.fen,
        analysis.engine.name,
        analysis.engine.sha256,
        settingsJson,
        analysis.bestMove,
        JSON.stringify(analysis.lines),
        analysis.createdAt,
      )
    }
    this.attachStudyAnalysis(nodeId, analysis.cacheKey)
    return this.getCachedStudyAnalysis(analysis.cacheKey)!
  }

  attachStudyAnalysis(nodeId: string, cacheKey: string): void {
    if (!this.getStudyNode(nodeId)) throw new Error('Study node does not exist')
    if (!this.getCachedStudyAnalysis(cacheKey)) throw new Error('Study analysis cache entry does not exist')
    this.database.prepare(`
      INSERT OR IGNORE INTO study_node_analysis (node_id, cache_key) VALUES (?, ?)
    `).run(nodeId, cacheKey)
  }

  getCachedStudyAnalysis(cacheKey: string): StudyAnalysis | null {
    const row = this.database.prepare('SELECT * FROM study_analysis_cache WHERE cache_key = ?')
      .get(cacheKey) as unknown as StudyAnalysisRow | undefined
    return row ? this.hydrateStudyAnalysis(row) : null
  }

  getStudyAnalyses(gameId: string): StudyAnalysis[] {
    const rows = this.database.prepare(`
      SELECT c.*, r.node_id
      FROM study_node_analysis r
      JOIN position_nodes n ON n.id = r.node_id
      JOIN study_analysis_cache c ON c.cache_key = r.cache_key
      WHERE n.game_id = ?
      ORDER BY c.created_at ASC, r.node_id ASC
    `).all(gameId) as unknown as StudyAnalysisRow[]
    return rows.map((row) => this.hydrateStudyAnalysis(row))
  }

  replaceStudyMarks(gameId: string, marks: StudyMark[]): void {
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM study_marks WHERE node_id IN (SELECT id FROM position_nodes WHERE game_id = ?)
      `).run(gameId)
      const insert = this.database.prepare(`
        INSERT INTO study_marks (
          node_id, kind, mover, actual_move, best_move, loss_cp, mate_swing, explanation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const mark of marks) {
        const node = this.getStudyNode(mark.nodeId)
        if (!node || node.gameId !== gameId) throw new Error('Study mark node does not belong to game')
        insert.run(
          mark.nodeId,
          mark.kind,
          mark.mover,
          mark.actualMove,
          mark.bestMove,
          mark.lossCp,
          mark.mateSwing ? 1 : 0,
          mark.explanation,
          mark.createdAt,
        )
      }
    })
  }

  getStudyMarks(gameId: string): StudyMark[] {
    const rows = this.database.prepare(`
      SELECT m.* FROM study_marks m
      JOIN position_nodes n ON n.id = m.node_id
      WHERE n.game_id = ? ORDER BY n.live_position_version ASC, n.ply ASC
    `).all(gameId) as unknown as StudyMarkRow[]
    return rows.map((row) => ({
      nodeId: row.node_id,
      kind: row.kind,
      mover: row.mover,
      actualMove: row.actual_move,
      bestMove: row.best_move,
      lossCp: row.loss_cp,
      mateSwing: row.mate_swing === 1,
      explanation: row.explanation,
      createdAt: row.created_at,
    }))
  }

  saveReviewJob(job: ReviewJob): ReviewJob {
    const updatedAt = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO review_jobs (
        game_id, status, depth, multi_pv, next_index, total_nodes, completed_nodes,
        node_ids_json, engine_sha256, message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET
        status = excluded.status,
        depth = excluded.depth,
        multi_pv = excluded.multi_pv,
        next_index = excluded.next_index,
        total_nodes = excluded.total_nodes,
        completed_nodes = excluded.completed_nodes,
        node_ids_json = excluded.node_ids_json,
        engine_sha256 = excluded.engine_sha256,
        message = excluded.message,
        updated_at = excluded.updated_at
    `).run(
      job.gameId,
      job.status,
      job.depth,
      job.multiPv,
      job.nextIndex,
      job.totalNodes,
      job.completedNodes,
      JSON.stringify(job.nodeIds),
      job.engineSha256,
      job.message,
      updatedAt,
    )
    return this.getReviewJob(job.gameId)!
  }

  updateReviewJob(gameId: string, changes: Partial<Omit<ReviewJob, 'gameId'>>): ReviewJob {
    const current = this.getReviewJob(gameId)
    if (!current) throw new Error('Review job does not exist')
    return this.saveReviewJob({ ...current, ...changes, gameId })
  }

  getReviewJob(gameId: string): ReviewJob | null {
    const row = this.database.prepare('SELECT * FROM review_jobs WHERE game_id = ?').get(gameId) as unknown as ReviewJobRow | undefined
    if (!row) return null
    return {
      gameId: row.game_id,
      status: row.status,
      depth: row.depth,
      multiPv: row.multi_pv,
      nextIndex: row.next_index,
      totalNodes: row.total_nodes,
      completedNodes: row.completed_nodes,
      nodeIds: JSON.parse(row.node_ids_json) as string[],
      engineSha256: row.engine_sha256,
      message: row.message,
      updatedAt: row.updated_at,
    }
  }

  close(): void {
    this.database.close()
  }

  private insertGameRow(
    id: string,
    fen: string,
    orientation: Orientation,
    settings: RealtimeSettings,
    provenance: GameProvenance,
    status: SessionStatus,
    now: string,
  ): void {
    this.database.prepare(`
      INSERT INTO games (
        id, orientation, baseline_fen, baseline_version, current_fen, current_version,
        status, multi_pv, analysis_depth, profile_id, profile_version, model_version, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      orientation,
      fen,
      fen,
      status,
      settings.multiPv,
      settings.depth,
      provenance.profileId,
      provenance.profileVersion,
      provenance.modelVersion,
      now,
      now,
    )
  }

  private insertStudyNode(input: {
    gameId: string
    parentId: string | null
    source: StudyNodeSource
    move: string | null
    fen: string
    ply: number
    livePositionVersion: number | null
    createdAt?: string
  }): StudyNode {
    const node: StudyNode = {
      id: randomUUID(),
      gameId: input.gameId,
      parentId: input.parentId,
      source: input.source,
      move: input.move,
      fen: input.fen,
      ply: input.ply,
      livePositionVersion: input.livePositionVersion,
      createdAt: input.createdAt ?? new Date().toISOString(),
    }
    this.database.prepare(`
      INSERT INTO position_nodes (
        id, game_id, parent_id, source, move, fen, ply, live_position_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id,
      node.gameId,
      node.parentId,
      node.source,
      node.move,
      node.fen,
      node.ply,
      node.livePositionVersion,
      node.createdAt,
    )
    return node
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

  private gameSummary(row: GameRow): StudyGameSummary {
    return {
      id: row.id,
      orientation: row.orientation,
      currentFen: row.current_fen,
      currentVersion: row.current_version,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private hydrateStudyNode(row: StudyNodeRow): StudyNode {
    return {
      id: row.id,
      gameId: row.game_id,
      parentId: row.parent_id,
      source: row.source,
      move: row.move,
      fen: row.fen,
      ply: row.ply,
      livePositionVersion: row.live_position_version,
      createdAt: row.created_at,
    }
  }

  private hydrateStudyAnalysis(row: StudyAnalysisRow): StudyAnalysis {
    return {
      cacheKey: row.cache_key,
      ...(row.node_id ? { nodeId: row.node_id } : {}),
      fen: row.fen,
      engine: { name: row.engine_name, sha256: row.engine_sha256 },
      settings: JSON.parse(row.settings_json) as RealtimeSettings,
      bestMove: row.best_move,
      lines: JSON.parse(row.lines_json) as AnalysisInfo[],
      createdAt: row.created_at,
    }
  }

  private requireWritable(gameId: string): GameRow {
    const row = this.database.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as unknown as GameRow | undefined
    if (!row || row.status === 'finished') throw new Error('Game session is not writable')
    return row
  }

  private requireLiveStudyNode(gameId: string, positionVersion: number): StudyNode {
    const row = this.database.prepare(`
      SELECT * FROM position_nodes WHERE game_id = ? AND live_position_version = ? LIMIT 1
    `).get(gameId, positionVersion) as unknown as StudyNodeRow | undefined
    if (!row) throw new Error('Live study node does not exist for the current position')
    return this.hydrateStudyNode(row)
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
