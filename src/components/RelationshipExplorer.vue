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
}>()
const emit = defineEmits<{
  'open-person': [personId: string]
  'view-clues': [personId: string]
  'remove-relationship': [relationshipId: string]
  'add-relationship': [fromId?: string, toId?: string]
}>()

type Point = { x: number; y: number }
type Gesture = { kind: 'pan' | 'person' | 'connect'; start: Point; pan: Point; personId?: string; position?: Point; moved: boolean }
type Pinch = { distance: number; zoom: number; anchor: Point }
const stage = ref<HTMLElement | null>(null)
const positions = ref<Record<string, Point>>({})
const pan = ref<Point>({ x: 0, y: 0 })
const zoom = ref(1)
const spatial = ref(true)
const fullscreen = ref(false)
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
const searchMatches = computed(() => {
  const value = search.value.trim().toLocaleLowerCase()
  return value ? people.value.filter(person => [person.name, ...person.aliases].some(name => name.toLocaleLowerCase().includes(value))) : []
})
const worldStyle = computed(() => ({ transform: `translate3d(${pan.value.x}px, ${pan.value.y}px, 0) scale(${zoom.value})` }))
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
  if (!linkSourceId.value || targetId === linkSourceId.value || !peopleById.value.has(targetId) || awaitingRelationship.value) return
  linkTargetId.value = targetId; awaitingRelationship.value = true
  emit('add-relationship', linkSourceId.value, targetId)
}
function choosePerson(personId: string) {
  if (linkSourceId.value) requestConnection(personId)
  else selectedId.value = personId
}
function openRelationshipPicker() { cancelConnection(); emit('add-relationship') }

