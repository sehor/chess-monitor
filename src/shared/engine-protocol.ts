export interface RawEngineInfo {
  depth: number
  multiPv: number
  score: { cp?: number; mateIn?: number }
  nodes: string | null
  pv: string[]
}

export interface RawBestMove {
  move: string | null
}

function readInteger(line: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}\\s+(-?\\d+)\\b`).exec(line)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

export function parseEngineInfo(line: string): RawEngineInfo | null {
  if (!line.startsWith('info ')) return null

  const depth = readInteger(line, 'depth')
  if (depth === undefined || depth < 0) return null

  const multiPv = readInteger(line, 'multipv') ?? 1
  if (multiPv < 1) return null

  const scoreMatch = /\bscore\s+(cp|mate)\s+(-?\d+)\b/.exec(line)
  if (!scoreMatch) return null

  const scoreValue = Number(scoreMatch[2])
  if (!Number.isSafeInteger(scoreValue)) return null

  const pvMarker = /\bpv\s+(.+)$/.exec(line)
  const pv = pvMarker
    ? pvMarker[1].trim().split(/\s+/).filter((move) => /^[a-i][0-9][a-i][0-9]$/.test(move))
    : []

  return {
    depth,
    multiPv,
    score: scoreMatch[1] === 'cp' ? { cp: scoreValue } : { mateIn: scoreValue },
    nodes: /\bnodes\s+(\d+)\b/.exec(line)?.[1] ?? null,
    pv,
  }
}

export function parseBestMove(line: string): RawBestMove | null {
  const match = /^bestmove\s+(\(none\)|[a-i][0-9][a-i][0-9])(?:\s+ponder\s+[a-i][0-9][a-i][0-9])?\s*$/.exec(line)
  if (!match) return null
  return { move: match[1] === '(none)' ? null : match[1] }
}
