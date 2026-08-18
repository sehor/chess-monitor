export interface NamedCaptureSource {
  id: string
  name: string
  kind?: 'window' | 'screen'
}

/** Recovers a restarted window only when its previous name has one unambiguous match. */
export function resolveSelectedSourceId(
  sources: NamedCaptureSource[],
  selectedSourceId: string | undefined,
  selectedSourceName: string | undefined,
  selectedSourceKind?: 'window' | 'screen',
): string | undefined {
  if (selectedSourceId && sources.some((source) => source.id === selectedSourceId)) return selectedSourceId
  if (!selectedSourceName) return undefined
  const replacements = sources.filter((source) =>
    source.name === selectedSourceName &&
    (selectedSourceKind === undefined || source.kind === undefined || source.kind === selectedSourceKind),
  )
  return replacements.length === 1 ? replacements[0].id : undefined
}