function imageFor(person: PersonRecord): string { return props.imageUrls[person.photoPath] || props.imageUrls[person.id] || '' }
function personStyle(person: PersonRecord, index: number) {
  const point = positions.value[person.id] || { x: 0, y: 0 }
  return { left: `${point.x}px`, top: `${point.y}px`, '--card-depth': `${index % 3 * 4}px` }
}
function layoutKey(): string { return `clue-vault:relationship-layout:${props.scriptId}:v1` }
function persistLayout() {
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
          const angle = -Math.PI / 2 + (index % 6) / Math.max(1, count) * Math.PI * 2 + ring * Math.PI / 6
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
}
function localPoint(event: PointerEvent | WheelEvent): Point {
  const rect = stage.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function startPinch() {
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
  gesture = { kind: linkSourceId.value ? 'connect' : personId ? 'person' : 'pan', start: point, pan: { ...pan.value }, personId, position: personId ? { ...positions.value[personId] } : undefined, moved: false }
  dragging.value = !linkSourceId.value
  if (linkSourceId.value) updateConnection(event)
  else if (personId && people.value.length > 1) {
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
  if (gesture.kind === 'person' && gesture.personId && gesture.position) {
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
    if (gesture.moved) persistLayout()
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
  if (event.key !== 'Escape' || awaitingRelationship.value) return
  if (linkSourceId.value) cancelConnection()
  else if (fullscreen.value) fullscreen.value = false
}
watch(() => props.scriptId, async () => {
  cancelConnection(); selectedId.value = ''; search.value = ''; syncPeople(true)
  await nextTick(); measure(); fit()
})
watch(() => people.value.map(person => person.id).join('|'), async () => {
  if (linkSourceId.value && (!peopleById.value.has(linkSourceId.value) || (linkTargetId.value && !peopleById.value.has(linkTargetId.value)))) cancelConnection()
  syncPeople(); await nextTick(); measure(); fit()
})
watch(() => props.relationshipDialogOpen, (open, previous) => {
  if (previous && !open && awaitingRelationship.value) cancelConnection()
})
watch(fullscreen, async value => {
  if (value) { previousBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
  else document.body.style.overflow = previousBodyOverflow
  await nextTick(); measure()
})
onMounted(async () => {
  syncPeople(true)
  await nextTick()
  measure(); fit(); initialized = true
  observer = new ResizeObserver(measure)
  if (stage.value) observer.observe(stage.value)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  cancelConnection()
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
  if (fullscreen.value) document.body.style.overflow = previousBodyOverflow
})
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <section class="relationship-explorer" :class="{ 'is-fullscreen': fullscreen, 'is-spatial': spatial }" :aria-label="fullscreen ? '人物关系全屏视图' : '人物关系图'">
      <header class="graph-toolbar">
        <div class="graph-heading"><strong>{{ people.length }} 位人物</strong><span>{{ relationships.length }} 条手动关系</span></div>
        <div class="graph-actions">
          <button type="button" class="graph-text-button" @click="openRelationshipPicker"><UiIcon name="plus" :size="18" /><span>添加关系</span></button>
          <button type="button" class="graph-icon-button" :title="fullscreen ? '退出全屏' : '全屏查看'" :aria-label="fullscreen ? '退出全屏' : '全屏查看'" @click="fullscreen = !fullscreen"><UiIcon :name="fullscreen ? 'restore' : 'fullscreen'" /></button>
          <button v-if="fullscreen" type="button" class="graph-icon-button" aria-label="关闭全屏" @click="fullscreen = false"><UiIcon name="close" /></button>
        </div>
      </header>
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
            <div v-for="(person, index) in people" :key="person.id" class="person-node" :class="{ 'is-selected': linkSourceId ? linkSourceId === person.id : selectedId === person.id, 'is-neighbor': !linkSourceId && adjacent.has(person.id), 'is-link-target': linkTargetId === person.id, 'is-muted': linkSourceId ? person.id !== linkSourceId && person.id !== linkTargetId : selectedId && selectedId !== person.id && !adjacent.has(person.id) }" :style="personStyle(person, index)" :data-person="person.id" tabindex="0" role="button" :aria-label="`查看${person.name}的人物关系`" :aria-pressed="linkSourceId ? linkSourceId === person.id || linkTargetId === person.id : selectedId === person.id" @keydown.enter.prevent="choosePerson(person.id)" @keydown.space.prevent="choosePerson(person.id)" @dblclick.stop="!linkSourceId && emit('open-person', person.id)">
              <div class="graph-person-card">
                <div class="graph-person-avatar"><img v-if="imageFor(person)" :src="imageFor(person)" alt="" draggable="false" /><span v-else>{{ person.name.slice(0, 1) }}</span></div>
                <div class="graph-person-card-copy"><strong>{{ person.name }}</strong><span>{{ person.aliases.length ? person.aliases.join(' · ') : '人物档案' }}</span></div>
                <span class="person-clue-count">{{ clueCounts[person.id] || 0 }} 条线索</span>
                <span class="graph-person-card-dot" aria-hidden="true"></span>
              </div>
            </div>
          </div>
          <div v-if="linkSourceId" class="graph-connection-bar" role="status"><div><strong>连线模式 · {{ peopleById.get(linkSourceId)?.name }}</strong><span>{{ linkTargetId ? `连接到 ${peopleById.get(linkTargetId)?.name}` : '拖到目标人物，或松手后点选人物' }}</span></div><button type="button" @click="cancelConnection"><UiIcon name="close" :size="16" />取消连线</button></div>
          <div v-else class="graph-hud">
            <div class="graph-search"><UiIcon name="search" :size="17" /><input v-model="search" placeholder="查找人物或别名" aria-label="查找人物或别名" @keydown.enter="searchMatches[0] && focusPerson(searchMatches[0].id)" /><button v-if="search" type="button" aria-label="清空搜索" @click="search = ''"><UiIcon name="close" :size="16" /></button><div v-if="search.trim()" class="graph-search-results"><button v-for="person in searchMatches" :key="person.id" type="button" @click="focusPerson(person.id)"><span>{{ person.name }}</span><UiIcon name="chevron" :size="16" /></button><p v-if="!searchMatches.length">没有匹配的人物</p></div></div>
            <button type="button" class="graph-mode" :class="{ active: spatial }" :aria-pressed="spatial" @click="spatial = !spatial"><UiIcon name="cube" :size="17" />{{ spatial ? '立体' : '平面' }}</button>
          </div>
          <div v-if="!people.length" class="graph-empty"><span><UiIcon name="people" :size="34" /></span><strong>建立你的人物关系图</strong><p>先创建人物，再手动连接他们的关系。</p><button type="button" class="graph-text-button" @click="openRelationshipPicker"><UiIcon name="plus" :size="18" />添加关系</button></div>
          <div class="graph-help"><span>{{ linkSourceId ? '拖向人物建立关系 · 点击取消退出' : '长按人物连线 · 拖动画布 · 双指缩放' }}</span><div class="graph-zoom"><button type="button" aria-label="缩小关系图" @click="zoomAt(zoom / 1.2)"><UiIcon name="zoomOut" :size="19" /></button><span>{{ Math.round(zoom * 100) }}%</span><button type="button" aria-label="放大关系图" @click="zoomAt(zoom * 1.2)"><UiIcon name="zoomIn" :size="19" /></button><i></i><button type="button" class="graph-fit" @click="fit"><UiIcon name="fullscreen" :size="17" />显示全部</button></div></div>
        </div>
        <aside v-if="selected && !linkSourceId" class="graph-inspector">
          <header><span>人物详情</span><button type="button" class="graph-icon-button" aria-label="关闭人物详情" @click="selectedId = ''"><UiIcon name="close" :size="18" /></button></header>
          <div class="inspector-content">
            <div class="inspector-person"><div class="graph-person-avatar"><img v-if="imageFor(selected)" :src="imageFor(selected)" alt="" /><span v-else>{{ selected.name.slice(0, 1) }}</span></div><div><h3>{{ selected.name }}</h3><p>{{ selected.aliases.length ? selected.aliases.join(' · ') : '暂无别名' }}</p></div></div>
            <div class="inspector-actions"><button type="button" @click="emit('open-person', selected.id)"><UiIcon name="edit" :size="16" />编辑档案</button><button type="button" @click="emit('view-clues', selected.id)"><UiIcon name="archive" :size="16" />线索 {{ clueCounts[selected.id] || 0 }}</button></div>
            <p v-if="selected.notes" class="inspector-notes">{{ selected.notes }}</p>
            <div class="inspector-section-title"><strong>关联人物</strong><span>{{ selectedRelationships.length }}</span></div>
            <div v-for="relationship in selectedRelationships" :key="relationship.id" class="inspector-relation"><button type="button" class="relation-person" @click="focusPerson(relationship.fromId === selected.id ? relationship.toId : relationship.fromId)"><span>{{ relationship.label || '关联' }}</span><strong>{{ peopleById.get(relationship.fromId === selected.id ? relationship.toId : relationship.fromId)?.name }}</strong><UiIcon name="chevron" :size="16" /></button><button type="button" class="graph-icon-button relation-delete" :aria-label="`删除${relationship.label || '关联'}关系`" @click="emit('remove-relationship', relationship.id)"><UiIcon name="trash" :size="16" /></button></div>
            <p v-if="!selectedRelationships.length" class="inspector-no-relations">尚未建立关系，点击“添加关系”手动连接。</p>
          </div>
        </aside>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.relationship-explorer, .relationship-explorer * { box-sizing: border-box; }
.relationship-explorer { --graph-green: #315c48; --graph-copper: #b66b4d; display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; min-height: 0; width: 100%; height: 100%; overflow: hidden; color: #273e33; border: 1px solid #e3e8e2; border-radius: 18px; background: #fff; }
.relationship-explorer.is-fullscreen { position: fixed; z-index: 1100; inset: 0; width: auto; height: auto; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); border: 0; border-radius: 0; background: #fcfdfb; }
.graph-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; padding: 8px 16px; border-bottom: 1px solid #e9ece7; }
.graph-heading { display: flex; align-items: center; gap: 11px; min-width: 0; }
.graph-heading-icon { display: grid; flex: 0 0 40px; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: #eef4ef; color: var(--graph-green); }
.graph-heading > div { display: flex; flex-direction: column; gap: 3px; }
.graph-heading strong { font-size: 13px; font-weight: 650; }
.graph-heading > span { color: #8a958c; font-size: 12px; }
.graph-actions { display: flex; align-items: center; gap: 8px; }
.graph-text-button, .graph-icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 40px; min-height: 40px; padding: 0 12px; border: 1px solid #e1e7df; border-radius: 11px; background: #fff; color: var(--graph-green); font: inherit; font-size: 13px; cursor: pointer; }
.graph-text-button { border-color: var(--graph-green); background: var(--graph-green); color: #fff; font-weight: 600; }
.graph-icon-button { padding: 0; }
.graph-layout { display: flex; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; }
.graph-stage { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; isolation: isolate; background: radial-gradient(ellipse at 50% 30%, #fff 0%, #f6f8f4 75%); touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
.graph-stage.is-dragging { cursor: grabbing; }
.graph-stage.is-linking, .is-linking .person-node { cursor: crosshair; }
.graph-stage, .person-node, .person-node * { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
.is-linking .person-node.is-muted { opacity: .22; }
.person-node.is-link-target { z-index: 3; }
.person-node.is-link-target .graph-person-card { border-color: #6d9b7e; background: linear-gradient(145deg, #fff, #e9f4e9); box-shadow: 0 0 0 4px #87b89442, 0 12px 26px #315c4826; }
.connection-preview line { stroke: #b87850; stroke-width: 3; stroke-dasharray: 9 6; stroke-linecap: round; }
.connection-preview line.has-target { stroke: #457858; stroke-dasharray: none; }
.connection-preview line.connection-preview-shadow { stroke: #315c48; stroke-width: 7; stroke-dasharray: none; opacity: .1; }
.graph-connection-bar { position: absolute; z-index: 5; top: 16px; right: 16px; left: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid #d3e3d0; border-radius: 12px; background: #fffffff5; box-shadow: 0 6px 20px #315c4812; }
.graph-connection-bar > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.graph-connection-bar strong { color: #315c48; font-size: 13px; }
.graph-connection-bar span { color: #87977f; font-size: 11px; }
.graph-connection-bar button { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; min-height: 40px; padding: 0 10px; border: 1px solid #dce6d8; border-radius: 9px; background: #f7faf4; color: #57764f; font: inherit; font-size: 12px; }
.graph-ground { position: absolute; inset: 0; z-index: -1; pointer-events: none; background-image: radial-gradient(#dce3da 1px, transparent 1px); background-size: 24px 24px; opacity: .7; transition: transform .3s ease, opacity .3s ease; }
.is-spatial .graph-ground { transform: perspective(800px) rotateX(14deg) scale(1.18); transform-origin: 50% 70%; opacity: .55; }
.graph-world { position: absolute; top: 0; left: 0; width: 1px; height: 1px; transform-origin: 0 0; will-change: transform; }
.graph-edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
.graph-edges g { transition: opacity .18s ease; }
.graph-edges g.is-muted { opacity: .14; }
.edge-shadow { stroke: #91a58f; stroke-width: 7; opacity: 0; }
.is-spatial .edge-shadow { opacity: .08; }
.edge-line { stroke: #91ab92; stroke-width: 2.5; }
.graph-edges g.is-connected .edge-line { stroke: var(--graph-copper); stroke-width: 3; }
.graph-edges rect { fill: #fff; stroke: #e4e9e2; }
.graph-edges text { fill: #758477; font-size: 12px; }
.graph-edges g.is-connected text { fill: #93563e; }
.person-node { position: absolute; width: 180px; height: 90px; margin-left: -90px; margin-top: -45px; outline: none; cursor: grab; transition: opacity .18s ease; }
.person-node.is-selected { z-index: 3; }
.person-node.is-muted { opacity: .32; }
.person-node:focus-visible .graph-person-card { outline: 3px solid #b4cec0; outline-offset: 4px; }
.graph-person-card { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr); grid-template-rows: 40px 15px; gap: 3px 9px; align-items: center; height: 100%; min-height: 0; padding: 13px 12px; border: 1px solid #dfe8df; border-radius: 16px; background: linear-gradient(150deg, #fff, #f5f8f3); box-shadow: 0 5px 16px #2f4a3220; transform-origin: center; transition: box-shadow .22s ease, transform .22s ease, border-color .22s ease; }
.is-spatial .graph-person-card { transform: perspective(760px) rotateY(-5deg) rotateX(5deg) translateZ(var(--card-depth)); box-shadow: 1px 2px 0 #edf2e9, 2px 4px 0 #dce5d8, 3px 7px 0 #c8d3c4, 9px 17px 22px #315c4830; }
.person-node.is-neighbor .graph-person-card { border-color: #c3b39f; }
.person-node.is-selected .graph-person-card, .person-node.is-central .graph-person-card { border-color: #a6b187; background: linear-gradient(135deg, #416d56, #254f3b); color: #fff; box-shadow: 0 0 0 2px #315c4814, 0 12px 26px #315c4826; }
.is-spatial .person-node.is-selected .graph-person-card, .is-spatial .person-node.is-central .graph-person-card { transform: perspective(760px) rotateY(-3deg) rotateX(3deg) translateY(-5px); box-shadow: 1px 2px 0 #b8bd94, 2px 4px 0 #a6ac83, 3px 7px 0 #8c986f, 9px 17px 28px #315c4838; }
.graph-person-avatar { display: grid; flex: 0 0 40px; place-items: center; width: 40px; height: 40px; overflow: hidden; border: 1px solid #e3e8df; border-radius: 13px; background: linear-gradient(145deg, #e4ede4, #f4f6ef); color: var(--graph-green); font-size: 20px; font-weight: 650; }
.graph-person-avatar img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.graph-person-card-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.graph-person-card-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; }
.graph-person-card-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #909b91; font-size: 11px; }
.person-clue-count { grid-column: 2; align-self: start; color: #839184; font-size: 11px; }
.graph-person-card-dot { position: absolute; right: 12px; bottom: 13px; width: 6px; height: 6px; border-radius: 50%; background: #b2c3b0; }
.is-selected .graph-person-card-dot, .is-central .graph-person-card-dot { background: #dfc29c; }
.is-selected .graph-person-card-copy > span, .is-central .graph-person-card-copy > span, .is-selected .person-clue-count, .is-central .person-clue-count { color: #d0dfcb; }
.graph-hud { position: absolute; top: 16px; left: 16px; right: 16px; z-index: 4; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; pointer-events: none; }
.graph-hud > * { pointer-events: auto; }
.graph-search { position: relative; display: flex; align-items: center; gap: 8px; width: min(250px, 68%); min-height: 42px; padding: 0 12px; border: 1px solid #e2e8df; border-radius: 12px; background: #ffffffed; color: #879585; box-shadow: 0 3px 12px #315c4807; }
.graph-search input { width: 100%; min-width: 0; padding: 0; border: 0; outline: none; background: transparent; color: #334d3d; font: inherit; font-size: 12px; }
.graph-search input::placeholder { color: #97a091; }
.graph-search > button { display: grid; place-items: center; min-width: 24px; height: 40px; border: 0; padding: 0; background: transparent; color: #839281; }
.graph-search-results { position: absolute; top: calc(100% + 7px); left: 0; right: 0; overflow-y: auto; max-height: 240px; padding: 5px; border: 1px solid #e1e7df; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px #315c4815; }
.graph-search-results button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #37523e; text-align: left; font: inherit; font-size: 13px; }
.graph-search-results button:hover { background: #f0f5ee; }
.graph-search-results p { padding: 8px; color: #8d978a; font-size: 12px; }
.graph-mode { display: flex; align-items: center; gap: 6px; min-height: 42px; padding: 0 12px; border: 1px solid #e0e7dc; border-radius: 12px; background: #ffffffed; color: #7e8c7b; font: inherit; font-size: 12px; cursor: pointer; }
.graph-mode.active { color: var(--graph-green); background: #f1f6ef; }
.graph-help { position: absolute; z-index: 4; right: 16px; left: 16px; bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; pointer-events: none; }
.graph-help > span { padding: 7px 9px; border-radius: 8px; background: #f7f9f3d9; color: #939e8d; font-size: 10px; }
.graph-zoom { display: flex; align-items: center; flex: 0 0 auto; min-height: 42px; padding: 0 5px; border: 1px solid #e0e7da; border-radius: 12px; background: #fffffff2; box-shadow: 0 3px 12px #315c4807; pointer-events: auto; }
.graph-zoom button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 40px; min-height: 40px; padding: 0; border: 0; background: transparent; color: var(--graph-green); cursor: pointer; }
.graph-zoom > span { min-width: 38px; color: #80917c; font-size: 10px; text-align: center; }
.graph-zoom > i { width: 1px; height: 18px; margin: 0 6px; background: #e6ebdf; }
.graph-zoom button.graph-fit { padding: 0 8px; font: inherit; font-size: 11px; }
.graph-empty { position: absolute; inset: 72px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 11px; text-align: center; cursor: auto; }
.graph-empty > span { display: grid; place-items: center; width: 72px; height: 72px; border-radius: 22px; background: #eaf1e6; color: #7a9674; }
.graph-empty strong { font-size: 17px; }
.graph-empty p { margin: 0 0 9px; color: #8d9b87; font-size: 12px; }
.graph-inspector { display: flex; flex: 0 0 270px; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid #e4e9e1; background: #fff; }
.graph-inspector > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; min-height: 52px; padding: 6px 12px 6px 18px; border-bottom: 1px solid #edf0e8; }
.graph-inspector > header > span { color: #7e8e76; font-size: 11px; font-weight: 600; }
.graph-inspector > header .graph-icon-button { border: 0; }
.inspector-content { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px; }
.inspector-person { display: flex; align-items: center; gap: 11px; }
.inspector-person h3 { margin: 0 0 5px; font-size: 18px; }
.inspector-person p { margin: 0; color: #96a18e; font-size: 11px; overflow-wrap: anywhere; }
.inspector-actions { display: flex; gap: 7px; margin: 18px 0; }
.inspector-actions button { display: inline-flex; align-items: center; justify-content: center; flex: 1; gap: 5px; min-height: 40px; padding: 5px; border: 1px solid #e2e9dc; border-radius: 9px; background: #f8faf5; color: var(--graph-green); font: inherit; font-size: 11px; }
.inspector-notes { margin: 0 0 20px; padding: 11px; border-radius: 10px; background: #f5f7f1; color: #7e8d76; font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.inspector-section-title { display: flex; align-items: center; justify-content: space-between; margin: 18px 0 8px; }
.inspector-section-title strong { font-size: 12px; }
.inspector-section-title > span { display: grid; place-items: center; min-width: 21px; height: 21px; border-radius: 7px; background: #eff4e9; color: #809572; font-size: 10px; }
.inspector-relation { display: flex; align-items: center; gap: 5px; border-bottom: 1px solid #edf1e6; }
.relation-person { position: relative; display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; min-height: 60px; padding: 9px 20px 9px 0; border: 0; background: transparent; color: #375338; text-align: left; font: inherit; }
.relation-person > span { color: #a17a5d; font-size: 10px; overflow-wrap: anywhere; }
.relation-person strong { font-size: 13px; }
.relation-person > svg { position: absolute; top: 22px; right: 0; color: #9aa68f; }
.relation-delete { min-width: 40px; border: 0; color: #a6ad9e; }
.inspector-no-relations { color: #9aa38f; font-size: 12px; line-height: 1.7; }
button:focus-visible { outline: 3px solid #bdd3b7; outline-offset: 2px; }
@media (max-width: 900px) { .graph-inspector { flex-basis: 230px; } .graph-help > span { display: none; } .graph-help { justify-content: flex-end; } }
@media (max-width: 700px) { .graph-toolbar { gap: 8px; padding: 10px 12px; } .graph-heading-icon { display: none; } .graph-actions { gap: 5px; } .graph-text-button { padding: 0 9px; font-size: 11px; } .graph-layout { flex-direction: column; } .graph-inspector { flex: 0 0 40%; max-height: 260px; border-left: 0; border-top: 1px solid #e4e9e1; } .graph-inspector > header { min-height: 42px; padding: 0 12px; } .inspector-content { padding: 12px; } .inspector-actions { margin: 10px 0; } .graph-heading > div > span { font-size: 10px; } .graph-hud { top: 12px; right: 12px; left: 12px; } .graph-search { width: min(250px, 70%); } }
@media (prefers-reduced-motion: reduce) { .graph-ground, .graph-edges g, .person-node, .graph-person-card { transition: none; } }
</style>
