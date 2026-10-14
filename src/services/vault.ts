import { Capacitor } from '@capacitor/core'
import { Camera } from '@capacitor/camera'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { CapgoFilePicker } from '@capgo/capacitor-file-picker'
import { Ocr } from '@jcesarmobile/capacitor-ocr'
import JSZip from 'jszip'

export type ScriptRecord = { id: string; name: string; playDate: string; coverPath: string; createdAt: string }
export type ClueRecord = { id: string; scriptId: string; number: number; title: string; imagePath: string; displayImagePath: string; ocrText: string; round: number; category: string; tags: string[]; favorite: boolean; notes: string; rotation: number; createdAt: string }
export type PersonRecord = { id: string; scriptId: string; name: string; aliases: string[]; photoPath: string; notes: string }
export type RelationshipRecord = { id: string; scriptId: string; fromId: string; toId: string; label: string }
export type TimelineRecord = { id: string; scriptId: string; title: string; startsAt: string; personIds: string[]; clueId: string; confirmed: boolean }
export type BoardItemRecord = { id: string; scriptId: string; kind: 'clue' | 'person' | 'note' | 'photo'; refId: string; text: string; x: number; y: number; color: string; group: string }
export type BoardLinkRecord = { id: string; scriptId: string; fromId: string; toId: string; label: string }
export type NoteRecord = { id: string; scriptId: string; clueId: string; personId: string; text: string; createdAt: string }
export type OrganizationPersonSuggestion = { id: string; name: string; aliases: string[]; sourceNo: number; quote: string }
export type OrganizationRelationshipSuggestion = { id: string; from: string; to: string; label: string; sourceNo: number; quote: string }
export type OrganizationTimelineSuggestion = { id: string; title: string; startsAt: string; people: string[]; sourceNo: number; quote: string; requiresTitle?: boolean }
export type OrganizationCluePointSuggestion = { id: string; title: string; category: string; tags: string[]; sourceNo: number; quote: string }
export type OrganizationSnapshot = { id: string; scriptId: string; updatedAt: string; people: OrganizationPersonSuggestion[]; relationships: OrganizationRelationshipSuggestion[]; timeline: OrganizationTimelineSuggestion[]; cluePoints: OrganizationCluePointSuggestion[] }
export type AnnotationRecord = { id: string; clueId: string; strokes: unknown[] }

