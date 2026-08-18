export type Side = 'red' | 'black'
export type Orientation = 'red-bottom' | 'black-bottom'

export interface PositionSnapshot {
  positionVersion: number
  fen: string
  sideToMove: Side
  orientation: Orientation
  lastMove: string | null
  moveHistory: string[]
}

const boardPattern = /^[rnbakcpRNBAKCP1-9]+$/

function sideFromFenToken(token: string | undefined): Side {
  if (token === undefined || token === 'w') return 'red'
  if (token === 'b') return 'black'
  throw new Error('FEN side to move must be "w" or "b"')
}

function validateBoard(board: string): void {
  const ranks = board.split('/')
  if (ranks.length !== 10) throw new Error('A xiangqi FEN must contain 10 ranks')

  for (const rank of ranks) {
    if (!boardPattern.test(rank)) throw new Error('FEN contains an unsupported board character')

    const width = [...rank].reduce(
      (total, character) => total + (/[1-9]/.test(character) ? Number(character) : 1),
      0,
    )
    if (width !== 9) throw new Error('Every xiangqi FEN rank must have exactly 9 files')
  }
}

export function parseFen(fen: string): { board: string; fen: string; sideToMove: Side } {
  const fields = fen.trim().split(/\s+/)
  const [board, sideToken] = fields
  if (!board || ![1, 2, 6].includes(fields.length)) {
    throw new Error('FEN must contain a board, an optional side-to-move field, or six FEN fields')
  }

  validateBoard(board)
  const sideToMove = sideFromFenToken(sideToken)
  const normalizedFen =
    fields.length === 6 ? fields.join(' ') : `${board} ${sideToken ?? 'w'} - - 0 1`

  return { board, fen: normalizedFen, sideToMove }
}

export function createPositionSnapshot(
  fen: string,
  positionVersion = 0,
  orientation: Orientation = 'red-bottom',
): PositionSnapshot {
  if (!Number.isSafeInteger(positionVersion) || positionVersion < 0) {
    throw new Error('Position version must be a non-negative integer')
  }

  const { fen: normalizedFen, sideToMove } = parseFen(fen)
  return {
    positionVersion,
    fen: normalizedFen,
    sideToMove,
    orientation,
    lastMove: null,
    moveHistory: [],
  }
}
