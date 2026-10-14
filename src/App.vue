<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { IonApp } from '@ionic/vue'
import { VueFlow, type Connection, type Node, type Edge } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { Timeline } from 'vis-timeline/standalone'
import UiIcon from './components/UiIcon.vue'
import AnnotationEditor from './components/AnnotationEditor.vue'
import OrganizationOverview from './components/OrganizationOverview.vue'
import * as organizer from './services/organizer'
import * as vault from './services/vault'
import type { ScriptRecord, ClueRecord, PersonRecord, RelationshipRecord, TimelineRecord, BoardItemRecord, BoardLinkRecord, NoteRecord, OrganizationSnapshot, OrganizationTimelineSuggestion } from './services/vault'

const scripts = ref<ScriptRecord[]>([])
const clues = ref<ClueRecord[]>([])
const people = ref<PersonRecord[]>([])
const relationships = ref<RelationshipRecord[]>([])
const events = ref<TimelineRecord[]>([])
const boardItems = ref<BoardItemRecord[]>([])
const boardLinks = ref<BoardLinkRecord[]>([])
const notes = ref<NoteRecord[]>([])
const organization = ref<OrganizationSnapshot | null>(null)
const apiKeyDraft = ref('')
const apiKeyConfigured = ref(false)
const autoOrganize = ref(localStorage.getItem('clue-vault:auto-organize') === 'true')
const activeScriptId = ref('')
const view = ref<'clues' | 'organize' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings'>('clues')
const mode = ref<'capture' | 'organize'>('capture')
const busy = ref(false)
const toast = ref('')
const query = ref('')
const filterRound = ref('')
const filterCategory = ref('')
const filterPerson = ref('')
const favoriteOnly = ref(false)
const layout = ref<'grid' | 'list'>('list')
const searchIds = ref<string[] | null>(null)
const imageUrls = reactive<Record<string, string>>({})
const compareIds = ref<string[]>([])
const detailId = ref('')
const scriptDialog = ref(false)
const clueDialog = ref(false)
const personDialog = ref(false)
const relationshipDialog = ref(false)
const eventDialog = ref(false)
const noteDialog = ref(false)
const boardDialog = ref(false)
const boardLinkDialog = ref(false)
const annotationOpen = ref(false)
const cropDialog = ref(false)
const cropImage = ref<HTMLImageElement | null>(null)
const cropStart = ref<{ x: number; y: number } | null>(null)
const cropEnd = ref<{ x: number; y: number } | null>(null)
const cropping = ref(false)
const relationGraph = ref(false)
const photoZoom = ref(false)
const noteId = ref('')
const editingScriptId = ref('')
const editingPersonId = ref('')
const editingEventId = ref('')
const pendingTimelineSuggestionId = ref('')
const editingBoardId = ref('')
const selectedBoardId = ref('')
const boardZoom = ref(1)
const scriptForm = reactive({ name: '', playDate: '', coverPath: '' })
const clueForm = reactive({ title: '', ocrText: '', round: '', category: '', tags: '', notes: '' })
const personForm = reactive({ name: '', aliases: '', notes: '', photoPath: '' })
const relationForm = reactive({ fromId: '', toId: '', label: '' })
const eventForm = reactive({ title: '', startsAt: '', yearless: false, personIds: [] as string[], clueId: '' })
const noteForm = reactive({ text: '', clueId: '', personId: '' })
const boardForm = reactive({ kind: 'note' as BoardItemRecord['kind'], refId: '', text: '', color: '#f2cc88', group: '' })
const boardLinkForm = reactive({ fromId: '', toId: '', label: '' })
const timelineElement = ref<HTMLElement | null>(null)
let timelineInstance: Timeline | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
let searchSequence = 0