type Table = 'scripts' | 'clues' | 'people' | 'relationships' | 'timeline' | 'board_items' | 'board_links' | 'notes' | 'annotations' | 'organization'
type Stored = { id: string; scriptId?: string }
const tables: Table[] = ['scripts', 'clues', 'people', 'relationships', 'timeline', 'board_items', 'board_links', 'notes', 'annotations', 'organization']
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
  if (imageUrls.has(path)) return imageUrls.get(path)!
  let url: string
  if (native) {
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data })
    url = Capacitor.convertFileSrc(uri)
  } else {
    const base64 = await readImage(path)
    url = `data:${mimeForPath(path)};base64,${base64}`
  }
  imageUrls.set(path, url)
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
  for (const person of await listPeople(id)) await deleteImage(person.photoPath)
  await deleteImage(script.coverPath)
  for (const table of tables.filter((item) => item !== 'scripts')) {
    for (const item of await listRecords<Stored>(table, id)) await removeRecord(table, item.id)
  }
  await removeRecord('scripts', id)
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
async function addPhoto(scriptId: string, uri: string, mime: string): Promise<ClueRecord> {
  const data = await sourceBase64(uri)
  const imagePath = await saveImage(scriptId, data, mime)
  try {
    const result = native ? await Ocr.process({ image: `data:${mime};base64,${data}` }) : { results: [] as { text: string }[] }
    const ocrText = result.results.map((item) => item.text).join('\n')
    const existing = await listClues(scriptId)
    const number = Math.max(0, ...existing.map((clue) => clue.number)) + 1
    const clue: ClueRecord = { id: uid(), scriptId, number, title: `线索 ${String(number).padStart(3, '0')}`, imagePath, displayImagePath: '', ocrText, round: 1, category: categoryFromText(ocrText), tags: [], favorite: false, notes: '', rotation: 0, createdAt: now() }
    await putRecord('clues', clue)
    await addTimeCandidates(clue)
    return clue
  } catch (error) {
    await deleteImage(imagePath)
    throw error
  }
}
export async function captureClues(scriptId: string): Promise<ClueRecord[]> {
  const photo = await Camera.takePhoto({ quality: 90, includeMetadata: true })
  const uri = photo.uri || photo.webPath
  if (!uri) throw new Error('无法读取拍摄照片')
  return [await addPhoto(scriptId, uri, mimeForPath(uri))]
}
export async function importCluePhotos(scriptId: string): Promise<ClueRecord[]> {
  const selection = await Camera.chooseFromGallery({ allowMultipleSelection: true, limit: 0, includeMetadata: true })
  const added: ClueRecord[] = []
  for (const photo of selection.results) {
    const uri = photo.uri || photo.webPath
    if (!uri) throw new Error('无法读取相册照片')
    added.push(await addPhoto(scriptId, uri, mimeForPath(uri)))
  }
  return added
}
export async function updateClue(id: string, patch: Partial<ClueRecord>): Promise<ClueRecord> {
  const existing = await getRecord<ClueRecord>('clues', id)
  if (!existing) throw new Error('线索不存在')
  return putRecord('clues', { ...existing, ...patch, id, scriptId: existing.scriptId, imagePath: existing.imagePath })
}
export async function deleteClue(id: string): Promise<void> {
  const clue = await getRecord<ClueRecord>('clues', id)
  if (!clue) return
  for (const item of await listTimelineEvents(clue.scriptId)) if (item.clueId === id) await deleteTimelineEvent(item.id)
  for (const item of await listBoardItems(clue.scriptId)) if (item.kind === 'clue' && item.refId === id) await deleteBoardItem(item.id)
  for (const item of await listNotes(clue.scriptId)) if (item.clueId === id) await deleteNote(item.id)
  const annotation = await getAnnotation(id)
  if (annotation) await removeRecord('annotations', annotation.id)
  await deleteImage(clue.imagePath)
  await deleteImage(clue.displayImagePath)
  await removeRecord('clues', id)
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
export async function deleteRelationship(id: string): Promise<void> { await removeRecord('relationships', id) }

export async function listTimelineEvents(scriptId: string): Promise<TimelineRecord[]> {
  return (await listRecords<TimelineRecord>('timeline', scriptId)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}
export async function createTimelineEvent(scriptId: string, input: Partial<TimelineRecord>): Promise<TimelineRecord> {
  return putRecord('timeline', { id: uid(), scriptId, title: input.title || '', startsAt: input.startsAt || '', personIds: input.personIds || [], clueId: input.clueId || '', confirmed: input.confirmed ?? true })
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
export async function resolveOrganizationSuggestion(scriptId: string, kind: 'people' | 'relationships' | 'timeline' | 'cluePoints', id: string): Promise<void> {
  const result = await getOrganization(scriptId)
  if (!result) return
  await saveOrganization(scriptId, { ...result, [kind]: result[kind].filter(item => item.id !== id) })
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
export async function exportScript(id: string): Promise<void> {
  const script = await getRecord<ScriptRecord>('scripts', id)
  if (!script) throw new Error('剧本不存在')
  const records: Record<string, unknown[]> = {}
  for (const table of archiveTables) records[table] = await listRecords(table, id)
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ format: 'clue-vault', version: 1, script, records }))
  const paths = [script.coverPath, ...(records.clues as ClueRecord[]).flatMap((item) => [item.imagePath, item.displayImagePath]), ...(records.people as PersonRecord[]).map((item) => item.photoPath)].filter(Boolean)
  for (const path of paths) zip.file(path, await readImage(path), { base64: true })
  const archive = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' })
  if (native) {
    const path = `exports/${script.name.replace(/[\\/:*?"<>|]/g, '_') || '剧本'}-${Date.now()}.zip`
    const result = await Filesystem.writeFile({ path, data: archive, directory: Directory.Documents, recursive: true })
    await Share.share({ title: `${script.name}档案`, files: [result.uri] })
  } else {
    const blob = new Blob([base64ToBytes(archive)], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${script.name || '剧本'}-档案.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
export async function importScript(): Promise<ScriptRecord | null> {
  const picked = await CapgoFilePicker.pickFiles({ types: ['application/zip'], limit: 1, readData: true })
  const file = picked.files[0]
  if (!file) return null
  const data = file.data || (file.path ? await sourceBase64(file.path) : '')
  if (!data) throw new Error('无法读取档案')
  const zip = await JSZip.loadAsync(cleanBase64(data), { base64: true })
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) throw new Error('档案缺少清单')
  const manifest = JSON.parse(await manifestFile.async('string')) as { format: string; version: number; script: ScriptRecord; records: Record<string, any[]> }
  if (manifest.format !== 'clue-vault' || manifest.version !== 1) throw new Error('不支持的档案格式')
  const oldScriptId = manifest.script.id
  const newScriptId = uid()
  const idMap = new Map<string, string>([[oldScriptId, newScriptId]])
  for (const table of archiveTables) for (const record of manifest.records[table] || []) idMap.set(record.id, uid())
  async function importedImage(path: string): Promise<string> {
    if (!path) return ''
    const entry = zip.file(path)
    if (!entry) throw new Error(`档案缺少图片：${path}`)
    const imageData = await entry.async('base64')
    return saveImage(newScriptId, imageData, mimeForPath(path))
  }
  const script: ScriptRecord = { ...manifest.script, id: newScriptId, coverPath: await importedImage(manifest.script.coverPath), createdAt: now() }
  await putRecord('scripts', script)
  for (const table of archiveTables) {
    for (const raw of manifest.records[table] || []) {
      const record = { ...raw, id: idMap.get(raw.id), scriptId: newScriptId }
      for (const key of ['clueId', 'personId', 'fromId', 'toId', 'refId']) if (record[key]) record[key] = idMap.get(record[key]) || ''
      if (Array.isArray(record.personIds)) record.personIds = record.personIds.map((id: string) => idMap.get(id) || '').filter(Boolean)
      if (table === 'clues') { record.imagePath = await importedImage(raw.imagePath); record.displayImagePath = await importedImage(raw.displayImagePath) }
      if (table === 'people') record.photoPath = await importedImage(raw.photoPath)
      await putRecord(table, record)
    }
  }
  return script
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
  return updateClue(id, { displayImagePath: imagePath })
}
