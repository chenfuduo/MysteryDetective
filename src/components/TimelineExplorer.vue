<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Timeline } from 'vis-timeline/standalone'
import UiIcon from './UiIcon.vue'
import type { ClueRecord, PersonRecord, TimelineRecord } from '../services/vault'

type Side = 'upper' | 'lower'
type LayoutMode = 'proportional' | 'sequence'
const sequenceStep = 60_000
const sequenceOrigin = Date.UTC(2000, 0, 1)
function savedLayoutMode(scriptId: string): LayoutMode {
  try { return localStorage.getItem(`cluevault:timeline-layout:${encodeURIComponent(scriptId)}`) === 'sequence' ? 'sequence' : 'proportional' } catch { return 'proportional' }
}
type TimeWindow = { start: Date; end: Date }
type PortraitPoint = { x: number; y: number; onCard: boolean }
type PortraitGesture = { mode: 'pending' | 'pan' | 'pinch'; startY: number; startWindow: TimeWindow; startDistance: number; startPointTime: number; interactive: boolean }
type DensityGroup = { id: string; side: Side; start: number; end: number; members: TimelineRecord[] }
type VisibleDensityGroup = DensityGroup & { visibleMembers: TimelineRecord[] }
const props = withDefaults(defineProps<{ events: TimelineRecord[]; people: PersonRecord[]; clues: ClueRecord[]; scriptId: string; personId: string; readOnly?: boolean; sourceReviewEventIds?: string[] }>(), { sourceReviewEventIds: () => [] })
const emit = defineEmits<{
  'update:personId': [value: string]
  'edit-event': [event: TimelineRecord]
  'open-clue': [clueId: string, quote?: string]
  'toggle-marker': [event: TimelineRecord]
  'fullscreen-change': [active: boolean]
  'show-event-list': []
}>()
const sides: Side[] = ['upper', 'lower']
const rootElement = ref<HTMLElement | null>(null)
const plotElement = ref<HTMLElement | null>(null)
const elements: Record<Side, HTMLElement | null> = { upper: null, lower: null }
const instances: Record<Side, Timeline | null> = { upper: null, lower: null }
const fullscreen = ref(false)
const isPortrait = ref(typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches)
const layoutMode = ref<LayoutMode>(savedLayoutMode(props.scriptId))
const densityEnabled = ref(true)
const clusterPanel = ref<HTMLElement | null>(null)
const selectedClusterId = ref('')
const selectedId = ref('')
const timeWindow = ref<TimeWindow | null>(null)
const plotExtent = ref(800)
const portraitPointers = new Map<number, PortraitPoint>()
let portraitGesture: PortraitGesture | null = null
let orientationMedia: MediaQueryList | null = null
let resizeObserver: ResizeObserver | null = null
let redrawFrame = 0
let densityFrame = 0
let syncRequest = 0
let previousOverflow = ''
let returnFocus: HTMLElement | null = null
let chartPointer: { x: number; y: number; moved: boolean } | null = null
let activeCacheKey = ''
defineExpose({ enterFullscreen: () => { fullscreen.value = true }, exitFullscreen: () => { fullscreen.value = false }, focusEvent })

const referenceYear = computed(() => {
  const years = props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && /^\d{4}-/.test(event.startsAt)).map(event => Number(event.startsAt.slice(0, 4)))
  return years.length ? Math.min(...years) : 2000
})
const allEvents = computed(() => props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && Number.isFinite(eventTime(event))))
const visibleEvents = computed(() => allEvents.value.filter(event => !props.personId || event.personIds.includes(props.personId)))
const datedCount = computed(() => allEvents.value.filter(event => !event.startsAt.startsWith('--')).length)
const yearlessCount = computed(() => allEvents.value.length - datedCount.value)
const orderedEvents = computed(() => [...allEvents.value].sort((a, b) => eventTime(a) - eventTime(b) || periodRank(a.timeOfDay) - periodRank(b.timeOfDay) || a.id.localeCompare(b.id)))
// Coordinates always use every event in the script; filters only hide cards.
const sequencePositions = computed(() => new Map(orderedEvents.value.map((event, index) => [event.id, sequenceOrigin + index * sequenceStep])))
const eventSides = computed(() => new Map(orderedEvents.value.map((event, index) => [event.id, sides[index % 2]])))
function eventPosition(event: TimelineRecord) { return layoutMode.value === 'sequence' ? sequencePositions.value.get(event.id)! : eventTime(event) }
// Use the full script and a zoom bucket so person filters and panning never move group anchors.
const densityTimePerPixel = computed(() => {
  const range = timeWindow.value ?? initialWindow()
  const value = Math.max(1, (range.end.getTime() - range.start.getTime()) / Math.max(200, plotExtent.value))
  return Math.pow(1.12, Math.round(Math.log(value) / Math.log(1.12)))
})
const densityGroups = computed<DensityGroup[]>(() => {
  const threshold = layoutMode.value === 'proportional' && densityEnabled.value ? densityTimePerPixel.value * 170 : -1
  const groups: DensityGroup[] = []
  for (const side of sides) {
    const members = [...allEvents.value].filter(event => eventSides.value.get(event.id) === side).sort((a, b) => eventTime(a) - eventTime(b) || periodRank(a.timeOfDay) - periodRank(b.timeOfDay) || a.id.localeCompare(b.id))
    let group: DensityGroup | undefined
    for (const event of members) {
      const time = eventPosition(event)
      if (group && time - group.start <= threshold) { group.members.push(event); group.end = time }
      else { group = { id: event.id, side, start: time, end: time, members: [event] }; groups.push(group) }
    }
  }
  return groups.map(group => group.members.length > 1 ? { ...group, id: `timeline-cluster:${group.side}:${group.members.map(event => event.id).join(':')}` } : group)
})
const visibleDensityGroups = computed<VisibleDensityGroup[]>(() => densityGroups.value.map(group => ({ ...group, visibleMembers: group.members.filter(event => !props.personId || event.personIds.includes(props.personId)) })).filter(group => group.visibleMembers.length))
const selectedCluster = computed(() => visibleDensityGroups.value.find(group => group.id === selectedClusterId.value && group.members.length > 1))
const densitySummary = computed(() => {
  if (!densityEnabled.value) return '已显示全部事件卡片'
  const groups = visibleDensityGroups.value.filter(group => group.members.length > 1)
  return groups.length ? `${groups.reduce((total, group) => total + group.visibleMembers.length, 0)} 个事件收拢为 ${groups.length} 组 · 点数量逐条查看` : '当前间距无需收拢 · 放大后自动展开'
})
const selectedEvent = computed(() => visibleEvents.value.find(event => event.id === selectedId.value))
const sourceReviewIds = computed(() => new Set(props.sourceReviewEventIds))
const selectedPeople = computed(() => props.people.filter(person => selectedEvent.value?.personIds.includes(person.id)))
const viewCacheKey = computed(() => `cluevault:timeline-view:${encodeURIComponent(props.scriptId)}:${referenceYear.value}:${layoutMode.value}`)
const selectedEvidence = computed(() => {
  const event = selectedEvent.value
  if (!event || event.scriptId !== props.scriptId) return []
  const evidence = (event.evidence || []).flatMap(item => {
    const clue = props.clues.find(clue => clue.scriptId === props.scriptId && clue.id === item.clueId && clue.number === item.sourceNo)
    return clue && item.quote && clue.ocrText.includes(item.quote) ? [{ clue, quote: item.quote }] : []
  })
  if (!evidence.length && event.clueId) {
    const clue = props.clues.find(item => item.scriptId === props.scriptId && item.id === event.clueId)
    if (clue) evidence.push({ clue, quote: '' })
  }
  return evidence.filter((item, index) => evidence.findIndex(other => other.clue.id === item.clue.id && other.quote === item.quote) === index)
})
function persistView() {
  if (!activeCacheKey) return
  try { sessionStorage.setItem(activeCacheKey, JSON.stringify({ start: timeWindow.value?.start.getTime(), end: timeWindow.value?.end.getTime(), densityEnabled: densityEnabled.value })) } catch { /* Storage can be unavailable in private contexts. */ }
}
function restoreView() {
  activeCacheKey = viewCacheKey.value
  timeWindow.value = null; densityEnabled.value = true
  try {
    const saved = JSON.parse(sessionStorage.getItem(activeCacheKey) || 'null')
    if (!saved || typeof saved !== 'object') return
    if (typeof saved.densityEnabled === 'boolean') densityEnabled.value = saved.densityEnabled
    if (typeof saved.start === 'number' && typeof saved.end === 'number' && Number.isFinite(saved.start) && Number.isFinite(saved.end) && saved.end > saved.start) timeWindow.value = { start: new Date(saved.start), end: new Date(saved.end) }
  } catch { /* A missing or obsolete cache starts from the full timeline. */ }
}
function precisionLabel(event: TimelineRecord) {
  const precision = event.precision || (/T\d{2}:\d{2}/.test(event.startsAt) ? 'minute' : /T\d{2}/.test(event.startsAt) ? 'hour' : 'date')
  return precision === 'minute' ? '到分钟' : precision === 'hour' ? '仅到小时' : '仅日期'
}

