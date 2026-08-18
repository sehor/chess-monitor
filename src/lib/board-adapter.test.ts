import { describe, expect, it } from 'vitest'
import { RulesAdapter, type IccsMove } from '../domain/game'
import type { Orientation } from '../domain/position'
import { createBoardConfig } from './board-adapter'

function buildPositions(count: number) {
  const game = new RulesAdapter()
  const positions = [game.snapshot()]
  for (let index = 1; index < count; index += 1) {
    const moves = game.legalMoves()
    if (moves.length === 0) break
    positions.push(game.apply(moves[index % moves.length]))
  }
  return positions
}

const FEN_MAPPING_CASES = buildPositions(25).flatMap((position) =>
  (['red-bottom', 'black-bottom'] as const).map((orientation) => ({
    position: { ...position, orientation },
    orientation,
  })),
)

describe('BoardAdapter', () => {
  it('contains the required 50 FEN and orientation mapping baselines', () => {
    expect(FEN_MAPPING_CASES).toHaveLength(50)
  })

  it.each(FEN_MAPPING_CASES)(
    'maps FEN version $position.positionVersion with $orientation orientation',
    ({ position, orientation }: { position: typeof FEN_MAPPING_CASES[number]['position']; orientation: Orientation }) => {
      const config = createBoardConfig({ position, legalMoves: [], onMove: () => undefined })
      expect(config.fen).toBe(position.fen.split(' ')[0])
      expect(config.orientation).toBe(orientation === 'red-bottom' ? 'white' : 'black')
      expect(config.turnColor).toBe(position.sideToMove === 'red' ? 'white' : 'black')
    },
  )

  it('maps legal destinations and the best-move arrow without exposing xiangqiground to Vue', () => {
    const game = new RulesAdapter()
    let emitted: IccsMove | undefined
    const config = createBoardConfig({
      position: game.snapshot(),
      legalMoves: ['a3a4', 'c3c4'],
      bestMove: 'a3a4',
      onMove: (move) => { emitted = move },
    })

    expect(config.movable?.dests?.get('a3')).toEqual(['a4'])
    expect(config.drawable?.autoShapes).toEqual([{ orig: 'a3', dest: 'a4', brush: 'blue' }])
    config.movable?.events?.after?.('a3', 'a4', { premove: false })
    expect(emitted).toBe('a3a4')
  })
})
