import * as vault from './vault'
import type { ClueRecord, OrganizationSnapshot, OrganizationTimelineSuggestion, PersonRecord, RelationshipRecord, TimelineRecord } from './vault'

export type ReviewSelection = { kind: 'people' | 'relationships' | 'timeline' | 'cluePoints'; id: string }
export type ReviewUndo = { scriptId: string; label: string; run: () => Promise<void> }
type Change = { kind: 'people' | 'relationships' | 'timeline' | 'clues'; before: unknown; after: unknown; id: string }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const normalized = (value: string) => value.trim().replace(/\s+/g, '').toLocaleLowerCase()

export function timelineEvidence(item: OrganizationTimelineSuggestion, clues: ClueRecord[]) {
  const sources = item.evidence?.length ? item.evidence : [{ clueId: '', sourceNo: item.sourceNo, quote: item.quote }]
  return sources.flatMap(source => {
    const clue = clues.find(clue => clue.number === source.sourceNo && (!source.clueId || clue.id === source.clueId))
    return clue && source.quote && clue.ocrText.includes(source.quote) ? [{ clueId: clue.id, sourceNo: clue.number, quote: source.quote }] : []
  })
}

async function makeUndo(scriptId: string, label: string, before: OrganizationSnapshot | null, after: OrganizationSnapshot | null, changes: Change[]): Promise<ReviewUndo> {
  const originals = copy(changes)
  const expected = copy(after)
  const previous = copy(before)
  return { scriptId, label, run: async () => {
    const [people, relationships, events, clues, organization, notes, board] = await Promise.all([
      vault.listPeople(scriptId), vault.listRelationships(scriptId), vault.listTimelineEvents(scriptId), vault.listClues(scriptId), vault.getOrganization(scriptId), vault.listNotes(scriptId), vault.listBoardItems(scriptId),
    ])
    if (!same(organization, expected)) throw new Error('整理内容已有新变化，无法撤销这次操作')
    const records = { people, relationships, timeline: events, clues }
    for (const change of originals) {
      const current = records[change.kind].find(item => item.id === change.id) || null
      if (!same(current, change.after)) throw new Error('相关内容已被修改，无法撤销这次操作')
    }
    const touched = new Set(originals.map(change => change.id))
    for (const change of originals.filter(change => change.kind === 'people' && !change.before)) {
      if (relationships.some(item => !touched.has(item.id) && (item.fromId === change.id || item.toId === change.id)) || events.some(item => !touched.has(item.id) && item.personIds.includes(change.id)) || notes.some(item => item.personId === change.id) || board.some(item => item.kind === 'person' && item.refId === change.id)) throw new Error('这个人物已有新的关联，请先保留当前内容')
    }
    for (const change of [...originals].reverse()) {
      if (change.kind === 'people') {
        if (change.before) await vault.restorePerson(change.before as PersonRecord)
        else await vault.deletePerson(change.id)
      } else if (change.kind === 'relationships') {
        if (change.before) await vault.restoreRelationship(change.before as RelationshipRecord)
        else await vault.deleteRelationship(change.id)
      } else if (change.kind === 'timeline') {
        if (change.before) await vault.restoreTimelineEvent(change.before as TimelineRecord)
        else await vault.deleteTimelineEvent(change.id)
      } else if (change.before) {
        const clue = change.before as ClueRecord
        await vault.updateClue(clue.id, { title: clue.title, category: clue.category, tags: clue.tags })
      }
    }
    if (previous) await vault.saveOrganization(scriptId, previous)
  } }
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
    const found = people.find(person => normalized(person.name) === normalized(name) || person.aliases.some(alias => normalized(alias) === normalized(name)))
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
  return { applied, skipped, warning, undo: applied || changes.length ? await makeUndo(scriptId, mode === 'ignore' ? '忽略整理建议' : '录入整理建议', before, after, changes) : null }
}

export async function recordUndo(scriptId: string, label: string, kind: Change['kind'], before: { id: string } | null, after: { id: string } | null, organizationBefore?: OrganizationSnapshot | null): Promise<ReviewUndo> {
  const organization = await vault.getOrganization(scriptId)
  return makeUndo(scriptId, label, organizationBefore === undefined ? organization : organizationBefore, organization, [{ kind, id: (after || before)!.id, before: copy(before), after: copy(after) }])
}

export async function mergeConfirmedEvents(scriptId: string, sourceId: string, targetId: string): Promise<ReviewUndo> {
  const [events, clues, organization] = await Promise.all([vault.listTimelineEvents(scriptId), vault.listClues(scriptId), vault.getOrganization(scriptId)])
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
  const updated = await vault.updateTimelineEvent(target.id, { evidence, personIds: [...new Set([...target.personIds, ...source.personIds])], approximate: Boolean(target.approximate || source.approximate), clueId: target.clueId || source.clueId })
  try { await vault.deleteTimelineEvent(source.id) }
  catch (error) { await vault.restoreTimelineEvent(target); throw error }
  return makeUndo(scriptId, '合并时间事件', organization, organization, [
    { kind: 'timeline', id: target.id, before: target, after: updated },
    { kind: 'timeline', id: source.id, before: source, after: null },
  ])
}
