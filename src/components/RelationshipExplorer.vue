<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PersonRecord, RelationshipRecord } from '../services/vault'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  imageUrls: Record<string, string>
  clueCounts: Record<string, number>
  scriptId: string
  relationshipDialogOpen?: boolean
  readOnly?: boolean
  hidePageToggle?: boolean
  displayMode?: 'graph' | 'list'
}>()
const emit = defineEmits<{
  'open-person': [personId: string]
  'view-person': [personId: string]
  'view-clues': [personId: string]
  'remove-relationship': [relationshipId: string]
  'add-relationship': [fromId?: string, toId?: string]
  'add-person': []
  'show-people-list': []
  'show-relationship-graph': []
  'fullscreen-change': [active: boolean]
}>()

type Point = { x: number; y: number }
type Gesture = { kind: 'pan' | 'person' | 'connect'; start: Point; pan: Point; personId?: string; position?: Point; beforePositions?: Record<string, Point>; moved: boolean }
type Pinch = { distance: number; zoom: number; anchor: Point }
const stage = ref<HTMLElement | null>(null)
const positions = ref<Record<string, Point>>({})
const pan = ref<Point>({ x: 0, y: 0 })
const zoom = ref(1)
const moveHistory = ref<Record<string, Point>[]>([])
let activeScriptId = props.scriptId
let viewReady = false
const fullscreen = ref(false)
defineExpose({ exitFullscreen: () => { fullscreen.value = false } })
const selectedId = ref('')
const search = ref('')
const dragging = ref(false)
const linkSourceId = ref('')
const linkTargetId = ref('')
const linkEndpoint = ref<Point | null>(null)
const awaitingRelationship = ref(false)
let longPressTimer: ReturnType<typeof setTimeout> | undefined
const viewport = ref({ width: 1, height: 1 })
const pointers = new Map<number, Point>()
let gesture: Gesture | null = null
let pinch: Pinch | null = null
let observer: ResizeObserver | undefined
let previousBodyOverflow = ''
let initialized = false

