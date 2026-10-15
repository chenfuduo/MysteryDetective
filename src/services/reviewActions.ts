import * as vault from './vault'
import type { ClueRecord, OrganizationSnapshot, OrganizationTimelineSuggestion, PersonRecord, RelationshipRecord, TimelineRecord } from './vault'

export type ReviewSelection = { kind: 'people' | 'relationships' | 'timeline' | 'cluePoints'; id: string }
export type ReviewUndo = { scriptId: string; label: string; run: () => Promise<void> }
type Change = vault.VaultRecordChange
type PersistedUndo = { version: 1; id: string; scriptId: string; label: string; createdAt: string; before: OrganizationSnapshot | null; after: OrganizationSnapshot | null; changes: Change[] }
type PersistedHistory = { version: 2; scriptId: string; undo: PersistedUndo[]; redo: PersistedUndo[] }
export type OperationHistoryEntry = { id: string; label: string; createdAt: string }
export type OperationHistoryState = { undo: OperationHistoryEntry[]; redo: OperationHistoryEntry[] }
const legacyUndoKey = 'review:last-undo'
const historyKey = 'review:operation-history'
const historyLimit = 20
const historyQueues = new Map<string, Promise<unknown>>()
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const normalized = (value: string) => value.trim().replace(/\s+/g, '').toLocaleLowerCase()

function inHistoryQueue<T>(scriptId: string, action: () => Promise<T>): Promise<T> {
  const previous = historyQueues.get(scriptId) || Promise.resolve()
  const current = previous.catch(() => undefined).then(action)
  historyQueues.set(scriptId, current)
  void current.finally(() => { if (historyQueues.get(scriptId) === current) historyQueues.delete(scriptId) }).catch(() => undefined)
  return current
}

async function readHistory(scriptId: string, persistMigration = true): Promise<PersistedHistory> {
  const history = await vault.getLocalState<PersistedHistory>(scriptId, historyKey)
  if (history?.version === 2 && history.scriptId === scriptId) return history
  const legacy = await vault.getLocalState<PersistedUndo>(scriptId, legacyUndoKey)
  const migrated: PersistedHistory = { version: 2, scriptId, undo: legacy?.version === 1 && legacy.scriptId === scriptId ? [{ ...legacy, createdAt: legacy.createdAt || '' }] : [], redo: [] }
  if (persistMigration) await vault.applyRecordChanges(scriptId, [], { save: [{ key: historyKey, value: migrated }], remove: [legacyUndoKey] })
  return migrated
}

function appendHistory(history: PersistedHistory, entry: PersistedUndo): PersistedHistory {
  return { ...history, undo: [...history.undo, entry].slice(-historyLimit), redo: [] }
}
function entryChanges(entry: PersistedUndo): Change[] {
  const changes = copy(entry.changes)
  if (!same(entry.before, entry.after) && !changes.some(change => change.kind === 'organization')) changes.push({ kind: 'organization', id: (entry.after || entry.before)!.id, before: entry.before, after: entry.after })
  return changes
}

