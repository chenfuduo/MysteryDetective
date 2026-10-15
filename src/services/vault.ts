import { Capacitor } from '@capacitor/core'
import { Camera } from '@capacitor/camera'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { CapgoFilePicker } from '@capgo/capacitor-file-picker'
import { Ocr } from '@jcesarmobile/capacitor-ocr'
import JSZip from 'jszip'
import { normalizedOcrRegions, type OcrRegion } from './ocrLocation'
import { buildSourceRevisionState, withSourceRevisionLock, type SourceRevisionState } from './sourceRevision'
export type { OcrRegion } from './ocrLocation'

export type ScriptRecord = { id: string; name: string; playDate: string; coverPath: string; createdAt: string }
export type ClueRecord = { id: string; scriptId: string; number: number; title: string; imagePath: string; displayImagePath: string; displayImageKind?: 'crop' | 'perspective' | 'retake'; ocrText: string; sourceRevision?: number; ocrRegions?: OcrRegion[]; ocrImagePath?: string; ocrStatus?: 'pending' | 'complete' | 'failed'; ocrError?: string; imageHash?: string; round: number; category: string; tags: string[]; favorite: boolean; notes: string; rotation: number; createdAt: string }
export type CluePhotoImportResult = { clues: ClueRecord[]; skippedDuplicates: number }
export type PersonRecord = { id: string; scriptId: string; name: string; aliases: string[]; photoPath: string; notes: string; photoPaths?: string[]; ocrNames?: string[] }
export type RelationshipRecord = { id: string; scriptId: string; fromId: string; toId: string; label: string }
export type OrganizationEvidence = { clueId: string; sourceNo: number; quote: string }
export type TimelineRecord = { id: string; scriptId: string; title: string; startsAt: string; personIds: string[]; clueId: string; confirmed: boolean; yearlessMarkerIgnored?: boolean; evidence?: OrganizationEvidence[]; precision?: 'date' | 'hour' | 'minute'; approximate?: boolean }
export type BoardItemRecord = { id: string; scriptId: string; kind: 'clue' | 'person' | 'note' | 'photo'; refId: string; text: string; x: number; y: number; color: string; group: string }
export type BoardLinkRecord = { id: string; scriptId: string; fromId: string; toId: string; label: string }
export type NoteRecord = { id: string; scriptId: string; clueId: string; personId: string; text: string; createdAt: string }
export type OrganizationPersonSuggestion = { id: string; name: string; aliases: string[]; sourceNo: number; quote: string }
export type OrganizationRelationshipSuggestion = { id: string; from: string; to: string; label: string; sourceNo: number; quote: string }
export type OrganizationTimelineSuggestion = { id: string; title: string; startsAt: string; people: string[]; sourceNo: number; quote: string; requiresTitle?: boolean; evidence?: OrganizationEvidence[]; precision?: 'date' | 'hour' | 'minute'; approximate?: boolean }
export type OrganizationCluePointSuggestion = { id: string; title: string; category: string; tags: string[]; sourceNo: number; quote: string }
export type OrganizationSnapshot = { id: string; scriptId: string; updatedAt: string; people: OrganizationPersonSuggestion[]; relationships: OrganizationRelationshipSuggestion[]; timeline: OrganizationTimelineSuggestion[]; cluePoints: OrganizationCluePointSuggestion[]; processedClues?: Record<string, string>; resolvedKeys?: string[]; timelineAudit?: { sourceNo: number; clocks: number; covered: number; status: 'complete' | 'review'; message: string }[]; analysis?: { provider: 'deepseek' | 'openai' | 'local'; localReason?: 'offline' | 'quota'; reviewed: boolean } }
export type OrganizationSuggestionKind = 'people' | 'relationships' | 'timeline' | 'cluePoints'
export function organizationTextKey(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s“”‘’]/g, '') }
export function suggestionKey(kind: OrganizationSuggestionKind, item: OrganizationSnapshot[OrganizationSuggestionKind][number]): string {
  const value = item as OrganizationPersonSuggestion & OrganizationRelationshipSuggestion & OrganizationTimelineSuggestion & OrganizationCluePointSuggestion
  const content = kind === 'people' ? value.name : kind === 'relationships' ? [value.from, value.to, value.label].join('|') : kind === 'timeline' ? [value.startsAt, value.title].join('|') : value.title
  return JSON.stringify([kind, value.sourceNo, organizationTextKey(value.quote), organizationTextKey(content)])
}
export type AnnotationRecord = { id: string; clueId: string; strokes: unknown[] }

type Table = 'scripts' | 'clues' | 'people' | 'relationships' | 'timeline' | 'board_items' | 'board_links' | 'notes' | 'annotations' | 'organization' | 'workspace_state'
type Stored = { id: string; scriptId?: string }
const tables: Table[] = ['scripts', 'clues', 'people', 'relationships', 'timeline', 'board_items', 'board_links', 'notes', 'annotations', 'organization', 'workspace_state']
const native = Capacitor.isNativePlatform()
let database: any = null
let initialized = false
let ftsReady = false
const imageUrls = new Map<string, string>()

function uid(): string { return crypto.randomUUID() }
function now(): string { return new Date().toISOString() }
function webKey(table: Table): string { return `clue-vault:${table}` }
function webRecords<T>(table: Table): T[] {
  try { return JSON.parse(localStorage.getItem(webKey(table)) || '[]') as T[] } catch { return [] }
}

export async function initVault(): Promise<void> {
  if (initialized) return
  if (native) {
    const { SQLiteConnection, CapacitorSQLite } = await import('@capacitor-community/sqlite')
    const connection = new SQLiteConnection(CapacitorSQLite)
    database = await connection.createConnection('clue_vault', false, 'no-encryption', 1, false)
    await database.open()
    for (const table of tables) {
      await database.execute(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, script_id TEXT NOT NULL, data TEXT NOT NULL)`)
      await database.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_script ON ${table}(script_id)`)
    }
    try {
      await database.execute("CREATE VIRTUAL TABLE IF NOT EXISTS clue_fts USING fts5(clue_id UNINDEXED, script_id UNINDEXED, title, ocr_text, notes, tokenize='trigram')")
      ftsReady = true
    } catch {
      try {
        await database.execute('CREATE VIRTUAL TABLE IF NOT EXISTS clue_fts USING fts5(clue_id UNINDEXED, script_id UNINDEXED, title, ocr_text, notes)')
        ftsReady = true
      } catch { ftsReady = false }
    }
  }
  initialized = true
}

async function listRecords<T>(table: Table, scriptId?: string): Promise<T[]> {
  await initVault()
  if (!native) {
    const records = webRecords<T & Stored>(table)
    return (scriptId ? records.filter((item) => item.scriptId === scriptId) : records) as T[]
  }
  const query = scriptId
    ? await database.query(`SELECT data FROM ${table} WHERE script_id = ?`, [scriptId])
    : await database.query(`SELECT data FROM ${table}`)
  return (query.values || []).map((row: { data: string }) => JSON.parse(row.data) as T)
}

async function getRecord<T>(table: Table, id: string): Promise<T | null> {
  await initVault()
  if (!native) return webRecords<T & Stored>(table).find((item) => item.id === id) || null
  const query = await database.query(`SELECT data FROM ${table} WHERE id = ?`, [id])
  return query.values?.length ? JSON.parse(query.values[0].data) as T : null
}

async function putRecord<T extends Stored>(table: Table, record: T): Promise<T> {
  await initVault()
  if (native) {
    await database.run(`INSERT OR REPLACE INTO ${table} (id, script_id, data) VALUES (?, ?, ?)`, [record.id, record.scriptId || record.id, JSON.stringify(record)])
  } else {
    const records = webRecords<T>(table)
    const index = records.findIndex((item) => item.id === record.id)
    if (index === -1) records.push(record)
    else records[index] = record
    localStorage.setItem(webKey(table), JSON.stringify(records))
  }
  if (table === 'clues') await indexClue(record as ClueRecord)
  return record
}

async function removeRecord(table: Table, id: string): Promise<void> {
  await initVault()
  if (native) await database.run(`DELETE FROM ${table} WHERE id = ?`, [id])
  else localStorage.setItem(webKey(table), JSON.stringify(webRecords<Stored>(table).filter((item) => item.id !== id)))
  if (table === 'clues' && ftsReady) await database.run('DELETE FROM clue_fts WHERE clue_id = ?', [id])
}

async function indexClue(clue: ClueRecord): Promise<void> {
  if (!native || !ftsReady) return
  await database.run('DELETE FROM clue_fts WHERE clue_id = ?', [clue.id])
  await database.run('INSERT INTO clue_fts (clue_id, script_id, title, ocr_text, notes) VALUES (?, ?, ?, ?, ?)', [clue.id, clue.scriptId, clue.title, clue.ocrText, clue.notes])
}

