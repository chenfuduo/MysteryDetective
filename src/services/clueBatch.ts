import { listClues, type ClueRecord, type VaultRecordChange } from './vault'
import { applyUndoableChanges, type ReviewUndo } from './reviewActions'

export type BatchCluePatch = {
  round?: number
  category?: string
  addTags?: string[]
  removeTags?: string[]
  favorite?: boolean
}

export async function updateCluesInBatch(scriptId: string, clueIds: string[], patch: BatchCluePatch): Promise<{ changed: number; unchanged: number; undo: ReviewUndo | null }> {
  if (!scriptId || !clueIds.length) throw new Error('请先选择当前剧本的线索')
  if (patch.round !== undefined && (!Number.isSafeInteger(patch.round) || patch.round < 1)) throw new Error('轮次必须是正整数')
  if (patch.category !== undefined && typeof patch.category !== 'string') throw new Error('分类格式不正确')
  if (patch.favorite !== undefined && typeof patch.favorite !== 'boolean') throw new Error('收藏设置不正确')
  const tagKey = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()
  const tagList = (values?: string[]) => {
    if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string'))) throw new Error('标签格式不正确')
    return [...new Map((values || []).map(value => value.trim()).filter(Boolean).map(value => [tagKey(value), value])).values()]
  }
  const addTags = tagList(patch.addTags), removeTags = new Set(tagList(patch.removeTags).map(tagKey))
  if (addTags.some(tag => removeTags.has(tagKey(tag)))) throw new Error('同一个标签不能同时添加和移除')
  if (patch.round === undefined && patch.category === undefined && patch.favorite === undefined && !addTags.length && !removeTags.size) throw new Error('请选择要批量修改的字段')
  const ids = [...new Set(clueIds)]
  const clues = await listClues(scriptId)
  const scoped = new Map(clues.filter(clue => clue.scriptId === scriptId).map(clue => [clue.id, clue]))
  if (ids.some(id => !scoped.has(id))) throw new Error('部分线索已移除或不属于当前剧本，请重新选择')
  const changes: VaultRecordChange[] = []
  for (const id of ids) {
    const before = scoped.get(id)!
    const after: ClueRecord = { ...before }
    if (patch.round !== undefined) after.round = patch.round
    if (patch.category !== undefined) after.category = patch.category.trim()
    if (patch.favorite !== undefined) after.favorite = patch.favorite
    if (addTags.length || removeTags.size) {
      after.tags = before.tags.filter(tag => !removeTags.has(tagKey(tag)))
      for (const tag of addTags) if (!after.tags.some(current => tagKey(current) === tagKey(tag))) after.tags.push(tag)
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ kind: 'clues', id, before, after })
  }
  if (!changes.length) return { changed: 0, unchanged: ids.length, undo: null }
  const undo = await applyUndoableChanges(scriptId, `批量编辑 ${changes.length} 条线索`, changes)
  return { changed: changes.length, unchanged: ids.length - changes.length, undo }
}
