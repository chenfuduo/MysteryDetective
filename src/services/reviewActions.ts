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

async function readHistory(scriptId: string): Promise<PersistedHistory> {
  const history = await vault.getLocalState<PersistedHistory>(scriptId, historyKey)
  if (history?.version === 2 && history.scriptId === scriptId) return history
  const legacy = await vault.getLocalState<PersistedUndo>(scriptId, legacyUndoKey)
  const migrated: PersistedHistory = { version: 2, scriptId, undo: legacy?.version === 1 && legacy.scriptId === scriptId ? [{ ...legacy, createdAt: legacy.createdAt || '' }] : [], redo: [] }
  await vault.applyRecordChanges(scriptId, [], { save: [{ key: historyKey, value: migrated }], remove: [legacyUndoKey] })
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
  const [before, people, relationships, events, clues] = await Promise.all([
    vault.getOrganization(scriptId), vault.listPeople(scriptId), vault.listRelationships(scriptId), vault.listTimelineEvents(scriptId), vault.listClues(scriptId),
  ])
  if (!before) return { applied: 0, skipped: selection.length, undo: null }
  const changes: Change[] = []
  const resolved: ReviewSelection[] = []
  const remember = (kind: Change['kind'], old: unknown, value: { id: string }) => {
    const existing = changes.find(change => change.kind === kind && change.id === value.id)
    if (existing) existing.after = copy(value)
    else changes.push({ kind, id: value.id, before: copy(old), after: copy(value) })
  }
  async function findPerson(name: string, aliases: string[] = []) {
    const found = people.find(person => normalized(person.name) === normalized(name) || [...person.aliases, ...(person.ocrNames || [])].some(alias => normalized(alias) === normalized(name)))
    if (found) return found
    const created = await vault.createPerson(scriptId, { name, aliases })
    people.push(created); remember('people', null, created)
    return created
  }
  let applied = 0, skipped = 0
  let warning = ''
  try {
    for (const entry of selection.filter((entry, index, entries) => entries.findIndex(other => other.kind === entry.kind && other.id === entry.id) === index)) {
      if (mode === 'ignore') {
        if (before[entry.kind].some(item => item.id === entry.id)) { resolved.push(entry); applied++ }
        continue
      }
      if (entry.kind === 'people') {
        const item = before.people.find(item => item.id === entry.id)
        if (!item) continue
        await findPerson(item.name, item.aliases)
      } else if (entry.kind === 'relationships') {
        const item = before.relationships.find(item => item.id === entry.id)
        if (!item) continue
        const from = await findPerson(item.from), to = await findPerson(item.to)
        if (!relationships.some(relation => normalized(relation.label) === normalized(item.label) && ((relation.fromId === from.id && relation.toId === to.id) || (relation.toId === from.id && relation.fromId === to.id)))) {
          const created = await vault.createRelationship(scriptId, { fromId: from.id, toId: to.id, label: item.label })
          relationships.push(created); remember('relationships', null, created)
        }
      } else if (entry.kind === 'timeline') {
        const item = before.timeline.find(item => item.id === entry.id)
        if (!item) continue
        if (item.requiresTitle || !item.title.trim() || item.title === '待补充事件') { skipped++; continue }
        const evidence = timelineEvidence(item, clues)
        if (!evidence.length) { skipped++; continue }
        const participants = []
        for (const name of item.people) participants.push(await findPerson(name))
        const created = await vault.createTimelineEvent(scriptId, { title: item.title, startsAt: item.startsAt, personIds: participants.map(person => person.id), clueId: evidence[0]!.clueId, evidence, precision: item.precision, approximate: item.approximate, confirmed: true })
        const previous = events.find(event => event.id === created.id) || null
        if (!same(previous, created)) remember('timeline', previous, created)
        if (previous) events[events.indexOf(previous)] = created
        else events.push(created)
      } else {
        const item = before.cluePoints.find(item => item.id === entry.id)
        const clue = item && clues.find(clue => clue.number === item.sourceNo)
        if (!item || !clue) { skipped++; continue }
        const updated = await vault.updateClue(clue.id, { title: item.title, category: item.category || clue.category, tags: [...new Set([...clue.tags, ...item.tags])] })
        remember('clues', clue, updated)
        clues[clues.indexOf(clue)] = updated
      }
      resolved.push(entry); applied++
    }
  } catch (error) {
    if (!applied && !changes.length) throw error
    warning = error instanceof Error ? error.message : '部分内容未完成，剩余建议已保留'
  } finally {
    for (const entry of resolved) {
      try { await vault.resolveOrganizationSuggestion(scriptId, entry.kind, entry.id) }
      catch (error) { warning = error instanceof Error ? error.message : '部分建议状态未保存'; break }
    }
  }
  const after = await vault.getOrganization(scriptId)
  return { applied, skipped, warning, undo: applied || changes.length ? await makeUndo(scriptId, `${mode === 'ignore' ? '忽略' : '录入'}整理建议（${applied} 条）`, before, after, changes) : null }
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