export type VaultRecordKind = Exclude<Table, 'scripts' | 'workspace_state'>
export type VaultRecordChange = { kind: VaultRecordKind; id: string; before: unknown; after: unknown }
type LocalStateRecord = { id: string; scriptId: string; key: string; value: unknown }
const stateId = (scriptId: string, key: string) => JSON.stringify([scriptId, key])
const recordEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Local workflow metadata stays on this device and is deliberately excluded from archives.
export async function getLocalState<T>(scriptId: string, key: string): Promise<T | null> {
  const record = await getRecord<LocalStateRecord>('workspace_state', stateId(scriptId, key))
  return record?.scriptId === scriptId ? record.value as T : null
}
export async function saveLocalState<T>(scriptId: string, key: string, value: T): Promise<void> {
  await putRecord('workspace_state', { id: stateId(scriptId, key), scriptId, key, value })
}
export async function removeLocalState(scriptId: string, key: string): Promise<void> {
  await removeRecord('workspace_state', stateId(scriptId, key))
}

// Merge, restore and undo write all linked records and their recovery metadata together.
export async function applyRecordChanges(scriptId: string, changes: VaultRecordChange[], state: { save?: { key: string; value: unknown }[]; remove?: string[] } = {}): Promise<void> {
  await initVault()
  const writes: { table: Table; id: string; after: Stored | null }[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    if (!tables.includes(change.kind) || change.kind === ('scripts' as Table) || change.kind === ('workspace_state' as Table)) throw new Error('不支持修改这个资料类型')
    const identity = `${change.kind}:${change.id}`
    if (seen.has(identity)) throw new Error('同一资料不能重复写入')
    seen.add(identity)
    const current = await getRecord<Stored>(change.kind, change.id)
    if (current && current.scriptId !== scriptId) throw new Error('资料不属于当前剧本')
    if (!recordEqual(current, change.before)) throw new Error('相关资料已有新变化，请保留当前内容后再操作')
    const after = change.after as Stored | null
    if (after && (after.id !== change.id || after.scriptId !== scriptId)) throw new Error('资料不属于当前剧本')
    writes.push({ table: change.kind, id: change.id, after })
  }
  for (const entry of state.save || []) writes.push({ table: 'workspace_state', id: stateId(scriptId, entry.key), after: { id: stateId(scriptId, entry.key), scriptId, key: entry.key, value: entry.value } as LocalStateRecord })
  for (const key of state.remove || []) writes.push({ table: 'workspace_state', id: stateId(scriptId, key), after: null })
  if (!writes.length) return
  if (native) {
    const statements: { statement: string; values: unknown[] }[] = []
    for (const write of writes) {
      statements.push(write.after
        ? { statement: `INSERT OR REPLACE INTO ${write.table} (id, script_id, data) VALUES (?, ?, ?)`, values: [write.id, scriptId, JSON.stringify(write.after)] }
        : { statement: `DELETE FROM ${write.table} WHERE id = ? AND script_id = ?`, values: [write.id, scriptId] })
      if (write.table === 'clues' && ftsReady) {
        statements.push({ statement: 'DELETE FROM clue_fts WHERE clue_id = ?', values: [write.id] })
        if (write.after) {
          const clue = write.after as ClueRecord
          statements.push({ statement: 'INSERT INTO clue_fts (clue_id, script_id, title, ocr_text, notes) VALUES (?, ?, ?, ?, ?)', values: [clue.id, scriptId, clue.title, clue.ocrText, clue.notes] })
        }
      }
    }
    await database.executeSet(statements, true)
  } else {
    const originals = new Map<Table, string | null>()
    const pending = new Map<Table, Stored[]>()
    for (const write of writes) {
      if (!pending.has(write.table)) { originals.set(write.table, localStorage.getItem(webKey(write.table))); pending.set(write.table, webRecords<Stored>(write.table)) }
      const records = pending.get(write.table)!
      const index = records.findIndex(item => item.id === write.id)
      if (write.after) { if (index < 0) records.push(write.after); else records[index] = write.after }
      else if (index >= 0) records.splice(index, 1)
    }
    try { for (const [table, records] of pending) localStorage.setItem(webKey(table), JSON.stringify(records)) }
    catch (error) {
      for (const table of originals.keys()) localStorage.removeItem(webKey(table))
      for (const [table, raw] of originals) if (raw !== null) localStorage.setItem(webKey(table), raw)
      throw error
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = ''
  for (let index = 0; index < bytes.length; index += 0x8000) result += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(result)
}
function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
async function imageFingerprint(data: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return ''
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', base64ToBytes(cleanBase64(data))))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
function normalizeClueText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\s“”‘’]/g, '')
}
function cleanBase64(data: string): string { return data.includes(',') ? data.slice(data.indexOf(',') + 1) : data }
function mimeForPath(path: string): string {
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.heic$/i.test(path)) return 'image/heic'
  if (/\.webp$/i.test(path)) return 'image/webp'
  return 'image/jpeg'
}
function extensionForMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('heic') || mime.includes('heif')) return 'heic'
  if (mime.includes('webp')) return 'webp'
  return 'jpg'
}

async function webImages(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clue-vault-images', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('images')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function webImagePut(path: string, data: string): Promise<void> {
  const db = await webImages()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('images', 'readwrite')
    transaction.objectStore('images').put(data, path)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}
async function webImageGet(path: string): Promise<string> {
  const db = await webImages()
  const data = await new Promise<string>((resolve, reject) => {
    const request = db.transaction('images', 'readonly').objectStore('images').get(path)
    request.onsuccess = () => resolve(request.result || '')
    request.onerror = () => reject(request.error)
  })
  db.close()
  return data
}
async function webImageDelete(path: string): Promise<void> {
  const db = await webImages()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('images', 'readwrite')
    transaction.objectStore('images').delete(path)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}
async function saveImage(scriptId: string, data: string, mime: string): Promise<string> {
  const path = `scripts/${scriptId}/images/${uid()}.${extensionForMime(mime)}`
  const base64 = cleanBase64(data)
  if (native) await Filesystem.writeFile({ path, data: base64, directory: Directory.Data, recursive: true })
  else await webImagePut(path, base64)
  return path
}
async function readImage(path: string): Promise<string> {
  if (!path) return ''
  if (path.startsWith('data:')) return cleanBase64(path)
  if (native) {
    const result = await Filesystem.readFile({ path, directory: Directory.Data })
    return typeof result.data === 'string' ? result.data : bytesToBase64(new Uint8Array(await result.data.arrayBuffer()))
  }
  return webImageGet(path)
}
async function deleteImage(path: string): Promise<void> {
  if (!path || path.startsWith('data:')) return
  imageUrls.delete(path)
  try {
    if (native) await Filesystem.deleteFile({ path, directory: Directory.Data })
    else await webImageDelete(path)
  } catch { /* Already removed. */ }
}
export async function imageUrl(path: string): Promise<string> {
  if (!path || path.startsWith('data:')) return path
  if (imageUrls.has(path)) {
    const cached = imageUrls.get(path)!
    imageUrls.delete(path); imageUrls.set(path, cached)
    return cached
  }
  let url: string
  if (native) {
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data })
    url = Capacitor.convertFileSrc(uri)
  } else {
    const base64 = await readImage(path)
    url = `data:${mimeForPath(path)};base64,${base64}`
  }
  imageUrls.set(path, url)
  while (imageUrls.size > 48) imageUrls.delete(imageUrls.keys().next().value!)
  return url
}