const people = computed(() => props.people.filter(person => person.scriptId === props.scriptId))
const peopleById = computed(() => new Map(people.value.map(person => [person.id, person])))
const relationships = computed(() => props.relationships.filter(relationship => relationship.scriptId === props.scriptId && peopleById.value.has(relationship.fromId) && peopleById.value.has(relationship.toId)))
const selected = computed(() => peopleById.value.get(selectedId.value))
const centerId = computed(() => {
  const degree = new Map(people.value.map(person => [person.id, 0]))
  for (const relationship of relationships.value) {
    degree.set(relationship.fromId, (degree.get(relationship.fromId) || 0) + 1)
    degree.set(relationship.toId, (degree.get(relationship.toId) || 0) + 1)
  }
  return [...people.value].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))[0]?.id || ''
})
const adjacent = computed(() => new Set(relationships.value.flatMap(relationship => relationship.fromId === selectedId.value ? [relationship.toId] : relationship.toId === selectedId.value ? [relationship.fromId] : [])))
const selectedRelationships = computed(() => relationships.value.filter(relationship => relationship.fromId === selectedId.value || relationship.toId === selectedId.value))
const isolateRelated = ref(false)
const searchMatches = computed(() => {
  const value = search.value.trim().toLocaleLowerCase()
  return value ? people.value.filter(person => [person.name, ...person.aliases].some(name => name.toLocaleLowerCase().includes(value))) : []
})
const worldStyle = computed(() => ({ transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})` }))
const edges = computed(() => {
  const placed: { x: number; y: number; width: number }[] = []
  return relationships.value.map(relationship => {
    const from = positions.value[relationship.fromId]
    const to = positions.value[relationship.toId]
    if (!from || !to) return null
    const active = !linkSourceId.value && (!selectedId.value || relationship.fromId === selectedId.value || relationship.toId === selectedId.value)
    const label = relationship.label || '关联'
    const labelWidth = Math.min(180, Math.max(44, label.length * 12 + 20))
    const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))
    const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length }
    let point = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    let found = false
    for (const offset of [0, 28, -28, 56, -56, 84, -84]) {
      for (const fraction of [0.5, 0.38, 0.62]) {
        const candidate = { x: from.x + (to.x - from.x) * fraction + normal.x * offset, y: from.y + (to.y - from.y) * fraction + normal.y * offset }
        const hitsLabel = placed.some(previous => Math.abs(candidate.x - previous.x) < (labelWidth + previous.width) / 2 + 9 && Math.abs(candidate.y - previous.y) < 32)
        const hitsPerson = Object.values(positions.value).some(position => Math.abs(candidate.x - position.x) < 94 + labelWidth / 2 && Math.abs(candidate.y - position.y) < 60)
        if (!hitsLabel && !hitsPerson) { point = candidate; found = true; break }
      }
      if (found) break
    }
    placed.push({ ...point, width: labelWidth })
    return { relationship, from, to, x: point.x, y: point.y, active, label, labelWidth }
  }).filter((edge): edge is NonNullable<typeof edge> => edge !== null)
})

const linkingLine = computed(() => {
  const from = positions.value[linkSourceId.value]
  const to = positions.value[linkTargetId.value] || linkEndpoint.value
  return from && to ? { from, to } : null
})
function clearLongPress() { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = undefined }
function cancelConnection() {
  clearLongPress()
  linkSourceId.value = ''; linkTargetId.value = ''; linkEndpoint.value = null; awaitingRelationship.value = false
  gesture = null; pinch = null; dragging.value = false
  const captured = [...pointers.keys()]
  pointers.clear()
  for (const id of captured) if (stage.value?.hasPointerCapture(id)) stage.value.releasePointerCapture(id)
}
function beginConnection(personId: string) {
  if (props.readOnly) return
  clearLongPress()
  if (people.value.length < 2 || !peopleById.value.has(personId)) return
  selectedId.value = ''
  linkSourceId.value = personId; linkTargetId.value = ''; awaitingRelationship.value = false
  linkEndpoint.value = { ...positions.value[personId] }
  if (gesture) gesture.kind = 'connect'
  dragging.value = false
}
function updateConnection(event: PointerEvent) {
  const point = localPoint(event)
  const node = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-person]')
  const target = node && stage.value?.contains(node) ? node.dataset.person || '' : ''
  linkTargetId.value = target !== linkSourceId.value && peopleById.value.has(target) ? target : ''
  linkEndpoint.value = { x: (point.x - pan.value.x) / zoom.value, y: (point.y - pan.value.y) / zoom.value }
}
function requestConnection(targetId: string) {
  if (props.readOnly) return
  if (!linkSourceId.value || targetId === linkSourceId.value || !peopleById.value.has(targetId) || awaitingRelationship.value) return
  linkTargetId.value = targetId; awaitingRelationship.value = true
  emit('add-relationship', linkSourceId.value, targetId)
}
function choosePerson(personId: string) {
  if (linkSourceId.value) requestConnection(personId)
  else selectedId.value = personId
}
function openRelationshipPicker() { if (props.readOnly) return; cancelConnection(); emit('add-relationship') }

function imageFor(person: PersonRecord): string { return props.imageUrls[person.photoPath] || props.imageUrls[person.id] || '' }
function personStyle(person: PersonRecord) {
  const point = positions.value[person.id] || { x: 0, y: 0 }
  const hidden = isolateRelated.value && selectedId.value && person.id !== selectedId.value && !adjacent.value.has(person.id)
  return { left: `${point.x}px`, top: `${point.y}px`, display: hidden ? 'none' : '' }
}
function layoutKey(): string { return `clue-vault:relationship-layout:${props.scriptId}:v1` }
function viewKey() { return `clue-vault:relationship-view:${activeScriptId}:v2` }
function persistView() {
  if (!viewReady) return
  try { sessionStorage.setItem(viewKey(), JSON.stringify({ pan: pan.value, zoom: zoom.value, viewport: viewport.value })) } catch { /* The current view remains usable without storage. */ }
}
function restoreView() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(viewKey()) || 'null')
    if (!saved || !Number.isFinite(saved.pan?.x) || !Number.isFinite(saved.pan?.y) || !Number.isFinite(saved.zoom) || saved.zoom <= 0) return false
    zoom.value = Math.max(.06, Math.min(3, saved.zoom))
    pan.value = { x: saved.pan.x + (viewport.value.width - (saved.viewport?.width || viewport.value.width)) / 2, y: saved.pan.y + (viewport.value.height - (saved.viewport?.height || viewport.value.height)) / 2 }
    return true
  } catch { return false }
}
function finishPersonMove() {
  if (props.readOnly) return
  if (gesture?.kind !== 'person' || !gesture.personId || !gesture.position || !gesture.beforePositions) return
  const current = positions.value[gesture.personId]
  if (!current || (current.x === gesture.position.x && current.y === gesture.position.y)) return
  moveHistory.value = [...moveHistory.value.slice(-19), gesture.beforePositions]
  persistLayout()
}
function undoPersonMove() {
  if (props.readOnly) return
  if (!moveHistory.value.length || linkSourceId.value || awaitingRelationship.value || pointers.size) return
  const previous = moveHistory.value[moveHistory.value.length - 1]
  moveHistory.value = moveHistory.value.slice(0, -1)
  positions.value = Object.fromEntries(people.value.map(person => [person.id, previous[person.id] ? { ...previous[person.id] } : positions.value[person.id]]))
  persistLayout()
}
function persistLayout() {
  if (props.readOnly) return
  try { localStorage.setItem(layoutKey(), JSON.stringify(positions.value)) } catch { /* The view remains usable when storage is full. */ }
}
function syncPeople(load = false) {
  let saved: Record<string, Point> = load ? {} : positions.value
  if (load) {
    try { const data = JSON.parse(localStorage.getItem(layoutKey()) || '{}'); saved = data && typeof data === 'object' && !Array.isArray(data) ? data : {} } catch { saved = {} }
  }
  const center = centerId.value
  const others = people.value.filter(person => person.id !== center)
  const ringIndex = new Map(others.map((person, index) => [person.id, index]))
  positions.value = Object.fromEntries(people.value.map(person => {
    const stored = saved[person.id]
    const point = stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
      ? { x: stored.x, y: stored.y }
      : (() => {
          if (person.id === center) return { x: 400, y: 240 }
          const index = ringIndex.get(person.id) || 0
          const ring = Math.floor(index / 6)
          const count = Math.min(6, others.length - ring * 6)
          const startAngle = count <= 2 ? 0 : -Math.PI / 2
          const angle = startAngle + (index % 6) / Math.max(1, count) * Math.PI * 2 + ring * Math.PI / 6
          return { x: 400 + Math.cos(angle) * (260 + ring * 250), y: 240 + Math.sin(angle) * (112 + ring * 142) }
        })()
    return [person.id, point]
  }))
  if (!peopleById.value.has(selectedId.value)) selectedId.value = ''
}
function fit() {
  if (!stage.value || !people.value.length) { pan.value = { x: 0, y: 0 }; zoom.value = 1; return }
  const points = people.value.map(person => positions.value[person.id]).filter(Boolean)
  if (!points.length) return
  const minX = Math.min(...points.map(point => point.x)) - 98
  const maxX = Math.max(...points.map(point => point.x)) + 98
  const minY = Math.min(...points.map(point => point.y)) - 52
  const maxY = Math.max(...points.map(point => point.y)) + 52
  const { width, height } = viewport.value
  zoom.value = Math.max(0.06, Math.min(1.15, (width - 88) / Math.max(maxX - minX, 1), (height - 134) / Math.max(maxY - minY, 1)))
  pan.value = { x: width / 2 - (minX + maxX) / 2 * zoom.value, y: (height + 10) / 2 - (minY + maxY) / 2 * zoom.value }
}
function zoomAt(nextZoom: number, point: Point = { x: viewport.value.width / 2, y: viewport.value.height / 2 }) {
  const value = Math.min(3, Math.max(0.06, nextZoom))
  const ratio = value / zoom.value
  pan.value = { x: point.x - (point.x - pan.value.x) * ratio, y: point.y - (point.y - pan.value.y) * ratio }
  zoom.value = value
}
async function focusPerson(personId: string) {
  if (linkSourceId.value) { requestConnection(personId); search.value = ''; return }
  selectedId.value = personId
  search.value = ''
  await nextTick()
  measure()
  const point = positions.value[personId]
  if (!point) return
  zoom.value = Math.max(0.85, Math.min(1.35, zoom.value))
  pan.value = { x: viewport.value.width / 2 - point.x * zoom.value, y: viewport.value.height / 2 - point.y * zoom.value }
}
function measure() {
  if (!stage.value) return
  const rect = stage.value.getBoundingClientRect()
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  if (initialized && !linkSourceId.value) pan.value = { x: pan.value.x + (width - viewport.value.width) / 2, y: pan.value.y + (height - viewport.value.height) / 2 }
  viewport.value = { width, height }
  persistView()
}
function localPoint(event: PointerEvent | WheelEvent): Point {
  const rect = stage.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function startPinch() {
  finishPersonMove()
  clearLongPress()
  linkSourceId.value = ''; linkTargetId.value = ''; linkEndpoint.value = null; awaitingRelationship.value = false
  const [a, b] = [...pointers.values()]
  if (!a || !b) return
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: zoom.value, anchor: { x: (midpoint.x - pan.value.x) / zoom.value, y: (midpoint.y - pan.value.y) / zoom.value } }
  gesture = null
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || awaitingRelationship.value || (event.target as Element).closest('.graph-hud, .graph-help, .graph-empty, .graph-connection-bar')) return
  clearLongPress()
  const point = localPoint(event)
  pointers.set(event.pointerId, point)
  stage.value?.setPointerCapture(event.pointerId)
  if (pointers.size >= 2) { startPinch(); return }
  const personId = (event.target as Element).closest<HTMLElement>('[data-person]')?.dataset.person
  gesture = { kind: linkSourceId.value ? 'connect' : personId ? 'person' : 'pan', start: point, pan: { ...pan.value }, personId, position: personId ? { ...positions.value[personId] } : undefined, beforePositions: personId && !linkSourceId.value ? Object.fromEntries(Object.entries(positions.value).map(([id, position]) => [id, { ...position }])) : undefined, moved: false }
  dragging.value = !linkSourceId.value
  if (linkSourceId.value) updateConnection(event)
  else if (!props.readOnly && personId && people.value.length > 1) {
    longPressTimer = setTimeout(() => {
      if (gesture?.kind === 'person' && !gesture.moved && pointers.size === 1) beginConnection(personId)
    }, 500)
  }
}
function pointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const point = localPoint(event)
  pointers.set(event.pointerId, point)
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    zoom.value = Math.min(3, Math.max(0.06, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance))
    pan.value = { x: midpoint.x - pinch.anchor.x * zoom.value, y: midpoint.y - pinch.anchor.y * zoom.value }
    return
  }
  if (!gesture) return
  const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y
  if (Math.hypot(dx, dy) > 5) { gesture.moved = true; clearLongPress() }
  if (gesture.kind === 'connect') { updateConnection(event); return }
  if (!props.readOnly && gesture.kind === 'person' && gesture.personId && gesture.position) {
    if (gesture.moved) positions.value[gesture.personId] = { x: gesture.position.x + dx / zoom.value, y: gesture.position.y + dy / zoom.value }
  } else pan.value = { x: gesture.pan.x + dx, y: gesture.pan.y + dy }
}
function pointerEnd(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  clearLongPress()
  const cancelled = event.type !== 'pointerup'
  const connecting = gesture?.kind === 'connect'
  let targetId = ''
  if (connecting && !cancelled) { updateConnection(event); targetId = linkTargetId.value }
  else if (gesture?.kind === 'person') {
    if (gesture.moved) finishPersonMove()
    else if (!cancelled) selectedId.value = gesture.personId || ''
  } else if (gesture?.kind === 'pan' && !gesture.moved && !cancelled) selectedId.value = ''
  pointers.delete(event.pointerId)
  gesture = null; pinch = null
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  if (pointers.size === 1) {
    const point = [...pointers.values()][0]
    gesture = { kind: 'pan', start: point, pan: { ...pan.value }, moved: true }
  }
  dragging.value = pointers.size > 0 && !linkSourceId.value
  if (connecting && cancelled) cancelConnection()
  else if (targetId) requestConnection(targetId)
  else if (linkSourceId.value) linkEndpoint.value = null
}
function wheel(event: WheelEvent) {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) zoomAt(zoom.value * Math.exp(-event.deltaY * 0.008), localPoint(event))
  else pan.value = { x: pan.value.x - event.deltaX, y: pan.value.y - event.deltaY }
}
function onKey(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null
  const targetGraph = target?.closest('.relationship-explorer')
  if (targetGraph && targetGraph !== stage.value?.closest('.relationship-explorer')) return
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
  if (target?.closest('[role="dialog"]') && !target.closest('.relationship-explorer')) return
  if (!props.readOnly && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && !props.relationshipDialogOpen && moveHistory.value.length && !linkSourceId.value) { event.preventDefault(); undoPersonMove(); return }
  if (event.key !== 'Escape' || awaitingRelationship.value) return
  if (linkSourceId.value) cancelConnection()
  else if (fullscreen.value) fullscreen.value = false
}
watch(() => props.scriptId, async () => {
  persistView(); viewReady = false; activeScriptId = props.scriptId; moveHistory.value = []
  cancelConnection(); selectedId.value = ''; search.value = ''; syncPeople(true)
  await nextTick(); measure(); if (!restoreView()) fit(); viewReady = true; persistView()
})
watch([pan, zoom], persistView, { deep: true, flush: 'sync' })
watch(() => people.value.map(person => person.id).join('|'), async () => {
  if (linkSourceId.value && (!peopleById.value.has(linkSourceId.value) || (linkTargetId.value && !peopleById.value.has(linkTargetId.value)))) cancelConnection()
  syncPeople(); await nextTick(); measure(); if (!initialized) fit()
})
watch(() => props.relationshipDialogOpen, (open, previous) => {
  if (previous && !open && awaitingRelationship.value) cancelConnection()
})
watch(() => props.readOnly, value => { if (value) cancelConnection() })
watch(fullscreen, async value => {
  emit('fullscreen-change', value)
  if (value) { previousBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
  else document.body.style.overflow = previousBodyOverflow
  await nextTick(); measure()
})
onMounted(async () => {
  syncPeople(true)
  await nextTick()
  measure(); if (!restoreView()) fit(); initialized = true; viewReady = true; persistView()
  observer = new ResizeObserver(measure)
  if (stage.value) observer.observe(stage.value)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  persistView(); viewReady = false
  cancelConnection()
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
  if (fullscreen.value) document.body.style.overflow = previousBodyOverflow
})
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <section class="relationship-explorer" :class="{ 'is-fullscreen': fullscreen, 'is-readonly': readOnly }" :aria-label="fullscreen ? '人物关系全屏视图' : '人物关系图'">
      <header class="graph-toolbar">
        <div class="graph-heading"><strong>人物关系</strong><span>{{ people.length }} 位人物 · {{ relationships.length }} 条关系</span></div>
        <nav v-if="!readOnly && !hidePageToggle" class="graph-page-toggle" aria-label="人物关系页面">
          <button type="button" :class="{ active: props.displayMode === 'list' }" :aria-current="props.displayMode === 'list' ? 'page' : undefined" @click="emit('show-people-list')">人物列表</button>
          <button type="button" :class="{ active: props.displayMode !== 'list' }" :aria-current="props.displayMode !== 'list' ? 'page' : undefined" @click="emit('show-relationship-graph')">关系图</button>
        </nav>
        <div class="graph-actions">
          <button v-if="!readOnly" type="button" class="graph-icon-button graph-undo" title="撤销人物移动" aria-label="撤销人物移动" :disabled="!moveHistory.length || Boolean(linkSourceId) || Boolean(relationshipDialogOpen)" @click="undoPersonMove"><UiIcon name="arrowLeft" :size="19" /></button>
          <button v-if="!readOnly" type="button" class="graph-text-button graph-add-person-button" @click="emit('add-person')"><UiIcon name="plus" :size="18" /><span>添加人物</span></button>
          <button v-if="!readOnly" type="button" class="graph-text-button" @click="openRelationshipPicker"><UiIcon name="plus" :size="18" /><span>添加关系</span></button>
          <button type="button" class="graph-icon-button" :title="fullscreen ? '退出全屏' : '全屏查看'" :aria-label="fullscreen ? '退出全屏' : '全屏查看'" @click="fullscreen = !fullscreen"><UiIcon :name="fullscreen ? 'restore' : 'fullscreen'" /></button>
                  </div>
      </header>
      <template v-if="props.displayMode !== 'list'">
          <div class="graph-hud">
            <div class="graph-search"><UiIcon name="search" :size="17" /><input v-model="search" placeholder="查找人物或别名" aria-label="查找人物或别名" @keydown.enter="searchMatches[0] && focusPerson(searchMatches[0].id)" /><button v-if="search" type="button" aria-label="清空搜索" @click="search = ''"><UiIcon name="close" :size="16" /></button><div v-if="search.trim()" class="graph-search-results"><button v-for="person in searchMatches" :key="person.id" type="button" @click="focusPerson(person.id)"><span>{{ person.name }}</span><UiIcon name="chevron" :size="16" /></button><p v-if="!searchMatches.length">没有匹配的人物</p></div></div>
            <div class="graph-view-buttons"><button type="button" class="graph-mode" :class="{ active: isolateRelated && selectedId }" :aria-pressed="Boolean(isolateRelated && selectedId)" :disabled="!selectedId" @click="isolateRelated = !isolateRelated"><UiIcon name="filter" :size="16" />只看关联</button><button type="button" class="graph-mode" @click="fit"><UiIcon name="fullscreen" :size="16" />显示全部</button></div>
            <div class="graph-zoom"><button type="button" aria-label="缩小关系图" @click="zoomAt(zoom / 1.2)"><UiIcon name="zoomOut" :size="19" /></button><span>{{ Math.round(zoom * 100) }}%</span><button type="button" aria-label="放大关系图" @click="zoomAt(zoom * 1.2)"><UiIcon name="zoomIn" :size="19" /></button></div>
          </div>
      <div class="graph-layout">
        <div ref="stage" class="graph-stage" :class="{ 'is-dragging': dragging, 'is-linking': linkSourceId }" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd" @contextmenu.prevent @wheel="wheel">
          <div class="graph-ground" aria-hidden="true"></div>
          <div class="graph-world" :style="worldStyle">
            <svg class="graph-edges" width="1" height="1" aria-hidden="true">
              <g v-for="edge in edges" :key="edge.relationship.id" :class="{ 'is-muted': !edge.active, 'is-connected': edge.active && selectedId }">
                <line class="edge-shadow" :x1="edge.from.x" :y1="edge.from.y + 8" :x2="edge.to.x" :y2="edge.to.y + 8" />
                <line class="edge-line" :x1="edge.from.x" :y1="edge.from.y" :x2="edge.to.x" :y2="edge.to.y" />
                <g :transform="`translate(${edge.x},${edge.y})`"><rect :x="-edge.labelWidth / 2" y="-13" :width="edge.labelWidth" height="26" rx="13" /><text text-anchor="middle" dominant-baseline="central">{{ edge.label.length > 14 ? `${edge.label.slice(0, 14)}…` : edge.label }}</text></g>
              </g>
              <g v-if="linkingLine" class="connection-preview"><line class="connection-preview-shadow" :x1="linkingLine.from.x" :y1="linkingLine.from.y + 6" :x2="linkingLine.to.x" :y2="linkingLine.to.y + 6" /><line :class="{ 'has-target': linkTargetId }" :x1="linkingLine.from.x" :y1="linkingLine.from.y" :x2="linkingLine.to.x" :y2="linkingLine.to.y" /></g>
            </svg>
            <div v-for="person in people" :key="person.id" class="person-node" :class="{ 'is-selected': linkSourceId ? linkSourceId === person.id : selectedId === person.id, 'is-neighbor': !linkSourceId && adjacent.has(person.id), 'is-link-target': linkTargetId === person.id, 'is-muted': linkSourceId ? person.id !== linkSourceId && person.id !== linkTargetId : selectedId && selectedId !== person.id && !adjacent.has(person.id) }" :style="personStyle(person)" :data-person="person.id" tabindex="0" role="button" :aria-label="`查看${person.name}的人物关系`" :aria-pressed="linkSourceId ? linkSourceId === person.id || linkTargetId === person.id : selectedId === person.id" @keydown.enter.prevent="choosePerson(person.id)" @keydown.space.prevent="choosePerson(person.id)" @dblclick.stop="!linkSourceId && (readOnly ? emit('view-person', person.id) : emit('open-person', person.id))">
              <div class="graph-person-card">
                <div class="graph-person-avatar"><img v-if="imageFor(person)" :src="imageFor(person)" alt="" draggable="false" /><span v-else>{{ person.name.slice(0, 1) }}</span></div>
                <div class="graph-person-card-copy"><strong>{{ person.name }}</strong><span v-if="person.aliases.length">{{ person.aliases.join(' · ') }}</span></div>
                <span class="person-clue-count">{{ clueCounts[person.id] || 0 }} 条线索</span>
                <span class="graph-person-card-dot" aria-hidden="true"></span>
              </div>
            </div>
          </div>
          <div v-if="linkSourceId" class="graph-connection-bar" role="status"><div><strong>连线模式 · {{ peopleById.get(linkSourceId)?.name }}</strong><span>{{ linkTargetId ? `连接到 ${peopleById.get(linkTargetId)?.name}` : '拖到目标人物，或松手后点选人物' }}</span></div><button type="button" @click="cancelConnection"><UiIcon name="close" :size="16" />取消连线</button></div>
          <div v-if="!people.length" class="graph-empty"><span><UiIcon name="people" :size="34" /></span><strong>建立你的人物关系图</strong><p>先创建人物，再手动连接他们的关系。</p><button v-if="!readOnly" type="button" class="graph-text-button" @click="openRelationshipPicker"><UiIcon name="plus" :size="18" />添加关系</button></div>
          
        </div>
        <aside v-if="selected && !linkSourceId" class="graph-inspector">
          <div class="inspector-content">
            <div class="inspector-person"><div class="graph-person-avatar"><img v-if="imageFor(selected)" :src="imageFor(selected)" alt="" /><span v-else>{{ selected.name.slice(0, 1) }}</span></div><div><h3>{{ selected.name }}</h3><p v-if="selected.aliases.length">{{ selected.aliases.join(' · ') }}</p></div><button type="button" class="graph-icon-button" aria-label="关闭人物详情" @click="selectedId = ''"><UiIcon name="close" :size="18" /></button></div>
            <div class="inspector-actions"><button v-if="!readOnly" type="button" @click="emit('open-person', selected.id)"><UiIcon name="edit" :size="16" />编辑档案</button><button type="button" @click="emit('view-clues', selected.id)"><UiIcon name="archive" :size="16" />线索 {{ clueCounts[selected.id] || 0 }}</button></div>
            <button type="button" class="inspector-workspace" @click="emit('view-person', selected.id)"><UiIcon name="person" :size="17" /><span>人物线索与事件</span><UiIcon name="chevron" :size="16" /></button>
            <p v-if="selected.notes" class="inspector-notes">{{ selected.notes }}</p>
            <div class="inspector-section-title"><strong>关联人物</strong><span>{{ selectedRelationships.length }}</span></div>
            <div v-for="relationship in selectedRelationships" :key="relationship.id" class="inspector-relation"><button type="button" class="relation-person" @click="focusPerson(relationship.fromId === selected.id ? relationship.toId : relationship.fromId)"><span>{{ relationship.label || '关联' }}</span><strong>{{ peopleById.get(relationship.fromId === selected.id ? relationship.toId : relationship.fromId)?.name }}</strong><UiIcon name="chevron" :size="16" /></button><button v-if="!readOnly" type="button" class="graph-icon-button relation-delete" :aria-label="`删除${relationship.label || '关联'}关系`" @click="emit('remove-relationship', relationship.id)"><UiIcon name="trash" :size="16" /></button></div>
            <p v-if="!selectedRelationships.length" class="inspector-no-relations">暂无关联人物</p>
          </div>
        </aside>
      </div>
      </template>
      <div v-else class="graph-people-list" aria-label="人物列表"><slot name="people-list" /></div>
    </section>
  </Teleport>
</template>

<style scoped>
.relationship-explorer, .relationship-explorer * { box-sizing: border-box; }
.relationship-explorer { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; min-height: 0; width: 100%; height: 100%; overflow: hidden; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel, 14px); background: var(--cv-surface); color: var(--cv-ink); font-family: var(--cv-font); }
.relationship-explorer.is-fullscreen { position: fixed; z-index: 1100; inset: 0; width: auto; height: auto; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); border: 0; border-radius: 0; }
.relationship-explorer :where(button) { font: inherit; cursor: pointer; touch-action: manipulation; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.relationship-explorer button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.relationship-explorer button:disabled { background: var(--cv-surface-subtle); color: var(--cv-muted); cursor: default; opacity: .55; }
.relationship-explorer button:enabled:active { background: var(--cv-accent-soft); color: var(--cv-accent-strong); border-color: var(--cv-border-strong); }
.graph-toolbar { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; min-height: 68px; padding: 12px 20px; }
.graph-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
.graph-heading strong { font-size: 17px; font-weight: 650; line-height: 1.5; }
.graph-heading > span { color: var(--cv-muted); font-size: 12px; line-height: 1.5; }
.graph-page-toggle { display: flex; flex: 0 0 auto; gap: 4px; padding: 3px; border-radius: 10px; background: var(--cv-surface-subtle); }
.graph-page-toggle button { min-height: 44px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--cv-secondary); font-size: 13px; }
.graph-page-toggle button.active { background: var(--cv-surface); color: var(--cv-accent); font-weight: 650; }
.graph-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; }
.graph-text-button, .graph-icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 44px; min-height: 44px; padding: 0 14px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); color: var(--cv-accent); font-size: 13px; line-height: 1.5; }
.graph-text-button { border-color: var(--cv-accent); background: var(--cv-accent); color: var(--cv-surface); font-weight: 600; }
.relationship-explorer .graph-text-button:enabled:active { background: var(--cv-accent-strong); border-color: var(--cv-accent-strong); color: var(--cv-surface); }
.graph-icon-button { padding: 0; }
.graph-add-person-button { border-color: var(--cv-border); background: var(--cv-surface); color: var(--cv-accent); font-weight: 550; }
.graph-hud { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 0 20px 12px; border-bottom: 1px solid var(--cv-border); }
.graph-search { position: relative; display: flex; flex: 1 1 210px; align-items: center; gap: 8px; max-width: 360px; min-width: 0; min-height: 44px; padding: 0 12px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-canvas); color: var(--cv-muted); }
.graph-search:focus-within { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.graph-search input { width: 100%; min-width: 0; min-height: 44px; padding: 0; border: 0; outline: none; background: transparent; color: var(--cv-ink); font: inherit; font-size: 16px; }
.graph-search input::placeholder { color: var(--cv-muted); }
.graph-search > button { display: grid; flex: 0 0 44px; place-items: center; width: 44px; height: 44px; margin-right: -12px; border: 0; padding: 0; border-radius: 8px; background: transparent; color: var(--cv-secondary); }
.graph-search-results { position: absolute; z-index: 7; top: calc(100% + 8px); left: 0; right: 0; overflow-y: auto; max-height: 240px; padding: 6px; border: 1px solid var(--cv-border); border-radius: 12px; background: var(--cv-surface); box-shadow: 0 8px 24px rgb(36 49 61 / .10); }
.graph-search-results button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--cv-ink); text-align: left; font-size: 14px; }
.graph-search-results p { margin: 8px; color: var(--cv-muted); font-size: 13px; }
.graph-view-buttons { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; justify-content: flex-end; }
.graph-mode { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); color: var(--cv-secondary); font-size: 13px; line-height: 1.5; }
.graph-mode.active { color: var(--cv-accent-strong); border-color: var(--cv-border-strong); background: var(--cv-accent-soft); font-weight: 600; }
.graph-layout { display: flex; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; }
.graph-people-list { flex: 1 1 0; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 20px; background: var(--cv-canvas); overscroll-behavior-y: contain; touch-action: pan-y; -webkit-overflow-scrolling: touch; }
.graph-stage { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; isolation: isolate; background: var(--cv-canvas); touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
.graph-stage.is-dragging { cursor: grabbing; }
.graph-stage.is-linking, .is-linking .person-node { cursor: crosshair; }
.graph-stage, .person-node, .person-node * { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
.graph-ground { position: absolute; inset: 0; z-index: -1; pointer-events: none; background-image: radial-gradient(var(--cv-border-strong) .7px, transparent .7px); background-size: 28px 28px; opacity: .24; }
.graph-world { position: absolute; top: 0; left: 0; width: 1px; height: 1px; transform-origin: 0 0; will-change: transform; }
.graph-edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
.graph-edges g { transition: opacity 180ms ease; }
.graph-edges g.is-muted { opacity: .18; }
.edge-shadow, .connection-preview line.connection-preview-shadow { display: none; }
.edge-line { stroke: var(--cv-border-strong); stroke-width: 1.8; }
.graph-edges g.is-connected .edge-line { stroke: var(--cv-accent); stroke-width: 2.5; }
.graph-edges rect { fill: var(--cv-surface); stroke: var(--cv-border); }
.graph-edges text { fill: var(--cv-secondary); font-size: 12px; font-weight: 500; }
.graph-edges g.is-connected rect { fill: var(--cv-accent-soft); stroke: var(--cv-border-strong); }
.graph-edges g.is-connected text { fill: var(--cv-accent-strong); }
.person-node { position: absolute; width: 180px; height: 90px; margin-left: -90px; margin-top: -45px; outline: none; cursor: grab; transition: opacity 180ms ease; }
.person-node.is-selected, .person-node.is-link-target { z-index: 3; }
.person-node.is-muted { opacity: .3; }
.is-linking .person-node.is-muted { opacity: .22; }
.person-node:focus-visible .graph-person-card { outline: 2px solid var(--cv-focus); outline-offset: 4px; }
.graph-person-card { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr); grid-template-rows: 44px 18px; gap: 2px 8px; align-items: center; height: 100%; min-height: 0; padding: 12px; border: 1px solid var(--cv-border); border-radius: 12px; background: var(--cv-surface); transition: border-color 180ms ease, background-color 180ms ease; }
.person-node.is-neighbor .graph-person-card { border-color: var(--cv-border-strong); }
.person-node.is-selected .graph-person-card, .person-node.is-link-target .graph-person-card { border: 2px solid var(--cv-accent); padding: 11px; background: var(--cv-accent-soft); }
.person-node:active .graph-person-card { background: var(--cv-accent-soft); }
.graph-person-avatar { display: grid; flex: 0 0 40px; place-items: center; width: 40px; height: 40px; overflow: hidden; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface-subtle); color: var(--cv-accent); font-size: 20px; font-weight: 600; }
.graph-person-avatar img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.graph-person-card-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.graph-person-card-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cv-ink); font-size: 16px; font-weight: 600; line-height: 1.5; }
.graph-person-card-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cv-muted); font-size: 12px; line-height: 1.5; }
.person-clue-count { grid-column: 2; align-self: start; color: var(--cv-muted); font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.graph-person-card-dot { position: absolute; right: 12px; bottom: 16px; width: 5px; height: 5px; border-radius: 50%; background: var(--cv-border-strong); }
.is-selected .graph-person-card-dot { background: var(--cv-accent); }
.connection-preview line { stroke: var(--cv-accent); stroke-width: 2.5; stroke-dasharray: 7 5; stroke-linecap: round; }
.connection-preview line.has-target { stroke: var(--cv-accent-strong); stroke-dasharray: none; }
.graph-connection-bar { position: absolute; z-index: 5; top: 12px; right: 16px; left: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--cv-border-strong); border-radius: 12px; background: var(--cv-surface); box-shadow: 0 3px 12px rgb(36 49 61 / .07); }
.graph-connection-bar > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.graph-connection-bar strong { color: var(--cv-accent-strong); font-size: 14px; line-height: 1.5; }
.graph-connection-bar span { color: var(--cv-muted); font-size: 12px; line-height: 1.5; }
.graph-connection-bar button { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; min-height: 44px; padding: 0 12px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); color: var(--cv-accent); font-size: 13px; }
.graph-zoom { display: flex; align-items: center; flex: 0 0 auto; min-height: 44px; padding: 0 4px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); pointer-events: auto; }
.graph-zoom button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--cv-accent); }
.graph-zoom > span { min-width: 42px; color: var(--cv-muted); font-size: 12px; text-align: center; font-variant-numeric: tabular-nums; }
.graph-empty { position: absolute; inset: 32px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; cursor: auto; }
.graph-empty > span { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 14px; background: var(--cv-accent-soft); color: var(--cv-accent); }
.graph-empty strong { font-size: 18px; line-height: 1.5; }
.graph-empty p { margin: 0 0 8px; color: var(--cv-muted); font-size: 14px; line-height: 1.7; }
.graph-inspector { display: flex; flex: 0 0 280px; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--cv-border); background: var(--cv-surface); }
.graph-inspector > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; min-height: 58px; gap: 8px; padding: 6px 12px 6px 20px; border-bottom: 1px solid var(--cv-border); }
.graph-inspector > header > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cv-secondary); font-size: 13px; font-weight: 600; }
.graph-inspector > header .graph-icon-button { flex: 0 0 44px; border: 0; }
.inspector-content { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px; }
.inspector-person { display: flex; align-items: center; gap: 12px; }
.inspector-person > div:not(.graph-person-avatar) { flex: 1; min-width: 0; }
.inspector-person > .graph-icon-button { flex: 0 0 44px; border: 0; align-self: flex-start; }
.inspector-person h3 { margin: 0 0 4px; font-size: 20px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.inspector-person p { margin: 0; color: var(--cv-muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.inspector-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
.inspector-actions button { display: inline-flex; align-items: center; justify-content: center; flex: 1 1 auto; gap: 8px; min-height: 44px; padding: 8px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); color: var(--cv-accent); font-size: 13px; }
.inspector-workspace { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; margin: -6px 0 20px; padding: 10px 12px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-accent-soft); color: var(--cv-accent-strong); font-size: 13px; text-align: left; }
.inspector-workspace span { flex: 1; }
.inspector-notes { margin: 0 0 20px; color: var(--cv-secondary); font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.inspector-section-title { display: flex; align-items: center; justify-content: space-between; margin: 20px 0 8px; }
.inspector-section-title strong { font-size: 14px; font-weight: 600; }
.inspector-section-title > span { color: var(--cv-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.inspector-relation { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--cv-border); }
.relation-person { position: relative; display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; min-height: 68px; padding: 12px 20px 12px 0; border: 0; background: transparent; color: var(--cv-ink); text-align: left; }
.relation-person > span { color: var(--cv-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.relation-person strong { font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.relation-person > svg { position: absolute; top: 26px; right: 0; color: var(--cv-secondary); }
.relation-delete { min-width: 44px; border: 0; color: var(--cv-danger); }
.inspector-no-relations { color: var(--cv-muted); font-size: 14px; line-height: 1.75; }
.is-readonly .person-node { cursor: pointer; }
@media (hover: hover) { .graph-search-results button:hover, .relation-person:hover { background: var(--cv-canvas); } .graph-icon-button:enabled:hover, .graph-mode:enabled:hover, .graph-zoom button:hover, .inspector-actions button:hover { background: var(--cv-accent-soft); } }
@media (max-width: 900px) { .graph-inspector { flex-basis: 240px; } .graph-toolbar { padding-inline: 16px; } .graph-hud { padding-inline: 16px; } }
@media (max-width: 700px) { .graph-toolbar { padding: 12px 14px; gap: 8px; } .graph-heading { flex: 1 1 auto; flex-direction: column; gap: 4px; } .graph-heading strong { font-size: 16px; } .graph-actions { flex: 1 1 auto; justify-content: flex-end; } .graph-text-button { padding-inline: 10px; } .graph-page-toggle { order: 2; } .graph-hud { padding: 0 14px 12px; gap: 8px; } .graph-search { max-width: none; flex: 1 1 100%; } .graph-view-buttons { flex: 1 1 auto; justify-content: flex-start; } .graph-mode { padding-inline: 10px; } .graph-zoom { margin-left: auto; } .graph-layout { flex-direction: column; } .graph-inspector { flex: 0 0 38%; max-height: 300px; border-left: 0; border-top: 1px solid var(--cv-border); } .graph-inspector > header { min-height: 48px; padding: 0 12px; } .inspector-content { padding: 14px; } .inspector-actions { margin: 12px 0; } .graph-connection-bar { flex-wrap: wrap; right: 12px; left: 12px; } }
@media (prefers-reduced-motion: reduce) { .relationship-explorer button, .graph-edges g, .person-node, .graph-person-card { transition: none; } }
</style>