async function protectAssociations(scriptId: string, changes: Change[]): Promise<void> {
  const [people, clues, relationships, events, notes, board] = await Promise.all([
    vault.listPeople(scriptId), vault.listClues(scriptId), vault.listRelationships(scriptId), vault.listTimelineEvents(scriptId), vault.listNotes(scriptId), vault.listBoardItems(scriptId),
  ])
  const changed = new Map(changes.map(change => [`${change.kind}:${change.id}`, change]))
  const finalValue = <T extends { id: string }>(kind: Change['kind'], item: T): T | null => {
    const change = changed.get(`${kind}:${item.id}`)
    return change ? change.after as T | null : item
  }
  const idsAfter = (kind: Change['kind'], values: { id: string }[]) => {
    const ids = new Set(values.map(item => item.id))
    for (const change of changes.filter(change => change.kind === kind)) { if (change.after) ids.add(change.id); else ids.delete(change.id) }
    return ids
  }
  const personIds = idsAfter('people', people), clueIds = idsAfter('clues', clues), noteIds = idsAfter('notes', notes)
  const removedPeople = new Set(changes.filter(change => change.kind === 'people' && !change.after).map(change => change.id))
  const removedClues = new Set(changes.filter(change => change.kind === 'clues' && !change.after).map(change => change.id))
  const removedNotes = new Set(changes.filter(change => change.kind === 'notes' && !change.after).map(change => change.id))
  const liveRelationships = relationships.flatMap(item => { const value = finalValue('relationships', item); return value ? [value] : [] })
  const liveEvents = events.flatMap(item => { const value = finalValue('timeline', item); return value ? [value] : [] })
  const liveNotes = notes.flatMap(item => { const value = finalValue('notes', item); return value ? [value] : [] })
  const liveBoard = board.flatMap(item => { const value = finalValue('board_items', item); return value ? [value] : [] })
  if (liveRelationships.some(item => removedPeople.has(item.fromId) || removedPeople.has(item.toId)) || liveEvents.some(item => item.personIds.some(id => removedPeople.has(id))) || liveNotes.some(item => removedPeople.has(item.personId)) || liveBoard.some(item => item.kind === 'person' && removedPeople.has(item.refId))) throw new Error('人物已有新的关联，请先保留当前内容后再撤销或重做')
  if (liveEvents.some(item => removedClues.has(item.clueId) || item.evidence?.some(source => removedClues.has(source.clueId))) || liveNotes.some(item => removedClues.has(item.clueId)) || liveBoard.some(item => item.kind === 'clue' && removedClues.has(item.refId))) throw new Error('线索已有新的关联，请先保留当前内容后再撤销或重做')
  if (liveBoard.some(item => item.kind === 'note' && removedNotes.has(item.refId))) throw new Error('笔记已有新的关联，请先保留当前内容后再撤销或重做')
  for (const change of changes) {
    if (!change.after) continue
    if (change.kind === 'relationships') {
      const item = change.after as RelationshipRecord
      if (!personIds.has(item.fromId) || !personIds.has(item.toId)) throw new Error('关系对应的人物已不存在，请先恢复人物')
    } else if (change.kind === 'timeline') {
      const item = change.after as TimelineRecord
      if (item.personIds.some(id => !personIds.has(id)) || item.clueId && !clueIds.has(item.clueId) || item.evidence?.some(source => source.clueId && !clueIds.has(source.clueId))) throw new Error('事件对应的人物或原始线索已不存在，请先恢复关联资料')
    } else if (change.kind === 'notes') {
      const item = change.after as vault.NoteRecord
      if (item.personId && !personIds.has(item.personId) || item.clueId && !clueIds.has(item.clueId)) throw new Error('笔记关联资料已不存在，请先恢复关联资料')
    } else if (change.kind === 'board_items') {
      const item = change.after as vault.BoardItemRecord
      if (item.kind === 'person' && !personIds.has(item.refId) || item.kind === 'clue' && !clueIds.has(item.refId) || item.kind === 'note' && item.refId && !noteIds.has(item.refId)) throw new Error('整理板卡片的原始资料已不存在，请先恢复关联资料')
    }
  }
}

function actionFromState(entry: PersistedUndo, direction: 'undo' | 'redo'): ReviewUndo {
  return { scriptId: entry.scriptId, label: entry.label, run: () => inHistoryQueue(entry.scriptId, async () => {
    const history = await readHistory(entry.scriptId)
    if (history[direction].at(-1)?.id !== entry.id) throw new Error('操作历史已有变化，请重新选择最近的一步')
    const changes = direction === 'undo' ? entryChanges(entry).reverse().map(change => ({ ...change, before: change.after, after: change.before })) : entryChanges(entry)
    await protectAssociations(entry.scriptId, changes)
    const next = copy(history)
    next[direction].pop()
    next[direction === 'undo' ? 'redo' : 'undo'].push(entry)
    await vault.applyRecordChanges(entry.scriptId, changes, { save: [{ key: historyKey, value: next }] })
  }) }
}