export async function listScripts(): Promise<ScriptRecord[]> {
  return (await listRecords<ScriptRecord>('scripts')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function createScript(input: Partial<ScriptRecord>): Promise<ScriptRecord> {
  const id = uid()
  const coverPath = input.coverPath?.startsWith('data:') ? await saveImage(id, input.coverPath, input.coverPath.slice(5, input.coverPath.indexOf(';'))) : input.coverPath || ''
  return putRecord('scripts', { id, name: (input.name || '').trim(), playDate: input.playDate || '', coverPath, createdAt: now() })
}
export async function updateScript(id: string, patch: Partial<ScriptRecord>): Promise<ScriptRecord> {
  const existing = await getRecord<ScriptRecord>('scripts', id)
  if (!existing) throw new Error('剧本不存在')
  const coverPath = patch.coverPath?.startsWith('data:') ? await saveImage(id, patch.coverPath, patch.coverPath.slice(5, patch.coverPath.indexOf(';'))) : patch.coverPath
  if (coverPath && coverPath !== existing.coverPath) await deleteImage(existing.coverPath)
  return putRecord('scripts', { ...existing, ...patch, coverPath: coverPath ?? existing.coverPath, id })
}
export async function deleteScript(id: string): Promise<void> {
  const script = await getRecord<ScriptRecord>('scripts', id)
  if (!script) return
  for (const clue of await listClues(id)) { await deleteImage(clue.imagePath); await deleteImage(clue.displayImagePath) }
  for (const person of await listPeople(id)) for (const path of [person.photoPath, ...(person.photoPaths || [])]) await deleteImage(path)
  for (const entry of await listRecords<LocalStateRecord>('workspace_state', id)) {
    if (!entry.key.startsWith('trash:')) continue
    const trash = entry.value as ClueTrashRecord
    const clue = trash?.changes?.find(change => change.kind === 'clues')?.before as ClueRecord | undefined
    if (clue) { await deleteImage(clue.imagePath); await deleteImage(clue.displayImagePath) }
  }
  await deleteImage(script.coverPath)
  for (const table of tables.filter((item) => item !== 'scripts')) {
    for (const item of await listRecords<Stored>(table, id)) await removeRecord(table, item.id)
  }
  await removeRecord('scripts', id)
  const draftPrefix = `clue-vault:draft:${encodeURIComponent(id)}:`
  for (const key of Object.keys(localStorage)) if (key.startsWith(draftPrefix)) localStorage.removeItem(key)
}

export async function listClues(scriptId: string): Promise<ClueRecord[]> {
  return (await listRecords<ClueRecord>('clues', scriptId)).sort((a, b) => a.number - b.number)
}
function categoryFromText(text: string): string {
  if (/短信|聊天记录|通话记录|邮件/.test(text)) return '通讯'
  if (/收据|发票|账单|转账/.test(text)) return '财务'
  if (/日记|信件|手写信/.test(text)) return '文书'
  if (/照片|合照|相片/.test(text)) return '影像'
  return '未分类'
}
function dateCandidates(text: string): string[] {
  const found = new Set<string>()
  const pattern = /(20\d{2})\s*[年/.-]\s*(0?[1-9]|1[0-2])\s*[月/.-]\s*(0?[1-9]|[12]\d|3[01])\s*日?(?:\s+([01]?\d|2[0-3]):([0-5]\d))?/g
  for (const match of text.matchAll(pattern)) {
    const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    if (!Number.isNaN(Date.parse(date))) found.add(`${date}T${(match[4] || '00').padStart(2, '0')}:${match[5] || '00'}`)
  }
  return [...found]
}
async function addTimeCandidates(clue: ClueRecord): Promise<void> {
  for (const startsAt of dateCandidates(clue.ocrText)) {
    await createTimelineEvent(clue.scriptId, { title: '待确认的时间', startsAt, clueId: clue.id, confirmed: false })
  }
}
async function sourceBase64(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return cleanBase64(uri)
  if (native) {
    const result = await Filesystem.readFile({ path: uri })
    return typeof result.data === 'string' ? result.data : bytesToBase64(new Uint8Array(await result.data.arrayBuffer()))
  }
  const response = await fetch(uri)
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()))
}
async function recognizeSavedClue(clue: ClueRecord, data?: string): Promise<ClueRecord> {
  let ocrText = ''
  let ocrRegions: OcrRegion[] = []
  let error = ''
  try {
    const base64 = data || await readImage(clue.imagePath)
    const result = native ? await Ocr.process({ image: `data:${mimeForPath(clue.imagePath)};base64,${base64}` }) : { results: [] as { text: string }[] }
    ocrText = result.results.map(item => item.text).join('\n')
    ocrRegions = normalizedOcrRegions(result.results)
    if (!ocrText.trim()) error = '未识别到文字，原始照片已保存，可以重新识别或手动输入'
  } catch {
    error = '文字识别失败，原始照片已保存，请重新识别或手动输入'
  }
  const current = await getRecord<ClueRecord>('clues', clue.id)
  if (!current || current.scriptId !== clue.scriptId) throw new Error('线索已被移除，无法继续识别')
  // A manual correction made while OCR was running always wins.
  if (current.ocrText.trim()) return ocrRegions.length ? updateClue(clue.id, { ocrRegions, ocrImagePath: clue.imagePath }) : current
  if (error) return updateClue(clue.id, { ocrStatus: 'failed', ocrError: error })
  return updateClue(clue.id, { ocrText, ocrRegions, ocrImagePath: clue.imagePath, category: categoryFromText(ocrText), ocrStatus: 'complete', ocrError: '' })
}
/** Supplement original-photo locations without replacing OCR text or manual corrections. */
export async function locateClueText(scriptId: string, clueId: string): Promise<ClueRecord> {
  const clue = await getRecord<ClueRecord>('clues', clueId)
  if (!clue || clue.scriptId !== scriptId) throw new Error('线索不属于当前剧本')
  if (!native) throw new Error('照片文字定位需要在 iPad 上使用本地 Apple Vision 识别')
  const base64 = await readImage(clue.imagePath)
  const result = await Ocr.process({ image: `data:${mimeForPath(clue.imagePath)};base64,${base64}` })
  const ocrRegions = normalizedOcrRegions(result.results)
  if (!ocrRegions.length) throw new Error('没有获取到文字位置，请使用包含定位功能的新版 iPad 应用，并确认照片文字清晰')
  const current = await getRecord<ClueRecord>('clues', clueId)
  if (!current || current.scriptId !== scriptId || current.imagePath !== clue.imagePath) throw new Error('原始线索已发生变化，请重新打开')
  return updateClue(clueId, { ocrRegions, ocrImagePath: clue.imagePath })
}
export async function retryClueOcr(scriptId: string, clueId: string): Promise<ClueRecord> {
  const clue = await getRecord<ClueRecord>('clues', clueId)
  if (!clue || clue.scriptId !== scriptId) throw new Error('线索不属于当前剧本')
  if (clue.ocrText.trim()) throw new Error('这条线索已有识别或修正文字，请先保留原文，不会自动覆盖')
  const pending = await updateClue(clue.id, { ocrStatus: 'pending', ocrError: '' })
  const result = await recognizeSavedClue(pending)
  if (result.ocrStatus === 'complete') await addTimeCandidates(result)
  return result
}
async function addPhoto(scriptId: string, uri: string, mime: string, round = 1): Promise<ClueRecord | null> {
  const data = await sourceBase64(uri)
  const imageHash = await imageFingerprint(data)
  const existing = await listClues(scriptId)
  if (imageHash && existing.some(clue => clue.imageHash === imageHash)) return null
  const imagePath = await saveImage(scriptId, data, mime)
  let pending: ClueRecord
  try {
    const deletedNumbers = (await listRecords<LocalStateRecord>('workspace_state', scriptId)).filter(item => item.key.startsWith('trash:')).map(item => ((item.value as ClueTrashRecord).changes.find(change => change.kind === 'clues')?.before as ClueRecord | undefined)?.number || 0)
    const number = Math.max(0, ...existing.map(clue => clue.number), ...deletedNumbers) + 1
    pending = { id: uid(), scriptId, number, title: `线索 ${String(number).padStart(3, '0')}`, imagePath, displayImagePath: '', ocrText: '', ocrStatus: 'pending', ocrError: '', imageHash, round: Number.isInteger(round) && round > 0 ? round : 1, category: '未分类', tags: [], favorite: false, notes: '', rotation: 0, createdAt: now() }
    await putRecord('clues', pending)
  } catch (error) {
    await deleteImage(imagePath)
    throw error
  }
  const clue = await recognizeSavedClue(pending, data)
  const normalizedText = normalizeClueText(clue.ocrText)
  if (normalizedText && (await listClues(scriptId)).some(other => other.id !== clue.id && normalizeClueText(other.ocrText) === normalizedText)) {
    await removeRecord('clues', clue.id)
    await deleteImage(imagePath)
    return null
  }
  if (clue.ocrStatus === 'complete') await addTimeCandidates(clue)
  return clue
}
export async function captureClues(scriptId: string, round = 1): Promise<CluePhotoImportResult> {
  const photo = await Camera.takePhoto({ quality: 90, includeMetadata: true })
  const uri = photo.uri || photo.webPath
  if (!uri) throw new Error('无法读取拍摄照片')
  const clue = await addPhoto(scriptId, uri, mimeForPath(uri), round)
  return { clues: clue ? [clue] : [], skippedDuplicates: clue ? 0 : 1 }
}
export async function importCluePhotos(scriptId: string, round = 1): Promise<CluePhotoImportResult> {
  const selection = await Camera.chooseFromGallery({ allowMultipleSelection: true, limit: 0, includeMetadata: true })
  const added: ClueRecord[] = []
  let skippedDuplicates = 0
  for (const photo of selection.results) {
    const uri = photo.uri || photo.webPath
    if (!uri) throw new Error('无法读取相册照片')
    const clue = await addPhoto(scriptId, uri, mimeForPath(uri), round)
    if (clue) added.push(clue)
    else skippedDuplicates += 1
  }
  return { clues: added, skippedDuplicates }
}
export async function updateClue(id: string, patch: Partial<ClueRecord>): Promise<ClueRecord> {
  return withSourceRevisionLock(id, async () => {
    const existing = await getRecord<ClueRecord>('clues', id)
    if (!existing) throw new Error('线索不存在')
    const ocrState = patch.ocrText?.trim() ? { ocrStatus: 'complete' as const, ocrError: '' } : {}
    const updated: ClueRecord = { ...existing, ...patch, ...ocrState, id, scriptId: existing.scriptId, imagePath: existing.imagePath, sourceRevision: existing.sourceRevision }
    if (patch.ocrText !== undefined && existing.ocrText.trim()) {
      const [previous, events, organization] = await Promise.all([
        getLocalState<SourceRevisionState>(existing.scriptId, `source-revision:${id}`),
        listTimelineEvents(existing.scriptId), getOrganization(existing.scriptId),
      ])
      const revision = buildSourceRevisionState(existing, updated.ocrText, previous, events, organization)
      if (revision) {
        updated.sourceRevision = revision.revision
        await applyRecordChanges(existing.scriptId, [{ kind: 'clues', id, before: existing, after: updated }], { save: [{ key: `source-revision:${id}`, value: revision }] })
        return updated
      }
    }
    return putRecord('clues', updated)
  })
}
type ClueTrashRecord = { id: string; label: string; deletedAt: string; kind: 'clue'; changes: VaultRecordChange[] }
export async function listTrash(scriptId: string): Promise<{ id: string; label: string; deletedAt: string; kind: 'clue' }[]> {
  return (await listRecords<LocalStateRecord>('workspace_state', scriptId)).filter(item => item.key.startsWith('trash:')).map(item => {
    const entry = item.value as ClueTrashRecord
    return { id: entry.id, label: entry.label, deletedAt: entry.deletedAt, kind: entry.kind }
  }).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}