function setChartElement(side: Side, element: unknown) {
  elements[side] = element instanceof HTMLElement ? element : null
}
function eventTime(event: TimelineRecord) {
  let value = event.startsAt.startsWith('--') ? `${referenceYear.value}-${event.startsAt.slice(2)}` : event.startsAt
  if (/T\d{2}$/.test(value)) value += ':00'
  return Date.parse(value)
}
function dateLabel(value: string) {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?/)
  if (!match) return value
  return `${match[1] ? `${match[1]}年` : ''}${Number(match[2])}月${Number(match[3])}日${match[4] ? ` ${match[5] ? `${match[4]}:${match[5]}` : `${Number(match[4])}时`}` : ''}`
}
function eventDateLabel(event: TimelineRecord) { return `${dateLabel(event.startsAt)}${event.timeOfDay && !/T\d{2}/.test(event.startsAt) ? ` ${event.timeOfDay}` : ''}` }
function periodRank(value = '') { return ['凌晨', '深夜', '半夜', '清晨', '早晨', '早上', '上午', '中午', '下午', '午后', '傍晚', '晚上', '晚间', '夜里', '夜间'].indexOf(value) }
function eventTitle(event: TimelineRecord) {
  const match = event.startsAt.match(/^(?:--|\d{4}-)(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  const title = event.title.trim()
  if (!match) return title
  const [, month, day, hour, minute] = match.map(Number)
  const datePrefix = new RegExp(`^\\s*(?:\\d{4}\\s*年\\s*)?0?${month}\\s*月\\s*0?${day}\\s*(?:日|号)?`)
  const timePrefix = new RegExp(`^\\s*(?:(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|晚上)\\s*)?0?${hour}\\s*(?:[:：点时])\\s*0?${minute}\\s*(?:分)?`)
  return title.replace(datePrefix, '').replace(timePrefix, '').replace(/^[\s,，、:：·—-]+/, '').trim() || title
}
function eventContent(event: TimelineRecord) {
  const content = document.createElement('div')
  content.className = 'timeline-event-content'
  content.dataset.eventId = event.id
  const time = document.createElement('span')
  time.className = 'timeline-node-time'
  time.textContent = `${event.approximate ? '约 ' : ''}${eventDateLabel(event)}`
  const title = document.createElement('span')
  title.className = 'timeline-node-title'
  title.textContent = eventTitle(event)
  content.append(time, title)
  return content
}
function clusterLabel(group: DensityGroup) {
  const first = eventDateLabel(group.members[0]!)
  const last = eventDateLabel(group.members[group.members.length - 1]!)
  return first === last ? first : `${first} — ${last}`
}
function clusterKinds(group: VisibleDensityGroup) {
  const yearless = group.visibleMembers.filter(event => event.startsAt.startsWith('--')).length
  return yearless === group.visibleMembers.length ? '无年份' : yearless === 0 ? '有年份' : `有年份 ${group.visibleMembers.length - yearless} · 无年份 ${yearless}`
}
function clusterContent(group: VisibleDensityGroup) {
  const content = document.createElement('button')
  content.type = 'button'
  content.className = 'timeline-event-content timeline-cluster-content'
  content.dataset.clusterId = group.id
  content.setAttribute('aria-label', `${clusterLabel(group)}，${group.visibleMembers.length} 个事件，展开逐条查看`)
  const time = document.createElement('span')
  time.className = 'timeline-node-time'
  time.textContent = clusterLabel(group)
  const count = document.createElement('strong')
  count.className = 'timeline-cluster-count'
  count.textContent = `${group.visibleMembers.length} 个事件`
  const hint = document.createElement('span')
  hint.className = 'timeline-node-precision'
  hint.textContent = `${clusterKinds(group)} · ${props.personId ? `全组 ${group.members.length} 条 · ` : ''}点击展开`
  content.append(time, count, hint)
  return content
}
function memberPeople(event: TimelineRecord) {
  return props.people.filter(person => person.scriptId === props.scriptId && event.personIds.includes(person.id)).map(person => person.name).join('、')
}
function fullWindow(): TimeWindow {
  const times = allEvents.value.map(eventPosition)
  const first = times.length ? Math.min(...times) : Date.now()
  const last = times.length ? Math.max(...times) : first
  const span = Math.max(last - first, layoutMode.value === 'sequence' ? sequenceStep * 2 : 3 * 60 * 60_000) * 1.18
  const center = (first + last) / 2
  return { start: new Date(center - span / 2), end: new Date(center + span / 2) }
}
function initialWindow(): TimeWindow {
  if (layoutMode.value === 'proportional' || !orderedEvents.value.length) return fullWindow()
  const whole = fullWindow()
  const span = Math.min(whole.end.getTime() - whole.start.getTime(), Math.max(3, plotExtent.value / 150) * sequenceStep)
  const selected = selectedEvent.value
  const start = selected ? eventPosition(selected) - span / 2 : eventPosition(orderedEvents.value[0]!) - sequenceStep * .65
  return { start: new Date(start), end: new Date(start + span) }
}
function bounds() {
  const range = fullWindow()
  const span = range.end.getTime() - range.start.getTime()
  return { min: new Date(range.start.getTime() - span * .35), max: new Date(range.end.getTime() + span * .35), zoomMin: layoutMode.value === 'sequence' ? sequenceStep * 2 : 60_000, zoomMax: span * 1.7 }
}
function items(side: Side) {
  return visibleDensityGroups.value.filter(group => group.side === side).map(group => {
    if (group.members.length > 1) {
      const yearless = group.visibleMembers.filter(event => event.startsAt.startsWith('--')).length
      return { id: group.id, start: new Date(group.start), content: clusterContent(group), className: `timeline-density-cluster ${yearless === group.visibleMembers.length ? 'timeline-node-yearless' : yearless ? 'timeline-node-mixed' : 'timeline-node-dated'}` }
    }
    const event = group.visibleMembers[0]!
    return { id: event.id, start: new Date(eventPosition(event)), content: eventContent(event), className: `${event.startsAt.startsWith('--') ? 'timeline-node-yearless' : 'timeline-node-dated'}${event.yearlessMarkerIgnored ? ' timeline-marker-ignored' : ''}` }
  })
}
function selectRenderedItem(id: string) {
  const group = visibleDensityGroups.value.find(item => item.id === id && item.members.length > 1)
  if (group) openCluster(group.id)
  else selectEvent(id)
}
function scheduleDensityRefresh() {
  if (densityFrame) return
  densityFrame = requestAnimationFrame(() => {
    densityFrame = 0
    for (const side of sides) instances[side]?.setItems(items(side))
    if (selectedClusterId.value && !selectedCluster.value) selectedClusterId.value = ''
    if (selectedEvent.value) selectEvent(selectedId.value)
    else if (selectedCluster.value) for (const side of sides) instances[side]?.setSelection(selectedCluster.value.side === side ? [selectedCluster.value.id] : [])
  })
}
async function openCluster(id: string) {
  const group = visibleDensityGroups.value.find(item => item.id === id && item.members.length > 1)
  if (!group) return
  selectedId.value = ''
  selectedClusterId.value = id
  for (const side of sides) instances[side]?.setSelection(group.side === side ? [id] : [])
  await nextTick()
  scheduleRedraw()
  clusterPanel.value?.focus()
}
function closeCluster() {
  selectedClusterId.value = ''
  if (!selectedId.value) for (const side of sides) instances[side]?.setSelection([])
  scheduleRedraw()
}
function expandCluster() {
  const group = selectedCluster.value
  if (!group || group.end <= group.start) return
  const span = Math.max(60_000, (group.end - group.start) * 1.8)
  const center = (group.start + group.end) / 2
  closeCluster()
  applyWindow({ start: new Date(center - span / 2), end: new Date(center + span / 2) })
}
function applyWindow(range: TimeWindow) {
  timeWindow.value = range
  for (const side of sides) instances[side]?.setWindow(range.start, range.end, { animation: false })
  persistView()
}
function scheduleRedraw() {
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  redrawFrame = requestAnimationFrame(() => {
    if (plotElement.value) plotExtent.value = isPortrait.value ? plotElement.value.clientHeight : plotElement.value.clientWidth
    const range = timeWindow.value
    for (const side of sides) {
      const instance = instances[side]
      if (!instance) continue
      // Reapply the viewport once the flex panel has its final dimensions.
      if (range) instance.setWindow(range.start, range.end, { animation: false })
      instance.redraw()
    }
    redrawFrame = 0
  })
}
async function syncCharts() {
  const request = ++syncRequest
  await nextTick()
  if (request !== syncRequest) return
  if (!allEvents.value.length) {
    for (const side of sides) { instances[side]?.destroy(); instances[side] = null }
    timeWindow.value = null
    return
  }
  const range = timeWindow.value ?? initialWindow()
  timeWindow.value = range
  for (const side of sides) {
    const element = elements[side]
    if (!element) continue
    if (instances[side]) {
      instances[side]!.setOptions(bounds())
      instances[side]!.setItems(items(side))
      instances[side]!.setWindow(range.start, range.end, { animation: false })
      continue
    }
    const instance = new Timeline(element, items(side), {
      ...bounds(), start: range.start, end: range.end,
      locale: 'zh-cn', locales: { 'zh-cn': { current: '现在', time: '时间', deleteSelected: '删除所选项' } },
      height: '100%', stack: true, selectable: true, showCurrentTime: false,
      showMajorLabels: false, showMinorLabels: false,
      zoomKey: 'ctrlKey', horizontalScroll: true, verticalScroll: true,
      margin: { item: { horizontal: 18, vertical: 20 }, axis: 42 },
      orientation: { axis: side === 'upper' ? 'bottom' : 'top', item: side === 'upper' ? 'bottom' : 'top' },
      tooltip: { followMouse: false },
    })
    instances[side] = instance
    instance.on('select', (properties: { items?: Array<string | number> }) => {
      const id = properties.items?.[0]
      if (id !== undefined) selectRenderedItem(String(id))
    })
    instance.on('rangechange', (properties: { start: Date; end: Date; byUser: boolean }) => {
      if (!properties.byUser) return
      const next = { start: new Date(properties.start), end: new Date(properties.end) }
      timeWindow.value = next
      persistView()
      instances[side === 'upper' ? 'lower' : 'upper']?.setWindow(next.start, next.end, { animation: false })
    })
  }
  if (selectedId.value && !selectedEvent.value) selectedId.value = ''
  if (selectedEvent.value) selectEvent(selectedId.value)
  scheduleRedraw()
}
function fitAll() { applyWindow(fullWindow()) }
const axisEvents = computed(() => {
  const range = timeWindow.value
  if (!range) return []
  const start = range.start.getTime(), span = range.end.getTime() - start
  return visibleEvents.value.map(event => ({ event, position: (eventPosition(event) - start) / span * 100 })).filter(item => item.position >= 0 && item.position <= 100)
})
function portraitPosition(value: number) {
  const range = timeWindow.value ?? initialWindow()
  return (value - range.start.getTime()) / Math.max(1, range.end.getTime() - range.start.getTime()) * 100
}
function portraitCardStyle(group: VisibleDensityGroup) {
  return { top: `${portraitPosition(group.start)}%` }
}
function overviewMarkerStyle(marker: { left: string }) {
  return isPortrait.value ? { top: marker.left, left: '50%' } : { left: marker.left }
}
function overviewMarkers() {
  const range = fullWindow(), span = range.end.getTime() - range.start.getTime()
  return allEvents.value.map(event => ({ id: event.id, left: `${(eventPosition(event) - range.start.getTime()) / span * 100}%`, yearless: event.startsAt.startsWith('--'), visible: !props.personId || event.personIds.includes(props.personId) }))
}
function overviewWindow() {
  const whole = fullWindow(), current = timeWindow.value ?? whole
  const span = whole.end.getTime() - whole.start.getTime()
  const start = Math.max(0, (current.start.getTime() - whole.start.getTime()) / span * 100)
  const end = Math.min(100, (current.end.getTime() - whole.start.getTime()) / span * 100)
  return isPortrait.value
    ? { top: `${start}%`, height: `${Math.max(1, end - start)}%`, left: '0', width: '100%' }
    : { left: `${start}%`, width: `${Math.max(1, end - start)}%` }
}
function navigateOverview(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement, rect = target.getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, isPortrait.value ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width))
  const whole = fullWindow(), current = timeWindow.value ?? whole, span = current.end.getTime() - current.start.getTime()
  const center = whole.start.getTime() + fraction * (whole.end.getTime() - whole.start.getTime())
  applyWindow({ start: new Date(center - span / 2), end: new Date(center + span / 2) })
}
function cloneWindow(range = timeWindow.value ?? initialWindow()): TimeWindow {
  return { start: new Date(range.start), end: new Date(range.end) }
}
function constrainedPortraitWindow(start: number, requestedSpan: number): TimeWindow {
  const limits = bounds()
  const span = Math.max(limits.zoomMin, Math.min(limits.zoomMax, requestedSpan))
  let nextStart = start
  const min = limits.min.getTime(), max = limits.max.getTime()
  if (nextStart < min) nextStart = min
  if (nextStart + span > max) nextStart = max - span
  return { start: new Date(nextStart), end: new Date(nextStart + span) }
}
function beginPortraitPointer(event: PointerEvent) {
  if (!isPortrait.value) return
  const target = event.target as HTMLElement
  const current = event.currentTarget as HTMLElement
  try { current.setPointerCapture(event.pointerId) } catch { /* Pointer capture can be unavailable in embedded browsers. */ }
  portraitPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, onCard: Boolean(target.closest('.portrait-event-card')) })
  chartPointer = { x: event.clientX, y: event.clientY, moved: false }
  if (portraitPointers.size === 1) {
    portraitGesture = { mode: 'pending', startY: event.clientY, startWindow: cloneWindow(), startDistance: 0, startPointTime: 0, interactive: Boolean(target.closest('.portrait-event-card')) }
  } else if (portraitPointers.size >= 2) {
    const points = [...portraitPointers.values()].slice(0, 2)
    const rect = current.getBoundingClientRect()
    const centerY = (points[0]!.y + points[1]!.y) / 2 - rect.top
    const range = cloneWindow()
    const span = range.end.getTime() - range.start.getTime()
    portraitGesture = {
      mode: 'pinch', startY: centerY, startWindow: range,
      startDistance: Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y),
      startPointTime: range.start.getTime() + centerY / Math.max(1, rect.height) * span,
      interactive: false,
    }
  }
}
function movePortraitPointer(event: PointerEvent) {
  const point = portraitPointers.get(event.pointerId)
  if (!point || !isPortrait.value) return
  point.x = event.clientX; point.y = event.clientY
  const current = event.currentTarget as HTMLElement
  const rect = current.getBoundingClientRect()
  const points = [...portraitPointers.values()]
  if (points.length >= 2) {
    const gesture = portraitGesture
    if (!gesture || gesture.mode !== 'pinch') return
    const centerY = (points[0]!.y + points[1]!.y) / 2 - rect.top
    const distance = Math.max(1, Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y))
    const initialSpan = gesture.startWindow.end.getTime() - gesture.startWindow.start.getTime()
    const nextSpan = initialSpan * gesture.startDistance / distance
    const nextStart = gesture.startPointTime - centerY / Math.max(1, rect.height) * nextSpan
    applyWindow(constrainedPortraitWindow(nextStart, nextSpan))
    if (chartPointer) chartPointer.moved = true
    return
  }
  const gesture = portraitGesture
  if (!gesture || gesture.mode === 'pinch' || gesture.interactive) return
  const distance = event.clientY - gesture.startY
  if (gesture.mode === 'pending' && Math.abs(distance) > 8) {
    gesture.mode = 'pan'
    if (chartPointer) chartPointer.moved = true
  }
  if (gesture.mode !== 'pan') return
  const span = gesture.startWindow.end.getTime() - gesture.startWindow.start.getTime()
  const nextStart = gesture.startWindow.start.getTime() - distance / Math.max(1, rect.height) * span
  applyWindow(constrainedPortraitWindow(nextStart, span))
}
function endPortraitPointer(event: PointerEvent) {
  portraitPointers.delete(event.pointerId)
  if (portraitPointers.size === 1) {
    const remaining = [...portraitPointers.values()][0]!
    portraitGesture = { mode: 'pending', startY: remaining.y, startWindow: cloneWindow(), startDistance: 0, startPointTime: 0, interactive: false }
  } else portraitGesture = null
}
function beginChartPointer(event: PointerEvent) { chartPointer = { x: event.clientX, y: event.clientY, moved: false } }
function moveChartPointer(event: PointerEvent) {
  if (chartPointer && Math.hypot(event.clientX - chartPointer.x, event.clientY - chartPointer.y) > 8) chartPointer.moved = true
}
function selectEvent(id: string) {
  if (!visibleEvents.value.some(event => event.id === id)) return
  selectedId.value = id
  selectedClusterId.value = ''
  const group = visibleDensityGroups.value.find(item => item.visibleMembers.some(event => event.id === id))
  for (const side of sides) instances[side]?.setSelection(eventSides.value.get(id) === side ? [group?.id ?? id] : [])
}
async function focusEvent(eventId: string): Promise<boolean> {
  await nextTick()
  const event = visibleEvents.value.find(item => item.id === eventId && item.scriptId === props.scriptId)
  if (!event) return false
  if (!timeWindow.value) await syncCharts()
  const range = timeWindow.value ?? initialWindow()
  const span = range.end.getTime() - range.start.getTime()
  const center = eventPosition(event)
  applyWindow({ start: new Date(center - span / 2), end: new Date(center + span / 2) })
  selectEvent(event.id)
  scheduleRedraw()
  return true
}
function selectChartEvent(event: MouseEvent) {
  if (chartPointer?.moved) { chartPointer = null; return }
  chartPointer = null
  const target = event.target as HTMLElement
  const content = target?.closest<HTMLElement>('.timeline-event-content') ?? target?.closest('.vis-item')?.querySelector<HTMLElement>('.timeline-event-content')
  if (content?.dataset.clusterId) void openCluster(content.dataset.clusterId)
  else if (content?.dataset.eventId) selectEvent(content.dataset.eventId)
}
function closeDetail() {
  selectedId.value = ''
  for (const side of sides) instances[side]?.setSelection([])
  scheduleRedraw()
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { if (selectedClusterId.value) closeCluster(); else if (selectedId.value) closeDetail(); else if (fullscreen.value) fullscreen.value = false }
}
watch(() => [props.events, props.personId], syncCharts, { deep: true })
watch(() => visibleDensityGroups.value.map(group => `${group.id}:${group.visibleMembers.map(event => event.id).join(',')}`).join('|'), scheduleDensityRefresh)
watch(layoutMode, value => {
  try { localStorage.setItem(`cluevault:timeline-layout:${encodeURIComponent(props.scriptId)}`, value) } catch {}
})
watch(viewCacheKey, async () => {
  persistView()
  for (const side of sides) { instances[side]?.destroy(); instances[side] = null }
  selectedClusterId.value = ''
  restoreView()
  await syncCharts()
})
watch(densityEnabled, persistView)
watch([selectedId, isPortrait], async () => { await nextTick(); scheduleRedraw() })
function updateOrientation() {
  if (!orientationMedia) return
  isPortrait.value = orientationMedia.matches
  void nextTick(scheduleRedraw)
}
watch(fullscreen, async active => {
  emit('fullscreen-change', active)
  if (active) {
    previousOverflow = document.body.style.overflow; returnFocus = document.activeElement as HTMLElement | null; document.body.style.overflow = 'hidden'
  } else { document.body.style.overflow = previousOverflow; returnFocus?.focus() }
  await nextTick()
  if (active) rootElement.value?.focus()
  scheduleRedraw()
})
onMounted(async () => {
  orientationMedia = window.matchMedia('(orientation: portrait)')
  isPortrait.value = orientationMedia.matches
  orientationMedia.addEventListener('change', updateOrientation)
  restoreView()
  await syncCharts()
  resizeObserver = new ResizeObserver(scheduleRedraw)
  if (rootElement.value) resizeObserver.observe(rootElement.value)
  if (plotElement.value) resizeObserver.observe(plotElement.value)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  persistView()
  for (const side of sides) instances[side]?.destroy()
  resizeObserver?.disconnect()
  orientationMedia?.removeEventListener('change', updateOrientation)
  portraitPointers.clear()
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  if (densityFrame) cancelAnimationFrame(densityFrame)
  document.removeEventListener('keydown', onKeydown)
  if (fullscreen.value) document.body.style.overflow = previousOverflow
})
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <section ref="rootElement" class="timeline-explorer" :class="{ 'is-fullscreen': fullscreen, 'has-detail': Boolean(selectedEvent || selectedCluster) }" tabindex="-1" :role="fullscreen ? 'dialog' : 'region'" :aria-modal="fullscreen || undefined" aria-label="时间线查看" @contextmenu.prevent>
      <header class="explorer-toolbar">
        <div class="explorer-header-main">
          <div class="explorer-heading"><span class="explorer-heading-icon"><UiIcon name="timeline" :size="20" /></span><div><strong>时间线</strong><span>{{ personId ? `${visibleEvents.length} / ${allEvents.length} 个事件` : `${allEvents.length} 个事件` }}</span></div></div>
          <div class="explorer-controls">
            <label v-if="allEvents.length && layoutMode === 'proportional'" class="density-toggle" :title="densitySummary"><input v-model="densityEnabled" type="checkbox" />收拢密集事件</label>
            <label class="person-filter person-filter-icon" :class="{ 'is-filtered': Boolean(personId) }" :title="personId ? '已筛选人物，点此切换' : '筛选人物'"><UiIcon name="person" :size="17" /><select :value="personId" aria-label="按人物筛选时间线" @change="emit('update:personId', ($event.target as HTMLSelectElement).value)"><option value="">全部人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label>
            <button type="button" class="explorer-button fit-button" title="显示全部" aria-label="显示全部" @click="fitAll"><UiIcon name="restore" :size="17" /><span>显示全部</span></button>
            <button type="button" class="explorer-button fullscreen-button" :aria-label="fullscreen ? '退出全屏时间线' : '全屏查看时间线'" :title="fullscreen ? '退出全屏' : '全屏'" @click="fullscreen = !fullscreen"><UiIcon :name="fullscreen ? 'close' : 'fullscreen'" :size="19" /><span>{{ fullscreen ? '退出全屏' : '全屏' }}</span></button>
            <div class="explorer-layout-toggle" role="group" aria-label="时间线排列方式"><button type="button" :class="{ active: layoutMode === 'proportional' }" aria-label="时间比例" title="时间比例" :aria-pressed="layoutMode === 'proportional'" @click="layoutMode = 'proportional'">时间比例</button><button type="button" :class="{ active: layoutMode === 'sequence' }" aria-label="事件顺序" title="事件顺序" :aria-pressed="layoutMode === 'sequence'" @click="layoutMode = 'sequence'">事件顺序</button></div>
          </div>
          <div class="explorer-page-actions"><slot name="page-actions" /></div>
        </div>
      </header>
      <div v-if="allEvents.length" class="explorer-stage">
        <article class="timeline-lane unified-lane">
          <div class="lane-heading"><strong>{{ layoutMode === 'sequence' ? '事件顺序' : '实际时间' }}</strong><span class="timeline-legend"><template v-if="datedCount"><i class="dated-swatch"></i>有年份</template><template v-if="yearlessCount"><i class="yearless-swatch"></i>无年份</template></span></div>
          <div class="timeline-view-body" :class="{ 'is-portrait': isPortrait }">
            <div ref="plotElement" class="unified-chart" :class="{ 'portrait-chart': isPortrait }">
              <div v-if="isPortrait" class="portrait-timeline" @pointerdown.capture="beginPortraitPointer" @pointermove.capture="movePortraitPointer" @pointerup.capture="endPortraitPointer" @pointercancel.capture="endPortraitPointer" @click.capture="selectChartEvent">
                <div class="shared-time-axis portrait-time-axis" aria-hidden="true"><div class="shared-axis-line"></div><i v-for="item in axisEvents" :key="item.event.id" class="shared-axis-dot" :class="{ 'is-yearless': item.event.startsAt.startsWith('--'), 'is-dated': !item.event.startsAt.startsWith('--'), 'is-selected': item.event.id === selectedId }" :style="{ top: `${item.position}%` }"></i></div>
                <button v-for="group in visibleDensityGroups" :key="group.id" class="portrait-event-card timeline-event-content" :class="[`half-${group.side}`, { 'timeline-node-yearless': group.visibleMembers.every(event => event.startsAt.startsWith('--')), 'timeline-node-mixed': group.visibleMembers.some(event => event.startsAt.startsWith('--')) && group.visibleMembers.some(event => !event.startsAt.startsWith('--')), 'is-selected': group.id === selectedClusterId || group.visibleMembers.some(event => event.id === selectedId) }]" :style="portraitCardStyle(group)" :data-event-id="group.members.length === 1 ? group.members[0]!.id : undefined" :data-cluster-id="group.members.length > 1 ? group.id : undefined" :aria-label="group.members.length > 1 ? `${clusterLabel(group)}，${group.visibleMembers.length} 个事件，展开逐条查看` : `${eventDateLabel(group.visibleMembers[0]!)}，${eventTitle(group.visibleMembers[0]!)}`">
                  <span class="timeline-node-time">{{ group.members.length > 1 ? clusterLabel(group) : `${group.visibleMembers[0]!.approximate ? '约 ' : ''}${eventDateLabel(group.visibleMembers[0]!)}` }}</span>
                  <span class="timeline-node-title">{{ group.members.length > 1 ? `${group.visibleMembers.length} 个事件` : eventTitle(group.visibleMembers[0]!) }}</span>
                  <span v-if="group.members.length > 1" class="timeline-node-precision">{{ clusterKinds(group) }} · 点击展开</span>
                </button>
              </div>
              <div v-for="side in sides" :key="side" v-show="!isPortrait" class="timeline-half" :class="`half-${side}`"><div class="lane-chart" @pointerdown.capture="beginChartPointer" @pointermove.capture="moveChartPointer" @click.capture="selectChartEvent"><div :ref="element => setChartElement(side, element)" class="explorer-vis-host"></div></div></div>
              <div v-if="!isPortrait" class="shared-time-axis" aria-hidden="true"><div class="shared-axis-line"></div><i v-for="item in axisEvents" :key="item.event.id" class="shared-axis-dot" :class="{ 'is-yearless': item.event.startsAt.startsWith('--'), 'is-dated': !item.event.startsAt.startsWith('--'), 'is-selected': item.event.id === selectedId }" :style="{ left: `${item.position}%` }"></i></div>
              <div v-if="!visibleEvents.length" class="lane-empty"><UiIcon name="filter" :size="24" /><span>没有该人物的时间事件</span><button @click="emit('update:personId', '')">查看全部人物</button></div>
            </div>
            <div class="lane-overview" aria-label="时间线全局导航" @pointerdown="navigateOverview"><span class="overview-window" :style="overviewWindow()"></span><i v-for="marker in overviewMarkers()" :key="marker.id" :style="overviewMarkerStyle(marker)" :class="{ 'is-hidden': !marker.visible, 'is-yearless': marker.yearless }"></i></div>
          </div>
        </article>
      </div>
      <div v-else class="explorer-empty"><span><UiIcon name="timeline" :size="34" /></span><strong>还没有已确认的时间事件</strong><p>添加时间节点，或从整理建议中录入事件。</p></div>
      <aside v-if="selectedCluster" ref="clusterPanel" class="event-cluster-panel" role="dialog" aria-label="密集事件列表" tabindex="-1">
        <header><div><strong>{{ selectedCluster.visibleMembers.length }} 个事件</strong><p>{{ clusterLabel(selectedCluster) }}</p><span>{{ clusterKinds(selectedCluster) }}<template v-if="personId"> · 全组 {{ selectedCluster.members.length }} 个，当前筛选 {{ selectedCluster.visibleMembers.length }} 个</template></span></div><button class="detail-close" aria-label="关闭密集事件列表" @click="closeCluster"><UiIcon name="close" :size="18" /></button></header>
        <p class="cluster-explanation">{{ selectedCluster.start === selectedCluster.end ? '这些事件位于同一时刻，可逐条查看；收拢未合并或删除事件。' : '事件按原时间顺序保留，筛选只隐藏成员，不改变本组在时间轴的位置。' }}</p>
        <ol class="cluster-members"><li v-for="event in selectedCluster.visibleMembers" :key="event.id"><button @click="selectEvent(event.id)"><span class="cluster-member-time">{{ event.approximate ? '约 ' : '' }}{{ eventDateLabel(event) }}<small :class="{ 'is-yearless': event.startsAt.startsWith('--') }">{{ event.startsAt.startsWith('--') ? '无年份' : '有年份' }}</small></span><strong>{{ eventTitle(event) }}</strong><span v-if="sourceReviewIds.has(event.id)" class="source-review-hint">来源已修改，待核对</span><span>{{ precisionLabel(event) }}<template v-if="memberPeople(event)"> · {{ memberPeople(event) }}</template></span><em>查看详情与原始线索 ›</em></button></li></ol>
        <footer v-if="selectedCluster.end > selectedCluster.start"><button class="explorer-button" @click="expandCluster"><UiIcon name="zoomIn" :size="16" />放大这一段</button></footer>
      </aside>
      <aside v-if="selectedEvent" class="event-detail" aria-live="polite">
        <button class="detail-close" aria-label="收起事件详情" @click="closeDetail"><UiIcon name="close" :size="18" /></button>
        <div class="detail-main"><div class="detail-time"><UiIcon name="clock" :size="17" /><strong>{{ selectedEvent.approximate ? '约 ' : '' }}{{ eventDateLabel(selectedEvent) }}</strong><span v-if="selectedEvent.startsAt.startsWith('--') && !selectedEvent.yearlessMarkerIgnored" class="yearless-badge">无年份</span></div><h3>{{ eventTitle(selectedEvent) }}</h3><p v-if="sourceReviewIds.has(selectedEvent.id)" class="source-review-hint">来源已修改，待核对</p><div class="detail-people"><span class="precision-badge">{{ selectedEvent.approximate ? '约时 · ' : '' }}{{ precisionLabel(selectedEvent) }}</span><span v-for="person in selectedPeople" :key="person.id"><UiIcon name="person" :size="13" />{{ person.name }}</span><button v-if="!readOnly && selectedEvent.startsAt.startsWith('--')" class="marker-button" @click="emit('toggle-marker', selectedEvent)">{{ selectedEvent.yearlessMarkerIgnored ? '恢复无年份标记' : '忽略无年份标记' }}</button></div></div>
        <div class="detail-evidence" v-if="selectedEvidence.length"><div v-for="source in selectedEvidence" :key="`${source.clue.id}:${source.quote}`" class="evidence-entry"><button class="explorer-button" @click="emit('open-clue', source.clue.id, source.quote || undefined)"><UiIcon name="image" :size="16" />原线索 #{{ String(source.clue.number).padStart(3, '0') }}</button><blockquote v-if="source.quote">{{ source.quote }}</blockquote></div></div>
        <div v-if="!readOnly" class="detail-actions"><button class="explorer-button edit-button" @click="emit('edit-event', selectedEvent)"><UiIcon name="edit" :size="17" />编辑事件</button></div>
      </aside>
    </section>
  </Teleport>
