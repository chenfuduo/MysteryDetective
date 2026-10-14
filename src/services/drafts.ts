import { getLocalState, saveLocalState, removeLocalState } from './vault'

export type EditorDraft<T> = { values: T; baseline: string; updatedAt: string }
const pending = new Map<string, Promise<void>>()
const mirrorKey = (scriptId: string, kind: string, recordId: string) => `clue-vault:draft:${encodeURIComponent(scriptId)}:${kind}:${encodeURIComponent(recordId)}`
const stateKey = (kind: string, recordId: string) => `draft:${kind}:${recordId}`

export async function getDraft<T>(scriptId: string, kind: 'clue' | 'note', recordId: string): Promise<EditorDraft<T> | null> {
  let mirror: EditorDraft<T> | null = null
  try { mirror = JSON.parse(localStorage.getItem(mirrorKey(scriptId, kind, recordId)) || 'null') } catch { /* SQLite remains the primary copy. */ }
  const stored = await getLocalState<EditorDraft<T>>(scriptId, stateKey(kind, recordId))
  return mirror && (!stored || mirror.updatedAt >= stored.updatedAt) ? mirror : stored
}

export function saveDraft<T>(scriptId: string, kind: 'clue' | 'note', recordId: string, values: T, baseline: string): Promise<void> {
  const draft: EditorDraft<T> = { values: JSON.parse(JSON.stringify(values)), baseline, updatedAt: new Date().toISOString() }
  const key = mirrorKey(scriptId, kind, recordId)
  try { localStorage.setItem(key, JSON.stringify(draft)) } catch { /* Report a database write failure to the editor. */ }
  const write = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => saveLocalState(scriptId, stateKey(kind, recordId), draft))
  pending.set(key, write)
  void write.finally(() => { if (pending.get(key) === write) pending.delete(key) }).catch(() => {})
  return write
}

export async function removeDraft(scriptId: string, kind: 'clue' | 'note', recordId: string): Promise<void> {
  const key = mirrorKey(scriptId, kind, recordId)
  await pending.get(key)?.catch(() => {})
  await removeLocalState(scriptId, stateKey(kind, recordId))
  localStorage.removeItem(key)
}

export async function flushDrafts(): Promise<void> { await Promise.all([...pending.values()]) }