export async function restoreTrash(scriptId: string, id: string): Promise<void> {
  const trash = await getLocalState<ClueTrashRecord>(scriptId, `trash:${id}`)
  if (!trash || trash.kind !== 'clue') throw new Error('这条回收记录不存在')
  const oldClue = trash.changes.find(change => change.kind === 'clues')?.before as ClueRecord | undefined
  if (oldClue && (await listClues(scriptId)).some(clue => clue.id !== oldClue.id && clue.number === oldClue.number)) throw new Error('原线索编号已被使用，请先调整当前线索编号后恢复')
  await applyRecordChanges(scriptId, trash.changes.map(change => ({ ...change, before: change.after, after: change.before })), { remove: [`trash:${id}`] })
}
export async function deleteClue(id: string): Promise<void> {
  const clue = await getRecord<ClueRecord>('clues', id)
  if (!clue) return
  const changes: VaultRecordChange[] = []
  const remember = (kind: VaultRecordKind, before: Stored, after: unknown = null) => changes.push({ kind, id: before.id, before, after })
  for (const item of await listTimelineEvents(clue.scriptId)) {
    if (item.clueId !== id && !item.evidence?.some(source => source.clueId === id)) continue
    const evidence = (item.evidence || []).filter(source => source.clueId !== id)
    remember('timeline', item, item.clueId !== id || evidence.length ? { ...item, evidence, clueId: item.clueId === id ? evidence[0]!.clueId : item.clueId } : null)
  }
  const removedCards = new Set<string>()
  for (const item of await listBoardItems(clue.scriptId)) if (item.kind === 'clue' && item.refId === id) { removedCards.add(item.id); remember('board_items', item) }
  for (const link of await listBoardLinks(clue.scriptId)) if (removedCards.has(link.fromId) || removedCards.has(link.toId)) remember('board_links', link)
  for (const item of await listNotes(clue.scriptId)) if (item.clueId === id) remember('notes', item)
  const annotation = await getAnnotation(id)
  if (annotation) remember('annotations', { ...annotation, scriptId: clue.scriptId })
  const organization = await getOrganization(clue.scriptId)
  if (organization) {
    const processedClues = { ...(organization.processedClues || {}) }; delete processedClues[id]
    remember('organization', organization, { ...organization, people: organization.people.filter(item => item.sourceNo !== clue.number), relationships: organization.relationships.filter(item => item.sourceNo !== clue.number), timeline: organization.timeline.filter(item => item.sourceNo !== clue.number && !item.evidence?.some(source => source.clueId === id || source.sourceNo === clue.number)), cluePoints: organization.cluePoints.filter(item => item.sourceNo !== clue.number), timelineAudit: organization.timelineAudit?.filter(item => item.sourceNo !== clue.number), processedClues, updatedAt: now() })
  }
  remember('clues', clue)
  const trash: ClueTrashRecord = { id, label: `#${String(clue.number).padStart(3, '0')} ${clue.title}`, deletedAt: now(), kind: 'clue', changes }
  // Photos remain on disk; explicit script deletion still removes the entire archive.
  await applyRecordChanges(clue.scriptId, changes, { save: [{ key: `trash:${id}`, value: trash }] })
}
export async function searchClues(scriptId: string, query: string): Promise<ClueRecord[]> {
  const clues = await listClues(scriptId)
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return clues
  return clues.filter((clue) => {
    const haystack = `${clue.title}\n${clue.ocrText}\n${clue.notes}\n${clue.category}\n${clue.tags.join(' ')}`.toLocaleLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export async function listPeople(scriptId: string): Promise<PersonRecord[]> { return listRecords('people', scriptId) }
export async function createPerson(scriptId: string, input: Partial<PersonRecord>): Promise<PersonRecord> {
  const photoPath = input.photoPath?.startsWith('data:') ? await saveImage(scriptId, input.photoPath, input.photoPath.slice(5, input.photoPath.indexOf(';'))) : input.photoPath || ''
  return putRecord('people', { id: uid(), scriptId, name: (input.name || '').trim(), aliases: input.aliases || [], photoPath, notes: input.notes || '' })
}
export async function updatePerson(id: string, patch: Partial<PersonRecord>): Promise<PersonRecord> {
  const existing = await getRecord<PersonRecord>('people', id)
  if (!existing) throw new Error('人物不存在')
  const photoPath = patch.photoPath?.startsWith('data:') ? await saveImage(existing.scriptId, patch.photoPath, patch.photoPath.slice(5, patch.photoPath.indexOf(';'))) : patch.photoPath
  if (photoPath && photoPath !== existing.photoPath) await deleteImage(existing.photoPath)
  return putRecord('people', { ...existing, ...patch, photoPath: photoPath ?? existing.photoPath, id, scriptId: existing.scriptId })
}
export async function restorePerson(record: PersonRecord): Promise<PersonRecord> {
  const existing = await getRecord<PersonRecord>('people', record.id)
  if (existing && existing.scriptId !== record.scriptId) throw new Error('人物不属于当前剧本')
  return putRecord('people', { ...record })
}
export async function deletePerson(id: string): Promise<void> {
  const person = await getRecord<PersonRecord>('people', id)
  if (!person) return
  for (const relation of await listRelationships(person.scriptId)) if (relation.fromId === id || relation.toId === id) await deleteRelationship(relation.id)
  for (const item of await listBoardItems(person.scriptId)) if (item.kind === 'person' && item.refId === id) await deleteBoardItem(item.id)
  for (const event of await listTimelineEvents(person.scriptId)) if (event.personIds.includes(id)) await updateTimelineEvent(event.id, { personIds: event.personIds.filter((personId) => personId !== id) })
  for (const note of await listNotes(person.scriptId)) if (note.personId === id) await deleteNote(note.id)
  await deleteImage(person.photoPath)
  await removeRecord('people', id)
}
export function personAppearsInClue(person: PersonRecord, clue: ClueRecord): boolean {
  return [person.name, ...person.aliases].some((name) => name.trim() && clue.ocrText.includes(name.trim()))
}

export async function listRelationships(scriptId: string): Promise<RelationshipRecord[]> { return listRecords('relationships', scriptId) }
export async function createRelationship(scriptId: string, input: Partial<RelationshipRecord>): Promise<RelationshipRecord> {
  return putRecord('relationships', { id: uid(), scriptId, fromId: input.fromId || '', toId: input.toId || '', label: input.label || '' })
}
export async function restoreRelationship(record: RelationshipRecord): Promise<RelationshipRecord> {
  const existing = await getRecord<RelationshipRecord>('relationships', record.id)
  if (existing && existing.scriptId !== record.scriptId) throw new Error('关系不属于当前剧本')
  return putRecord('relationships', { ...record })
}
export async function deleteRelationship(id: string): Promise<void> { await removeRecord('relationships', id) }

export async function listTimelineEvents(scriptId: string): Promise<TimelineRecord[]> {
  return (await listRecords<TimelineRecord>('timeline', scriptId)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}
function timelineIdentity(item: Pick<TimelineRecord, 'title' | 'startsAt' | 'personIds'>): string {
  return JSON.stringify([organizationTextKey(item.title), item.startsAt, [...new Set(item.personIds)].sort()])
}
async function timelineEvidence(scriptId: string, input: Partial<TimelineRecord>): Promise<OrganizationEvidence[]> {
  const clues = await listClues(scriptId)
  const sources = new Map(clues.map(clue => [clue.id, clue]))
  const evidence = new Map<string, OrganizationEvidence>()
  for (const source of input.evidence || []) {
    const clue = sources.get(source.clueId)
    if (clue) evidence.set(JSON.stringify([clue.id, source.quote]), { clueId: clue.id, sourceNo: clue.number, quote: source.quote })
  }
  if (input.clueId && sources.has(input.clueId) && ![...evidence.values()].some(item => item.clueId === input.clueId)) {
    evidence.set(JSON.stringify([input.clueId, '']), { clueId: input.clueId, sourceNo: sources.get(input.clueId)!.number, quote: '' })
  }
  return [...evidence.values()]
}
export async function mergeTimelineEvidence(existing: TimelineRecord, input: Partial<TimelineRecord>): Promise<TimelineRecord> {
  const evidence = await timelineEvidence(existing.scriptId, { clueId: existing.clueId || input.clueId, evidence: [...(existing.evidence || []), ...(input.evidence || [])] })
  if (input.clueId && input.clueId !== existing.clueId && !evidence.some(item => item.clueId === input.clueId)) evidence.push(...await timelineEvidence(existing.scriptId, { clueId: input.clueId }))
  return putRecord('timeline', { ...existing, evidence, clueId: existing.clueId || evidence[0]?.clueId || '' })
}
export async function createTimelineEvent(scriptId: string, input: Partial<TimelineRecord>): Promise<TimelineRecord> {
  const record: TimelineRecord = { id: uid(), scriptId, title: input.title || '', startsAt: input.startsAt || '', personIds: input.personIds || [], clueId: input.clueId || '', confirmed: input.confirmed ?? true, yearlessMarkerIgnored: input.yearlessMarkerIgnored ?? false, evidence: await timelineEvidence(scriptId, input), precision: input.precision, approximate: input.approximate }
  if (record.title && !/待确认|待补充/.test(record.title)) {
    const duplicate = (await listTimelineEvents(scriptId)).find(event => event.confirmed === record.confirmed && timelineIdentity(event) === timelineIdentity(record))
    if (duplicate) return mergeTimelineEvidence(duplicate, record)
  }
  return putRecord('timeline', record)
}
export async function restoreTimelineEvent(record: TimelineRecord): Promise<TimelineRecord> {
  const existing = await getRecord<TimelineRecord>('timeline', record.id)
  if (existing && existing.scriptId !== record.scriptId) throw new Error('时间节点不属于当前剧本')
  return putRecord('timeline', { ...record })
}
export async function updateTimelineEvent(id: string, patch: Partial<TimelineRecord>): Promise<TimelineRecord> {
  const existing = await getRecord<TimelineRecord>('timeline', id)
  if (!existing) throw new Error('时间节点不存在')
  return putRecord('timeline', { ...existing, ...patch, id, scriptId: existing.scriptId })
}
export async function deleteTimelineEvent(id: string): Promise<void> { await removeRecord('timeline', id) }

export async function listBoardItems(scriptId: string): Promise<BoardItemRecord[]> { return listRecords('board_items', scriptId) }
export async function upsertBoardItem(scriptId: string, input: Partial<BoardItemRecord>): Promise<BoardItemRecord> {
  const existing = input.id ? await getRecord<BoardItemRecord>('board_items', input.id) : null
  return putRecord('board_items', { id: existing?.id || uid(), scriptId, kind: input.kind || existing?.kind || 'note', refId: input.refId ?? existing?.refId ?? '', text: input.text ?? existing?.text ?? '', x: input.x ?? existing?.x ?? 80, y: input.y ?? existing?.y ?? 80, color: input.color ?? existing?.color ?? '#f2eadc', group: input.group ?? existing?.group ?? '' })
}
export async function deleteBoardItem(id: string): Promise<void> {
  const item = await getRecord<BoardItemRecord>('board_items', id)
  if (!item) return
  for (const link of await listBoardLinks(item.scriptId)) if (link.fromId === id || link.toId === id) await deleteBoardLink(link.id)
  await removeRecord('board_items', id)
}
export async function listBoardLinks(scriptId: string): Promise<BoardLinkRecord[]> { return listRecords('board_links', scriptId) }
export async function createBoardLink(scriptId: string, input: Partial<BoardLinkRecord>): Promise<BoardLinkRecord> {
  return putRecord('board_links', { id: uid(), scriptId, fromId: input.fromId || '', toId: input.toId || '', label: input.label || '' })
}
export async function deleteBoardLink(id: string): Promise<void> { await removeRecord('board_links', id) }

export async function listNotes(scriptId: string): Promise<NoteRecord[]> { return listRecords('notes', scriptId) }
export async function getOrganization(scriptId: string): Promise<OrganizationSnapshot | null> {
  return (await listRecords<OrganizationSnapshot>('organization', scriptId))[0] || null
}
export async function saveOrganization(scriptId: string, result: OrganizationSnapshot): Promise<OrganizationSnapshot> {
  return putRecord('organization', { ...result, id: `organization-${scriptId}`, scriptId, updatedAt: now() })
}
export async function resolveOrganizationSuggestion(scriptId: string, kind: OrganizationSuggestionKind, id: string): Promise<void> {
  const result = await getOrganization(scriptId)
  if (!result) return
  const item = result[kind].find(value => value.id === id)
  const keys = new Set(result.resolvedKeys || [])
  if (item) {
    keys.add(suggestionKey(kind, item))
    if (kind === 'timeline') for (const source of (item as OrganizationTimelineSuggestion).evidence || []) keys.add(suggestionKey(kind, { ...item, sourceNo: source.sourceNo, quote: source.quote }))
  }
  await saveOrganization(scriptId, { ...result, resolvedKeys: [...keys], [kind]: result[kind].filter(item => item.id !== id) })
}

export async function createNote(scriptId: string, input: Partial<NoteRecord>): Promise<NoteRecord> {
  return putRecord('notes', { id: uid(), scriptId, clueId: input.clueId || '', personId: input.personId || '', text: input.text || '', createdAt: now() })
}
export async function updateNote(id: string, patch: Partial<NoteRecord>): Promise<NoteRecord> {
  const existing = await getRecord<NoteRecord>('notes', id)
  if (!existing) throw new Error('笔记不存在')
  return putRecord('notes', { ...existing, ...patch, id, scriptId: existing.scriptId })
}
export async function deleteNote(id: string): Promise<void> { await removeRecord('notes', id) }
export async function getAnnotation(clueId: string): Promise<AnnotationRecord | null> {
  return (await listRecords<AnnotationRecord>('annotations')).find((item) => item.clueId === clueId) || null
}
export async function saveAnnotation(clueId: string, strokes: unknown[]): Promise<AnnotationRecord> {
  const existing = await getAnnotation(clueId)
  const clue = await getRecord<ClueRecord>('clues', clueId)
  if (!clue) throw new Error('线索不存在')
  return putRecord('annotations', { id: existing?.id || uid(), scriptId: clue.scriptId, clueId, strokes }) as Promise<AnnotationRecord>
}

const archiveTables: Table[] = ['clues', 'people', 'relationships', 'timeline', 'board_items', 'board_links', 'notes', 'annotations', 'organization']
export type ArchiveStatus = { generatedAt: string; fileName: string; clueCount: number; personCount: number; eventCount: number; noteCount: number; changed: boolean }
type SavedArchiveStatus = Omit<ArchiveStatus, 'changed'> & { fingerprint: string }
type ArchiveSource = { script: ScriptRecord; records: Record<string, unknown[]> }

async function archiveSource(id: string): Promise<ArchiveSource> {
  const script = await getRecord<ScriptRecord>('scripts', id)
  if (!script) throw new Error('剧本不存在')
  const records: Record<string, unknown[]> = {}
  for (const table of archiveTables) records[table] = await listRecords(table, id)
  return { script, records }
}
function archiveCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(archiveCanonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, archiveCanonical((value as Record<string, unknown>)[key])]))
  return value
}
async function archiveDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function archiveFingerprint(source: ArchiveSource, zip?: JSZip): Promise<string> {
  const { script, records } = source
  const paths = [...new Set([script.coverPath, ...(records.clues as ClueRecord[]).flatMap(item => [item.imagePath, item.displayImagePath, item.ocrImagePath || '']), ...(records.people as PersonRecord[]).flatMap(item => [item.photoPath, ...(item.photoPaths || [])]), ...(records.board_items as BoardItemRecord[]).filter(item => item.kind === 'photo').map(item => item.refId)].filter(Boolean))].sort()
  const attachments: { path: string; length: number; digest: string }[] = []
  for (const path of paths) {
    // Hash the exact attachment data being archived; replacing a file at the same path is still a change.
    const data = await readImage(path)
    if (!data) throw new Error('图片暂时无法读取，请稍后重试')
    if (zip) zip.file(path, data, { base64: true })
    attachments.push({ path, length: data.length, digest: await archiveDigest(data) })
  }
  const orderedRecords = Object.fromEntries(archiveTables.map(table => [table, [...records[table]].sort((left, right) => {
    const a = String((left as Stored).id), b = String((right as Stored).id)
    return a < b ? -1 : a > b ? 1 : 0
  })]))
  return archiveDigest(JSON.stringify(archiveCanonical({ script, records: orderedRecords, attachments })))
}
export async function getArchiveStatus(scriptId: string): Promise<ArchiveStatus | null> {
  const saved = await getLocalState<SavedArchiveStatus>(scriptId, 'archive-status')
  if (!saved) return null
  const source = await archiveSource(scriptId)
  const fingerprint = await archiveFingerprint(source)
  const { fingerprint: previousFingerprint, ...status } = saved
  return { ...status, changed: previousFingerprint !== fingerprint }
}
export async function exportScript(id: string): Promise<void> {
  const source = await archiveSource(id)
  const { script, records } = source
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ format: 'clue-vault', version: 1, script, records }))
  const fingerprint = await archiveFingerprint(source, zip)
  const archive = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' })
  const fileName = native
    ? `${script.name.replace(/[\\/:*?"<>|]/g, '_') || '剧本'}-${Date.now()}.zip`
    : `${script.name || '剧本'}-档案.zip`
  const completed: SavedArchiveStatus = { generatedAt: now(), fileName, clueCount: records.clues.length, personCount: records.people.length, eventCount: records.timeline.length, noteCount: records.notes.length, fingerprint }
  if (native) {
    const result = await Filesystem.writeFile({ path: `exports/${fileName}`, data: archive, directory: Directory.Documents, recursive: true })
    // Share completion does not confirm that the user saved the archive outside this app.
    await saveLocalState(id, 'archive-status', completed)
    await Share.share({ title: `${script.name}档案`, files: [result.uri] })
  } else {
    const blob = new Blob([base64ToBytes(archive)], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    try {
      await saveLocalState(id, 'archive-status', completed)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.click()
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
  }
}
export type ArchiveImportPreview = {
  token: string; fileName: string; scriptName: string; playDate: string
  counts: { clues: number; people: number; relationships: number; events: number; notes: number; boardItems: number; annotations: number; suggestions: number; images: number }
  issues: string[]; warnings: string[]; canImport: boolean
}
type ArchiveManifest = { format: 'clue-vault'; version: 1; script: ScriptRecord; records: Record<string, any[]> }
type PreparedArchive = { manifestText: string; images: Map<string, Uint8Array> }
const preparedArchives = new Map<string, PreparedArchive>()
const archiveLimits = { bytes: 512 * 1024 * 1024, expanded: 1024 * 1024 * 1024, entry: 64 * 1024 * 1024, manifest: 32 * 1024 * 1024, files: 5000, records: 50000 }
const archiveObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeArchivePath = (path: string) => !!path && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !/^[a-z]:/i.test(path) && !path.split('/').some(part => part === '..' || part === '.')

// Inspect the public ZIP directory before decompression, without relying on JSZip private fields.
function archiveDirectory(bytes: Uint8Array): Map<string, number> {
  if (bytes.length > archiveLimits.bytes) throw new Error('档案超过导入容量上限：ZIP 文件最大 512 MiB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break }
  }
  if (end < 0) throw new Error('档案不是完整的 ZIP 文件')
  const count = view.getUint16(end + 10, true), directoryBytes = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true), expanded = 0
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count === 65535 || offset === 0xffffffff || directoryBytes === 0xffffffff) throw new Error('暂不支持分卷或 ZIP64 档案')
  if (count > archiveLimits.files) throw new Error('档案超过导入数量上限：最多 5000 个文件')
  if (offset + directoryBytes !== end) throw new Error('档案目录不完整')
  const entries = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('档案目录损坏')
    const size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > end || view.getUint16(offset + 8, true) & 1) throw new Error('档案目录损坏或使用了不支持的加密格式')
    const path = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (!safeArchivePath(path) || entries.has(path)) throw new Error('档案包含不安全或重复的文件路径')
    if (size > archiveLimits.entry || (expanded += size) > archiveLimits.expanded) throw new Error('档案超过导入容量上限：解压后总计最大 1 GiB，单张图片最大 64 MiB')
    entries.set(path, size); offset = next
  }
  if (offset !== end) throw new Error('档案目录不完整')
  return entries
}