const nav = [
  { id: 'clues', label: '线索库', icon: 'archive' },
  { id: 'organize', label: '整理总览', icon: 'board' },
  { id: 'settings', label: '剧本管理', icon: 'file' },
] as const
const activeNavId = computed(() => ['people', 'timeline', 'board', 'notes', 'compare'].includes(view.value) ? 'organize' : view.value)
const viewLabel = computed(() => ({ clues: '线索库', organize: '整理总览', people: '人物档案', timeline: '时间线', board: '自由整理板', notes: '笔记', compare: '线索对照', settings: '剧本管理' })[view.value])
const activeScript = computed(() => scripts.value.find(item => item.id === activeScriptId.value))
const selectedClue = computed(() => clues.value.find(item => item.id === detailId.value))
const selectedBoardItem = computed(() => boardItems.value.find(item => item.id === selectedBoardId.value))
const compareClues = computed(() => compareIds.value.map(id => clues.value.find(item => item.id === id)).filter((item): item is ClueRecord => Boolean(item)))
const confirmedEvents = computed(() => events.value.filter(item => item.confirmed))
const datedConfirmedEvents = computed(() => confirmedEvents.value.filter(item => !item.startsAt.startsWith('--')))
const yearlessEvents = computed(() => sortedConfirmedEvents.value.filter(item => item.startsAt.startsWith('--')))
const sortedConfirmedEvents = computed(() => [...confirmedEvents.value].sort((a, b) => Number(a.startsAt.startsWith('--')) - Number(b.startsAt.startsWith('--')) || a.startsAt.localeCompare(b.startsAt)))
const candidateEvents = computed(() => events.value.filter(item => !item.confirmed))
const cropStyle = computed(() => {
  if (!cropStart.value || !cropEnd.value) return {}
  const left = Math.min(cropStart.value.x, cropEnd.value.x) * 100
  const top = Math.min(cropStart.value.y, cropEnd.value.y) * 100
  return { left: `${left}%`, top: `${top}%`, width: `${Math.abs(cropStart.value.x - cropEnd.value.x) * 100}%`, height: `${Math.abs(cropStart.value.y - cropEnd.value.y) * 100}%` }
})
const rounds = computed(() => [...new Set(clues.value.map(item => item.round).filter(Boolean))].sort())
const categories = computed(() => [...new Set(clues.value.map(item => item.category).filter(Boolean))].sort())
const visibleClues = computed(() => clues.value.filter(item => {
  if (searchIds.value && !searchIds.value.includes(item.id)) return false
  if (filterRound.value && item.round !== filterRound.value) return false
  if (filterCategory.value && item.category !== filterCategory.value) return false
  if (favoriteOnly.value && !item.favorite) return false
  if (filterPerson.value) {
    const person = people.value.find(value => value.id === filterPerson.value)
    if (person && ![person.name, ...person.aliases].some(name => name && `${item.title} ${item.ocrText} ${item.notes}`.includes(name))) return false
  }
  return true
}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const personClueCount = (person: PersonRecord) => clues.value.filter(clue => [person.name, ...person.aliases].some(name => name && `${clue.title} ${clue.ocrText}`.includes(name))).length
const boardNodes = computed<Node[]>(() => boardItems.value.map(item => ({
  id: item.id,
  type: 'default',
  position: { x: item.x, y: item.y },
  data: { label: item.kind === 'clue' ? clues.value.find(clue => clue.id === item.refId)?.title || '线索' : item.kind === 'person' ? people.value.find(person => person.id === item.refId)?.name || '人物' : item.text || '便签' },
  class: `board-node board-node-${item.kind}`,
  style: { background: item.color || '#fffaf0' },
})))
const boardEdges = computed<Edge[]>(() => boardLinks.value.map(link => ({ id: link.id, source: link.fromId, target: link.toId, label: link.label || undefined, animated: false, style: { stroke: '#8b7f70', strokeWidth: 2 } })))
const relationNodes = computed<Node[]>(() => people.value.map((person, index) => ({
  id: person.id,
  position: { x: 65 + (index % 3) * 240, y: 55 + Math.floor(index / 3) * 145 },
  data: { label: person.name },
  draggable: false,
  class: 'relationship-node',
})))
const relationEdges = computed<Edge[]>(() => relationships.value.map(link => ({ id: link.id, source: link.fromId, target: link.toId, label: link.label, style: { stroke: '#c08d60', strokeWidth: 2 } })))

function notify(message: string) {
  toast.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3300)
}
function dateLabel(value: string) {
  if (!value) return '未设置日期'
  const partial = value.match(/^--(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (partial) return `${Number(partial[1])}月${Number(partial[2])}日${partial[3] ? ` ${partial[4] ? `${partial[3]}:${partial[4]}` : `${partial[3]}时`}` : ''}`
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
function shortText(value: string, length = 100) { return value.length > length ? `${value.slice(0, length)}…` : value }
function highlight(value: string) {
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
  const safe = escape(value)
  const terms = query.value.trim().split(/\s+/).filter(Boolean).map(escape)
  if (!terms.length) return safe
  return safe.replace(new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<mark>$1</mark>')
}
async function loadImages() {
  const paths = [
    ...scripts.value.map(item => item.coverPath),
    ...clues.value.map(item => item.imagePath),
    ...clues.value.map(item => item.displayImagePath),
    ...people.value.map(item => item.photoPath),
  ].filter(Boolean)
  await Promise.all(paths.map(async path => {
    if (imageUrls[path]) return
    try { imageUrls[path] = await vault.imageUrl(path) } catch { /* File may have been removed outside the app. */ }
  }))
}
async function loadScripts() {
  scripts.value = await vault.listScripts()
  if (activeScriptId.value && !scripts.value.some(item => item.id === activeScriptId.value)) activeScriptId.value = ''
  if (!activeScriptId.value && scripts.value.length) activeScriptId.value = scripts.value[0].id
  await loadImages()
}
async function loadWorkspace() {
  if (!activeScriptId.value) return
  const id = activeScriptId.value
  const [nextClues, nextPeople, nextRelationships, nextEvents, nextBoardItems, nextBoardLinks, nextNotes, nextOrganization] = await Promise.all([
    vault.listClues(id), vault.listPeople(id), vault.listRelationships(id), vault.listTimelineEvents(id),
    vault.listBoardItems(id), vault.listBoardLinks(id), vault.listNotes(id), vault.getOrganization(id),
  ])
  if (id !== activeScriptId.value) return
  clues.value = nextClues
  people.value = nextPeople
  relationships.value = nextRelationships
  events.value = nextEvents
  boardItems.value = nextBoardItems
  boardLinks.value = nextBoardLinks
  notes.value = nextNotes
  organization.value = nextOrganization
  compareIds.value = compareIds.value.filter(value => nextClues.some(clue => clue.id === value))
  await loadImages()
}
async function action(work: () => Promise<unknown>, success?: string) {
  if (busy.value) return
  busy.value = true
  try { await work(); if (success) notify(success) }
  catch (error) { notify(error instanceof Error ? error.message : '操作未完成，请重试') }
  finally { busy.value = false }
}
function switchView(next: typeof view.value, section?: 'profiles' | 'relationships') {
  view.value = next
  if (next === 'people' && section) relationGraph.value = section === 'relationships'
  mode.value = next === 'clues' ? 'capture' : 'organize'
}
function openScriptDialog(script?: ScriptRecord) {
  editingScriptId.value = script?.id || ''
  scriptForm.name = script?.name || ''
  scriptForm.playDate = script?.playDate || ''
  scriptForm.coverPath = script?.coverPath || ''
  scriptDialog.value = true
}
async function chooseCover() {
  await action(async () => { scriptForm.coverPath = await vault.pickLocalImage() })
}
async function saveScript() {
  if (!scriptForm.name.trim()) return notify('请填写剧本名称')
  await action(async () => {
    if (editingScriptId.value) await vault.updateScript(editingScriptId.value, { name: scriptForm.name.trim(), playDate: scriptForm.playDate, coverPath: scriptForm.coverPath })
    else {
      const created = await vault.createScript({ name: scriptForm.name.trim(), playDate: scriptForm.playDate, coverPath: scriptForm.coverPath })
      activeScriptId.value = created.id
    }
    scriptDialog.value = false
    await loadScripts()
    await loadWorkspace()
  }, '剧本已保存')
}
async function removeScript(script: ScriptRecord) {
  if (!window.confirm(`删除「${script.name}」及其中全部线索、人物和笔记？此操作无法撤销。`)) return
  await action(async () => {
    await vault.deleteScript(script.id)
    activeScriptId.value = ''
    await loadScripts()
    if (activeScriptId.value) await loadWorkspace()
    else { clues.value = []; people.value = []; events.value = []; boardItems.value = []; notes.value = [] }
  }, '剧本已删除')
}
async function performOrganization() {
  if (!activeScriptId.value) throw new Error('请先打开一个剧本')
  const result = await organizer.organizeClues(clues.value)
  await vault.saveOrganization(activeScriptId.value, result)
  organization.value = await vault.getOrganization(activeScriptId.value)
}
async function runOrganization() {
  if (!clues.value.some(item => item.ocrText.trim())) return notify('当前剧本没有可整理的 OCR 文字')
  await action(performOrganization, '整理建议已更新')
}
async function capture() {
  if (!activeScriptId.value) return
  let message = '照片已保存，可继续拍摄'
  await action(async () => {
    const captured = await vault.captureClues(activeScriptId.value)
    await loadWorkspace()
    if (captured.length && autoOrganize.value) {
      try { await performOrganization(); message = '照片已录入，整理建议已更新' }
      catch (error) { message = `照片已保存，整理未完成：${error instanceof Error ? error.message : '请重试'}` }
    }
  })
  notify(message)
}
async function importPhotos() {
  if (!activeScriptId.value) return
  let message = '图片已导入并识别'
  await action(async () => {
    const imported = await vault.importCluePhotos(activeScriptId.value)
    await loadWorkspace()
    if (imported.length && autoOrganize.value) {
      try { await performOrganization(); message = '图片已录入，整理建议已更新' }
      catch (error) { message = `图片已保存，整理未完成：${error instanceof Error ? error.message : '请重试'}` }
    }
  })
  notify(message)
}
async function saveDeepSeekKey() {
  await action(async () => {
    await organizer.saveApiKey(apiKeyDraft.value)
    apiKeyDraft.value = ''
    apiKeyConfigured.value = true
  }, 'API Key 已保存到 iPad 安全存储')
}
async function removeDeepSeekKey() {
  await action(async () => {
    await organizer.removeApiKey()
    apiKeyConfigured.value = false
    autoOrganize.value = false
    localStorage.setItem('clue-vault:auto-organize', 'false')
  }, 'API Key 已从 iPad 移除')
}
function saveAutoOrganize() {
  if (autoOrganize.value && !apiKeyConfigured.value) {
    autoOrganize.value = false
    return notify('请先保存 DeepSeek API Key')
  }
  localStorage.setItem('clue-vault:auto-organize', String(autoOrganize.value))
}
async function refreshOrganization() {
  if (activeScriptId.value) organization.value = await vault.getOrganization(activeScriptId.value)
}
async function acceptPersonSuggestion(id: string) {
  const item = organization.value?.people.find(value => value.id === id)
  if (!item || !activeScriptId.value) return
  await action(async () => {
    if (!people.value.some(person => person.name === item.name || person.aliases.includes(item.name))) {
      await vault.createPerson(activeScriptId.value, { name: item.name, aliases: item.aliases })
    }
    await vault.resolveOrganizationSuggestion(activeScriptId.value, 'people', id)
    await loadWorkspace()
  }, '人物已加入档案')
}
async function acceptRelationshipSuggestion(id: string) {
  const item = organization.value?.relationships.find(value => value.id === id)
  if (!item || !activeScriptId.value) return
  await action(async () => {
    const findOrCreate = async (name: string) => {
      const found = people.value.find(person => person.name === name || person.aliases.includes(name))
      return found || await vault.createPerson(activeScriptId.value, { name })
    }
    const from = await findOrCreate(item.from)
    const to = await findOrCreate(item.to)
    const existing = relationships.value.some(relation => relation.fromId === from.id && relation.toId === to.id && relation.label === item.label)
    if (!existing) await vault.createRelationship(activeScriptId.value, { fromId: from.id, toId: to.id, label: item.label })
    await vault.resolveOrganizationSuggestion(activeScriptId.value, 'relationships', id)
    await loadWorkspace()
  }, '关系已确认并加入关系图')
}
async function acceptTimelineSuggestion(id: string) {
  const item = organization.value?.timeline.find(value => value.id === id)
  if (!item || !activeScriptId.value) return
  if (item.startsAt.startsWith('--') || item.requiresTitle || !/T\d{2}:\d{2}$/.test(item.startsAt)) {
    openTimelineSuggestionDialog(item)
    return
  }
  await action(async () => {
    const personIds = people.value.filter(person => item.people.some(name => name === person.name || person.aliases.includes(name))).map(person => person.id)
    const clue = clues.value.find(value => value.number === item.sourceNo)
    await vault.createTimelineEvent(activeScriptId.value, { title: item.title, startsAt: item.startsAt, personIds, clueId: clue?.id || '', confirmed: true })
    await vault.resolveOrganizationSuggestion(activeScriptId.value, 'timeline', id)
    await loadWorkspace()
  }, '时间节点已确认')
}
async function acceptCluePointSuggestion(id: string) {
  const item = organization.value?.cluePoints.find(value => value.id === id)
  const clue = item && clues.value.find(value => value.number === item.sourceNo)
  if (!item || !clue) return
  await action(async () => {
    await vault.updateClue(clue.id, { title: item.title, category: item.category || clue.category, tags: [...new Set([...clue.tags, ...item.tags])] })
    await vault.resolveOrganizationSuggestion(activeScriptId.value, 'cluePoints', id)
    await loadWorkspace()
  }, '线索主题已应用')
}
function openSourceClue(sourceNo: number) {
  const clue = clues.value.find(item => item.number === sourceNo)
  if (clue) openClue(clue)
}
function openClue(clue: ClueRecord) {
  detailId.value = clue.id
  clueForm.title = clue.title
  clueForm.ocrText = clue.ocrText
  clueForm.round = clue.round
  clueForm.category = clue.category
  clueForm.tags = clue.tags.join('，')
  clueForm.notes = clue.notes
  photoZoom.value = false
  clueDialog.value = true
}
async function saveClue() {
  if (!selectedClue.value) return
  await action(async () => {
    await vault.updateClue(selectedClue.value!.id, {
      title: clueForm.title.trim() || `线索 ${selectedClue.value!.number}`,
      ocrText: clueForm.ocrText,
      round: clueForm.round,
      category: clueForm.category,
      tags: clueForm.tags.split(/[，,]/).map(value => value.trim()).filter(Boolean),
      notes: clueForm.notes,
    })
    await loadWorkspace()
    clueDialog.value = false
  }, '线索已保存')
}
async function toggleFavorite(clue: ClueRecord) {
  await action(async () => { await vault.updateClue(clue.id, { favorite: !clue.favorite }); await loadWorkspace() })
}
async function rotatePhoto(clue: ClueRecord) {
  await action(async () => { await vault.updateClue(clue.id, { rotation: (clue.rotation + 90) % 360 }); await loadWorkspace() })
}
function openCrop() {
  cropStart.value = null; cropEnd.value = null; cropDialog.value = true
}
function pointOnCrop(event: PointerEvent) {
  const rect = cropImage.value?.getBoundingClientRect()
  if (!rect) return null
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
}
function beginCrop(event: PointerEvent) {
  const point = pointOnCrop(event)
  if (!point) return
  cropStart.value = point; cropEnd.value = point; cropping.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveCrop(event: PointerEvent) { if (cropping.value) cropEnd.value = pointOnCrop(event) }
function endCrop() { cropping.value = false }
async function applyCrop() {
  if (!selectedClue.value || !cropStart.value || !cropEnd.value) return
  const x = Math.min(cropStart.value.x, cropEnd.value.x)
  const y = Math.min(cropStart.value.y, cropEnd.value.y)
  const width = Math.abs(cropStart.value.x - cropEnd.value.x)
  const height = Math.abs(cropStart.value.y - cropEnd.value.y)
  if (width < .03 || height < .03) return notify('请拖出更大的裁剪范围')
  await action(async () => { await vault.cropCluePhoto(selectedClue.value!.id, { x, y, width, height }); cropDialog.value = false; await loadWorkspace() }, '已保存裁剪视图，原图仍保留')
}
async function removeClue(clue: ClueRecord) {
  if (!window.confirm(`删除线索「${clue.title}」？`)) return
  await action(async () => { await vault.deleteClue(clue.id); await loadWorkspace(); clueDialog.value = false }, '线索已删除')
}
function toggleCompare(id: string) {
  compareIds.value = compareIds.value.includes(id) ? compareIds.value.filter(value => value !== id) : [...compareIds.value, id]
}
function openPersonDialog(person?: PersonRecord) {
  editingPersonId.value = person?.id || ''
  personForm.name = person?.name || ''
  personForm.aliases = person?.aliases.join('，') || ''
  personForm.notes = person?.notes || ''
  personForm.photoPath = person?.photoPath || ''
  personDialog.value = true
}
async function choosePersonPhoto() {
  await action(async () => { personForm.photoPath = await vault.pickLocalImage() })
}
async function savePerson() {
  if (!personForm.name.trim() || !activeScriptId.value) return notify('请填写人物姓名')
  const input = { name: personForm.name.trim(), aliases: personForm.aliases.split(/[，,]/).map(value => value.trim()).filter(Boolean), notes: personForm.notes, photoPath: personForm.photoPath }
  await action(async () => {
    if (editingPersonId.value) await vault.updatePerson(editingPersonId.value, input)
    else await vault.createPerson(activeScriptId.value, input)
    await loadWorkspace(); personDialog.value = false
  }, '人物已保存')
}
async function removePerson(person: PersonRecord) {
  if (!window.confirm(`删除人物「${person.name}」？`)) return
  await action(async () => { await vault.deletePerson(person.id); await loadWorkspace() }, '人物已删除')
}
async function saveRelationship() {
  if (!activeScriptId.value || !relationForm.fromId || !relationForm.toId || relationForm.fromId === relationForm.toId || !relationForm.label.trim()) return notify('请选择两位不同人物并填写关系')
  await action(async () => {
    await vault.createRelationship(activeScriptId.value, { fromId: relationForm.fromId, toId: relationForm.toId, label: relationForm.label.trim() })
    await loadWorkspace(); relationshipDialog.value = false
  }, '关系已添加')
}
async function removeRelationship(id: string) {
  await action(async () => { await vault.deleteRelationship(id); await loadWorkspace() }, '关系已删除')
}
function openEventDialog(event?: TimelineRecord) {
  pendingTimelineSuggestionId.value = ''
  editingEventId.value = event?.id || ''
  eventForm.title = event?.title || ''
  eventForm.startsAt = event?.startsAt || ''
  eventForm.yearless = Boolean(event?.startsAt.startsWith('--'))
  eventForm.personIds = event?.personIds ? [...event.personIds] : []
  eventForm.clueId = event?.clueId || ''
  eventDialog.value = true
}
function openTimelineSuggestionDialog(item: OrganizationTimelineSuggestion) {
  pendingTimelineSuggestionId.value = item.id
  editingEventId.value = ''
  eventForm.title = item.requiresTitle ? '' : item.title
  eventForm.yearless = item.startsAt.startsWith('--')
  eventForm.startsAt = eventForm.yearless ? item.startsAt : (!/T\d{2}:\d{2}$/.test(item.startsAt) ? '' : item.startsAt)
  eventForm.personIds = people.value.filter(person => item.people.some(name => name === person.name || person.aliases.includes(name))).map(person => person.id)
  eventForm.clueId = clues.value.find(clue => clue.number === item.sourceNo)?.id || ''
  eventDialog.value = true
}
function toggleEventYearless() {
  if (eventForm.yearless) {
    eventForm.yearless = false
    eventForm.startsAt = ''
    return
  }
  const dated = eventForm.startsAt.match(/^\d{4}-(\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/)
  eventForm.startsAt = dated ? `--${dated[1]}${dated[2] ? `T${dated[2]}` : ''}` : '--'
  eventForm.yearless = true
}
async function toggleYearlessMarker(event: TimelineRecord) {
  await action(async () => {
    await vault.updateTimelineEvent(event.id, { yearlessMarkerIgnored: !event.yearlessMarkerIgnored })
    await loadWorkspace()
  }, event.yearlessMarkerIgnored ? '已显示无年份标记' : '已忽略无年份标记')
}
async function saveEvent() {
  const startsAt = eventForm.startsAt.trim()
  if (!activeScriptId.value || !eventForm.title.trim() || !startsAt) return notify('请填写事件与时间')
  if (eventForm.yearless && !/^--\d{2}-\d{2}(?:T\d{2}(?::\d{2})?)?$/.test(startsAt)) return notify('无年份时间请按 --月-日 或 --月-日T时:分 填写')
  const existingEvent = events.value.find(event => event.id === editingEventId.value)
  const input = { title: eventForm.title.trim(), startsAt, personIds: [...eventForm.personIds], clueId: eventForm.clueId, confirmed: true, yearlessMarkerIgnored: eventForm.yearless ? existingEvent?.yearlessMarkerIgnored ?? false : false }
  await action(async () => {
    if (editingEventId.value) await vault.updateTimelineEvent(editingEventId.value, input)
    else await vault.createTimelineEvent(activeScriptId.value, input)
    if (pendingTimelineSuggestionId.value) await vault.resolveOrganizationSuggestion(activeScriptId.value, 'timeline', pendingTimelineSuggestionId.value)
    pendingTimelineSuggestionId.value = ''
    await loadWorkspace(); eventDialog.value = false
  }, '时间节点已保存')
}
async function removeEvent(id: string) {
  if (!window.confirm('删除这个时间节点？')) return
  await action(async () => { await vault.deleteTimelineEvent(id); await loadWorkspace() }, '时间节点已删除')
}
function openNoteDialog(note?: NoteRecord) {
  noteId.value = note?.id || ''
  noteForm.text = note?.text || ''
  noteForm.clueId = note?.clueId || ''
  noteForm.personId = note?.personId || ''
  noteDialog.value = true
}
async function saveNote() {
  if (!activeScriptId.value || !noteForm.text.trim()) return notify('请写下笔记内容')
  const input = { text: noteForm.text.trim(), clueId: noteForm.clueId, personId: noteForm.personId }
  await action(async () => {
    if (noteId.value) await vault.updateNote(noteId.value, input)
    else await vault.createNote(activeScriptId.value, input)
    await loadWorkspace(); noteDialog.value = false
  }, '笔记已保存')
}
async function removeNote(id: string) {
  if (!window.confirm('删除这条笔记？')) return
  await action(async () => { await vault.deleteNote(id); await loadWorkspace() }, '笔记已删除')
}
function openBoardDialog(kind: BoardItemRecord['kind'] = 'note', item?: BoardItemRecord) {
  editingBoardId.value = item?.id || ''
  boardForm.kind = item?.kind || kind
  boardForm.refId = item?.refId || ''
  boardForm.text = item?.text || ''
  boardForm.color = item?.color || '#f2cc88'
  boardForm.group = item?.group || ''
  boardDialog.value = true
}
async function saveBoardItem() {
  if (!activeScriptId.value) return
  if ((boardForm.kind === 'clue' || boardForm.kind === 'person') && !boardForm.refId) return notify('请选择要放上整理板的内容')
  if (boardForm.kind === 'note' && !boardForm.text.trim()) return notify('请填写便签内容')
  const original = boardItems.value.find(item => item.id === editingBoardId.value)
  await action(async () => {
    await vault.upsertBoardItem(activeScriptId.value, {
      ...(original ? { id: original.id } : {}), kind: boardForm.kind, refId: boardForm.refId,
      text: boardForm.text, color: boardForm.color, group: boardForm.group,
      x: original?.x ?? 140 + (boardItems.value.length % 4) * 80,
      y: original?.y ?? 120 + (boardItems.value.length % 3) * 60,
    })
    await loadWorkspace(); boardDialog.value = false
  }, '卡片已保存')
}
async function removeBoardItem(id: string) {
  await action(async () => { await vault.deleteBoardItem(id); selectedBoardId.value = ''; await loadWorkspace() }, '卡片已移除')
}
async function onBoardDragStop(payload: { node: Node }) {
  const item = boardItems.value.find(value => value.id === payload.node.id)
  if (!item || !activeScriptId.value) return
  await vault.upsertBoardItem(activeScriptId.value, { ...item, x: payload.node.position.x, y: payload.node.position.y })
}
async function onBoardConnect(connection: Connection) {
  if (!activeScriptId.value || !connection.source || !connection.target) return
  await action(async () => {
    await vault.createBoardLink(activeScriptId.value, { fromId: connection.source, toId: connection.target, label: '' })
    await loadWorkspace()
  }, '卡片已连接')
}
async function saveBoardLink() {
  if (!activeScriptId.value || !boardLinkForm.fromId || !boardLinkForm.toId || boardLinkForm.fromId === boardLinkForm.toId) return notify('请选择两张不同卡片')
  await action(async () => {
    await vault.createBoardLink(activeScriptId.value, { ...boardLinkForm })
    await loadWorkspace(); boardLinkDialog.value = false
  }, '连接已添加')
}
async function removeBoardLink(id: string) {
  await action(async () => { await vault.deleteBoardLink(id); await loadWorkspace() }, '连接已删除')
}
async function exportArchive() {
  if (!activeScriptId.value) return
  await action(() => vault.exportScript(activeScriptId.value), '档案已导出')
}
async function importArchive() {
  await action(async () => {
    const imported = await vault.importScript()
    if (!imported) return
    activeScriptId.value = imported.id
    await loadScripts(); await loadWorkspace()
  }, '档案已导入')
}
function buildTimeline() {
  timelineInstance?.destroy()
  timelineInstance = null
  if (view.value !== 'timeline' || !timelineElement.value || !datedConfirmedEvents.value.length) return
  timelineInstance = new Timeline(timelineElement.value, datedConfirmedEvents.value.map(event => ({ id: event.id, content: event.title, start: event.startsAt, title: event.title })), {
    locale: 'zh-cn', stack: true, zoomKey: 'ctrlKey', margin: { item: 18 }, height: '220px', showCurrentTime: false,
  })
  timelineInstance.on('select', properties => {
    const id = properties.items?.[0]
    if (id) openEventDialog(events.value.find(item => item.id === id))
  })
}
watch(view, next => { mode.value = next === 'clues' ? 'capture' : 'organize' })
watch([view, events], async () => { await nextTick(); buildTimeline() })
watch(activeScriptId, async () => { query.value = ''; searchIds.value = null; await loadWorkspace() })
watch(query, async value => {
  const sequence = ++searchSequence
  if (!value.trim() || !activeScriptId.value) { searchIds.value = null; return }
  try {
    const results = await vault.searchClues(activeScriptId.value, value.trim())
    if (sequence === searchSequence) searchIds.value = results.map(item => item.id)
  } catch { if (sequence === searchSequence) searchIds.value = [] }
})
onMounted(async () => {
  await action(async () => { await vault.initVault(); await loadScripts(); await loadWorkspace() })
  try { apiKeyConfigured.value = await organizer.hasApiKey() } catch { apiKeyConfigured.value = false }
})
onUnmounted(() => { timelineInstance?.destroy(); if (toastTimer) clearTimeout(toastTimer) })
</script>

<template>
  <IonApp>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark"><span></span><span></span><span></span></div><div><strong>迹册</strong><small>线索整理工具</small></div></div>
        <div class="script-switcher" v-if="activeScript">
          <div class="switcher-label">当前剧本</div>
          <button class="script-switcher-button" @click="view = 'settings'"><span class="script-cover-mini" :style="activeScript.coverPath && imageUrls[activeScript.coverPath] ? { backgroundImage: `url(${imageUrls[activeScript.coverPath]})` } : {}"><UiIcon v-if="!activeScript.coverPath" name="file" :size="18" /></span><span class="switcher-name">{{ activeScript.name }}<small>{{ dateLabel(activeScript.playDate) }}</small></span><UiIcon name="chevron" :size="16" /></button>
        </div>
        <div class="sidebar-section-title">工作空间</div>
        <nav class="primary-nav" aria-label="主导航"><button v-for="item in nav" :key="item.id" :class="['nav-item', { active: activeNavId === item.id }]" @click="switchView(item.id)"><UiIcon :name="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'compare' && compareIds.length" class="nav-count">{{ compareIds.length }}</span></button></nav>
        <div class="sidebar-bottom"><div class="offline-chip"><span class="offline-dot"></span>本机保存 · AI 可选</div><button class="sidebar-small-button" @click="openScriptDialog()"><UiIcon name="plus" :size="16" />新建剧本</button></div>
      </aside>
      <main class="main-panel">
        <header class="topbar"><div class="topbar-title"><span class="topbar-parent">{{ activeScript?.name || '我的剧本' }}</span><UiIcon name="chevron" :size="14" /><strong>{{ viewLabel }}</strong></div><div class="topbar-actions"><button class="icon-button topbar-export" title="导出剧本档案" :disabled="!activeScript" @click="exportArchive"><UiIcon name="download" :size="19" /></button></div></header>
        <div v-if="!activeScript" class="empty-home"><div class="empty-art"><div class="art-paper art-paper-one"></div><div class="art-paper art-paper-two"></div><div class="art-paper art-paper-three"><UiIcon name="search" :size="38" /></div></div><h1>从一个剧本开始</h1><p>拍下线索，OCR 文字在本机识别。需要时可选择 AI 整理。</p><div class="empty-home-actions"><button class="primary-button" @click="openScriptDialog()"><UiIcon name="plus" :size="18" />新建剧本</button><button class="secondary-button" @click="importArchive"><UiIcon name="upload" :size="18" />导入档案</button></div></div>
        <template v-else>
          <section v-if="view === 'clues'" class="page page-clues">
            <div class="page-header capture-header"><div><span class="capture-eyebrow">当前剧本</span><h1>线索库</h1><p>拍照录入，文字自动识别并保存。</p></div><div class="header-actions capture-actions"><button class="secondary-button" :disabled="busy" @click="importPhotos"><UiIcon name="image" :size="18" />选照片</button><button class="primary-button" :disabled="busy" @click="capture"><UiIcon name="camera" :size="19" />拍照录入</button></div></div>
            <div class="clue-toolbar"><label class="search-field"><UiIcon name="search" :size="19" /><input v-model="query" placeholder="搜索线索文字" aria-label="搜索线索" /><button v-if="query" class="text-clear" @click="query = ''"><UiIcon name="close" :size="15" /></button></label><details class="filter-disclosure"><summary>筛选</summary><div class="toolbar-selects"><select v-model="filterRound" aria-label="筛选轮次"><option value="">全部轮次</option><option v-for="round in rounds" :key="round" :value="round">{{ round }}</option></select><select v-model="filterCategory" aria-label="筛选分类"><option value="">全部分类</option><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select><select v-model="filterPerson" aria-label="筛选人物"><option value="">全部人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select><button :class="['filter-favorite', { active: favoriteOnly }]" @click="favoriteOnly = !favoriteOnly"><UiIcon name="heart" :size="17" />收藏</button></div></details></div>
            <div class="result-bar"><span>{{ visibleClues.length }} 条线索<span v-if="query"> · 搜索「{{ query }}」</span></span><div class="view-toggle"><button :class="{ active: layout === 'grid' }" title="网格视图" @click="layout = 'grid'"><UiIcon name="grid" :size="18" /></button><button :class="{ active: layout === 'list' }" title="列表视图" @click="layout = 'list'"><UiIcon name="list" :size="18" /></button></div></div>
            <div v-if="!visibleClues.length" class="section-empty"><div class="section-empty-icon"><UiIcon :name="clues.length ? 'search' : 'camera'" :size="31" /></div><h2>{{ clues.length ? '没有符合条件的线索' : '还没有线索' }}</h2><p>{{ clues.length ? '试着调整搜索词或筛选条件。' : '拍摄或导入第一张线索照片，文字会在本机自动识别。' }}</p><button v-if="!clues.length" class="primary-button" @click="capture"><UiIcon name="camera" :size="18" />拍摄线索</button></div>
            <div v-else :class="['clue-collection', layout]"><article v-for="clue in visibleClues" :key="clue.id" class="clue-card" @click="openClue(clue)"><div class="clue-image"><img v-if="imageUrls[clue.displayImagePath || clue.imagePath]" :src="imageUrls[clue.displayImagePath || clue.imagePath]" :alt="clue.title" :style="{ transform: `rotate(${clue.rotation}deg)` }" /><UiIcon v-else name="image" :size="31" /><span class="clue-number">#{{ String(clue.number).padStart(3, '0') }}</span><button :class="['favorite-button', { active: clue.favorite }]" title="收藏线索" @click.stop="toggleFavorite(clue)"><UiIcon name="heart" :size="17" /></button></div><div class="clue-card-body"><div class="clue-card-meta"><span v-if="clue.round">{{ clue.round }}</span><span v-if="clue.category">{{ clue.category }}</span></div><h2 v-html="highlight(clue.title)"></h2><p v-if="clue.ocrText" v-html="highlight(shortText(clue.ocrText, layout === 'list' ? 165 : 74))"></p><p v-else class="muted">暂无识别文字</p><div class="clue-card-foot"><span>{{ dateLabel(clue.createdAt) }}</span><button :class="['compare-pick', { active: compareIds.includes(clue.id) }]" @click.stop="toggleCompare(clue.id)"><UiIcon name="compare" :size="15" />{{ compareIds.includes(clue.id) ? '已对照' : '加入对照' }}</button></div></div></article></div>
          </section>
          <OrganizationOverview v-else-if="view === 'organize'" :clues="clues" :people="people" :relationships="relationships" :events="events" :organization="organization" :busy="busy" :auto-organize="autoOrganize" :api-configured="apiKeyConfigured" @analyze="runOrganization" @navigate="switchView" @open-clue="openSourceClue" @accept-person="acceptPersonSuggestion" @accept-relationship="acceptRelationshipSuggestion" @accept-timeline="acceptTimelineSuggestion" @accept-clue-point="acceptCluePointSuggestion" />
          <section v-else-if="view === 'people'" class="page"><div class="page-header"><div><h1>{{ relationGraph ? '人物关系' : '人物档案' }}</h1><p>{{ relationGraph ? '查看你手动建立的人物关系。' : '名字匹配来自已保存线索；人物之间的关系由你亲自建立。' }}</p></div><div class="header-actions"><button class="secondary-button" :disabled="people.length < 2" @click="relationForm.fromId = ''; relationForm.toId = ''; relationForm.label = ''; relationshipDialog = true"><UiIcon name="plus" :size="18" />添加关系</button><button class="primary-button" @click="openPersonDialog()"><UiIcon name="plus" :size="18" />添加人物</button></div></div><div class="subtabs"><button :class="{ active: !relationGraph }" @click="relationGraph = false">人物列表</button><button :class="{ active: relationGraph }" @click="relationGraph = true">关系图</button></div><div v-if="!people.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="people" :size="31" /></div><h2>建立人物档案</h2><p>添加人物姓名后，可以自动找到提及姓名的线索。</p><button class="primary-button" @click="openPersonDialog()"><UiIcon name="plus" :size="18" />添加人物</button></div><div v-else-if="relationGraph" class="graph-shell"><VueFlow :nodes="relationNodes" :edges="relationEdges" :fit-view-on-init="true" :nodes-connectable="false" :edges-updatable="false"><Background :gap="24" :size="1" pattern-color="#e2ddd5" /><Controls /></VueFlow><div v-if="relationships.length" class="graph-legend"><div v-for="link in relationships" :key="link.id"><span>{{ people.find(p => p.id === link.fromId)?.name }} — {{ link.label }} — {{ people.find(p => p.id === link.toId)?.name }}</span><button title="删除关系" @click="removeRelationship(link.id)"><UiIcon name="close" :size="14" /></button></div></div></div><div v-else class="people-grid"><article v-for="person in people" :key="person.id" class="person-card"><div class="person-avatar"><img v-if="person.photoPath && imageUrls[person.photoPath]" :src="imageUrls[person.photoPath]" :alt="person.name" /><span v-else>{{ person.name.slice(0, 1) }}</span></div><div class="person-card-main"><h2>{{ person.name }}</h2><p v-if="person.aliases.length">又名 {{ person.aliases.join('、') }}</p><p v-else class="muted">暂无别名</p></div><div class="person-card-meta">{{ personClueCount(person) }} 条相关线索</div><p v-if="person.notes" class="person-card-notes">{{ shortText(person.notes, 82) }}</p><div class="person-card-actions"><button @click="filterPerson = person.id; view = 'clues'">查看线索 <UiIcon name="chevron" :size="15" /></button><button title="编辑人物" @click="openPersonDialog(person)"><UiIcon name="edit" :size="17" /></button><button title="删除人物" @click="removePerson(person)"><UiIcon name="trash" :size="17" /></button></div></article></div></section>
          <section v-else-if="view === 'timeline'" class="page"><div class="page-header"><div><h1>时间线</h1><p>只展示你确认的事件，不补全未知经过。</p></div><button class="primary-button" @click="openEventDialog()"><UiIcon name="plus" :size="18" />添加时间节点</button></div><div v-if="organization?.timeline.length" class="candidate-list ai-timeline-list"><div class="section-label">待确认时间点</div><p>AI 和 OCR 原文扫描结果会显示在这里。无年份的时间也可以录入，保存后会标记；标记可单独忽略。</p><article v-for="suggestion in organization.timeline" :key="suggestion.id"><div class="ai-timeline-main"><strong>{{ suggestion.title }}</strong><span>{{ dateLabel(suggestion.startsAt) }}</span><em v-if="suggestion.startsAt.startsWith('--')" class="ai-timeline-yearless">无年份</em><small>“{{ suggestion.quote }}”</small></div><button @click="openSourceClue(suggestion.sourceNo)">原线索 #{{ String(suggestion.sourceNo).padStart(3, '0') }}</button><button class="primary-button" @click="acceptTimelineSuggestion(suggestion.id)">{{ suggestion.startsAt.startsWith('--') ? '补充并录入' : suggestion.requiresTitle || !/T\d{2}:\d{2}$/.test(suggestion.startsAt) ? '补充并确认' : '确认并加入' }}</button></article></div><div v-if="candidateEvents.length" class="candidate-list"><div class="section-label">待确认的时间</div><p>以下日期来自照片文字识别。请核对原图并填写事件后再加入时间线。</p><article v-for="candidate in candidateEvents" :key="candidate.id"><span>{{ dateLabel(candidate.startsAt) }}</span><button v-if="candidate.clueId" @click="clues.find(clue => clue.id === candidate.clueId) && openClue(clues.find(clue => clue.id === candidate.clueId)!)">查看原图</button><button class="primary-button" @click="openEventDialog(candidate)">确认事件</button></article></div><div v-if="!confirmedEvents.length && !organization?.timeline.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="timeline" :size="31" /></div><h2>等待第一条确认的事件</h2><p>从线索里找到明确的时间，再由你录入事件。</p><button class="primary-button" @click="openEventDialog()"><UiIcon name="plus" :size="18" />添加时间节点</button></div><template v-else-if="confirmedEvents.length"><div v-if="datedConfirmedEvents.length" class="timeline-visual"><div class="section-label">时间概览</div><div ref="timelineElement" class="vis-timeline-host"></div></div><div v-if="yearlessEvents.length" class="timeline-visual yearless-timeline-visual"><div class="yearless-timeline-heading"><div class="section-label">无年份时间线</div><p>按原文中的月日和时间排列，不代表具体年份。点击节点可编辑。</p></div><div class="yearless-track-scroll"><div class="yearless-track" :style="{ '--yearless-count': yearlessEvents.length }"><div class="yearless-track-line"></div><button v-for="event in yearlessEvents" :key="event.id" class="yearless-track-event" :title="event.title" @click="openEventDialog(event)"><span class="yearless-track-dot"></span><span class="yearless-track-date">{{ dateLabel(event.startsAt) }}</span><strong>{{ event.title }}</strong><span v-if="!event.yearlessMarkerIgnored" class="yearless-track-badge">无年份</span></button></div></div></div><div class="timeline-list"><article v-for="event in sortedConfirmedEvents" :key="event.id" class="timeline-event"><div class="timeline-event-marker"></div><div class="timeline-event-date">{{ dateLabel(event.startsAt) }}<span v-if="event.startsAt.startsWith('--') && !event.yearlessMarkerIgnored" class="yearless-pill">无年份</span><button v-if="event.startsAt.startsWith('--')" class="timeline-marker-action" @click.stop="toggleYearlessMarker(event)">{{ event.yearlessMarkerIgnored ? '显示标记' : '忽略标记' }}</button></div><div class="timeline-event-content"><h2>{{ event.title }}</h2><div class="timeline-event-refs"><span v-for="id in event.personIds" :key="id">{{ people.find(person => person.id === id)?.name }}</span><button v-if="event.clueId" @click="clues.find(clue => clue.id === event.clueId) && openClue(clues.find(clue => clue.id === event.clueId)!)">查看原始线索 <UiIcon name="chevron" :size="13" /></button></div></div><div class="row-actions"><button title="编辑" @click="openEventDialog(event)"><UiIcon name="edit" :size="17" /></button><button title="删除" @click="removeEvent(event.id)"><UiIcon name="trash" :size="17" /></button></div></article></div></template></section>
          <section v-else-if="view === 'board'" class="page board-page"><div class="page-header"><div><h1>自由整理板</h1><p>拖动卡片，手动连接思路。布局自动保存在本机。</p></div><div class="header-actions"><button class="secondary-button" @click="boardLinkForm.fromId = ''; boardLinkForm.toId = ''; boardLinkForm.label = ''; boardLinkDialog = true"><UiIcon name="plus" :size="18" />连接卡片</button><button class="primary-button" @click="openBoardDialog('note')"><UiIcon name="plus" :size="18" />添加卡片</button></div></div><div class="board-toolbar"><button @click="openBoardDialog('clue')"><UiIcon name="archive" :size="17" />线索</button><button @click="openBoardDialog('person')"><UiIcon name="person" :size="17" />人物</button><button @click="openBoardDialog('note')"><UiIcon name="note" :size="17" />便签</button><div class="board-toolbar-spacer"></div><button @click="boardZoom = Math.max(.5, boardZoom - .15)"><UiIcon name="zoomOut" :size="17" /></button><span>{{ Math.round(boardZoom * 100) }}%</span><button @click="boardZoom = Math.min(2, boardZoom + .15)"><UiIcon name="zoomIn" :size="17" /></button></div><div class="board-canvas"><div v-if="!boardItems.length" class="board-empty"><div class="board-empty-symbol"><UiIcon name="board" :size="37" /></div><strong>你的线索空间</strong><span>添加人物、线索或便签，开始整理。</span><button class="primary-button" @click="openBoardDialog('note')"><UiIcon name="plus" :size="17" />添加第一张卡片</button></div><VueFlow v-else :nodes="boardNodes" :edges="boardEdges" :default-zoom="boardZoom" :min-zoom=".5" :max-zoom="2" :fit-view-on-init="false" @node-click="selectedBoardId = $event.node.id" @node-drag-stop="onBoardDragStop" @connect="onBoardConnect"><Background :gap="24" :size="1" pattern-color="#e2ddd5" /><Controls /></VueFlow><div v-if="selectedBoardItem" class="board-inspector"><div><strong>卡片详情</strong><button title="关闭" @click="selectedBoardId = ''"><UiIcon name="close" :size="16" /></button></div><p>{{ selectedBoardItem.text || (selectedBoardItem.kind === 'clue' ? clues.find(clue => clue.id === selectedBoardItem.refId)?.title : people.find(person => person.id === selectedBoardItem.refId)?.name) }}</p><span v-if="selectedBoardItem.group">分组：{{ selectedBoardItem.group }}</span><div><button @click="openBoardDialog(selectedBoardItem.kind, selectedBoardItem)"><UiIcon name="edit" :size="16" />编辑</button><button @click="removeBoardItem(selectedBoardItem.id)"><UiIcon name="trash" :size="16" />移除</button></div></div></div><div v-if="boardLinks.length" class="board-links-list"><span>已建立的连接</span><div v-for="link in boardLinks" :key="link.id"><span>{{ link.label || '未命名连接' }}</span><button title="删除连接" @click="removeBoardLink(link.id)"><UiIcon name="close" :size="15" /></button></div></div></section>
          <section v-else-if="view === 'notes'" class="page"><div class="page-header"><div><h1>笔记</h1><p>记录你自己的观察与讨论，不生成答案或推理。</p></div><button class="primary-button" @click="openNoteDialog()"><UiIcon name="plus" :size="18" />新建笔记</button></div><div v-if="!notes.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="note" :size="31" /></div><h2>先记下一个想法</h2><p>文字笔记可以关联具体线索或人物。</p><button class="primary-button" @click="openNoteDialog()"><UiIcon name="plus" :size="18" />新建笔记</button></div><div v-else class="notes-grid"><article v-for="note in [...notes].sort((a,b) => b.createdAt.localeCompare(a.createdAt))" :key="note.id" class="note-card"><div class="note-card-top"><UiIcon name="note" :size="19" /><span>{{ dateLabel(note.createdAt) }}</span></div><p>{{ note.text }}</p><div class="note-card-bottom"><span v-if="note.clueId">{{ clues.find(clue => clue.id === note.clueId)?.title || '线索' }}</span><span v-else-if="note.personId">{{ people.find(person => person.id === note.personId)?.name || '人物' }}</span><span v-else>独立笔记</span><button title="编辑" @click="openNoteDialog(note)"><UiIcon name="edit" :size="17" /></button><button title="删除" @click="removeNote(note.id)"><UiIcon name="trash" :size="17" /></button></div></article></div></section>
          <section v-else-if="view === 'compare'" class="page"><div class="page-header"><div><h1>线索对照</h1><p>把多条线索放在一起，逐字查看原图和识别内容。</p></div><button v-if="compareIds.length" class="secondary-button" @click="compareIds = []">清空对照</button></div><div v-if="!compareClues.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="compare" :size="31" /></div><h2>还没有加入对照的线索</h2><p>在线索库中点击「加入对照」，即可并排查看。</p><button class="primary-button" @click="view = 'clues'"><UiIcon name="archive" :size="18" />前往线索库</button></div><div v-else class="compare-grid"><article v-for="clue in compareClues" :key="clue.id" class="compare-card"><div class="compare-card-header"><div><span>#{{ String(clue.number).padStart(3, '0') }}</span><h2>{{ clue.title }}</h2></div><button title="移出对照" @click="toggleCompare(clue.id)"><UiIcon name="close" :size="18" /></button></div><button class="compare-photo" @click="openClue(clue)"><img v-if="imageUrls[clue.imagePath]" :src="imageUrls[clue.imagePath]" :alt="clue.title" :style="{ transform: `rotate(${clue.rotation}deg)` }" /><UiIcon v-else name="image" :size="32" /></button><div class="compare-ocr"><span>识别文字</span><p>{{ clue.ocrText || '暂无识别文字' }}</p></div></article></div></section>
          <section v-else-if="view === 'settings'" class="page"><div class="page-header"><div><h1>档案管理</h1><p>每个剧本独立存储；可以按剧本导出与恢复。</p></div><button class="primary-button" @click="openScriptDialog()"><UiIcon name="plus" :size="18" />新建剧本</button></div><div class="settings-layout"><div><div class="section-label">我的剧本</div><div class="script-list"><article v-for="script in scripts" :key="script.id" :class="['script-row', { active: script.id === activeScriptId }]" @click="activeScriptId = script.id"><div class="script-row-cover" :style="script.coverPath && imageUrls[script.coverPath] ? { backgroundImage: `url(${imageUrls[script.coverPath]})` } : {}"><UiIcon v-if="!script.coverPath" name="file" :size="23" /></div><div><h2>{{ script.name }}</h2><p>{{ dateLabel(script.playDate) }}</p></div><UiIcon name="chevron" :size="16" /></article></div></div><div class="settings-side"><div class="section-label">当前剧本</div><div class="settings-card"><h2>{{ activeScript.name }}</h2><p>照片、OCR 文字、人物和整理内容都保存在本机。导出的档案可在另一台设备上导入。</p><button class="settings-action" @click="openScriptDialog(activeScript)"><UiIcon name="edit" :size="18" />编辑剧本<UiIcon name="chevron" :size="16" /></button><button class="settings-action" @click="exportArchive"><UiIcon name="download" :size="18" />导出完整档案<UiIcon name="chevron" :size="16" /></button><button class="settings-action" @click="importArchive"><UiIcon name="upload" :size="18" />导入历史档案<UiIcon name="chevron" :size="16" /></button><button class="settings-action danger" @click="removeScript(activeScript)"><UiIcon name="trash" :size="18" />删除剧本<UiIcon name="chevron" :size="16" /></button></div><div class="settings-card ai-settings-card"><h2>DeepSeek 线索整理</h2><p>可选联网功能。发送当前剧本的 OCR 文字和线索编号，照片仍保存在本机；API Key 保存于 iPad Keychain，不进入导出档案。</p><label class="ai-key-label">DeepSeek API Key<input v-model="apiKeyDraft" type="password" autocomplete="off" placeholder="粘贴 API Key 后保存" /></label><div class="ai-key-actions"><button class="primary-button" :disabled="busy || !apiKeyDraft.trim()" @click="saveDeepSeekKey">保存到 iPad</button><button v-if="apiKeyConfigured" class="text-button" :disabled="busy" @click="removeDeepSeekKey">移除密钥</button></div><label class="auto-organize-toggle"><input v-model="autoOrganize" type="checkbox" :disabled="!apiKeyConfigured" @change="saveAutoOrganize" /><span><strong>自动整理新增线索</strong><small>拍照或导入后会发送 OCR 文字到 DeepSeek；可能产生 API 用量。</small></span></label></div><div class="privacy-note"><UiIcon name="info" :size="18" /><span>本机 OCR 和照片管理可离线使用。选择 AI 整理时会联网发送文字；模型只生成待确认建议，不判断证词、不推断因果或答案。</span></div></div></div></section>
        </template>
      </main>
      <nav class="mobile-nav" aria-label="底部导航"><button v-for="item in nav" :key="item.id" :class="{ active: activeNavId === item.id }" @click="switchView(item.id)"><UiIcon :name="item.icon" :size="21" /><span>{{ item.label }}</span></button></nav>
      <div v-if="toast" class="toast" role="status">{{ toast }}</div>
      <div v-if="scriptDialog" class="modal-backdrop" @click.self="scriptDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingScriptId ? '编辑剧本' : '新建剧本' }}</h2><button title="关闭" @click="scriptDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>剧本名称<input v-model="scriptForm.name" maxlength="80" placeholder="输入剧本名称" /></label><label>游玩日期<input v-model="scriptForm.playDate" type="date" /></label><div class="image-picker-row"><div class="image-picker-preview" :style="scriptForm.coverPath ? { backgroundImage: `url(${scriptForm.coverPath.startsWith('data:') ? scriptForm.coverPath : imageUrls[scriptForm.coverPath] || ''})` } : {}"><UiIcon v-if="!scriptForm.coverPath" name="image" :size="22" /></div><button class="secondary-button" @click="chooseCover">选择封面照片</button></div></div><div class="modal-actions"><button class="secondary-button" @click="scriptDialog = false">取消</button><button class="primary-button" :disabled="busy" @click="saveScript">保存剧本</button></div></div></div>
      <div v-if="clueDialog && selectedClue" class="modal-backdrop clue-backdrop" @click.self="clueDialog = false"><div class="modal clue-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><span class="modal-kicker">线索 #{{ String(selectedClue.number).padStart(3, '0') }}</span><h2>{{ selectedClue.title }}</h2></div><button title="关闭" @click="clueDialog = false"><UiIcon name="close" :size="20" /></button></div><div class="clue-detail-layout"><div class="clue-photo-panel"><div class="photo-stage" :class="{ zoomed: photoZoom }" @click="photoZoom = !photoZoom"><img v-if="imageUrls[selectedClue.imagePath]" :src="imageUrls[selectedClue.imagePath]" :alt="selectedClue.title" :style="{ transform: `rotate(${selectedClue.rotation}deg)` }" /><UiIcon v-else name="image" :size="40" /></div><div class="photo-tools"><span>原始照片</span><button @click="capture"><UiIcon name="camera" :size="18" />继续拍摄</button><button title="放大或缩小" @click="photoZoom = !photoZoom"><UiIcon name="zoomIn" :size="18" />{{ photoZoom ? '缩小' : '放大' }}</button><button @click="rotatePhoto(selectedClue)"><UiIcon name="rotate" :size="18" />旋转</button><button @click="openCrop"><UiIcon name="image" :size="18" />裁剪</button><button @click="annotationOpen = true"><UiIcon name="edit" :size="18" />标注</button></div></div><div class="clue-editor"><div class="editor-section"><span class="section-label">基础信息</span><label>标题<input v-model="clueForm.title" /></label><div class="two-fields"><label>搜证轮次<input v-model="clueForm.round" placeholder="如：第一轮" /></label><label>分类<input v-model="clueForm.category" placeholder="如：物证" /></label></div><label>标签<input v-model="clueForm.tags" placeholder="用逗号分隔" /></label></div><div class="editor-section"><span class="section-label">OCR 识别文字 <small>可直接修正错误</small></span><textarea v-model="clueForm.ocrText" rows="8" placeholder="照片中暂未识别出文字"></textarea></div><div class="editor-section"><span class="section-label">备注</span><textarea v-model="clueForm.notes" rows="3" placeholder="写下你的观察"></textarea></div><div class="clue-editor-bottom"><button class="danger-text" @click="removeClue(selectedClue)"><UiIcon name="trash" :size="17" />删除线索</button><div><button class="secondary-button" @click="toggleCompare(selectedClue)"><UiIcon name="compare" :size="17" />{{ compareIds.includes(selectedClue.id) ? '移出对照' : '加入对照' }}</button><button class="primary-button" :disabled="busy" @click="saveClue">保存修改</button></div></div></div></div></div></div>
      <div v-if="personDialog" class="modal-backdrop" @click.self="personDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingPersonId ? '编辑人物' : '添加人物' }}</h2><button title="关闭" @click="personDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>姓名<input v-model="personForm.name" placeholder="人物姓名" /></label><div class="image-picker-row"><div class="image-picker-preview round" :style="personForm.photoPath ? { backgroundImage: `url(${personForm.photoPath.startsWith('data:') ? personForm.photoPath : imageUrls[personForm.photoPath] || ''})` } : {}"><UiIcon v-if="!personForm.photoPath" name="person" :size="22" /></div><button class="secondary-button" @click="choosePersonPhoto">选择人物照片</button></div><label>别名<input v-model="personForm.aliases" placeholder="多个别名用逗号分隔" /></label><label>备注<textarea v-model="personForm.notes" rows="4" placeholder="人物档案备注"></textarea></label></div><div class="modal-actions"><button class="secondary-button" @click="personDialog = false">取消</button><button class="primary-button" @click="savePerson">保存人物</button></div></div></div>
      <div v-if="relationshipDialog" class="modal-backdrop" @click.self="relationshipDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>添加人物关系</h2><button title="关闭" @click="relationshipDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>人物 A<select v-model="relationForm.fromId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label>人物 B<select v-model="relationForm.toId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label>关系描述<input v-model="relationForm.label" placeholder="如：同事" /></label><p class="form-help">这条关系完全由你确认，系统不会推断。</p></div><div class="modal-actions"><button class="secondary-button" @click="relationshipDialog = false">取消</button><button class="primary-button" @click="saveRelationship">添加关系</button></div></div></div>
      <div v-if="eventDialog" class="modal-backdrop" @click.self="eventDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ pendingTimelineSuggestionId ? '确认时间线建议' : editingEventId ? '编辑时间节点' : '添加时间节点' }}</h2><button title="关闭" @click="eventDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>事件<input v-model="eventForm.title" placeholder="已确认的事件" /></label><div class="event-time-field"><label v-if="eventForm.yearless">时间（无年份）<input v-model="eventForm.startsAt" type="text" placeholder="--06-17T03:04" /></label><label v-else>时间<input v-model="eventForm.startsAt" type="datetime-local" /></label><button type="button" class="secondary-button time-mode-button" @click="toggleEventYearless">{{ eventForm.yearless ? '切换为有年份' : '录入无年份时间' }}</button></div><label>原始线索<select v-model="eventForm.clueId"><option value="">暂不关联</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label>涉及人物<select v-model="eventForm.personIds" multiple size="4"><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><p class="form-help">只添加线索中明确出现且由你确认的事件。无年份时间按 --月-日T时:分 填写，保存后可单独忽略“无年份”标记。</p></div><div class="modal-actions"><button class="secondary-button" @click="eventDialog = false; pendingTimelineSuggestionId = ''">取消</button><button class="primary-button" @click="saveEvent">保存节点</button></div></div></div>
      <div v-if="noteDialog" class="modal-backdrop" @click.self="noteDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ noteId ? '编辑笔记' : '新建笔记' }}</h2><button title="关闭" @click="noteDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>笔记内容<textarea v-model="noteForm.text" rows="8" placeholder="写下观察、疑问或讨论内容"></textarea></label><label>关联线索<select v-model="noteForm.clueId" @change="noteForm.personId = ''"><option value="">不关联线索</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label>关联人物<select v-model="noteForm.personId" @change="noteForm.clueId = ''"><option value="">不关联人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label></div><div class="modal-actions"><button class="secondary-button" @click="noteDialog = false">取消</button><button class="primary-button" @click="saveNote">保存笔记</button></div></div></div>
      <div v-if="boardDialog" class="modal-backdrop" @click.self="boardDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingBoardId ? '编辑卡片' : '添加整理板卡片' }}</h2><button title="关闭" @click="boardDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>类型<select v-model="boardForm.kind" @change="boardForm.refId = ''"><option value="note">便签</option><option value="clue">线索</option><option value="person">人物</option></select></label><label v-if="boardForm.kind === 'clue'">线索<select v-model="boardForm.refId"><option value="">选择线索</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label v-if="boardForm.kind === 'person'">人物<select v-model="boardForm.refId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label v-if="boardForm.kind === 'note'">便签内容<textarea v-model="boardForm.text" rows="4" placeholder="写在卡片上的内容"></textarea></label><label>分组<input v-model="boardForm.group" placeholder="可选，如：第一轮" /></label><label>颜色<input v-model="boardForm.color" type="color" class="color-input" /></label></div><div class="modal-actions"><button class="secondary-button" @click="boardDialog = false">取消</button><button class="primary-button" @click="saveBoardItem">保存卡片</button></div></div></div>
      <div v-if="boardLinkDialog" class="modal-backdrop" @click.self="boardLinkDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>手动连接卡片</h2><button title="关闭" @click="boardLinkDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>起点<select v-model="boardLinkForm.fromId"><option value="">选择卡片</option><option v-for="item in boardItems" :key="item.id" :value="item.id">{{ item.text || (item.kind === 'clue' ? clues.find(clue => clue.id === item.refId)?.title : people.find(person => person.id === item.refId)?.name) }}</option></select></label><label>终点<select v-model="boardLinkForm.toId"><option value="">选择卡片</option><option v-for="item in boardItems" :key="item.id" :value="item.id">{{ item.text || (item.kind === 'clue' ? clues.find(clue => clue.id === item.refId)?.title : people.find(person => person.id === item.refId)?.name) }}</option></select></label><label>连接说明<input v-model="boardLinkForm.label" placeholder="可选" /></label></div><div class="modal-actions"><button class="secondary-button" @click="boardLinkDialog = false">取消</button><button class="primary-button" @click="saveBoardLink">连接卡片</button></div></div></div>
      <div v-if="cropDialog && selectedClue" class="modal-backdrop crop-backdrop" @click.self="cropDialog = false"><div class="crop-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>裁剪线索照片</h2><p>在原图上拖动，选择需要保留的范围。原图始终保留。</p></div><button title="关闭" @click="cropDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="crop-stage"><div class="crop-image-frame" @pointerdown="beginCrop" @pointermove="moveCrop" @pointerup="endCrop" @pointercancel="endCrop"><img ref="cropImage" :src="imageUrls[selectedClue.imagePath]" :alt="selectedClue.title" draggable="false" /><div v-if="cropStart && cropEnd" class="crop-selection" :style="cropStyle"></div></div></div><div class="modal-actions"><button class="secondary-button" @click="cropDialog = false">取消</button><button class="primary-button" :disabled="busy || !cropStart || !cropEnd" @click="applyCrop">保存裁剪</button></div></div></div>
      <AnnotationEditor v-if="annotationOpen && selectedClue" :clue-id="selectedClue.id" :image-url="imageUrls[selectedClue.imagePath] || ''" :rotation="selectedClue.rotation" @close="annotationOpen = false" @saved="annotationOpen = false; notify('标注已保存')" />
    </div>
  </IonApp>
</template>