async function makeUndo(scriptId: string, label: string, before: OrganizationSnapshot | null, after: OrganizationSnapshot | null, changes: Change[]): Promise<ReviewUndo> {
  return inHistoryQueue(scriptId, async () => {
    const entry: PersistedUndo = copy({ version: 1, id: crypto.randomUUID(), scriptId, label, createdAt: new Date().toISOString(), before, after, changes })
    const history = appendHistory(await readHistory(scriptId), entry)
    await vault.applyRecordChanges(scriptId, [], { save: [{ key: historyKey, value: history }] })
    return actionFromState(entry, 'undo')
  })
}
export async function loadLastUndo(scriptId: string): Promise<ReviewUndo | null> {
  return inHistoryQueue(scriptId, async () => { const entry = (await readHistory(scriptId)).undo.at(-1); return entry ? actionFromState(entry, 'undo') : null })
}
export async function loadLastRedo(scriptId: string): Promise<ReviewUndo | null> {
  return inHistoryQueue(scriptId, async () => { const entry = (await readHistory(scriptId)).redo.at(-1); return entry ? actionFromState(entry, 'redo') : null })
}
export async function getOperationHistory(scriptId: string): Promise<OperationHistoryState> {
  return inHistoryQueue(scriptId, async () => {
    const history = await readHistory(scriptId)
    const describe = (entry: PersistedUndo): OperationHistoryEntry => ({ id: entry.id, label: entry.label, createdAt: entry.createdAt })
    return { undo: [...history.undo].reverse().map(describe), redo: [...history.redo].reverse().map(describe) }
  })
}
export async function applyUndoableChanges(scriptId: string, label: string, changes: Change[]): Promise<ReviewUndo> {
  return inHistoryQueue(scriptId, async () => {
    const organization = await vault.getOrganization(scriptId)
    const entry: PersistedUndo = copy({ version: 1, id: crypto.randomUUID(), scriptId, label, createdAt: new Date().toISOString(), before: organization, after: organization, changes })
    const history = appendHistory(await readHistory(scriptId), entry)
    await vault.applyRecordChanges(scriptId, changes, { save: [{ key: historyKey, value: history }] })
    return actionFromState(entry, 'undo')
  })
}

export function timelineEvidence(item: OrganizationTimelineSuggestion, clues: ClueRecord[]) {
  const sources = item.evidence?.length ? item.evidence : [{ clueId: '', sourceNo: item.sourceNo, quote: item.quote }]
  return sources.flatMap(source => {
    const clue = clues.find(clue => clue.number === source.sourceNo && (!source.clueId || clue.id === source.clueId))
    return clue && source.quote && clue.ocrText.includes(source.quote) ? [{ clueId: clue.id, sourceNo: clue.number, quote: source.quote }] : []
  })
}