function validateArchiveManifest(value: unknown, imagePaths: Set<string>): { manifest: ArchiveManifest | null; issues: string[] } {
  const issues: string[] = []
  const issue = (message: string) => { if (issues.length < 30 && !issues.includes(message)) issues.push(message) }
  if (!archiveObject(value) || value.format !== 'clue-vault' || value.version !== 1) return { manifest: null, issues: ['不支持的档案格式或版本'] }
  const script = value.script
  const records = archiveObject(value.records) ? { ...value.records } : null
  if (!archiveObject(script) || !['id', 'name', 'playDate', 'coverPath', 'createdAt'].every(key => typeof script[key] === 'string') || !script.id || !script.name.trim()) return { manifest: null, issues: ['剧本资料不完整'] }
  if (!records || !Array.isArray(records.clues)) return { manifest: null, issues: ['档案缺少必需的线索列表'] }
  for (const table of archiveTables) {
    if (records[table] === undefined) records[table] = []
    else if (!Array.isArray(records[table])) return { manifest: null, issues: ['档案资料列表格式不正确'] }
  }
  if (archiveTables.reduce((count, table) => count + records[table].length, 0) > archiveLimits.records) return { manifest: null, issues: ['档案超过导入数量上限：最多 50000 条资料'] }
  const identities = new Set<string>([script.id]), ids = new Map<string, Set<string>>()
  for (const table of archiveTables) {
    const tableIds = new Set<string>(); ids.set(table, tableIds)
    for (const record of records[table]) {
      if (!archiveObject(record) || typeof record.id !== 'string' || !record.id || record.scriptId !== script.id) { issue(`${table} 包含无效或跨剧本的资料`); continue }
      if (identities.has(record.id)) issue('档案存在重复资料编号')
      identities.add(record.id); tableIds.add(record.id)
    }
  }
  if (issues.length) return { manifest: null, issues }
  const strings = (record: Record<string, any>, keys: string[], label: string) => { if (!keys.every(key => typeof record[key] === 'string')) issue(`${label}字段格式不正确`) }
  const stringArray = (record: Record<string, any>, key: string, optional: boolean, label: string) => { if (!(optional && record[key] === undefined) && (!Array.isArray(record[key]) || !record[key].every((item: unknown) => typeof item === 'string'))) issue(`${label}字段格式不正确`) }
  const image = (path: unknown, required: boolean, label: string) => {
    if (typeof path !== 'string' || (required && !path)) { issue(`${label}缺少图片路径`); return }
    if (path && (!safeArchivePath(path) || !imagePaths.has(path))) issue(`${label}缺少图片：${path.slice(0, 100)}`)
  }
  const ref = (value: unknown, table: string, optional: boolean, label: string) => { if (!(optional && value === '') && (typeof value !== 'string' || !ids.get(table)?.has(value))) issue(`${label}引用的资料不存在`) }
  const clues = new Map<string, any>(records.clues.map((item: any) => [item.id, item]))
  const numbers = new Map<number, any>()
  const evidence = (sources: unknown, label: string) => {
    if (!Array.isArray(sources)) { issue(`${label}出处格式不正确`); return }
    for (const source of sources) if (!archiveObject(source) || typeof source.quote !== 'string' || !clues.has(source.clueId) || clues.get(source.clueId).number !== source.sourceNo) issue(`${label}出处指向缺失或不一致的线索`)
  }
  image(script.coverPath, false, '剧本封面')
  for (const record of records.clues) {
    strings(record, ['title', 'imagePath', 'displayImagePath', 'ocrText', 'category', 'notes', 'createdAt'], '线索')
    stringArray(record, 'tags', false, '标签')
    if (!Number.isInteger(record.number) || record.number < 1 || numbers.has(record.number)) issue('线索编号无效或重复')
    numbers.set(record.number, record)
    if (!Number.isInteger(record.round) || record.round < 1 || !Number.isFinite(record.rotation) || typeof record.favorite !== 'boolean') issue('线索轮次、旋转或收藏格式不正确')
    if (record.ocrStatus !== undefined && !['pending', 'complete', 'failed'].includes(record.ocrStatus)) issue('OCR 状态格式不正确')
    image(record.imagePath, true, '线索原图'); image(record.displayImagePath, false, '线索展示图')
    if (record.ocrImagePath !== undefined) image(record.ocrImagePath, false, 'OCR 定位原图')
    if (record.ocrRegions !== undefined && (!Array.isArray(record.ocrRegions) || !record.ocrRegions.every((region: any) => archiveObject(region) && typeof region.text === 'string' && [region.x, region.y, region.width, region.height].every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001))) issue('OCR 图片定位数据不正确')
  }
  for (const record of records.people) {
    strings(record, ['name', 'photoPath', 'notes'], '人物'); stringArray(record, 'aliases', false, '人物别名'); stringArray(record, 'photoPaths', true, '人物照片'); stringArray(record, 'ocrNames', true, 'OCR 错名映射')
    image(record.photoPath, false, '人物照片')
    if (Array.isArray(record.photoPaths)) record.photoPaths.forEach((path: unknown) => image(path, false, '人物照片'))
  }
  for (const record of records.relationships) { strings(record, ['label'], '人物关系'); ref(record.fromId, 'people', false, '人物关系'); ref(record.toId, 'people', false, '人物关系') }
  for (const record of records.timeline) {
    strings(record, ['title', 'startsAt'], '时间事件'); stringArray(record, 'personIds', false, '事件人物')
    if (typeof record.confirmed !== 'boolean') issue('事件确认状态格式不正确')
    if (Array.isArray(record.personIds)) record.personIds.forEach((id: unknown) => ref(id, 'people', false, '时间事件'))
    ref(record.clueId, 'clues', true, '时间事件')
    if (record.evidence !== undefined) evidence(record.evidence, '时间事件')
  }
  for (const record of records.board_items) {
    strings(record, ['refId', 'text', 'color', 'group'], '整理板卡片')
    if (!['clue', 'person', 'note', 'photo'].includes(record.kind) || !Number.isFinite(record.x) || !Number.isFinite(record.y)) issue('整理板卡片格式不正确')
    if (record.kind === 'clue') ref(record.refId, 'clues', false, '线索卡片')
    if (record.kind === 'person') ref(record.refId, 'people', false, '人物卡片')
    if (record.kind === 'note') ref(record.refId, 'notes', true, '笔记卡片')
    if (record.kind === 'photo') image(record.refId, true, '照片卡片')
  }
  for (const record of records.board_links) { strings(record, ['label'], '卡片连线'); ref(record.fromId, 'board_items', false, '卡片连线'); ref(record.toId, 'board_items', false, '卡片连线') }
  for (const record of records.notes) { strings(record, ['text', 'createdAt'], '笔记'); ref(record.clueId, 'clues', true, '笔记'); ref(record.personId, 'people', true, '笔记') }
  for (const record of records.annotations) { ref(record.clueId, 'clues', false, '标注'); if (!Array.isArray(record.strokes)) issue('手写标注格式不正确') }
  if (records.organization.length > 1) issue('一个剧本只能包含一份整理建议')
  for (const organization of records.organization) {
    strings(organization, ['updatedAt'], '整理建议')
    const suggestionIds = new Set<string>()
    for (const kind of ['people', 'relationships', 'timeline', 'cluePoints']) {
      if (!Array.isArray(organization[kind])) { issue('整理建议列表格式不正确'); continue }
      for (const item of organization[kind]) {
        if (!archiveObject(item)) { issue('整理建议格式不正确'); continue }
        strings(item, ['id', 'quote'], '整理建议')
        if (!item.id || suggestionIds.has(item.id)) issue('整理建议编号无效或重复')
        suggestionIds.add(item.id)
        if (!numbers.has(item.sourceNo)) issue('整理建议引用的原始线索不存在')
        if (kind === 'people') { strings(item, ['name'], '人物建议'); stringArray(item, 'aliases', false, '人物建议') }
        if (kind === 'relationships') strings(item, ['from', 'to', 'label'], '关系建议')
        if (kind === 'timeline') { strings(item, ['title', 'startsAt'], '时间建议'); stringArray(item, 'people', false, '时间建议'); if (item.evidence !== undefined) evidence(item.evidence, '时间建议') }
        if (kind === 'cluePoints') { strings(item, ['title', 'category'], '线索点建议'); stringArray(item, 'tags', false, '线索点建议') }
      }
    }
    if (organization.processedClues !== undefined && (!archiveObject(organization.processedClues) || !Object.entries(organization.processedClues).every(([id, fingerprint]) => clues.has(id) && typeof fingerprint === 'string'))) issue('整理进度引用的线索不存在或格式不正确')
    stringArray(organization, 'resolvedKeys', true, '已处理建议')
    if (organization.timelineAudit !== undefined && (!Array.isArray(organization.timelineAudit) || !organization.timelineAudit.every((item: any) => archiveObject(item) && numbers.has(item.sourceNo) && Number.isInteger(item.clocks) && Number.isInteger(item.covered) && ['complete', 'review'].includes(item.status) && typeof item.message === 'string'))) issue('时间核对记录格式不正确')
  }
  return { manifest: { ...value, records } as ArchiveManifest, issues }
}

