import {
  getLocalState, getOrganization, mergeTimelineEvidence, organizationTextKey, removeLocalState, saveLocalState, saveOrganization, suggestionKey,
  type ClueRecord, type OrganizationEvidence, type OrganizationSnapshot,
  type OrganizationTimelineSuggestion,
  type PersonRecord, type RelationshipRecord, type TimelineRecord,
} from './vault'

import { OrganizationPausedError, organizationRun, type OrganizationCheckpoint, type OrganizationContext, type OrganizationStage } from './organizer'

export type OrganizationProgress = { processed: number; total: number; clue: ClueRecord; stage?: OrganizationStage; message?: string }
export type OrganizationTaskState = {
  clueId: string
  sourceNo: number
  fingerprint: string
  stage: OrganizationStage
  message: string
  updatedAt: string
}

export async function getOrganizationTaskStates(scriptId: string, clues: ClueRecord[]): Promise<OrganizationTaskState[]> {
  const states = await Promise.all(clues.filter(clue => clue.scriptId === scriptId).map(async clue => {
    const state = await getLocalState<OrganizationTaskState>(scriptId, `organization-job:${clue.id}`)
    return state && state.fingerprint === await fingerprint(clue) ? state : null
  }))
  return states.filter((state): state is OrganizationTaskState => state !== null)
}

export type IncrementalOrganizationInput = {
  scriptId: string
  clues: ClueRecord[]
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  events: TimelineRecord[]
  previous: OrganizationSnapshot | null
  onProgress?: (progress: OrganizationProgress) => void
  shouldPause?: () => boolean
}