</template>

<style scoped>
.timeline-explorer, .timeline-explorer :deep(*) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.timeline-explorer { --explorer-accent: #486b86; position: relative; display: flex; flex: 1; flex-direction: column; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; border: 1px solid #dfe6ec; border-radius: 20px; background: #f6f8fa; color: #24313d; outline: none; }
.timeline-explorer.is-fullscreen { position: fixed; inset: 0; z-index: 1100; width: 100%; height: 100dvh; border: 0; border-radius: 0; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); background: #f6f8fa; box-sizing: border-box; }
.explorer-toolbar { display: flex; flex-shrink: 0; padding: 14px 16px; border-bottom: 1px solid #e5eaef; background: #fff; }
.explorer-header-main { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.explorer-controls { display: flex; flex: 1 1 auto; align-items: center; justify-content: flex-end; flex-wrap: nowrap; gap: 4px; min-width: 0; }
.explorer-page-actions { flex: 0 0 auto; min-width: 0; margin-left: 0; }
.explorer-page-actions :deep(.timeline-page-actions) { gap: 4px; flex-wrap: nowrap; }
.explorer-page-actions :deep(.timeline-display-toggle button) { flex: 0 0 40px; width: 40px; min-width: 40px; min-height: 40px; padding: 0; gap: 0; font-size: 12px; }
.explorer-page-actions :deep(.timeline-add-event) { flex: 0 0 40px; width: 40px; min-width: 40px; min-height: 40px; padding: 0; font-size: 12px; white-space: nowrap; }
.explorer-heading { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.explorer-heading-icon { display: grid; place-items: center; width: 40px; height: 40px; color: #486b86; background: #eef3f7; border-radius: 12px; }
.explorer-heading strong { display: block; color: #24313d; font-size: 17px; line-height: 1.4; font-weight: 650; letter-spacing: -.02em; }
.explorer-heading div > span { display: block; color: #778491; font-size: 12px; line-height: 1.6; }
.person-filter { display: flex; align-items: center; gap: 7px; margin: 0; min-width: 140px; min-height: 44px; padding: 0 12px; border: 1px solid #dfe6ec; border-radius: 11px; color: #6b7c8b; background: #fff; }
.explorer-controls .person-filter { flex: 0 0 40px; width: 40px; min-width: 40px; min-height: 40px; justify-content: center; gap: 0; padding: 0; }
.person-filter select { width: 100%; min-width: 0; min-height: 42px; margin: 0; padding: 4px 2px; border: 0; border-radius: 0; background: transparent; color: #344657; font: inherit; font-size: 13px; box-shadow: none; }
.person-filter-icon { position: relative; }
.person-filter-icon select { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; padding: 0; opacity: 0; cursor: pointer; }
.person-filter-icon.is-filtered { border-color: #b8cbd5; background: #eef4f7; color: #466879; }
.explorer-view-toggle { display: flex; padding: 3px; gap: 2px; border: 1px solid #e5eaef; border-radius: 12px; background: #f4f6f8; }
.explorer-view-toggle button { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: #7b8894; font: inherit; font-size: 13px; cursor: pointer; transition: background .18s, color .18s; }
.explorer-view-toggle button.active { color: #324e66; background: #fff; box-shadow: 0 1px 3px #24313d0c; }
.explorer-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0 14px; border: 1px solid #dce4eb; border-radius: 11px; background: #fff; color: #40596e; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; touch-action: manipulation; transition: background .18s, border-color .18s; }
.explorer-button:active, .explorer-view-toggle button:active { background: #eaf0f5; }
.fullscreen-button { color: #fff; background: #344e64; border-color: #344e64; }
.fullscreen-button:active { background: #263e52; }
.explorer-layout-toggle { display: flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid #e5eaef; border-radius: 12px; background: #f4f6f8; flex-shrink: 0; }
.explorer-controls .explorer-button { min-height: 40px; padding-inline: 9px; font-size: 12px; }
.explorer-controls .fit-button, .explorer-controls .fullscreen-button { width: 40px; flex: 0 0 40px; gap: 0; padding: 0; }
.explorer-controls .fit-button > span, .explorer-controls .fullscreen-button > span { display: none; }
.explorer-controls .explorer-layout-toggle button { min-height: 38px; padding-inline: 9px; font-size: 12px; }
.explorer-controls .density-toggle { min-height: 40px; }
.explorer-layout-toggle button { border: 0; border-radius: 9px; background: transparent; color: #7b8894; padding: 0 14px; min-height: 44px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s; }
.explorer-layout-toggle button.active { background: #fff; color: #324e66; font-weight: 600; box-shadow: 0 1px 3px #24313d0c; }
.explorer-layout-toggle button:focus-visible, .explorer-button:focus-visible, .explorer-view-toggle button:focus-visible { outline: 2px solid #7f9db4; outline-offset: 2px; }
.density-toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; margin: 0; color: #526879; font-size: 12px; cursor: pointer; }
.density-toggle input { width: 17px; height: 17px; margin: 0; accent-color: var(--explorer-accent); }
.explorer-stage { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; padding: 10px 14px 12px; overflow: hidden; }
.timeline-lane { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: 0; border-radius: 0; background: transparent; }
.lane-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; flex-shrink: 0; padding: 2px 2px 10px; color: #738392; }
.lane-heading strong { font-size: 11px; font-weight: 500; }
.timeline-legend { display: inline-flex; margin-left: auto; align-items: center; flex-wrap: wrap; gap: 7px; color: #7a8996; font-size: 11px; }
.timeline-legend i { display: inline-block; width: 8px; height: 8px; margin-left: 5px; border: 1px solid; border-radius: 3px; }
.timeline-legend i:first-child { margin-left: 0; }
.timeline-legend .dated-swatch { background: #edf3f7; border-color: #afc2d2; }
.timeline-legend .yearless-swatch { background: #f7f3ec; border-color: #d4c6b1; }
.unified-chart { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-width: 0; min-height: 0; margin: 0; overflow: hidden; isolation: isolate; background: #fbfcfd; border: 0; border-radius: 8px; }
.timeline-half { position: relative; z-index: 1; min-width: 0; min-height: 0; overflow: hidden; }
.lane-chart { position: relative; display: flex; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.explorer-vis-host { flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.shared-time-axis { position: absolute; z-index: 3; top: 50%; left: 0; right: 0; height: 0; pointer-events: none; }
.shared-axis-line { position: absolute; top: -1px; left: 0; right: 0; height: 2px; border-radius: 2px; background: #bdcbd7; }
.shared-axis-tick { position: absolute; top: 0; width: 1px; height: 0; color: #6e8293; font-style: normal; font-variant-numeric: tabular-nums; }
.shared-axis-tick::before { position: absolute; top: -5px; left: 0; width: 1px; height: 10px; background: #b8c7d4; content: ''; }
.shared-axis-tick > span, .shared-axis-tick > small { position: absolute; left: 0; padding: 2px 5px; border-radius: 4px; background: #fbfcfdf2; white-space: nowrap; text-align: center; transform: translateX(-50%); }
.shared-axis-tick > span { bottom: 9px; color: #526a7e; font-size: 11px; line-height: 1.5; font-weight: 600; }
.shared-axis-tick > small { top: 10px; color: #8a99a5; font-size: 10px; line-height: 1.5; }
.shared-axis-dot { position: absolute; z-index: 2; top: -4px; width: 8px; height: 8px; box-sizing: border-box; border: 2px solid #7895ad; border-radius: 50%; background: #fff; transform: translateX(-50%); }
.shared-axis-dot.is-yearless { border-color: #b9a68c; background: #fffdf9; }
.shared-axis-dot.is-selected { z-index: 3; border-color: #486b86; background: #486b86; box-shadow: 0 0 0 4px #486b8616; }
.lane-empty { position: absolute; z-index: 4; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #7e8d9a; font-size: 13px; background: #fbfcfdf2; }
.lane-empty button { min-height: 44px; padding: 0 14px; background: #eef3f7; border: 0; border-radius: 10px; color: #486b86; font: inherit; font-size: 13px; }
.lane-overview { position: relative; height: 26px; flex-shrink: 0; margin: 10px 0 0; border: 1px solid #e2e8ee; border-radius: 7px; background: #f3f6f9; overflow: hidden; cursor: pointer; touch-action: none; }
.lane-overview i { position: absolute; top: 6px; width: 3px; height: 12px; border-radius: 2px; background: #89a1b5; transform: translateX(-50%); pointer-events: none; }
.lane-overview i.is-yearless { background: #b7a38a; }
.lane-overview i.is-hidden { opacity: .16; }
.overview-window { position: absolute; inset-block: 0; border: 1px solid #9db3c6; border-radius: 6px; background: #b8cbdc26; pointer-events: none; }
.timeline-view-body { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.timeline-view-body.is-portrait { flex-direction: row; align-items: stretch; gap: 8px; }
.timeline-view-body.is-portrait .unified-chart { display: block; flex: 1; }
.timeline-view-body.is-portrait .lane-overview { width: 24px; height: auto; flex: 0 0 24px; margin: 0; }
.timeline-view-body.is-portrait .lane-overview i { top: auto; left: 50%; width: 12px; height: 3px; transform: translate(-50%, -50%); }
.portrait-timeline { position: absolute; z-index: 2; inset: 0; overflow: hidden; touch-action: none; }
.portrait-time-axis { top: 0; right: auto; bottom: 0; left: 50%; width: 0; height: auto; pointer-events: none; }
.portrait-time-axis .shared-axis-line { top: 0; right: auto; bottom: 0; left: -1px; width: 2px; height: auto; border-radius: 2px; background: #bdcbd7; }
.portrait-axis-tick { top: 0; left: 0; width: 0; height: 0; }
.portrait-axis-tick::before { top: 0; left: -5px; width: 10px; height: 1px; }
.portrait-axis-tick > span { top: 0; bottom: auto; left: 12px; transform: translateY(-50%); }
.portrait-axis-tick > small { top: 0; right: 12px; left: auto; transform: translateY(-50%); }
.portrait-time-axis .shared-axis-dot { top: 0; left: 0; transform: translate(-50%, -50%); }
.portrait-event-card { position: absolute; z-index: 2; display: block; width: calc(50% - 34px); max-width: 340px; min-width: 0; min-height: 56px; margin: 0; padding: 10px 12px; transform: translateY(-50%); overflow: visible; border: 1px solid #c8d7e3; border-radius: 10px; background: #f5f8fb; box-shadow: 0 2px 6px #23394d08; color: #24313d; font: inherit; text-align: left; white-space: normal; cursor: pointer; touch-action: manipulation; }
.portrait-event-card.half-upper { left: 8px; }
.portrait-event-card.half-lower { right: 8px; }
.portrait-event-card.half-upper::after, .portrait-event-card.half-lower::after { position: absolute; top: 50%; width: 26px; border-top: 1px solid #bacbd8; content: ''; }
.portrait-event-card.half-upper::after { right: -27px; }
.portrait-event-card.half-lower::after { left: -27px; }
.portrait-event-card.timeline-node-yearless { border-color: #dfd4c5; background: #faf7f2; }
.portrait-event-card.timeline-node-mixed { border-color: #cfd9e1; background: #f3f6f8; }
.portrait-event-card.is-selected { border-color: #6c91ae; background: #eef4f7; box-shadow: 0 0 0 2px #6c91ae17; }
.portrait-event-card .timeline-node-time { display: block; margin-bottom: 5px; color: #647f94; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.portrait-event-card.timeline-node-yearless .timeline-node-time { color: #9b846a; }
.portrait-event-card .timeline-node-title { display: block; max-width: 100%; color: #24313d; font-size: 12px; font-weight: 550; line-height: 1.5; overflow-wrap: anywhere; }
.portrait-event-card .timeline-node-precision { display: block; margin-top: 5px; color: #93a0ab; font-size: 10px; }
.explorer-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 0; padding: 24px; color: #5d7283; }
.explorer-empty > span { display: grid; place-items: center; width: 68px; height: 68px; margin-bottom: 6px; border-radius: 20px; background: #edf2f6; }
.explorer-empty strong { font-size: 16px; }
.explorer-empty p { margin: 0; color: #8a97a2; font-size: 13px; }
.event-detail { position: relative; z-index: 4; display: flex; align-items: flex-start; gap: 20px; flex: 0 0 auto; min-height: 0; max-height: 30%; margin: 0 14px 14px; padding: 18px 54px 18px 20px; border: 1px solid #d6e1ea; border-radius: 14px; background: #fff; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; animation: detail-appear .18s ease-out; box-sizing: border-box; }
.detail-main { flex: 1.2; min-width: 160px; }
.detail-evidence { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 150px; max-width: 42%; }
.evidence-entry { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.evidence-entry blockquote { margin: 0; padding-left: 11px; border-left: 2px solid #dce5ed; color: #6f808e; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.detail-time { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: #46647d; font-variant-numeric: tabular-nums; }
.yearless-badge { padding: 3px 7px; border-radius: 5px; background: #f5f0e8; color: #9a8162; font-size: 10px; }
.source-review-hint { margin: 6px 0; color: #9c7c4c; font-size: 12px; line-height: 1.5; }
.detail-main h3 { margin: 8px 0 10px; color: #24313d; font-size: 16px; font-weight: 600; line-height: 1.65; }
.detail-people { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.detail-people > span { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; background: #f1f5f8; color: #6d8090; font-size: 11px; }
.marker-button { min-height: 44px; border: 0; background: none; color: #8b95a0; font: inherit; font-size: 11px; padding: 6px 5px; cursor: pointer; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; align-self: center; }
.edit-button { background: #eef4f7; border-color: #d8e3eb; }
.detail-close { position: absolute; right: 6px; top: 6px; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: #8a99a5; cursor: pointer; }
.detail-close:active { background: #eef3f7; }
.event-cluster-panel { position: relative; z-index: 5; display: flex; flex-direction: column; flex: 0 0 34%; max-height: 34%; min-height: 0; margin: 0 14px 14px; overflow: hidden; border: 1px solid #d6e1ea; border-radius: 14px; background: #fff; outline: none; }
.event-cluster-panel > header { position: relative; flex-shrink: 0; padding: 16px 54px 12px 18px; border-bottom: 1px solid #e7edf2; }
.event-cluster-panel header strong { color: #344d63; font-size: 15px; }
.event-cluster-panel header p { margin: 6px 0; color: #6c8090; font-size: 12px; line-height: 1.5; }
.event-cluster-panel header span { color: #8a99a5; font-size: 11px; }
.cluster-explanation { flex-shrink: 0; margin: 0; padding: 10px 18px; color: #8292a0; background: #f7f9fb; font-size: 11px; line-height: 1.6; }
.cluster-members { flex: 1; min-height: 0; margin: 0; padding: 0 16px; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; list-style: none; }
.cluster-members li + li { border-top: 1px solid #e8edf2; }
.cluster-members button { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; width: 100%; min-height: 44px; padding: 15px 2px; border: 0; background: transparent; color: #3f596e; font: inherit; text-align: left; cursor: pointer; }
.cluster-members button:focus-visible { outline: 2px solid #8ca6bb; outline-offset: -2px; border-radius: 8px; }
.cluster-member-time { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
.cluster-member-time small { padding: 3px 6px; border-radius: 5px; background: #edf3f7; color: #7e95a8; font-size: 10px; }
.cluster-member-time small.is-yearless { color: #9a8162; background: #f5f0e8; }
.cluster-members strong { color: #24313d; font-size: 14px; line-height: 1.6; font-weight: 600; }
.cluster-members button > span:last-of-type { color: #8a99a5; font-size: 11px; }
.cluster-members em { color: #6989a2; font-size: 11px; font-style: normal; }
.event-cluster-panel footer { flex-shrink: 0; padding: 8px 18px; border-top: 1px solid #e8edf2; }
.event-cluster-panel footer button { width: 100%; }
.explorer-vis-host :deep(.vis-shadow) { display: none !important; }
.explorer-vis-host :deep(.vis-timeline) { border: 0; font-family: inherit; background: transparent; }
.explorer-vis-host :deep(.vis-panel.vis-center), .explorer-vis-host :deep(.vis-panel.vis-bottom), .explorer-vis-host :deep(.vis-panel.vis-top) { border: 0; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-minor) { border-color: #e5ecf144; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-major) { border-color: #dce5ec80; }
.explorer-vis-host :deep(.vis-item.vis-box) { border: 1px solid #c8d7e3 !important; border-radius: 11px !important; color: #24313d !important; background: #f5f8fb !important; box-shadow: 0 2px 6px #23394d04; font-size: 14px !important; }
.explorer-vis-host :deep(.vis-item .vis-item-content) { min-width: 160px; padding: 12px 15px; }
.explorer-vis-host :deep(.timeline-node-time) { display: block; margin-bottom: 7px; color: #647f94; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.explorer-vis-host :deep(.timeline-node-precision) { display: block; margin-top: 8px; color: #93a0ab; font-size: 10px; }
.explorer-vis-host :deep(.timeline-node-title) { display: block; max-width: 260px; white-space: normal; color: #24313d; font-size: 14px; font-weight: 550; line-height: 1.65; }
.explorer-vis-host :deep(.timeline-cluster-content) { display: block; max-width: 260px; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; white-space: normal; }
.explorer-vis-host :deep(.timeline-cluster-count) { display: block; color: #344e64; font-size: 16px; line-height: 1.5; }
.explorer-vis-host :deep(.timeline-cluster-content:focus-visible) { outline: 2px solid currentColor; outline-offset: 5px; border-radius: 4px; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-box) { color: #24313d !important; background: #faf7f2 !important; border-color: #dfd4c5 !important; }
.explorer-vis-host :deep(.timeline-node-yearless .timeline-node-time) { color: #9b846a; }
.explorer-vis-host :deep(.vis-item.timeline-node-mixed.vis-box) { background: #f3f6f8 !important; border-color: #cfd9e1 !important; }
.explorer-vis-host :deep(.vis-item.vis-selected.vis-box), .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected.vis-box) { color: #24313d !important; background: #eef4f7 !important; border-color: #6c91ae !important; box-shadow: 0 0 0 2px #6c91ae17; }
.explorer-vis-host :deep(.vis-selected .timeline-node-time) { color: #486b86; }
.explorer-vis-host :deep(.vis-item.vis-line) { width: 0; border: 0; border-left: 1px solid #bacbd8 !important; border-radius: 0 !important; background: transparent !important; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-line) { border-left-color: #d4c5b1 !important; }
.explorer-vis-host :deep(.vis-item.vis-dot) { display: none; }
@keyframes detail-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 950px) { .explorer-toolbar { padding: 12px 14px; } .explorer-header-main { gap: 10px; } .explorer-controls { gap: 5px; } .explorer-heading strong { font-size: 15px; } .person-filter { min-width: 120px; } .explorer-button { padding: 0 11px; font-size: 12px; } .explorer-view-toggle button { padding: 0 9px; font-size: 12px; } .explorer-stage { padding: 10px; } .lane-heading { padding-inline: 2px; } .detail-actions { max-width: 145px; } .detail-actions button { width: 100%; } }
@media (max-width: 1100px) { .explorer-header-main { gap: 6px; } .explorer-controls { gap: 3px; } .explorer-page-actions :deep(.timeline-page-actions) { gap: 3px; } }
@media (orientation: landscape) and (min-width: 760px) {
  .timeline-explorer.has-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 300px); grid-template-rows: auto minmax(0, 1fr); }
  .has-detail .explorer-toolbar { grid-column: 1 / -1; }
  .has-detail .explorer-stage { grid-column: 1; grid-row: 2; }
  .has-detail .event-detail, .has-detail .event-cluster-panel { grid-column: 2; grid-row: 2; width: auto; height: auto; min-width: 0; min-height: 0; max-height: none; margin: 10px 14px 12px 0; }
  .has-detail .event-detail { flex-direction: column; align-items: stretch; gap: 18px; padding: 20px; }
  .has-detail .detail-main { flex: 0 0 auto; min-width: 0; }
  .has-detail .detail-time { padding-right: 22px; }
  .has-detail .detail-evidence { flex: 0 0 auto; min-width: 0; max-width: none; }
  .has-detail .detail-actions { align-self: stretch; max-width: none; margin-top: auto; }
  .has-detail .detail-actions button { width: 100%; }
}
@media (orientation: portrait) { .event-detail { max-height: 35%; flex-wrap: wrap; gap: 12px; padding: 16px 52px 16px 18px; } .detail-main { flex-basis: 100%; } .detail-evidence { flex-basis: 100%; max-width: none; } .detail-actions { max-width: none; } .detail-main h3 { font-size: 15px; } .event-cluster-panel { flex-basis: 35%; max-height: 35%; } }
@media (max-width: 650px) { .explorer-header-main { flex-wrap: wrap; gap: 8px; } .explorer-heading { flex: 1 1 auto; order: 1; } .explorer-page-actions { flex: 0 0 auto; order: 2; margin-left: auto; } .explorer-controls { flex: 1 1 100%; order: 3; justify-content: flex-start; flex-wrap: wrap; } .portrait-event-card { width: calc(50% - 25px); padding: 8px 9px; } .portrait-event-card.half-upper { left: 4px; } .portrait-event-card.half-lower { right: 4px; } .portrait-event-card.half-upper::after { right: -21px; width: 20px; } .portrait-event-card.half-lower::after { left: -21px; width: 20px; } .explorer-controls .person-filter { margin-left: 0; } .explorer-controls .fit-button { margin-left: 0; } .explorer-layout-toggle { max-width: 100%; } .explorer-layout-toggle button { padding-inline: 12px; } .lane-heading { gap: 7px 10px; } .timeline-legend { font-size: 10px; } .shared-axis-tick > span { font-size: 10px; } .shared-axis-tick > small { font-size: 9px; } .explorer-vis-host :deep(.timeline-node-title) { max-width: 220px; } .event-detail, .event-cluster-panel { margin: 0 10px 10px; } }
@media (prefers-reduced-motion: reduce) { .event-detail { animation: none; } .explorer-button, .explorer-view-toggle button, .explorer-layout-toggle button { transition: none; } }
</style>