export function discardScriptImportPreview(token: string): void { preparedArchives.delete(token) }

export async function previewScriptImport(): Promise<ArchiveImportPreview | null> {
  const picked = await CapgoFilePicker.pickFiles({ types: ['application/zip'], limit: 1, readData: true })
  const file = picked.files[0]
  if (!file) return null
  preparedArchives.clear()
  const preview: ArchiveImportPreview = { token: uid(), fileName: file.name || '剧本档案.zip', scriptName: '', playDate: '', counts: { clues: 0, people: 0, relationships: 0, events: 0, notes: 0, boardItems: 0, annotations: 0, suggestions: 0, images: 0 }, issues: [], warnings: [], canImport: false }
  try {
    if (file.size > archiveLimits.bytes) throw new Error('档案超过导入容量上限：ZIP 文件最大 512 MiB')
    const data = cleanBase64(file.data || (file.path ? await sourceBase64(file.path) : ''))
    if (!data) throw new Error('无法读取档案')
    if (data.length > Math.ceil(archiveLimits.bytes / 3) * 4) throw new Error('档案超过导入容量上限：ZIP 文件最大 512 MiB')
    const bytes = base64ToBytes(data), directory = archiveDirectory(bytes)
    const manifestSize = directory.get('manifest.json')
    if (manifestSize === undefined) throw new Error('档案缺少清单')
    if (manifestSize > archiveLimits.manifest) throw new Error('档案清单超过导入容量上限：清单最大 32 MiB')
    const zip = await JSZip.loadAsync(bytes)
    const manifestBytes = await zip.file('manifest.json')!.async('uint8array')
    if (manifestBytes.length !== manifestSize) throw new Error('档案清单大小与目录不一致')
    const rawManifestText = new TextDecoder().decode(manifestBytes), parsed: unknown = JSON.parse(rawManifestText)
    const validated = validateArchiveManifest(parsed, new Set(directory.keys()))
    preview.issues.push(...validated.issues)
    if (archiveObject(parsed) && archiveObject(parsed.script)) { preview.scriptName = typeof parsed.script.name === 'string' ? parsed.script.name : ''; preview.playDate = typeof parsed.script.playDate === 'string' ? parsed.script.playDate : '' }
    const manifest = validated.manifest
    if (!manifest || preview.issues.length) return preview
    const { records, script } = manifest
    const paths = [...new Set([script.coverPath, ...records.clues.flatMap(item => [item.imagePath, item.displayImagePath, item.ocrImagePath || '']), ...records.people.flatMap(item => [item.photoPath, ...(item.photoPaths || [])]), ...records.board_items.filter(item => item.kind === 'photo').map(item => item.refId)].filter(Boolean))] as string[]
    const images = new Map<string, Uint8Array>()
    let actualSize = manifestBytes.length
    for (const path of paths) {
      const image = await zip.file(path)?.async('uint8array')
      if (!image?.length || image.length !== directory.get(path)) throw new Error(`图片内容不完整：${path.slice(0, 100)}`)
      if ((actualSize += image.length) > archiveLimits.expanded) throw new Error('档案超过导入容量上限：解压后总计最大 1 GiB')
      images.set(path, image)
    }
    preview.counts = { clues: records.clues.length, people: records.people.length, relationships: records.relationships.length, events: records.timeline.length, notes: records.notes.length, boardItems: records.board_items.length, annotations: records.annotations.length, suggestions: records.organization.reduce((total, item) => total + item.people.length + item.relationships.length + item.timeline.length + item.cluePoints.length, 0), images: images.size }
    preview.warnings.push('此版本档案没有文件哈希清单；已检查资料格式、关联及图片是否存在且可解压，无法核验图片是否曾被替换。')
    if (archiveObject(parsed) && archiveObject(parsed.records) && archiveTables.some(table => parsed.records[table] === undefined)) preview.warnings.push('旧档案未包含的资料列表将恢复为空；所有已有资料的关联仍须通过预检。')
    if ((await listScripts()).some(existing => existing.name.trim() === script.name.trim())) preview.warnings.push('本机已有同名剧本。导入后会创建独立副本，不覆盖或混合已有资料。')
    preview.canImport = true
    preparedArchives.set(preview.token, { manifestText: JSON.stringify(manifest), images })
    return preview
  } catch (error) {
    preview.issues.push(error instanceof Error && !(error instanceof SyntaxError) ? error.message : '档案清单无法读取，请选择完整的导出档案')
    return preview
  }
}

