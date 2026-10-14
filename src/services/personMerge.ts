import * as vault from './vault'
import { applyUndoableChanges, type ReviewUndo } from './reviewActions'
import type { PersonRecord, VaultRecordChange } from './vault'

export type PersonMergePreview = {
  source: PersonRecord
  target: PersonRecord
  eventCount: number
  relationshipCount: number
  clueCount: number
  noteCount: number
  boardCount: number
}
async function mergeContext(scriptId: string, sourceId: string, targetId: string) {
  const [people, events, relationships, clues, notes, board] = await Promise.all([
    vault.listPeople(scriptId), vault.listTimelineEvents(scriptId), vault.listRelationships(scriptId), vault.listClues(scriptId), vault.listNotes(scriptId), vault.listBoardItems(scriptId),
  ])
  const source = people.find(person => person.id === sourceId)
  const target = people.find(person => person.id === targetId)
  if (!source || !target || source.id === target.id) throw new Error('请选择当前剧本中的两个不同人物')
  return { source, target, events, relationships, clues, notes, board }
}
export async function previewPersonMerge(scriptId: string, sourceId: string, targetId: string): Promise<PersonMergePreview> {
  const { source, target, events, relationships, clues, notes, board } = await mergeContext(scriptId, sourceId, targetId)
  return {
    source, target,
    eventCount: events.filter(event => event.personIds.includes(sourceId)).length,
    relationshipCount: relationships.filter(item => item.fromId === sourceId || item.toId === sourceId).length,
    clueCount: clues.filter(clue => vault.personAppearsInClue(source, clue)).length,
    noteCount: notes.filter(note => note.personId === sourceId).length,
    boardCount: board.filter(item => item.kind === 'person' && item.refId === sourceId).length,
  }
}
export async function mergePeople(scriptId: string, sourceId: string, targetId: string): Promise<ReviewUndo> {
  const { source, target, events, relationships, notes, board } = await mergeContext(scriptId, sourceId, targetId)
  const changes: VaultRecordChange[] = []
  const remember = (kind: VaultRecordChange['kind'], before: { id: string }, after: unknown) => changes.push({ kind, id: before.id, before, after })
  const names = new Map<string, string>()
  for (const name of [...target.aliases, source.name, ...source.aliases]) {
    const value = name.trim(), key = vault.organizationTextKey(value)
    if (value && key !== vault.organizationTextKey(target.name) && !names.has(key)) names.set(key, value)
  }
  const formalNames = new Set([target.name, ...names.values()].map(vault.organizationTextKey))
  const ocrNames = new Map<string, string>()
  for (const value of [...(target.ocrNames || []), ...(source.ocrNames || [])]) {
    const name = value.trim(), key = vault.organizationTextKey(name)
    if (name && !formalNames.has(key) && !ocrNames.has(key)) ocrNames.set(key, name)
  }
  const primaryPhoto = target.photoPath || source.photoPath
  const photoPaths = [...new Set([...(target.photoPaths || []), source.photoPath, ...(source.photoPaths || [])].filter(path => path && path !== primaryPhoto))]
  const notesText = source.notes.trim() && source.notes.trim() !== target.notes.trim()
    ? [target.notes.trim(), `【原人物：${source.name}】\n${source.notes.trim()}`].filter(Boolean).join('\n\n') : target.notes
  const merged: PersonRecord = { ...target, aliases: [...names.values()], ocrNames: [...ocrNames.values()], notes: notesText, photoPath: primaryPhoto, photoPaths }
  remember('people', target, merged)
  for (const event of events) if (event.personIds.includes(sourceId)) remember('timeline', event, { ...event, personIds: [...new Set(event.personIds.map(id => id === sourceId ? targetId : id))] })
  const seenRelations = new Set<string>()
  // Keep existing target relations when replacing a source relation would duplicate one.
  const orderedRelations = [...relationships].sort((a, b) => Number(a.fromId === sourceId || a.toId === sourceId) - Number(b.fromId === sourceId || b.toId === sourceId))
  for (const relation of orderedRelations) {
    const fromId = relation.fromId === sourceId ? targetId : relation.fromId
    const toId = relation.toId === sourceId ? targetId : relation.toId
    const touched = relation.fromId === sourceId || relation.toId === sourceId
    const key = JSON.stringify([[fromId, toId].sort(), vault.organizationTextKey(relation.label)])
    if (touched && (fromId === toId || seenRelations.has(key))) { remember('relationships', relation, null); continue }
    seenRelations.add(key)
    if (touched) remember('relationships', relation, { ...relation, fromId, toId })
  }
  for (const note of notes) if (note.personId === sourceId) remember('notes', note, { ...note, personId: targetId })
  for (const item of board) if (item.kind === 'person' && item.refId === sourceId) remember('board_items', item, { ...item, refId: targetId })
  // The source is removed directly in the same transaction, without deletePerson cascades.
  remember('people', source, null)
  return applyUndoableChanges(scriptId, `将“${source.name}”合并到“${target.name}”`, changes)
}