export async function reviewSuggestions(scriptId: string, selection: ReviewSelection[], mode: 'accept' | 'ignore'): Promise<{ applied: number; skipped: number; undo: ReviewUndo | null; warning?: string }> {
  return inHistoryQueue(scriptId, async () => {
    const [before, people, relationships, events, clues] = await Promise.all([
      vault.getOrganization(scriptId), vault.listPeople(scriptId), vault.listRelationships(scriptId), vault.listTimelineEvents(scriptId), vault.listClues(scriptId),
    ])
    if (!before) return { applied: 0, skipped: selection.length, undo: null }
    const after = copy(before)
    const changes: Change[] = []
    const resolvedKeys = new Set(after.resolvedKeys || [])
    const remember = (kind: Change['kind'], old: unknown, value: { id: string }) => {
      const existing = changes.find(change => change.kind === kind && change.id === value.id)
      if (existing) existing.after = copy(value)
      else changes.push({ kind, id: value.id, before: copy(old), after: copy(value) })
    }
    const findPerson = (name: string, aliases: string[] = []): PersonRecord => {
      const found = people.find(person => normalized(person.name) === normalized(name) || [...person.aliases, ...(person.ocrNames || [])].some(alias => normalized(alias) === normalized(name)))
      if (found) return found
      const created: PersonRecord = { id: crypto.randomUUID(), scriptId, name: name.trim(), aliases, photoPath: '', notes: '' }
      people.push(created); remember('people', null, created)
      return created
    }
    const validSource = (item: { sourceNo: number; quote: string }): boolean => {
      const clue = clues.find(clue => clue.number === item.sourceNo)
      return Boolean(clue && item.quote.trim() && clue.ocrText.includes(item.quote))
    }
    const eventIdentity = (event: Pick<TimelineRecord, 'title' | 'startsAt' | 'timeOfDay' | 'personIds'>): string => JSON.stringify([vault.organizationTextKey(event.title), event.startsAt, event.timeOfDay || '', [...new Set(event.personIds)].sort()])
    const mergeEvidence = (previous: TimelineRecord, incoming: TimelineRecord): TimelineRecord => {
      const evidence = new Map<string, vault.OrganizationEvidence>()
      for (const source of [...(previous.evidence || []), ...(incoming.evidence || [])]) {
        const clue = clues.find(clue => clue.id === source.clueId)
        if (clue) evidence.set(JSON.stringify([clue.id, source.quote]), { ...source, clueId: clue.id, sourceNo: clue.number })
      }
      for (const clueId of [previous.clueId, incoming.clueId]) {
        const clue = clues.find(clue => clue.id === clueId)
        if (clue && ![...evidence.values()].some(source => source.clueId === clue.id)) evidence.set(JSON.stringify([clue.id, '']), { clueId: clue.id, sourceNo: clue.number, quote: '' })
      }
      return { ...previous, timeOfDay: previous.timeOfDay || incoming.timeOfDay, evidence: [...evidence.values()], clueId: previous.clueId || evidence.values().next().value?.clueId || '' }
    }
    let applied = 0, skipped = 0
    for (const entry of selection.filter((entry, index, entries) => entries.findIndex(other => other.kind === entry.kind && other.id === entry.id) === index)) {
      const suggestion = before[entry.kind].find(item => item.id === entry.id)
      if (!suggestion) { skipped++; continue }
      if (mode === 'accept') {
        if (entry.kind === 'people') {
          const item = before.people.find(item => item.id === entry.id)!
          if (!validSource(item)) { skipped++; continue }
          findPerson(item.name, item.aliases)
        } else if (entry.kind === 'relationships') {
          const item = before.relationships.find(item => item.id === entry.id)!
          if (!validSource(item)) { skipped++; continue }
          const from = findPerson(item.from), to = findPerson(item.to)
          if (!relationships.some(relation => normalized(relation.label) === normalized(item.label) && ((relation.fromId === from.id && relation.toId === to.id) || (relation.toId === from.id && relation.fromId === to.id)))) {
            const created: RelationshipRecord = { id: crypto.randomUUID(), scriptId, fromId: from.id, toId: to.id, label: item.label }
            relationships.push(created); remember('relationships', null, created)
          }
        } else if (entry.kind === 'timeline') {
          const item = before.timeline.find(item => item.id === entry.id)!
          if (item.requiresTitle || !item.title.trim() || item.title === '待补充事件') { skipped++; continue }
          const evidence = timelineEvidence(item, clues)
          if (!evidence.length) { skipped++; continue }
          const created: TimelineRecord = { id: crypto.randomUUID(), scriptId, title: item.title, startsAt: item.startsAt, timeOfDay: item.timeOfDay, personIds: item.people.map(name => findPerson(name).id), clueId: evidence[0]!.clueId, evidence, precision: item.precision, approximate: item.approximate, confirmed: true, yearlessMarkerIgnored: false }
          const previous = !/待确认|待补充/.test(created.title) ? events.find(event => event.confirmed === created.confirmed && eventIdentity(event) === eventIdentity(created)) : undefined
          const next = previous ? mergeEvidence(previous, created) : created
          if (!same(previous || null, next)) remember('timeline', previous || null, next)
          if (previous) events[events.indexOf(previous)] = next
          else events.push(next)
        } else {
          const item = before.cluePoints.find(item => item.id === entry.id)!
          const clue = clues.find(clue => clue.number === item.sourceNo)
          if (!clue || !validSource(item)) { skipped++; continue }
          const updated: ClueRecord = { ...clue, title: item.title, category: item.category || clue.category, tags: [...new Set([...clue.tags, ...item.tags])] }
          remember('clues', clue, updated)
          clues[clues.indexOf(clue)] = updated
        }
      }
      resolvedKeys.add(vault.suggestionKey(entry.kind, suggestion))
      if (entry.kind === 'timeline') for (const source of (suggestion as OrganizationTimelineSuggestion).evidence || []) resolvedKeys.add(vault.suggestionKey(entry.kind, { ...suggestion, sourceNo: source.sourceNo, quote: source.quote }))
      if (entry.kind === 'people') after.people = after.people.filter(item => item.id !== entry.id)
      else if (entry.kind === 'relationships') after.relationships = after.relationships.filter(item => item.id !== entry.id)
      else if (entry.kind === 'timeline') after.timeline = after.timeline.filter(item => item.id !== entry.id)
      else after.cluePoints = after.cluePoints.filter(item => item.id !== entry.id)
      applied++
    }
    if (!applied) return { applied, skipped, undo: null }
    after.resolvedKeys = [...resolvedKeys]
    after.updatedAt = new Date().toISOString()
    remember('organization', before, after)
    const label = `${mode === 'ignore' ? '忽略' : '录入'}整理建议（${applied} 条）`
    const entry: PersistedUndo = copy({ version: 1, id: crypto.randomUUID(), scriptId, label, createdAt: new Date().toISOString(), before, after, changes })
    const history = appendHistory(await readHistory(scriptId, false), entry)
    await vault.applyRecordChanges(scriptId, changes, { save: [{ key: historyKey, value: history }], remove: [legacyUndoKey] })
    return { applied, skipped, undo: actionFromState(entry, 'undo') }
  })
}