export async function importPreparedScript(token: string): Promise<ScriptRecord> {
  const prepared = preparedArchives.get(token)
  if (!prepared) throw new Error('导入预览已失效，请重新选择档案')
  const validation = validateArchiveManifest(JSON.parse(prepared.manifestText), new Set(prepared.images.keys()))
  if (!validation.manifest || validation.issues.length) throw new Error(validation.issues[0] || '档案预检未通过')
  const manifest = validation.manifest, newScriptId = uid(), idMap = new Map<string, string>([[manifest.script.id, newScriptId]])
  for (const table of archiveTables) for (const record of manifest.records[table]) idMap.set(record.id, table === 'organization' ? `organization-${newScriptId}` : uid())
  const savedImages = new Map<string, string>(), createdPaths: string[] = []
  const remap = (id: string) => { if (!id) return ''; const mapped = idMap.get(id); if (!mapped) throw new Error('档案存在无法恢复的关联'); return mapped }
  const remapEvidence = (sources: OrganizationEvidence[]) => sources.map(source => ({ ...source, clueId: remap(source.clueId) }))
  async function importedImage(path: string): Promise<string> {
    if (!path) return ''
    if (savedImages.has(path)) return savedImages.get(path)!
    const bytes = prepared!.images.get(path)
    if (!bytes?.length) throw new Error('档案缺少图片')
    // Track the target path before writing, so a partial native write can also be removed.
    const target = `scripts/${newScriptId}/images/${uid()}.${extensionForMime(mimeForPath(path))}`
    createdPaths.push(target)
    const data = bytesToBase64(bytes)
    if (native) await Filesystem.writeFile({ path: target, data, directory: Directory.Data, recursive: true })
    else await webImagePut(target, data)
    savedImages.set(path, target); return target
  }
  let script: ScriptRecord | null = null
  try {
    script = { ...manifest.script, id: newScriptId, coverPath: await importedImage(manifest.script.coverPath), createdAt: now() }
    const changes: VaultRecordChange[] = []
    for (const table of archiveTables) for (const raw of manifest.records[table]) {
      const record = { ...raw, id: remap(raw.id), scriptId: newScriptId }
      if (table === 'clues') {
        record.imagePath = await importedImage(raw.imagePath); record.displayImagePath = await importedImage(raw.displayImagePath)
        if (raw.ocrImagePath !== undefined) record.ocrImagePath = await importedImage(raw.ocrImagePath)
      }
      if (table === 'people') { record.photoPath = await importedImage(raw.photoPath); if (raw.photoPaths) record.photoPaths = await Promise.all(raw.photoPaths.map(importedImage)) }
      if (table === 'relationships' || table === 'board_links') { record.fromId = remap(raw.fromId); record.toId = remap(raw.toId) }
      if (table === 'timeline') { record.personIds = raw.personIds.map(remap); record.clueId = remap(raw.clueId); if (raw.evidence) record.evidence = remapEvidence(raw.evidence) }
      if (table === 'notes') { record.clueId = remap(raw.clueId); record.personId = remap(raw.personId) }
      if (table === 'annotations') record.clueId = remap(raw.clueId)
      if (table === 'board_items') record.refId = raw.kind === 'photo' ? await importedImage(raw.refId) : remap(raw.refId)
      if (table === 'organization') {
        for (const kind of ['people', 'relationships', 'timeline', 'cluePoints']) record[kind] = raw[kind].map((item: any) => ({ ...item, id: uid(), ...(item.evidence ? { evidence: remapEvidence(item.evidence) } : {}) }))
        if (raw.processedClues) record.processedClues = Object.fromEntries(Object.entries(raw.processedClues).map(([id, value]) => [remap(id), value]))
      }
      changes.push({ kind: table as VaultRecordKind, id: record.id, before: null, after: record })
    }
    await applyRecordChanges(newScriptId, changes)
    // Publish the script after every attachment and linked record has been persisted.
    await putRecord('scripts', script)
    preparedArchives.delete(token)
    return script
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const table of [...archiveTables, 'scripts'] as Table[]) {
      try {
        if (native) await database.run(`DELETE FROM ${table} WHERE script_id = ?`, [newScriptId])
        else localStorage.setItem(webKey(table), JSON.stringify(webRecords<Stored>(table).filter(record => table === 'scripts' ? record.id !== newScriptId : record.scriptId !== newScriptId)))
      } catch (failure) { cleanupErrors.push(failure) }
    }
    if (native && ftsReady) { try { await database.run('DELETE FROM clue_fts WHERE script_id = ?', [newScriptId]) } catch (failure) { cleanupErrors.push(failure) } }
    for (const path of createdPaths) {
      try {
        if (native) await Filesystem.deleteFile({ path, directory: Directory.Data })
        else await webImageDelete(path)
      } catch { /* A failed write may not have created the target file. */ }
    }
    if (native) { try { await Filesystem.rmdir({ path: `scripts/${newScriptId}`, directory: Directory.Data, recursive: true }) } catch { /* No directory was created. */ } }
    if (cleanupErrors.length) throw new Error('导入未完成，清理本次副本时发生错误；已有剧本未被修改，请先关闭应用后重试')
    throw error
  }
}

