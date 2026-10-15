import type { ClueRecord, OrganizationSnapshot, OrganizationTimelineSuggestion, TimelineRecord } from './vault'

export type SourceRevisionEvent = { id: string; title: string; startsAt: string; quote: string }
export type SourceRevisionState = {
  version: 1; scriptId: string; clueId: string; sourceNo: number; revision: number;
  previousText: string; currentText: string; updatedAt: string; acknowledgedRevision?: number; reviewedAt?: string;
  affectedEvents: SourceRevisionEvent[];
}
export type SourceRevisionReview = SourceRevisionState & { clueTitle: string; pendingCount: number; pendingQuotes: string[] }
const queues = new Map<string, Promise<unknown>>()
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s\u200b\ufeff]+/g, '')

// OCR saves and acknowledgements share a queue so an old confirmation cannot hide a newer edit.
export async function withSourceRevisionLock<T>(clueId: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(clueId) || Promise.resolve()
  const pending = previous.catch(() => undefined).then(action)
  queues.set(clueId, pending)
  try { return await pending }
  finally { if (queues.get(clueId) === pending) queues.delete(clueId) }
}

function eventSource(event: TimelineRecord, clue: ClueRecord): boolean {
  return event.scriptId === clue.scriptId && (event.clueId === clue.id || Boolean(event.evidence?.some(source => source.clueId === clue.id)))
}
function pendingSources(organization: OrganizationSnapshot | null, clue: ClueRecord) {
  if (organization?.scriptId !== clue.scriptId) return []
  return [...organization.people, ...organization.relationships, ...organization.timeline, ...organization.cluePoints].filter(item =>
    item.sourceNo === clue.number || Boolean((item as OrganizationTimelineSuggestion).evidence?.some(source => source.clueId === clue.id)),
  )
}

// Pure preparation: the caller writes the OCR row and this metadata in the same transaction.
export function buildSourceRevisionState(clue: ClueRecord, currentText: string, previous: SourceRevisionState | null, events: TimelineRecord[], _organization: OrganizationSnapshot | null): SourceRevisionState | null {
  if (!clue.ocrText.trim() || normalized(clue.ocrText) === normalized(currentText)) return null
  const validPrevious = previous?.scriptId === clue.scriptId && previous.clueId === clue.id ? previous : null
  const stillPending = Boolean(validPrevious && validPrevious.acknowledgedRevision !== validPrevious.revision)
  const oldEvents = new Map((stillPending ? validPrevious!.affectedEvents : []).map(event => [event.id, event]))
  const affectedEvents = events.filter(event => event.confirmed && eventSource(event, clue)).map(event => ({
    id: event.id, title: event.title, startsAt: event.startsAt,
    quote: oldEvents.get(event.id)?.quote || event.evidence?.filter(source => source.clueId === clue.id).map(source => source.quote).filter(Boolean).join('\n') || '',
  }))
  return {
    version: 1, scriptId: clue.scriptId, clueId: clue.id, sourceNo: clue.number,
    revision: Math.max(clue.sourceRevision || 0, validPrevious?.revision || 0) + 1,
    previousText: stillPending ? validPrevious!.previousText : clue.ocrText,
    currentText, updatedAt: new Date().toISOString(), affectedEvents,
  }
}

export async function getSourceRevisionReviews(scriptId: string): Promise<SourceRevisionReview[]> {
  const vault = await import('./vault')
  const [clues, events, organization] = await Promise.all([vault.listClues(scriptId), vault.listTimelineEvents(scriptId), vault.getOrganization(scriptId)])
  const states = await Promise.all(clues.map(async clue => {
    const state = await vault.getLocalState<SourceRevisionState>(scriptId, `source-revision:${clue.id}`)
    if (!state || state.scriptId !== scriptId || state.clueId !== clue.id || state.acknowledgedRevision === state.revision) return null
    if (state.revision !== clue.sourceRevision || normalized(state.currentText) !== normalized(clue.ocrText)) return null
    const confirmed = new Map(events.filter(event => event.confirmed && eventSource(event, clue)).map(event => [event.id, event]))
    const affectedEvents = state.affectedEvents.filter(event => confirmed.has(event.id)).map(event => ({ ...event, title: confirmed.get(event.id)!.title, startsAt: confirmed.get(event.id)!.startsAt }))
    const pending = pendingSources(organization, clue)
    return { ...state, sourceNo: clue.number, clueTitle: clue.title, affectedEvents, pendingCount: pending.length, pendingQuotes: [...new Set(pending.map(item => item.quote).filter(Boolean))] } satisfies SourceRevisionReview
  }))
  return states.filter((state): state is SourceRevisionReview => state !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function acknowledgeSourceRevision(scriptId: string, clueId: string, revision: number): Promise<void> {
  await withSourceRevisionLock(clueId, async () => {
    const vault = await import('./vault')
    const [clues, state] = await Promise.all([vault.listClues(scriptId), vault.getLocalState<SourceRevisionState>(scriptId, `source-revision:${clueId}`)])
    const clue = clues.find(item => item.id === clueId && item.scriptId === scriptId)
    if (!clue || !state || state.scriptId !== scriptId || state.clueId !== clueId) throw new Error('这条来源不属于当前剧本')
    if (state.revision !== revision || clue.sourceRevision !== revision || normalized(state.currentText) !== normalized(clue.ocrText)) throw new Error('OCR 又有新修改，请重新核对最新版本')
    await vault.applyRecordChanges(scriptId, [], { save: [{ key: `source-revision:${clueId}`, value: { ...state, acknowledgedRevision: revision, reviewedAt: new Date().toISOString() } }] })
  })
}