export async function recordUndo(scriptId: string, label: string, kind: Change['kind'], before: { id: string } | null, after: { id: string } | null, organizationBefore?: OrganizationSnapshot | null): Promise<ReviewUndo> {
  const organization = await vault.getOrganization(scriptId)
  return makeUndo(scriptId, label, organizationBefore === undefined ? organization : organizationBefore, organization, [{ kind, id: (after || before)!.id, before: copy(before), after: copy(after) }])
}

export const persistRecordUndo = recordUndo

export async function mergeConfirmedEvents(scriptId: string, sourceId: string, targetId: string): Promise<ReviewUndo> {
  const [events, clues] = await Promise.all([vault.listTimelineEvents(scriptId), vault.listClues(scriptId)])
  const source = events.find(event => event.id === sourceId && event.confirmed)
  const target = events.find(event => event.id === targetId && event.confirmed)
  if (!source || !target || source.id === target.id || source.startsAt !== target.startsAt) throw new Error('请选择同一时间的另一条事件，时间不同的记录会分别保留')
  const evidenceFor = (event: TimelineRecord) => {
    const evidence = event.evidence?.filter(item => clues.some(clue => clue.id === item.clueId && clue.number === item.sourceNo && item.quote && clue.ocrText.includes(item.quote))) || []
    const clue = clues.find(clue => clue.id === event.clueId)
    if (clue && !evidence.some(item => item.clueId === clue.id) && clue.ocrText.trim()) evidence.push({ clueId: clue.id, sourceNo: clue.number, quote: clue.ocrText.slice(0, 600) })
    return evidence
  }
  const evidence = [...evidenceFor(target), ...evidenceFor(source)].filter((item, index, entries) => entries.findIndex(other => other.clueId === item.clueId && other.quote === item.quote) === index)
  const updated: TimelineRecord = { ...target, evidence, personIds: [...new Set([...target.personIds, ...source.personIds])], approximate: Boolean(target.approximate || source.approximate), clueId: target.clueId || source.clueId }
  return applyUndoableChanges(scriptId, '合并时间事件', [
    { kind: 'timeline', id: target.id, before: target, after: updated },
    { kind: 'timeline', id: source.id, before: source, after: null },
  ])
}
