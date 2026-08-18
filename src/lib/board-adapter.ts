import type { Config } from 'xiangqiground/config'
import type { Key } from 'xiangqiground/types'
import type { IccsMove } from '../domain/game'
import type { PositionSnapshot } from '../domain/position'

export interface BoardAdapterInput {
  position: PositionSnapshot
  legalMoves: IccsMove[]
  bestMove?: IccsMove | null
  onMove(move: IccsMove): void
}

function destinationsFor(moves: IccsMove[]): Map<Key, Key[]> {
  const destinations = new Map<Key, Key[]>()
  for (const move of moves) {
    const origin = move.slice(0, 2) as Key
    const destination = move.slice(2, 4) as Key
    destinations.set(origin, [...(destinations.get(origin) ?? []), destination])
  }
  return destinations
}

/** Owns every xiangqiground-specific red/white, orientation, move and arrow conversion. */
export function createBoardConfig({ position, legalMoves, bestMove, onMove }: BoardAdapterInput): Config {
  return {
    fen: position.fen.split(' ')[0],
    orientation: position.orientation === 'red-bottom' ? 'white' : 'black',
    turnColor: position.sideToMove === 'red' ? 'white' : 'black',
    coordinates: true,
    lastMove: position.lastMove
      ? [position.lastMove.slice(0, 2) as Key, position.lastMove.slice(2, 4) as Key]
      : [],
    drawable: {
      enabled: false,
      autoShapes: bestMove
        ? [{ orig: bestMove.slice(0, 2) as Key, dest: bestMove.slice(2, 4) as Key, brush: 'blue' }]
        : [],
    },
    movable: {
      color: position.sideToMove === 'red' ? 'white' : 'black',
      dests: destinationsFor(legalMoves),
      events: {
        after: (origin: Key, destination: Key) => onMove(`${origin}${destination}` as IccsMove),
      },
    },
  }
}
