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
const props = withDefaults(defineProps<{ events: TimelineRecord[]; people: PersonRecord[]; clues: ClueRecord[]; scriptId: string; personId: string; displayMode?: 'axis' | 'list'; readOnly?: boolean; sourceReviewEventIds?: string[] }>(), { displayMode: 'axis', sourceReviewEventIds: () => [] })
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
const orderedVisibleEvents = computed(() => orderedEvents.value.filter(event => !props.personId || event.personIds.includes(props.personId)))
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
  const content = document.createElement('button')
  content.type = 'button'
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
  hint.textContent = `${clusterKinds(group)}${props.personId ? ` · 全组 ${group.members.length} 条` : ''}`
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
  const extent = Math.max(1, (isPortrait.value ? plotElement.value?.clientHeight : plotElement.value?.clientWidth) || plotExtent.value)
  const cards = plotElement.value?.querySelectorAll<HTMLElement>(isPortrait.value ? '.portrait-event-card' : '.vis-item.vis-box')
  const cardExtent = Math.max(isPortrait.value ? 96 : 290, ...Array.from(cards || [], card => isPortrait.value ? card.getBoundingClientRect().height : card.getBoundingClientRect().width))
  // Reserve card half-width plus a reading gutter on each edge of the time axis.
  const edgeRatio = Math.min(.45, Math.max(.08, (cardExtent / 2 + 20) / extent))
  const span = Math.max(last - first, layoutMode.value === 'sequence' ? sequenceStep * 2 : 3 * 60 * 60_000) / (1 - edgeRatio * 2)
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
function fitAll() {
  const range = fullWindow()
  for (const side of sides) instances[side]?.setOptions(bounds())
  applyWindow(range)
}
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
watch(() => props.displayMode, async mode => {
  if (mode === 'axis') { await nextTick(); scheduleRedraw() }
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
    <section ref="rootElement" class="timeline-explorer" :class="{ 'is-fullscreen': fullscreen, 'has-detail': Boolean(selectedEvent || selectedCluster) }" tabindex="-1" :role="fullscreen ? 'dialog' : 'region'" :aria-modal="fullscreen || undefined" aria-label="时间线查看">
      <header class="explorer-toolbar">
        <div class="explorer-header-main">
          <div class="explorer-heading"><span class="explorer-heading-icon"><UiIcon name="timeline" :size="20" /></span><div><strong>时间线</strong><span>{{ personId ? `${visibleEvents.length} / ${allEvents.length} 个事件` : `${allEvents.length} 个事件` }}</span></div></div>
          <div v-if="displayMode === 'axis'" class="explorer-controls">
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
          <div class="lane-heading"><strong>{{ displayMode === 'list' ? '事件列' : layoutMode === 'sequence' ? '事件顺序' : '实际时间' }}</strong><span class="timeline-legend"><template v-if="datedCount"><i class="dated-swatch"></i>有年份</template><template v-if="yearlessCount"><i class="yearless-swatch"></i>无年份</template></span></div>
          <div class="timeline-view-body" :class="{ 'is-portrait': isPortrait && displayMode === 'axis', 'is-event-list': displayMode === 'list' }">
            <div v-show="displayMode === 'axis'" ref="plotElement" class="unified-chart" :class="{ 'portrait-chart': isPortrait }" @contextmenu.prevent>
              <div v-if="isPortrait" class="portrait-timeline" @pointerdown.capture="beginPortraitPointer" @pointermove.capture="movePortraitPointer" @pointerup.capture="endPortraitPointer" @pointercancel.capture="endPortraitPointer" @click.capture="selectChartEvent">
                <div class="shared-time-axis portrait-time-axis" aria-hidden="true"><div class="shared-axis-line"></div><i v-for="item in axisEvents" :key="item.event.id" class="shared-axis-dot" :class="{ 'is-yearless': item.event.startsAt.startsWith('--'), 'is-dated': !item.event.startsAt.startsWith('--'), 'is-selected': item.event.id === selectedId }" :style="{ top: `${item.position}%` }"></i></div>
                <button v-for="group in visibleDensityGroups" :key="group.id" class="portrait-event-card timeline-event-content" :class="[`half-${group.side}`, { 'timeline-node-yearless': group.visibleMembers.every(event => event.startsAt.startsWith('--')), 'timeline-node-mixed': group.visibleMembers.some(event => event.startsAt.startsWith('--')) && group.visibleMembers.some(event => !event.startsAt.startsWith('--')), 'is-selected': group.id === selectedClusterId || group.visibleMembers.some(event => event.id === selectedId) }]" :style="portraitCardStyle(group)" :data-event-id="group.members.length === 1 ? group.members[0]!.id : undefined" :data-cluster-id="group.members.length > 1 ? group.id : undefined" :aria-label="group.members.length > 1 ? `${clusterLabel(group)}，${group.visibleMembers.length} 个事件，展开逐条查看` : `${eventDateLabel(group.visibleMembers[0]!)}，${eventTitle(group.visibleMembers[0]!)}`">
                  <span class="timeline-node-time">{{ group.members.length > 1 ? clusterLabel(group) : `${group.visibleMembers[0]!.approximate ? '约 ' : ''}${eventDateLabel(group.visibleMembers[0]!)}` }}</span>
                  <span class="timeline-node-title">{{ group.members.length > 1 ? `${group.visibleMembers.length} 个事件` : eventTitle(group.visibleMembers[0]!) }}</span>
                  <span v-if="group.members.length > 1" class="timeline-node-precision">{{ clusterKinds(group) }}</span>
                </button>
              </div>
              <div v-for="side in sides" :key="side" v-show="!isPortrait" class="timeline-half" :class="`half-${side}`"><div class="lane-chart" @pointerdown.capture="beginChartPointer" @pointermove.capture="moveChartPointer" @click.capture="selectChartEvent"><div :ref="element => setChartElement(side, element)" class="explorer-vis-host"></div></div></div>
              <div v-if="!isPortrait" class="shared-time-axis" aria-hidden="true"><div class="shared-axis-line"></div><i v-for="item in axisEvents" :key="item.event.id" class="shared-axis-dot" :class="{ 'is-yearless': item.event.startsAt.startsWith('--'), 'is-dated': !item.event.startsAt.startsWith('--'), 'is-selected': item.event.id === selectedId }" :style="{ left: `${item.position}%` }"></i></div>
              <div v-if="!visibleEvents.length" class="lane-empty"><UiIcon name="filter" :size="24" /><span>没有该人物的时间事件</span><button @click="emit('update:personId', '')">查看全部人物</button></div>
            </div>
            <div v-if="displayMode === 'list'" class="event-list-view" role="list" aria-label="事件列">
              <button v-for="event in orderedVisibleEvents" :key="event.id" type="button" class="event-column-card" :class="{ 'timeline-node-yearless': event.startsAt.startsWith('--'), 'is-selected': event.id === selectedId }" :data-event-id="event.id" role="listitem" @click="selectEvent(event.id)">
                <i class="event-column-marker" aria-hidden="true"></i>
                <span class="event-column-main"><time class="event-column-time">{{ event.approximate ? '约 ' : '' }}{{ eventDateLabel(event) }}</time><strong class="event-column-title">{{ eventTitle(event) }}</strong><small v-if="memberPeople(event)" class="event-column-people">{{ memberPeople(event) }}</small></span>
                <span v-if="sourceReviewIds.has(event.id)" class="event-column-review">来源待核对</span>
              </button>
              <div v-if="!orderedVisibleEvents.length" class="event-list-empty"><UiIcon name="filter" :size="24" /><span>没有该人物的时间事件</span><button type="button" @click="emit('update:personId', '')">查看全部人物</button></div>
            </div>
            <div v-show="displayMode === 'axis'" class="lane-overview" aria-label="时间线全局导航" @contextmenu.prevent @pointerdown="navigateOverview"><span class="overview-window" :style="overviewWindow()"></span><i v-for="marker in overviewMarkers()" :key="marker.id" :style="overviewMarkerStyle(marker)" :class="{ 'is-hidden': !marker.visible, 'is-yearless': marker.yearless }"></i></div>
          </div>
        </article>
      </div>
      <div v-else class="explorer-empty"><span><UiIcon name="timeline" :size="34" /></span><strong>还没有已确认的时间事件</strong><p>添加时间节点，或从整理建议中录入事件。</p></div>
      <aside v-if="selectedCluster" ref="clusterPanel" class="event-cluster-panel" role="dialog" aria-label="密集事件列表" tabindex="-1">
        <header><div><strong>{{ selectedCluster.visibleMembers.length }} 个事件</strong><p>{{ clusterLabel(selectedCluster) }}</p><span>{{ clusterKinds(selectedCluster) }}<template v-if="personId"> · 全组 {{ selectedCluster.members.length }} 个，当前筛选 {{ selectedCluster.visibleMembers.length }} 个</template></span></div><button class="detail-close" aria-label="关闭密集事件列表" @click="closeCluster"><UiIcon name="close" :size="18" /></button></header>
        <ol class="cluster-members"><li v-for="event in selectedCluster.visibleMembers" :key="event.id"><button @click="selectEvent(event.id)"><span class="cluster-member-time">{{ event.approximate ? '约 ' : '' }}{{ eventDateLabel(event) }}<small :class="{ 'is-yearless': event.startsAt.startsWith('--') }">{{ event.startsAt.startsWith('--') ? '无年份' : '有年份' }}</small></span><strong>{{ eventTitle(event) }}</strong><span v-if="sourceReviewIds.has(event.id)" class="source-review-hint">来源已修改，待核对</span><span>{{ precisionLabel(event) }}<template v-if="memberPeople(event)"> · {{ memberPeople(event) }}</template></span><em>查看详情 ›</em></button></li></ol>
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
.unified-chart, .unified-chart :deep(*), .lane-overview, .lane-overview * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.timeline-explorer { --explorer-accent: var(--cv-accent); position: relative; display: flex; flex: 1; flex-direction: column; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-canvas); color: var(--cv-ink); outline: none; }
.timeline-explorer.is-fullscreen { position: fixed; inset: 0; z-index: 1100; width: 100%; height: 100dvh; border: 0; border-radius: 0; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); background: var(--cv-canvas); box-sizing: border-box; }
.explorer-toolbar { display: flex; flex-shrink: 0; padding: 14px 16px; border-bottom: 1px solid var(--cv-border); background: var(--cv-surface); }
.explorer-header-main { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.explorer-controls { display: flex; flex: 1 1 auto; align-items: center; justify-content: flex-end; flex-wrap: nowrap; gap: 4px; min-width: 0; }
.explorer-page-actions { flex: 0 0 auto; min-width: 0; margin-left: auto; }
.explorer-page-actions :deep(.timeline-page-actions) { gap: 4px; flex-wrap: nowrap; }
.explorer-page-actions :deep(.timeline-display-toggle button) { flex: 0 0 40px; width: 40px; min-width: 40px; height: 40px; min-height: 40px; padding: 0; gap: 0; font-size: 12px; }
.explorer-page-actions :deep(.timeline-add-event) { flex: 0 0 40px; width: 40px; min-width: 40px; height: 40px; min-height: 40px; padding: 0; font-size: 12px; white-space: nowrap; }
.explorer-heading { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.explorer-heading-icon { display: grid; place-items: center; width: 40px; height: 40px; color: var(--cv-accent); background: var(--cv-accent-soft); border-radius: var(--cv-radius-control); }
.explorer-heading strong { display: block; color: var(--cv-ink); font-size: 17px; line-height: 1.4; font-weight: 650; letter-spacing: -.02em; }
.explorer-heading div > span { display: block; color: var(--cv-muted); font-size: 12px; line-height: 1.6; }
.person-filter { display: flex; align-items: center; gap: 7px; margin: 0; min-width: 140px; min-height: 44px; padding: 0 12px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); color: var(--cv-secondary); background: var(--cv-surface); }
.explorer-controls .person-filter { flex: 0 0 40px; width: 40px; min-width: 40px; min-height: 40px; justify-content: center; gap: 0; padding: 0; }
.person-filter select { width: 100%; min-width: 0; min-height: 42px; margin: 0; padding: 4px 2px; border: 0; border-radius: 0; background: transparent; color: var(--cv-ink); font: inherit; font-size: 13px; box-shadow: none; }
.person-filter-icon { position: relative; }
.person-filter-icon select { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; padding: 0; opacity: 0; cursor: pointer; }
.person-filter-icon.is-filtered { border-color: var(--cv-accent); background: var(--cv-accent-soft); color: var(--cv-accent); }
.explorer-view-toggle { display: flex; padding: 3px; gap: 2px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface-subtle); }
.explorer-view-toggle button { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; padding: 0 12px; border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--cv-muted); font: inherit; font-size: 13px; cursor: pointer; transition: background-color var(--cv-motion-press) var(--cv-ease), color var(--cv-motion-press) var(--cv-ease); }
.explorer-view-toggle button.active { color: var(--cv-accent-strong); background: var(--cv-surface); box-shadow: 0 1px 3px transparent; }
.explorer-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0 14px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface); color: var(--cv-secondary); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; touch-action: manipulation; transition: background-color var(--cv-motion-press) var(--cv-ease), border-color var(--cv-motion-press) var(--cv-ease); }
.explorer-button:active, .explorer-view-toggle button:active { background: var(--cv-accent-soft); }
.fullscreen-button { color: var(--cv-on-accent); background: var(--cv-accent); border-color: var(--cv-accent); }
.fullscreen-button:active { background: var(--cv-accent-strong); }
.explorer-layout-toggle { display: flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface-subtle); flex-shrink: 0; }
.explorer-controls .explorer-button { min-height: 40px; padding-inline: 9px; font-size: 12px; }
.explorer-controls .fit-button, .explorer-controls .fullscreen-button { width: 40px; flex: 0 0 40px; gap: 0; padding: 0; }
.explorer-controls .fit-button > span, .explorer-controls .fullscreen-button > span { display: none; }
.explorer-controls .explorer-layout-toggle button { min-height: 38px; padding-inline: 9px; font-size: 12px; }
.explorer-controls .density-toggle { min-height: 40px; }
.explorer-layout-toggle button { border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--cv-muted); padding: 0 14px; min-height: 44px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; transition: background-color var(--cv-motion-press) var(--cv-ease), color var(--cv-motion-press) var(--cv-ease); }
.explorer-layout-toggle button.active { background: var(--cv-surface); color: var(--cv-accent-strong); font-weight: 600; box-shadow: 0 1px 3px transparent; }
.explorer-layout-toggle button:focus-visible, .explorer-button:focus-visible, .explorer-view-toggle button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.density-toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; margin: 0; color: var(--cv-secondary); font-size: 12px; cursor: pointer; }
.density-toggle input { width: 17px; height: 17px; margin: 0; accent-color: var(--explorer-accent); }
.explorer-stage { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; padding: 10px 14px 12px; overflow: hidden; }
.timeline-lane { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: 0; border-radius: 0; background: transparent; }
.lane-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; flex-shrink: 0; padding: 2px 2px 10px; color: var(--cv-muted); }
.lane-heading strong { font-size: var(--cv-type-meta); font-weight: 500; }
.timeline-legend { display: inline-flex; margin-left: auto; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--cv-muted); font-size: var(--cv-type-meta); }
.timeline-legend i { display: inline-block; width: 8px; height: 8px; margin-left: 5px; border: 1px solid; border-radius: 3px; }
.timeline-legend i:first-child { margin-left: 0; }
.timeline-legend .dated-swatch { background: var(--cv-accent-soft); border-color: var(--cv-border-strong); }
.timeline-legend .yearless-swatch { background: var(--cv-warning-soft); border-color: var(--cv-warning); }
.unified-chart { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-width: 0; min-height: 0; margin: 0; overflow: hidden; isolation: isolate; background: var(--cv-surface); border: 0; border-radius: 8px; }
.timeline-half { position: relative; z-index: 1; min-width: 0; min-height: 0; overflow: hidden; }
.lane-chart { position: relative; display: flex; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.explorer-vis-host { flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.shared-time-axis { position: absolute; z-index: 3; top: 50%; left: 0; right: 0; height: 0; pointer-events: none; }
.shared-axis-line { position: absolute; top: -1px; left: 0; right: 0; height: 2px; border-radius: 2px; background: var(--cv-border-strong); }
.shared-axis-tick { position: absolute; top: 0; width: 1px; height: 0; color: var(--cv-secondary); font-style: normal; font-variant-numeric: tabular-nums; }
.shared-axis-tick::before { position: absolute; top: -5px; left: 0; width: 1px; height: 10px; background: var(--cv-border-strong); content: ''; }
.shared-axis-tick > span, .shared-axis-tick > small { position: absolute; left: 0; padding: 2px 5px; border-radius: 4px; background: var(--cv-surface); white-space: nowrap; text-align: center; transform: translateX(-50%); }
.shared-axis-tick > span { bottom: 9px; color: var(--cv-secondary); font-size: var(--cv-type-meta); line-height: 1.5; font-weight: 600; }
.shared-axis-tick > small { top: 10px; color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: 1.5; }
.shared-axis-dot { position: absolute; z-index: 2; top: -4px; width: 8px; height: 8px; box-sizing: border-box; border: 2px solid var(--cv-accent); border-radius: 50%; background: var(--cv-surface); transform: translateX(-50%); }
.shared-axis-dot.is-yearless { border-color: var(--cv-warning); background: var(--cv-warning-soft); }
.shared-axis-dot.is-selected { z-index: 3; border-color: var(--cv-accent); background: var(--cv-accent); box-shadow: 0 0 0 4px var(--cv-accent-soft); }
.lane-empty { position: absolute; z-index: 4; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--cv-muted); font-size: 13px; background: var(--cv-surface); }
.lane-empty button { min-height: 44px; padding: 0 14px; background: var(--cv-accent-soft); border: 0; border-radius: var(--cv-radius-control); color: var(--cv-accent); font: inherit; font-size: 13px; }
.lane-overview { position: relative; height: var(--cv-control); flex-shrink: 0; margin: 10px 0 0; border: 1px solid var(--cv-border); border-radius: 7px; background: var(--cv-surface-subtle); overflow: hidden; cursor: pointer; touch-action: none; }
.lane-overview i { position: absolute; top: 15px; width: 3px; height: 12px; border-radius: 2px; background: var(--cv-accent); transform: translateX(-50%); pointer-events: none; }
.lane-overview i.is-yearless { background: var(--cv-warning); }
.lane-overview i.is-hidden { opacity: .16; }
.overview-window { position: absolute; inset-block: 0; border: 1px solid var(--cv-accent); border-radius: var(--cv-radius-tag); background: var(--cv-accent-soft); pointer-events: none; }
.timeline-view-body { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.timeline-view-body.is-portrait { flex-direction: row; align-items: stretch; gap: 8px; }
.event-list-view { display: flex; flex: 1; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; padding: 12px 14px; overflow-x: hidden; overflow-y: auto; border-radius: 8px; background: var(--cv-surface); overscroll-behavior-y: contain; touch-action: pan-y; scrollbar-gutter: stable; -webkit-overflow-scrolling: touch; }
.event-column-card { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 64px; flex: 0 0 auto; padding: 12px 16px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface); box-shadow: 0 2px 6px transparent; color: var(--cv-ink); font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
.event-column-card.timeline-node-yearless { border-color: var(--cv-warning); background: var(--cv-warning-soft); }
.event-column-card.is-selected { border-color: var(--cv-accent); background: var(--cv-accent-soft); box-shadow: 0 0 0 2px var(--cv-accent-soft); }
.event-column-marker { width: 8px; height: 8px; border: 2px solid var(--cv-accent); border-radius: 50%; background: var(--cv-surface); }
.event-column-card.timeline-node-yearless .event-column-marker { border-color: var(--cv-warning); background: var(--cv-warning-soft); }
.event-column-main { display: grid; grid-template-columns: minmax(130px, 185px) minmax(0, 1fr); align-items: baseline; gap: 4px 16px; min-width: 0; }
.event-column-time { color: var(--cv-secondary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.event-column-card.timeline-node-yearless .event-column-time { color: var(--cv-warning); }
.event-column-title { min-width: 0; color: var(--cv-ink); font-size: 13px; font-weight: 550; line-height: 1.5; overflow-wrap: anywhere; }
.event-column-people { grid-column: 2; color: var(--cv-muted); font-size: var(--cv-type-meta); }
.event-column-review { flex: 0 0 auto; color: var(--cv-warning); font-size: var(--cv-type-meta); }
.event-list-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 180px; color: var(--cv-muted); font-size: 13px; }
.event-list-empty button { min-height: 40px; padding: 0 12px; border: 0; border-radius: var(--cv-radius-control); background: var(--cv-accent-soft); color: var(--cv-accent); font: inherit; touch-action: manipulation; }
.timeline-view-body.is-portrait .unified-chart { display: block; flex: 1; }
.timeline-view-body.is-portrait .lane-overview { width: var(--cv-control); height: auto; flex: 0 0 var(--cv-control); margin: 0; }
.timeline-view-body.is-portrait .lane-overview i { top: auto; left: 50%; width: 12px; height: 3px; transform: translate(-50%, -50%); }
.portrait-timeline { position: absolute; z-index: 2; inset: 0; overflow: hidden; touch-action: none; }
.portrait-time-axis { top: 0; right: auto; bottom: 0; left: 50%; width: 0; height: auto; pointer-events: none; }
.portrait-time-axis .shared-axis-line { top: 0; right: auto; bottom: 0; left: -1px; width: 2px; height: auto; border-radius: 2px; background: var(--cv-border-strong); }
.portrait-axis-tick { top: 0; left: 0; width: 0; height: 0; }
.portrait-axis-tick::before { top: 0; left: -5px; width: 10px; height: 1px; }
.portrait-axis-tick > span { top: 0; bottom: auto; left: 12px; transform: translateY(-50%); }
.portrait-axis-tick > small { top: 0; right: 12px; left: auto; transform: translateY(-50%); }
.portrait-time-axis .shared-axis-dot { top: 0; left: 0; transform: translate(-50%, -50%); }
.portrait-event-card { position: absolute; z-index: 2; display: block; width: calc(50% - 34px); max-width: 340px; min-width: 0; min-height: 56px; margin: 0; padding: 10px 12px; transform: translateY(-50%); overflow: visible; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface); box-shadow: 0 2px 6px transparent; color: var(--cv-ink); font: inherit; text-align: left; white-space: normal; cursor: pointer; touch-action: manipulation; }
.portrait-event-card.half-upper { left: 8px; }
.portrait-event-card.half-lower { right: 8px; }
.portrait-event-card.half-upper::after, .portrait-event-card.half-lower::after { position: absolute; top: 50%; width: 26px; border-top: 1px solid var(--cv-border-strong); content: ''; }
.portrait-event-card.half-upper::after { right: -27px; }
.portrait-event-card.half-lower::after { left: -27px; }
.portrait-event-card.timeline-node-yearless { border-color: var(--cv-warning); background: var(--cv-warning-soft); }
.portrait-event-card.timeline-node-mixed { border-color: var(--cv-border); background: var(--cv-surface-subtle); }
.portrait-event-card.is-selected { border-color: var(--cv-accent); background: var(--cv-accent-soft); box-shadow: 0 0 0 2px var(--cv-accent-soft); }
.portrait-event-card .timeline-node-time { display: block; margin-bottom: 5px; color: var(--cv-secondary); font-size: var(--cv-type-meta); font-weight: 600; font-variant-numeric: tabular-nums; }
.portrait-event-card.timeline-node-yearless .timeline-node-time { color: var(--cv-warning); }
.portrait-event-card .timeline-node-title { display: block; max-width: 100%; color: var(--cv-ink); font-size: 12px; font-weight: 550; line-height: 1.5; overflow-wrap: anywhere; }
.portrait-event-card .timeline-node-precision { display: block; margin-top: 5px; color: var(--cv-muted); font-size: var(--cv-type-meta); }
.explorer-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 0; padding: 24px; color: var(--cv-secondary); }
.explorer-empty > span { display: grid; place-items: center; width: 68px; height: 68px; margin-bottom: 6px; border-radius: var(--cv-radius-panel); background: var(--cv-surface-subtle); }
.explorer-empty strong { font-size: 16px; }
.explorer-empty p { margin: 0; color: var(--cv-muted); font-size: 13px; }
.event-detail { position: relative; z-index: 4; display: flex; align-items: flex-start; gap: 20px; flex: 0 0 auto; min-height: 0; max-height: 30%; margin: 0 14px 14px; padding: 18px 54px 18px 20px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; animation: detail-appear var(--cv-motion-panel) var(--cv-ease); box-sizing: border-box; }
.detail-main { flex: 1.2; min-width: 160px; }
.detail-evidence { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 150px; max-width: 42%; }
.evidence-entry { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.evidence-entry blockquote { margin: 0; padding-left: 11px; border-left: 2px solid var(--cv-border); color: var(--cv-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.detail-time { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--cv-accent-strong); font-variant-numeric: tabular-nums; }
.yearless-badge { padding: 3px 7px; border-radius: var(--cv-radius-tag); background: var(--cv-warning-soft); color: var(--cv-warning); font-size: var(--cv-type-meta); }
.source-review-hint { margin: 6px 0; color: var(--cv-warning); font-size: 12px; line-height: 1.5; }
.detail-main h3 { margin: 8px 0 10px; color: var(--cv-ink); font-size: 16px; font-weight: 600; line-height: 1.65; }
.detail-people { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.detail-people > span { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: var(--cv-radius-tag); background: var(--cv-surface-subtle); color: var(--cv-secondary); font-size: var(--cv-type-meta); }
.marker-button { min-height: 44px; border: 0; background: none; color: var(--cv-muted); font: inherit; font-size: var(--cv-type-meta); padding: 6px 5px; cursor: pointer; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; align-self: center; }
.edit-button { background: var(--cv-accent-soft); border-color: var(--cv-border); }
.detail-close { position: absolute; right: 6px; top: 6px; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--cv-muted); cursor: pointer; }
.detail-close:active { background: var(--cv-accent-soft); }
.event-cluster-panel { position: relative; z-index: 5; display: flex; flex-direction: column; flex: 0 0 34%; max-height: 34%; min-height: 0; margin: 0 14px 14px; overflow: hidden; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); outline: none; }
.event-cluster-panel > header { position: relative; flex-shrink: 0; padding: 16px 54px 12px 18px; border-bottom: 1px solid var(--cv-border); }
.event-cluster-panel header strong { color: var(--cv-ink); font-size: 15px; }
.event-cluster-panel header p { margin: 6px 0; color: var(--cv-secondary); font-size: 12px; line-height: 1.5; }
.event-cluster-panel header span { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.cluster-explanation { flex-shrink: 0; margin: 0; padding: 10px 18px; color: var(--cv-muted); background: var(--cv-canvas); font-size: var(--cv-type-meta); line-height: 1.6; }
.cluster-members { flex: 1; min-height: 0; margin: 0; padding: 0 16px; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; list-style: none; }
.cluster-members li + li { border-top: 1px solid var(--cv-border); }
.cluster-members button { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; width: 100%; min-height: 44px; padding: 15px 2px; border: 0; background: transparent; color: var(--cv-secondary); font: inherit; text-align: left; cursor: pointer; }
.cluster-members button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: -2px; border-radius: 8px; }
.cluster-member-time { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
.cluster-member-time small { padding: 3px 6px; border-radius: var(--cv-radius-tag); background: var(--cv-accent-soft); color: var(--cv-secondary); font-size: var(--cv-type-meta); }
.cluster-member-time small.is-yearless { color: var(--cv-warning); background: var(--cv-warning-soft); }
.cluster-members strong { color: var(--cv-ink); font-size: 14px; line-height: 1.6; font-weight: 600; }
.cluster-members button > span:last-of-type { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.cluster-members em { color: var(--cv-accent); font-size: var(--cv-type-meta); font-style: normal; }
.event-cluster-panel footer { flex-shrink: 0; padding: 8px 18px; border-top: 1px solid var(--cv-border); }
.event-cluster-panel footer button { width: 100%; }
.explorer-vis-host :deep(.vis-shadow) { display: none !important; }
.explorer-vis-host :deep(.vis-timeline) { border: 0; font-family: inherit; background: transparent; }
.explorer-vis-host :deep(.vis-panel.vis-center), .explorer-vis-host :deep(.vis-panel.vis-bottom), .explorer-vis-host :deep(.vis-panel.vis-top) { border: 0; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-minor) { border-color: var(--cv-border); }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-major) { border-color: var(--cv-border); }
.explorer-vis-host :deep(.vis-item.vis-box) { border: 1px solid var(--cv-border) !important; border-radius: var(--cv-radius-control) !important; color: var(--cv-ink) !important; background: var(--cv-surface) !important; box-shadow: 0 2px 6px transparent; font-size: 14px !important; }
.explorer-vis-host :deep(.vis-item .vis-item-content) { min-width: 160px; padding: 12px 15px; }
.explorer-vis-host :deep(.timeline-node-time) { display: block; margin-bottom: 7px; color: var(--cv-secondary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.explorer-vis-host :deep(.timeline-node-precision) { display: block; margin-top: 8px; color: var(--cv-muted); font-size: var(--cv-type-meta); }
.explorer-vis-host :deep(.timeline-node-title) { display: block; max-width: 260px; white-space: normal; color: var(--cv-ink); font-size: 14px; font-weight: 550; line-height: 1.65; }
.explorer-vis-host :deep(.timeline-event-content) { display: block; min-height: var(--cv-control); touch-action: manipulation; max-width: 260px; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; white-space: normal; }
.explorer-vis-host :deep(.timeline-cluster-count) { display: block; color: var(--cv-accent); font-size: 16px; line-height: 1.5; }
.explorer-vis-host :deep(.timeline-event-content:focus-visible) { outline: 2px solid currentColor; outline-offset: 5px; border-radius: 4px; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-box) { color: var(--cv-ink) !important; background: var(--cv-warning-soft) !important; border-color: var(--cv-warning) !important; }
.explorer-vis-host :deep(.timeline-node-yearless .timeline-node-time) { color: var(--cv-warning); }
.explorer-vis-host :deep(.vis-item.timeline-node-mixed.vis-box) { background: var(--cv-surface-subtle) !important; border-color: var(--cv-border) !important; }
.explorer-vis-host :deep(.vis-item.vis-selected.vis-box), .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected.vis-box) { color: var(--cv-ink) !important; background: var(--cv-accent-soft) !important; border-color: var(--cv-accent) !important; box-shadow: 0 0 0 2px var(--cv-accent-soft); }
.explorer-vis-host :deep(.vis-selected .timeline-node-time) { color: var(--cv-accent); }
.explorer-vis-host :deep(.vis-item.vis-line) { width: 0; border: 0; border-left: 1px solid var(--cv-border-strong) !important; border-radius: 0 !important; background: transparent !important; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-line) { border-left-color: var(--cv-warning) !important; }
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
@media (max-width: 650px) { .event-list-view { padding: 8px; } .event-column-card { gap: 9px; padding: 10px 12px; } .event-column-main { grid-template-columns: minmax(0, 1fr); gap: 4px; } .event-column-people { grid-column: 1; } .event-column-review { font-size: var(--cv-type-meta); } .explorer-header-main { flex-wrap: wrap; gap: 8px; } .explorer-heading { flex: 1 1 auto; order: 1; } .explorer-page-actions { flex: 0 0 auto; order: 2; margin-left: auto; } .explorer-controls { flex: 1 1 100%; order: 3; justify-content: flex-start; flex-wrap: wrap; } .portrait-event-card { width: calc(50% - 25px); padding: 8px 9px; } .portrait-event-card.half-upper { left: 4px; } .portrait-event-card.half-lower { right: 4px; } .portrait-event-card.half-upper::after { right: -21px; width: 20px; } .portrait-event-card.half-lower::after { left: -21px; width: 20px; } .explorer-controls .person-filter { margin-left: 0; } .explorer-controls .fit-button { margin-left: 0; } .explorer-layout-toggle { max-width: 100%; } .explorer-layout-toggle button { padding-inline: 12px; } .lane-heading { gap: 7px 10px; } .timeline-legend { font-size: var(--cv-type-meta); } .shared-axis-tick > span { font-size: var(--cv-type-meta); } .shared-axis-tick > small { font-size: var(--cv-type-meta); } .explorer-vis-host :deep(.timeline-node-title) { max-width: 220px; } .event-detail, .event-cluster-panel { margin: 0 10px 10px; } }
@media (prefers-reduced-motion: reduce) { .event-detail { animation: none; } .explorer-button, .explorer-view-toggle button, .explorer-layout-toggle button { transition: none; } }

.timeline-explorer {
  --explorer-accent: var(--cv-accent);
  border-color: var(--cv-border);
  background: var(--cv-canvas);
  color: var(--cv-ink);
  font-family: var(--cv-font);
}
.explorer-toolbar { border-bottom-color: var(--cv-border); background: var(--cv-surface); }
.explorer-page-actions :deep(.timeline-display-toggle button),
.explorer-page-actions :deep(.timeline-add-event) {
  flex-basis: var(--cv-control);
  width: var(--cv-control);
  min-width: var(--cv-control);
  min-height: var(--cv-control);
}
.explorer-controls .person-filter { flex-basis: var(--cv-control); width: var(--cv-control); min-width: var(--cv-control); min-height: var(--cv-control); }
.explorer-controls .explorer-button, .explorer-controls .fit-button,
.explorer-controls .fullscreen-button, .explorer-controls .density-toggle { min-height: var(--cv-control); }
.explorer-controls .fit-button, .explorer-controls .fullscreen-button { flex-basis: var(--cv-control); width: var(--cv-control); }
.explorer-controls .explorer-layout-toggle button { min-height: var(--cv-control); }
.explorer-view-toggle button, .event-list-empty button { min-height: var(--cv-control); }
.timeline-explorer :is(button, select, input):focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.person-filter-icon:focus-within { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.timeline-explorer button { touch-action: manipulation; }
.explorer-layout-toggle button:active,
.detail-close:active,
.marker-button:active,
.cluster-members button:active,
.event-column-card:active,
.portrait-event-card:active,
.explorer-vis-host :deep(.timeline-event-content:active) { background: var(--cv-accent-soft); }
.explorer-vis-host :deep(.timeline-node-yearless .timeline-event-content:active) { background: var(--cv-warning-soft); }
.event-detail, .event-cluster-panel { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.event-detail :is(button, .detail-people > span), .event-cluster-panel button { -webkit-user-select: none; user-select: none; }
@media (max-width: 950px) { .explorer-header-main { flex-wrap: wrap; } .explorer-controls { flex: 1 1 auto; flex-wrap: wrap; } }
@media (prefers-reduced-motion: reduce) { .timeline-explorer *, .timeline-explorer :deep(*) { animation: none !important; transition: none !important; } }
.lane-heading, .timeline-legend, .event-column-people { color: var(--cv-secondary); }
</style>
