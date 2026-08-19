import { Chess, DEFAULT_POSITION, type Square } from '@west-shell/xiangqi.js'
import {
  createPositionSnapshot,
  type Orientation,
  type PositionSnapshot,
} from './position'

export type IccsMove = `${string}${string}${string}${string}`

export interface GameStatus {
  isCheck: boolean
  isCheckmate: boolean
  isStalemate: boolean
  isDraw: boolean
  isThreefoldRepetition: boolean
  isGameOver: boolean
}

function normalizeMove(move: string): IccsMove {
  const normalized = move.toLowerCase()
  if (!/^[a-i][0-9][a-i][0-9]$/.test(normalized)) {
    throw new Error('Moves must use four-character ICCS coordinates, for example h2e2')
  }
  return normalized as IccsMove
}

/** Isolates the third-party rule engine from the renderer and application state. */
export class RulesAdapter {
  private chess: Chess
  private positionVersion = 0
  private orientation: Orientation
  private lastMove: IccsMove | null = null

  constructor(
    fen = DEFAULT_POSITION,
    orientation: Orientation = 'red-bottom',
    positionVersion = 0,
  ) {
    this.chess = new Chess(fen)
    this.orientation = orientation
    if (!Number.isSafeInteger(positionVersion) || positionVersion < 0) {
      throw new Error('Position version must be a non-negative integer')
    }
    this.positionVersion = positionVersion
  }

  snapshot(): PositionSnapshot {
    const snapshot = createPositionSnapshot(this.chess.fen(), this.positionVersion, this.orientation)
    return {
      ...snapshot,
      lastMove: this.lastMove,
      moveHistory: this.chess.history({ verbose: true }).map((move) => normalizeMove(move.lan)),
    }
  }

  legalMovesFrom(square: string): IccsMove[] {
    if (!/^[a-i][0-9]$/.test(square)) return []
    return this.chess
      .moves({ verbose: true, square: square as Square })
      .map((move) => normalizeMove(move.lan))
  }

  legalMoves(): IccsMove[] {
    return this.chess.moves({ verbose: true }).map((move) => normalizeMove(move.lan))
  }

  status(): GameStatus {
    return {
      isCheck: this.chess.isCheck(),
      isCheckmate: this.chess.isCheckmate(),
      isStalemate: this.chess.isStalemate(),
      isDraw: this.chess.isDraw(),
      isThreefoldRepetition: this.chess.isThreefoldRepetition(),
      isGameOver: this.chess.isGameOver(),
    }
  }

  apply(move: string): PositionSnapshot {
    const normalizedMove = normalizeMove(move)
    this.chess.move({ from: normalizedMove.slice(0, 2), to: normalizedMove.slice(2, 4) }, { strict: true })
    this.lastMove = normalizedMove
    this.positionVersion += 1
    return this.snapshot()
  }

  undo(): PositionSnapshot {
    const undoneMove = this.chess.undo()
    if (!undoneMove) return this.snapshot()

    this.positionVersion += 1
    const history = this.chess.history({ verbose: true })
    this.lastMove = history.length > 0 ? normalizeMove(history.at(-1)!.lan) : null
    return this.snapshot()
  }

  reset(fen = DEFAULT_POSITION): PositionSnapshot {
    this.chess = new Chess(fen)
    this.positionVersion += 1
    this.lastMove = null
    return this.snapshot()
  }

  setOrientation(orientation: Orientation): PositionSnapshot {
    this.orientation = orientation
    return this.snapshot()
  }
}

// Kept as an additive compatibility alias for the existing renderer and tests.
export { RulesAdapter as XiangqiGame }