async function fingerprint(clue: ClueRecord): Promise<string> {
  const value = clue.ocrText
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ value.charCodeAt(index)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

function uniqueEvidence(items: OrganizationEvidence[]): OrganizationEvidence[] {
  const result = new Map<string, OrganizationEvidence>()
  for (const item of items) result.set(JSON.stringify([item.clueId, organizationTextKey(item.quote)]), item)
  return [...result.values()]
}

function sourceEvidence(item: OrganizationTimelineSuggestion, sources: Map<number, ClueRecord>): OrganizationEvidence[] {
  const candidates = item.evidence?.length ? item.evidence : [{ clueId: sources.get(item.sourceNo)?.id || '', sourceNo: item.sourceNo, quote: item.quote }]
  return uniqueEvidence(candidates.flatMap(source => {
    const clue = sources.get(source.sourceNo)
    if (!clue || source.clueId !== clue.id || !source.quote.trim() || !clue.ocrText.includes(source.quote)) return []
    return [{ clueId: clue.id, sourceNo: clue.number, quote: source.quote }]
  }))
}

function snapshotFor(scriptId: string, previous: OrganizationSnapshot | null): OrganizationSnapshot {
  const source = previous?.scriptId === scriptId ? previous : null
  return {
    id: `organization-${scriptId}`, scriptId, updatedAt: new Date().toISOString(),
    people: [...(source?.people || [])], relationships: [...(source?.relationships || [])],
    timeline: [...(source?.timeline || [])], cluePoints: [...(source?.cluePoints || [])],
    processedClues: { ...(source?.processedClues || {}) }, resolvedKeys: [...(source?.resolvedKeys || [])],
    timelineAudit: [...(source?.timelineAudit || [])], analysis: source?.analysis,
  }
}

/** Analyze only changed OCR, checkpoint every clue, and preserve previously reviewed work. */
export async function organizeIncrementally(
  input: IncrementalOrganizationInput,
  analyze: (clues: ClueRecord[], context?: OrganizationContext) => Promise<OrganizationSnapshot>,
): Promise<{ snapshot: OrganizationSnapshot; processed: number; skipped: number; total: number; paused: boolean; remaining: number }> {
  const { scriptId } = input
  const clues = input.clues.filter(clue => clue.scriptId === scriptId && clue.ocrText.trim())
  const sources = new Map(clues.map(clue => [clue.number, clue]))
  const fingerprints = new Map<string, string>()
  for (const clue of clues) fingerprints.set(clue.id, await fingerprint(clue))
  let snapshot = snapshotFor(scriptId, input.previous)
  const checkpoints = new Map<string, OrganizationCheckpoint>()
  for (const clue of clues) {
    const key = `organization-task:${clue.id}`
    const saved = await getLocalState<OrganizationCheckpoint>(scriptId, key)
    if (saved?.version === 1 && saved.fingerprint === fingerprints.get(clue.id) && saved.clueIds.length === 1 && saved.clueIds[0] === clue.id) checkpoints.set(clue.id, saved)
    else if (saved) await removeLocalState(scriptId, key)
  }
  const pending = clues.filter(clue => {
    const saved = checkpoints.get(clue.id)
    if (saved) return true
    if (snapshot.processedClues?.[clue.id] !== fingerprints.get(clue.id)) return true
    // A failed second request used to look complete because OCR itself had not changed.
    return snapshot.timelineAudit?.some(audit => audit.sourceNo === clue.number && audit.status === 'review' && /尚未完成 API|第二轮核对未完成/.test(audit.message)) || false
  })
  const changed = new Set(pending.filter(clue => {
    const previousFingerprint = snapshot.processedClues?.[clue.id]
    return previousFingerprint && previousFingerprint.replace(/^(?:local:|review:)/, '') !== fingerprints.get(clue.id)
  }).map(clue => clue.id))
  snapshot.processedClues = Object.fromEntries(Object.entries(snapshot.processedClues || {}).filter(([id]) => fingerprints.has(id) && !changed.has(id)))
  const unchangedSource = (sourceNo: number): boolean => {
    const clue = sources.get(sourceNo)
    return Boolean(clue && !changed.has(clue.id))
  }
  snapshot.people = snapshot.people.filter(item => unchangedSource(item.sourceNo))
  snapshot.relationships = snapshot.relationships.filter(item => unchangedSource(item.sourceNo))
  snapshot.cluePoints = snapshot.cluePoints.filter(item => unchangedSource(item.sourceNo))
  snapshot.timeline = snapshot.timeline.flatMap(item => {
    const evidence = sourceEvidence(item, sources).filter(source => !changed.has(source.clueId))
    if (!evidence.length) return []
    return [{ ...item, sourceNo: evidence[0]!.sourceNo, quote: evidence[0]!.quote, evidence }]
  })
  snapshot.timelineAudit = snapshot.timelineAudit?.filter(item => unchangedSource(item.sourceNo))

  const people = input.people.filter(person => person.scriptId === scriptId)
  const nameById = new Map(people.map(person => [person.id, organizationTextKey(person.name)]))
  const canonicalNames = new Map<string, string>()
  for (const person of people) for (const name of [person.name, ...person.aliases]) canonicalNames.set(organizationTextKey(name), organizationTextKey(person.name))
  const canonicalName = (name: string): string => canonicalNames.get(organizationTextKey(name)) || organizationTextKey(name)
  const eventKey = (title: string, startsAt: string, names: string[]): string => JSON.stringify([organizationTextKey(title), startsAt, [...new Set(names)].sort()])
  const timelineKey = (item: OrganizationTimelineSuggestion): string => eventKey(item.title, item.startsAt, item.people.map(canonicalName))
  const knownEvents = new Map(input.events.filter(event => event.scriptId === scriptId && event.confirmed && !/待确认|待补充/.test(event.title)).map(event => [eventKey(event.title, event.startsAt, event.personIds.map(id => nameById.get(id) || `id:${id}`)), event]))
  const relationKey = (from: string, to: string, label: string): string => JSON.stringify([canonicalName(from), canonicalName(to), organizationTextKey(label)])
  const knownRelationships = new Set(input.relationships.filter(relation => relation.scriptId === scriptId).map(relation => JSON.stringify([nameById.get(relation.fromId) || `id:${relation.fromId}`, nameById.get(relation.toId) || `id:${relation.toId}`, organizationTextKey(relation.label)])))

  async function suppressReviewed(): Promise<void> {
    const resolved = new Set(snapshot.resolvedKeys || [])
    snapshot.people = snapshot.people.filter(item => !resolved.has(suggestionKey('people', item)) && !canonicalNames.has(organizationTextKey(item.name)))
    snapshot.relationships = snapshot.relationships.filter(item => !resolved.has(suggestionKey('relationships', item)) && !knownRelationships.has(relationKey(item.from, item.to, item.label)))
    snapshot.cluePoints = snapshot.cluePoints.filter(item => !resolved.has(suggestionKey('cluePoints', item)))
    const remaining: OrganizationTimelineSuggestion[] = []
    for (const item of snapshot.timeline) {
      const evidence = sourceEvidence(item, sources).filter(source => !resolved.has(suggestionKey('timeline', { ...item, sourceNo: source.sourceNo, quote: source.quote })))
      if (!evidence.length) continue
      const candidate = { ...item, sourceNo: evidence[0]!.sourceNo, quote: evidence[0]!.quote, evidence }
      const key = timelineKey(candidate)
      const known = knownEvents.get(key)
      if (known && !candidate.requiresTitle) {
        knownEvents.set(key, await mergeTimelineEvidence(known, { evidence, clueId: evidence[0]!.clueId, precision: candidate.precision, approximate: candidate.approximate }))
      } else remaining.push(candidate)
    }
    snapshot.timeline = remaining
  }

  async function checkpoint(): Promise<void> {
    const latest = await getOrganization(scriptId)
    if (latest) snapshot.resolvedKeys = [...new Set([...(snapshot.resolvedKeys || []), ...(latest.resolvedKeys || [])])]
    await suppressReviewed()
    snapshot = await saveOrganization(scriptId, snapshot)
  }

  await checkpoint()
  let processed = 0
  const pausedResult = () => {
    organizationRun.phase = 'paused'
    organizationRun.message = `已暂停，已处理 ${processed}/${pending.length} 条线索；继续时接着处理`
    return { snapshot, processed, skipped: clues.length - pending.length, total: pending.length, paused: true, remaining: pending.length - processed }
  }
  for (const clue of pending) {
    const saved = checkpoints.get(clue.id)
    const taskKey = `organization-task:${clue.id}`
    const saveTask = async (stage: OrganizationStage, message = ''): Promise<void> => {
      await saveLocalState<OrganizationTaskState>(scriptId, `organization-job:${clue.id}`, { clueId: clue.id, sourceNo: clue.number, fingerprint: fingerprints.get(clue.id)!, stage, message, updatedAt: new Date().toISOString() })
      input.onProgress?.({ processed, total: pending.length, clue, stage, message })
    }
    if (input.shouldPause?.()) {
      await saveTask('paused', saved ? '已暂停，已保存的结果将在继续时恢复' : '已暂停，尚未发起当前线索的 API 请求')
      return pausedResult()
    }
    await saveTask(saved ? 'checking' : 'extracting', saved ? '已恢复首轮结果，仅重试时间核对' : '正在提取 OCR 文字')
    let result: OrganizationSnapshot
    let paused = false
    try {
      result = await analyze([clue], {
        fingerprint: fingerprints.get(clue.id), checkpoint: saved, shouldPause: input.shouldPause,
        onCheckpoint: async value => { await saveLocalState(scriptId, taskKey, value); checkpoints.set(clue.id, value) },
        onStage: saveTask,
      })
    } catch (error) {
      if (error instanceof OrganizationPausedError) {
        if (!error.snapshot) { await saveTask('paused', error.message); return pausedResult() }
        result = error.snapshot
        paused = true
      } else {
        await saveTask('failed', error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    if (result.scriptId && result.scriptId !== scriptId) throw new Error('整理结果不属于当前剧本')
    const validSource = (item: { sourceNo: number; quote: string }): boolean => item.sourceNo === clue.number && Boolean(item.quote.trim()) && clue.ocrText.includes(item.quote)
    snapshot.people = snapshot.people.filter(item => item.sourceNo !== clue.number)
    snapshot.relationships = snapshot.relationships.filter(item => item.sourceNo !== clue.number)
    snapshot.cluePoints = snapshot.cluePoints.filter(item => item.sourceNo !== clue.number)
    snapshot.timeline = snapshot.timeline.flatMap(item => {
      const evidence = sourceEvidence(item, sources).filter(source => source.clueId !== clue.id)
      if (!evidence.length) return []
      return [{ ...item, sourceNo: evidence[0]!.sourceNo, quote: evidence[0]!.quote, evidence }]
    })
    const peopleByName = new Map(snapshot.people.map(item => [organizationTextKey(item.name), item]))
    for (const item of result.people.filter(validSource)) if (!peopleByName.has(organizationTextKey(item.name))) peopleByName.set(organizationTextKey(item.name), item)
    snapshot.people = [...peopleByName.values()]
    const relationsByKey = new Map(snapshot.relationships.map(item => [relationKey(item.from, item.to, item.label), item]))
    for (const item of result.relationships.filter(validSource)) if (!relationsByKey.has(relationKey(item.from, item.to, item.label))) relationsByKey.set(relationKey(item.from, item.to, item.label), item)
    snapshot.relationships = [...relationsByKey.values()]
    const timelineByKey = new Map(snapshot.timeline.map(item => [timelineKey(item), item]))
    for (const item of result.timeline.filter(validSource)) {
      const evidence = sourceEvidence(item, new Map([[clue.number, clue]]))
      if (!evidence.length) continue
      const key = timelineKey(item)
      const existing = timelineByKey.get(key)
      timelineByKey.set(key, existing ? { ...existing, evidence: uniqueEvidence([...(existing.evidence || []), ...evidence]) } : { ...item, evidence })
    }
    snapshot.timeline = [...timelineByKey.values()]
    const pointByKey = new Map(snapshot.cluePoints.map(item => [suggestionKey('cluePoints', item), item]))
    for (const item of result.cluePoints.filter(validSource)) pointByKey.set(suggestionKey('cluePoints', item), pointByKey.get(suggestionKey('cluePoints', item)) || item)
    snapshot.cluePoints = [...pointByKey.values()]
    snapshot.timelineAudit = [...(snapshot.timelineAudit || []).filter(item => item.sourceNo !== clue.number), ...(result.timelineAudit || []).filter(item => item.sourceNo === clue.number)]
    snapshot.analysis = result.analysis
    const reviewed = result.analysis?.reviewed === true && result.analysis.provider !== 'local'
    snapshot.processedClues![clue.id] = `${result.analysis?.provider === 'local' ? 'local:' : reviewed ? '' : 'review:'}${fingerprints.get(clue.id)!}`
    await checkpoint()
    if (reviewed) { await removeLocalState(scriptId, taskKey); checkpoints.delete(clue.id) }
    if (paused) {
      await saveTask('paused', '首轮整理已保存，继续时仅补做时间核对')
      return pausedResult()
    }
    processed += 1
    await saveTask(reviewed ? 'complete' : 'failed', reviewed ? '提取及时间核对已完成' : result.timelineAudit?.find(audit => audit.sourceNo === clue.number)?.message || '整理未完成，可继续重试')
  }
  return { snapshot, processed, skipped: clues.length - pending.length, total: pending.length, paused: false, remaining: 0 }
}