// Kept for callers outside the review UI; the app uses preview + explicit confirmation.
export async function importScript(): Promise<ScriptRecord | null> {
  const preview = await previewScriptImport()
  if (!preview) return null
  if (!preview.canImport) { discardScriptImportPreview(preview.token); throw new Error(preview.issues.join('；')) }
  return importPreparedScript(preview.token)
}

export async function pickLocalImage(): Promise<string> {
  const picked = await CapgoFilePicker.pickImages({ limit: 1, readData: true })
  const file = picked.files[0]
  if (!file) return ''
  const data = file.data || (file.path ? await sourceBase64(file.path) : '')
  if (!data) throw new Error('无法读取所选图片')
  return `data:${file.mimeType || 'image/jpeg'};base64,${cleanBase64(data)}`
}

export async function cropCluePhoto(id: string, crop: { x: number; y: number; width: number; height: number }): Promise<ClueRecord> {
  const clue = await getRecord<ClueRecord>('clues', id)
  if (!clue) throw new Error('线索不存在')
  const data = await readImage(clue.imagePath)
  const original = new Image()
  await new Promise<void>((resolve, reject) => {
    original.onload = () => resolve()
    original.onerror = () => reject(new Error('无法读取线索图片'))
    original.src = `data:${mimeForPath(clue.imagePath)};base64,${data}`
  })
  const x = Math.max(0, Math.min(1, crop.x))
  const y = Math.max(0, Math.min(1, crop.y))
  const width = Math.max(0.01, Math.min(1 - x, crop.width))
  const height = Math.max(0.01, Math.min(1 - y, crop.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(original.naturalWidth * width))
  canvas.height = Math.max(1, Math.round(original.naturalHeight * height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法裁剪图片')
  context.drawImage(original, original.naturalWidth * x, original.naturalHeight * y, original.naturalWidth * width, original.naturalHeight * height, 0, 0, canvas.width, canvas.height)
  const imagePath = await saveImage(clue.scriptId, canvas.toDataURL('image/jpeg', 0.94), 'image/jpeg')
  await deleteImage(clue.displayImagePath)
  return updateClue(id, { displayImagePath: imagePath, displayImageKind: 'crop' })
}


export async function saveCorrectedCluePhoto(scriptId: string, id: string, dataUrl: string) {
  const clue = await getRecord<ClueRecord>('clues', id)
  if (!clue || clue.scriptId !== scriptId) throw new Error('线索不属于当前剧本')
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('无法读取校正后的照片')
  const path = await saveImage(scriptId, dataUrl, 'image/jpeg')
  try {
    const current = await getRecord<ClueRecord>('clues', id)
    if (!current || current.scriptId !== scriptId || current.imagePath !== clue.imagePath) throw new Error('原线索已变化，请重新打开后校正')
    const after: ClueRecord = { ...current, displayImagePath: path, displayImageKind: 'perspective' }
    const { applyUndoableChanges } = await import('./reviewActions')
    const undo = await applyUndoableChanges(scriptId, '保存四角校正视图', [{ kind: 'clues', id, before: current, after }])
    return { clue: after, undo }
  } catch (error) { await deleteImage(path); throw error }
}

export async function retakeCluePhoto(scriptId: string, id: string) {
  const clue = await getRecord<ClueRecord>('clues', id)
  if (!clue || clue.scriptId !== scriptId) throw new Error('线索不属于当前剧本')
  const photo = await Camera.takePhoto({ quality: 90, includeMetadata: true })
  const uri = photo.uri || photo.webPath
  if (!uri) throw new Error('无法读取补拍照片')
  const path = await saveImage(scriptId, await sourceBase64(uri), mimeForPath(uri))
  try {
    const current = await getRecord<ClueRecord>('clues', id)
    if (!current || current.scriptId !== scriptId || current.imagePath !== clue.imagePath) throw new Error('原线索已变化，请重新打开后补拍')
    const after: ClueRecord = { ...current, displayImagePath: path, displayImageKind: 'retake' }
    const { applyUndoableChanges } = await import('./reviewActions')
    const undo = await applyUndoableChanges(scriptId, '保存线索补拍照片', [{ kind: 'clues', id, before: current, after }])
    return { clue: after, undo }
  } catch (error) { await deleteImage(path); throw error }
}
