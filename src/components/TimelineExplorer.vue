<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Timeline } from 'vis-timeline/standalone'
import UiIcon from './UiIcon.vue'
import type { ClueRecord, PersonRecord, TimelineRecord } from '../services/vault'

type Side = 'upper' | 'lower'
type TimeWindow = { start: Date; end: Date }
const props = defineProps<{ events: TimelineRecord[]; people: PersonRecord[]; clues: ClueRecord[]; scriptId: string; personId: string; scale: number }>()
const emit = defineEmits<{
  'update:personId': [value: string]
  'update:scale': [value: number]
  'edit-event': [event: TimelineRecord]
  'open-clue': [clueId: string]
  'toggle-marker': [event: TimelineRecord]
  'fullscreen-change': [active: boolean]
}>()
const sides: Side[] = ['upper', 'lower']
const rootElement = ref<HTMLElement | null>(null)
const plotElement = ref<HTMLElement | null>(null)
const elements: Record<Side, HTMLElement | null> = { upper: null, lower: null }
const instances: Record<Side, Timeline | null> = { upper: null, lower: null }
const fullscreen = ref(false)
const dimensional = ref(true)
const selectedId = ref('')
const timeWindow = ref<TimeWindow | null>(null)
const plotWidth = ref(800)
let appliedScale = props.scale || 1
let resizeObserver: ResizeObserver | null = null
let redrawFrame = 0
let syncRequest = 0
let previousOverflow = ''
let returnFocus: HTMLElement | null = null
let chartPointer: { x: number; y: number; moved: boolean } | null = null
defineExpose({ enterFullscreen: () => { fullscreen.value = true } })

const referenceYear = computed(() => {
  const years = props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && /^\d{4}-/.test(event.startsAt)).map(event => Number(event.startsAt.slice(0, 4)))
  return years.length ? Math.min(...years) : 2000
})
const allEvents = computed(() => props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && Number.isFinite(eventTime(event))))
const visibleEvents = computed(() => allEvents.value.filter(event => !props.personId || event.personIds.includes(props.personId)))
const datedCount = computed(() => allEvents.value.filter(event => !event.startsAt.startsWith('--')).length)
const yearlessCount = computed(() => allEvents.value.length - datedCount.value)
const eventSides = computed(() => new Map([...allEvents.value].sort((a, b) => eventTime(a) - eventTime(b) || a.id.localeCompare(b.id)).map((event, index) => [event.id, sides[index % 2]])))
const selectedEvent = computed(() => visibleEvents.value.find(event => event.id === selectedId.value))
const selectedPeople = computed(() => props.people.filter(person => selectedEvent.value?.personIds.includes(person.id)))
const selectedClue = computed(() => props.clues.find(clue => clue.id === selectedEvent.value?.clueId))

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
  time.textContent = dateLabel(event.startsAt)
  const title = document.createElement('span')
  title.className = 'timeline-node-title'
  title.textContent = eventTitle(event)
  content.append(time, title)
  return content
}
function fullWindow(scale = 1): TimeWindow {
  const times = allEvents.value.map(eventTime)
  const first = times.length ? Math.min(...times) : Date.now()
  const last = times.length ? Math.max(...times) : first
  const span = Math.max(last - first, 3 * 60 * 60_000) * 1.18 / scale
  const center = (first + last) / 2
  return { start: new Date(center - span / 2), end: new Date(center + span / 2) }
}
function bounds() {
  const range = fullWindow()
  const span = range.end.getTime() - range.start.getTime()
  return { min: new Date(range.start.getTime() - span * .35), max: new Date(range.end.getTime() + span * .35), zoomMin: 60_000, zoomMax: span * 1.7 }
}
function items(side: Side) {
  return visibleEvents.value.filter(event => eventSides.value.get(event.id) === side).map(event => ({
    id: event.id, start: new Date(eventTime(event)), content: eventContent(event),
    className: `${event.startsAt.startsWith('--') ? 'timeline-node-yearless' : 'timeline-node-dated'}${event.yearlessMarkerIgnored ? ' timeline-marker-ignored' : ''}`,
  }))
}
function applyWindow(range: TimeWindow) {
  timeWindow.value = range
  for (const side of sides) instances[side]?.setWindow(range.start, range.end, { animation: false })
}
function scheduleRedraw() {
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  redrawFrame = requestAnimationFrame(() => {
    if (plotElement.value) plotWidth.value = plotElement.value.clientWidth
    for (const side of sides) instances[side]?.redraw()
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
  const range = timeWindow.value ?? fullWindow(props.scale || 1)
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
      if (id !== undefined) selectEvent(String(id))
    })
    instance.on('rangechange', (properties: { start: Date; end: Date; byUser: boolean }) => {
      if (!properties.byUser) return
      const next = { start: new Date(properties.start), end: new Date(properties.end) }
      timeWindow.value = next
      instances[side === 'upper' ? 'lower' : 'upper']?.setWindow(next.start, next.end, { animation: false })
    })
  }
  if (selectedId.value && !selectedEvent.value) selectedId.value = ''
  if (selectedEvent.value) selectEvent(selectedId.value)
  scheduleRedraw()
}
function fitAll() {
  appliedScale = 1
  emit('update:scale', 1)
  applyWindow(fullWindow())
}
function zoom(factor: number) {
  const range = timeWindow.value
  if (!range) return
  const center = (range.start.getTime() + range.end.getTime()) / 2
  const span = Math.max(60_000, (range.end.getTime() - range.start.getTime()) / factor)
  applyWindow({ start: new Date(center - span / 2), end: new Date(center + span / 2) })
}
const axisTicks = computed(() => {
  const range = timeWindow.value
  if (!range) return []
  const start = range.start.getTime(), end = range.end.getTime(), span = end - start
  const target = span / Math.max(2, Math.floor(plotWidth.value / 126))
  const intervals = [60_000, 5*60_000, 15*60_000, 30*60_000, 3600_000, 3*3600_000, 6*3600_000, 12*3600_000, 86400_000, 2*86400_000, 7*86400_000]
  const interval = intervals.find(value => value >= target)
  const cursor = new Date(start)
  const monthStep = target > 365*86400_000 ? 12 * Math.ceil(target / (365*86400_000)) : target > 180*86400_000 ? 12 : target > 60*86400_000 ? 3 : 1
  if (interval) {
    cursor.setHours(0, 0, 0, 0)
    cursor.setTime(cursor.getTime() + Math.ceil((start - cursor.getTime()) / interval) * interval)
  } else {
    cursor.setDate(1); cursor.setHours(0, 0, 0, 0)
    cursor.setMonth(Math.floor(cursor.getMonth() / monthStep) * monthStep)
    if (cursor.getTime() < start) cursor.setMonth(cursor.getMonth() + monthStep)
  }
  const ticks: { id: number; left: string; label: string; context: string }[] = []
  const format = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('zh-CN-u-ca-gregory-nu-latn', options).format(date)
  let previousDay = ''
  while (cursor.getTime() <= end && ticks.length < 50) {
    const position = (cursor.getTime() - start) / span * 100
    const date = new Date(cursor)
    const day = format(date, { month: 'numeric', day: 'numeric' })
    const clock = interval !== undefined && interval < 86400_000
    if (position > 2 && position < 98) ticks.push({
      id: date.getTime(), left: `${position}%`,
      label: clock ? format(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : format(date, { month: 'numeric', ...(interval ? { day: 'numeric' as const } : {}) }),
      context: clock ? (day !== previousDay ? `${datedCount.value ? `${date.getFullYear()}年` : ''}${day}` : '') : (datedCount.value ? `${date.getFullYear()}年` : ''),
    })
    previousDay = day
    if (interval) cursor.setTime(cursor.getTime() + interval)
    else cursor.setMonth(cursor.getMonth() + monthStep)
  }
  return ticks
})
const axisEvents = computed(() => {
  const range = timeWindow.value
  if (!range) return []
  const start = range.start.getTime(), span = range.end.getTime() - start
  return visibleEvents.value.map(event => ({ event, position: (eventTime(event) - start) / span * 100 })).filter(item => item.position >= 0 && item.position <= 100)
})
function overviewMarkers() {
  const range = fullWindow(), span = range.end.getTime() - range.start.getTime()
  return allEvents.value.map(event => ({ id: event.id, left: `${(eventTime(event) - range.start.getTime()) / span * 100}%`, yearless: event.startsAt.startsWith('--'), visible: !props.personId || event.personIds.includes(props.personId) }))
}
function overviewWindow() {
  const whole = fullWindow(), current = timeWindow.value ?? whole
  const span = whole.end.getTime() - whole.start.getTime()
  const left = Math.max(0, (current.start.getTime() - whole.start.getTime()) / span * 100)
  const right = Math.min(100, (current.end.getTime() - whole.start.getTime()) / span * 100)
  return { left: `${left}%`, width: `${Math.max(1, right - left)}%` }
}
function navigateOverview(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement, rect = target.getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const whole = fullWindow(), current = timeWindow.value ?? whole, span = current.end.getTime() - current.start.getTime()
  const center = whole.start.getTime() + fraction * (whole.end.getTime() - whole.start.getTime())
  applyWindow({ start: new Date(center - span / 2), end: new Date(center + span / 2) })
}
function beginChartPointer(event: PointerEvent) { chartPointer = { x: event.clientX, y: event.clientY, moved: false } }
function moveChartPointer(event: PointerEvent) {
  if (chartPointer && Math.hypot(event.clientX - chartPointer.x, event.clientY - chartPointer.y) > 8) chartPointer.moved = true
}
function selectEvent(id: string) {
  if (!visibleEvents.value.some(event => event.id === id)) return
  selectedId.value = id
  for (const side of sides) instances[side]?.setSelection(eventSides.value.get(id) === side ? [id] : [])
}
function selectChartEvent(event: MouseEvent) {
  if (chartPointer?.moved) { chartPointer = null; return }
  chartPointer = null
  const target = event.target as HTMLElement
  const content = target?.closest<HTMLElement>('.timeline-event-content') ?? target?.closest('.vis-item')?.querySelector<HTMLElement>('.timeline-event-content')
  if (content?.dataset.eventId) selectEvent(content.dataset.eventId)
}
function closeDetail() {
  selectedId.value = ''
  for (const side of sides) instances[side]?.setSelection([])
  scheduleRedraw()
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { if (selectedId.value) closeDetail(); else if (fullscreen.value) fullscreen.value = false }
}
watch(() => [props.events, props.personId], syncCharts, { deep: true })
watch(() => props.scale, next => {
  if (!Number.isFinite(next) || next <= 0) return
  zoom(next / appliedScale); appliedScale = next
})
watch(() => [props.scriptId, referenceYear.value], async () => {
  for (const side of sides) { instances[side]?.destroy(); instances[side] = null }
  timeWindow.value = null; selectedId.value = ''; appliedScale = props.scale || 1
  await syncCharts()
})
watch([dimensional, selectedId], async () => { await nextTick(); scheduleRedraw() })
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
  await syncCharts()
  resizeObserver = new ResizeObserver(scheduleRedraw)
  if (rootElement.value) resizeObserver.observe(rootElement.value)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  for (const side of sides) instances[side]?.destroy()
  resizeObserver?.disconnect()
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  document.removeEventListener('keydown', onKeydown)
  if (fullscreen.value) document.body.style.overflow = previousOverflow
})
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <section ref="rootElement" class="timeline-explorer" :class="{ 'is-fullscreen': fullscreen, 'is-dimensional': dimensional }" tabindex="-1" :role="fullscreen ? 'dialog' : 'region'" :aria-modal="fullscreen || undefined" aria-label="时间线查看" @contextmenu.prevent>
      <header class="explorer-toolbar">
        <div class="explorer-heading"><span class="explorer-heading-icon"><UiIcon name="timeline" :size="20" /></span><div><strong>{{ fullscreen ? '时间线' : `${visibleEvents.length} 个事件` }}</strong><span>{{ fullscreen ? `${visibleEvents.length} / ${allEvents.length} 个事件` : `共 ${allEvents.length} 个已确认事件` }}</span></div></div>
        <label class="person-filter"><UiIcon name="person" :size="17" /><select :value="personId" aria-label="按人物筛选时间线" @change="emit('update:personId', ($event.target as HTMLSelectElement).value)"><option value="">全部人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label>
        <div class="explorer-view-toggle" aria-label="时间线显示方式"><button :class="{ active: !dimensional }" :aria-pressed="!dimensional" @click="dimensional = false"><UiIcon name="list" :size="17" />平面</button><button :class="{ active: dimensional }" :aria-pressed="dimensional" @click="dimensional = true"><UiIcon name="cube" :size="17" />立体</button></div>
        <button class="explorer-button fit-button" @click="fitAll"><UiIcon name="restore" :size="17" />显示全部</button>
        <button class="explorer-button fullscreen-button" :aria-label="fullscreen ? '退出全屏时间线' : '全屏查看时间线'" @click="fullscreen = !fullscreen"><UiIcon :name="fullscreen ? 'close' : 'fullscreen'" :size="19" /><span>{{ fullscreen ? '退出全屏' : '全屏' }}</span></button>
      </header>
      <div class="explorer-scale-row">
        <div class="explorer-scale"><span>时间间距</span><button aria-label="缩小时间线" @click="emit('update:scale', Math.max(.25, scale / 1.3))"><UiIcon name="zoomOut" :size="18" /></button><input type="range" min="0.25" max="4" step="0.05" :value="scale" aria-label="时间线间距缩放" @input="emit('update:scale', Number(($event.target as HTMLInputElement).value))" /><button aria-label="放大时间线" @click="emit('update:scale', Math.min(4, scale * 1.3))"><UiIcon name="zoomIn" :size="18" /></button><output>{{ Math.round(scale * 100) }}%</output></div>
        <span class="explorer-hint"><UiIcon name="move" :size="15" />拖动平移 · 双指缩放 · 点事件看详情</span>
      </div>
      <div v-if="allEvents.length" class="explorer-stage">
        <article class="timeline-lane unified-lane">
          <div class="lane-heading"><strong>事件时间线</strong><span class="timeline-legend"><i class="dated-swatch"></i>有年份 {{ datedCount }}<i class="yearless-swatch"></i>无年份 {{ yearlessCount }}</span><small>{{ visibleEvents.length }} 个事件</small></div>
          <p v-if="yearlessCount" class="timeline-reference">{{ datedCount ? `无年份事件按月日对齐至 ${referenceYear} 年的位置，仅用于显示，未补全年份。` : '按月日与时刻排列，卡片保留无年份标记。' }}</p>
          <div ref="plotElement" class="unified-chart">
            <div v-for="side in sides" :key="side" class="timeline-half" :class="`half-${side}`"><div class="lane-chart" @pointerdown.capture="beginChartPointer" @pointermove.capture="moveChartPointer" @click.capture="selectChartEvent"><div :ref="element => setChartElement(side, element)" class="explorer-vis-host"></div></div></div>
            <div class="shared-time-axis" aria-hidden="true"><div class="shared-axis-line"></div><i v-for="tick in axisTicks" :key="tick.id" class="shared-axis-tick" :style="{ left: tick.left }"><span>{{ tick.label }}</span><small v-if="tick.context">{{ tick.context }}</small></i><i v-for="item in axisEvents" :key="item.event.id" class="shared-axis-dot" :class="{ 'is-yearless': item.event.startsAt.startsWith('--'), 'is-dated': !item.event.startsAt.startsWith('--'), 'is-selected': item.event.id === selectedId }" :style="{ left: `${item.position}%` }"></i></div>
            <div v-if="!visibleEvents.length" class="lane-empty"><UiIcon name="filter" :size="24" /><span>没有该人物的时间事件</span><button @click="emit('update:personId', '')">查看全部人物</button></div>
          </div>
          <div class="lane-overview" aria-label="时间线全局导航" @pointerdown="navigateOverview"><span class="overview-window" :style="overviewWindow()"></span><i v-for="marker in overviewMarkers()" :key="marker.id" :style="{ left: marker.left }" :class="{ 'is-hidden': !marker.visible, 'is-yearless': marker.yearless }"></i></div>
        </article>
      </div>
      <div v-else class="explorer-empty"><span><UiIcon name="timeline" :size="34" /></span><strong>还没有已确认的时间事件</strong><p>添加时间节点，或从整理建议中录入事件。</p></div>
      <aside v-if="selectedEvent" class="event-detail" aria-live="polite">
        <button class="detail-close" aria-label="收起事件详情" @click="closeDetail"><UiIcon name="close" :size="18" /></button>
        <div class="detail-main"><div class="detail-time"><UiIcon name="clock" :size="17" /><strong>{{ dateLabel(selectedEvent.startsAt) }}</strong><span v-if="selectedEvent.startsAt.startsWith('--') && !selectedEvent.yearlessMarkerIgnored" class="yearless-badge">无年份</span></div><h3>{{ eventTitle(selectedEvent) }}</h3><div class="detail-people"><span v-for="person in selectedPeople" :key="person.id"><UiIcon name="person" :size="13" />{{ person.name }}</span><button v-if="selectedEvent.startsAt.startsWith('--')" class="marker-button" @click="emit('toggle-marker', selectedEvent)">{{ selectedEvent.yearlessMarkerIgnored ? '恢复无年份标记' : '忽略无年份标记' }}</button></div></div>
        <div class="detail-actions"><button v-if="selectedClue" class="explorer-button" @click="emit('open-clue', selectedClue.id)"><UiIcon name="image" :size="17" />原线索 #{{ String(selectedClue.number).padStart(3, '0') }}</button><button class="explorer-button edit-button" @click="emit('edit-event', selectedEvent)"><UiIcon name="edit" :size="17" />编辑事件</button></div>
      </aside>
    </section>
  </Teleport>
</template>

<style scoped>
.timeline-explorer, .timeline-explorer :deep(*) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.timeline-explorer { --explorer-green: #315c48; --explorer-copper: #b66b4d; position: relative; display: flex; flex: 1; flex-direction: column; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; border: 1px solid #e3e8e2; border-radius: 20px; background: #f8faf7; box-shadow: 0 4px 18px #273d2f06; outline: none; }
.timeline-explorer.is-fullscreen { position: fixed; inset: 0; z-index: 1100; width: 100%; height: 100dvh; border: 0; border-radius: 0; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); background: #f6f8f4; box-sizing: border-box; }
.explorer-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; flex-shrink: 0; padding: 15px 18px 10px; background: #fff; }
.explorer-heading { display: flex; align-items: center; gap: 9px; margin-right: auto; }
.explorer-heading-icon { display: grid; place-items: center; width: 38px; height: 38px; color: var(--explorer-green); background: #eaf1eb; border-radius: 11px; }
.explorer-heading strong { display: block; color: #233c2f; font-size: 16px; line-height: 1.3; }
.explorer-heading div > span { color: #8b968d; font-size: 11px; line-height: 1.6; }
.person-filter { display: flex; align-items: center; gap: 5px; margin: 0; min-width: 130px; min-height: 40px; padding: 0 10px; border: 1px solid #e1e7df; border-radius: 10px; color: #667b6b; background: #fafcf9; }
.person-filter select { width: 100%; min-width: 0; margin: 0; padding: 4px 2px; border: 0; border-radius: 0; background: transparent; color: #365541; font: inherit; font-size: 12px; box-shadow: none; }
.explorer-view-toggle { display: flex; padding: 3px; gap: 2px; border-radius: 11px; background: #f0f3ee; }
.explorer-view-toggle button { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; padding: 0 11px; border: 0; border-radius: 8px; background: transparent; color: #7a867d; font: inherit; font-size: 12px; cursor: pointer; transition: background .18s, color .18s, box-shadow .18s; }
.explorer-view-toggle button.active { color: #315c48; background: #fff; box-shadow: 0 2px 5px #283d3012; }
.explorer-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 0 12px; border: 1px solid #e0e7dd; border-radius: 10px; background: #fff; color: #45634f; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; touch-action: manipulation; transition: background .18s, box-shadow .18s, transform .18s; }
.explorer-button:active, .explorer-view-toggle button:active { transform: scale(.97); }
.fullscreen-button { color: #fff; background: var(--explorer-green); border-color: var(--explorer-green); }
.explorer-scale-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0 18px 10px; flex-shrink: 0; background: #fff; border-bottom: 1px solid #e7ece4; }
.explorer-scale { display: flex; align-items: center; gap: 7px; min-width: 0; width: 370px; max-width: 52%; }
.explorer-scale > span { color: #839086; font-size: 11px; white-space: nowrap; }
.explorer-scale button { display: grid; place-items: center; flex-shrink: 0; width: 34px; height: 36px; padding: 0; border: 0; background: transparent; color: #56755f; cursor: pointer; }
.explorer-scale input { width: 100%; min-width: 30px; height: 28px; margin: 0; padding: 0; border: 0; box-shadow: none; accent-color: var(--explorer-green); }
.explorer-scale output { min-width: 37px; color: #46674f; font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.explorer-hint { display: flex; align-items: center; gap: 5px; color: #94a095; font-size: 11px; }
.explorer-stage { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; padding: 14px; overflow: hidden; }
.timeline-lane { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid #dfe7db; border-radius: 16px; background: #fcfdfb; }
.lane-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; flex-shrink: 0; padding: 13px 16px 5px; color: #405e48; }
.lane-heading strong { font-size: 12px; font-weight: 650; }
.lane-heading small { margin-left: auto; color: #8a988b; font-size: 10px; }
.timeline-legend { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 7px; color: #7e8d7c; font-size: 10px; }
.timeline-legend i { display: inline-block; width: 9px; height: 9px; margin-left: 5px; border: 1px solid; border-radius: 3px; }
.timeline-legend i:first-child { margin-left: 0; }
.timeline-legend .dated-swatch { background: #e6f0df; border-color: #8fa989; box-shadow: 0 2px 0 #c8d8be; }
.timeline-legend .yearless-swatch { background: #faefdf; border-color: #c5a182; box-shadow: 0 2px 0 #e3c9ab; }
.timeline-reference { flex-shrink: 0; margin: 0; padding: 0 16px 8px; color: #94a08c; font-size: 10px; line-height: 1.6; }
.unified-chart { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-width: 0; min-height: 0; margin: 0 14px; overflow: hidden; isolation: isolate; }
.timeline-half { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.lane-chart { position: relative; display: flex; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.explorer-vis-host { flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.shared-time-axis { position: absolute; z-index: 3; top: 50%; left: 0; right: 0; height: 0; pointer-events: none; }
.shared-axis-line { position: absolute; top: -2px; left: 0; right: 0; height: 4px; border-radius: 4px; background: #b3c5aa; }
.shared-axis-tick { position: absolute; top: 0; width: 1px; height: 0; color: #778b70; font-style: normal; font-variant-numeric: tabular-nums; }
.shared-axis-tick::before { position: absolute; top: -6px; left: 0; width: 1px; height: 12px; background: #adbea3; content: ''; }
.shared-axis-tick > span, .shared-axis-tick > small { position: absolute; left: 0; padding: 1px 5px; border-radius: 4px; background: #fcfdfbf0; white-space: nowrap; text-align: center; transform: translateX(-50%); }
.shared-axis-tick > span { bottom: 10px; color: #556c4d; font-size: 10px; line-height: 1.5; font-weight: 600; }
.shared-axis-tick > small { top: 11px; color: #95a18c; font-size: 9px; line-height: 1.5; }
.shared-axis-dot { position: absolute; z-index: 2; top: -4px; width: 8px; height: 8px; box-sizing: border-box; border: 2px solid #6d9460; border-radius: 50%; background: #f1f7ed; transform: translateX(-50%); }
.shared-axis-dot.is-yearless, .shared-axis-dot.timeline-node-yearless { border-color: #c19775; background: #fff5e8; }
.shared-axis-dot.is-selected { z-index: 3; border-color: #315c48; box-shadow: 0 0 0 4px #527a4530; }
.shared-axis-dot.is-yearless.is-selected, .shared-axis-dot.timeline-node-yearless.is-selected { border-color: #ac7753; box-shadow: 0 0 0 4px #b7835a2b; }
.lane-empty { position: absolute; z-index: 4; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #829381; font-size: 12px; background: #fcfdfbef; }
.lane-empty button { min-height: 40px; padding: 0 12px; background: #eff4ed; border: 0; border-radius: 9px; color: #42604a; font: inherit; font-size: 12px; }
.lane-overview { position: relative; height: 26px; flex-shrink: 0; margin: 8px 14px 12px; border: 1px solid #e4eadd; border-radius: 8px; background: #f0f3eb; overflow: hidden; cursor: pointer; touch-action: none; }
.lane-overview i { position: absolute; top: 6px; width: 3px; height: 12px; border-radius: 2px; background: #6c9261; transform: translateX(-50%); pointer-events: none; }
.lane-overview i.is-yearless, .lane-overview i.timeline-node-yearless { background: #bd9370; }
.lane-overview i.is-hidden { opacity: .16; }
.overview-window { position: absolute; inset-block: 0; border: 1px solid #628a6c66; border-radius: 7px; background: #789b7b19; pointer-events: none; }
.explorer-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 0; padding: 24px; color: #5b715d; }
.explorer-empty > span { display: grid; place-items: center; width: 74px; height: 74px; margin-bottom: 8px; border-radius: 23px; background: #eaf0e5; }
.explorer-empty strong { font-size: 15px; }
.explorer-empty p { margin: 0; color: #94a08e; font-size: 12px; }
.event-detail { position: absolute; z-index: 4; left: 14px; right: 14px; bottom: 12px; display: flex; align-items: center; gap: 18px; flex-shrink: 0; max-height: 32%; padding: 14px 48px 14px 20px; border: 1px solid #d9e4d6; border-radius: 14px; background: #fffffffa; box-shadow: 0 8px 32px #28432a16; overflow: auto; animation: detail-appear .18s ease-out; }
.detail-main { flex: 1; min-width: 0; }
.detail-time { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; color: #47614d; }
.yearless-badge { padding: 2px 6px; border-radius: 5px; background: #f7eee5; color: #a87b58; font-size: 10px; }
.detail-main h3 { margin: 7px 0; color: #294432; font-size: 15px; font-weight: 600; line-height: 1.45; }
.detail-people { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.detail-people > span { display: inline-flex; align-items: center; gap: 3px; padding: 3px 7px; border-radius: 5px; background: #f0f4ed; color: #74836e; font-size: 10px; }
.marker-button { border: 0; background: none; color: #9d8975; font: inherit; font-size: 10px; padding: 6px 4px; cursor: pointer; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
.edit-button { background: #eef4eb; }
.detail-close { position: absolute; right: 8px; top: 8px; display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent; color: #8a9985; cursor: pointer; }
.explorer-vis-host :deep(.vis-timeline) { border: 0; font-family: inherit; background: transparent; }
.explorer-vis-host :deep(.vis-panel.vis-center), .explorer-vis-host :deep(.vis-panel.vis-bottom), .explorer-vis-host :deep(.vis-panel.vis-top) { border: 0; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-minor) { border-color: #e8eee35e; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-major) { border-color: #dce6d49c; }
.explorer-vis-host :deep(.vis-item.vis-box) { border: 1px solid #99b198 !important; border-radius: 10px !important; color: #345c3d !important; background: #f0f6eb !important; font-size: 12px !important; }
.explorer-vis-host :deep(.vis-item .vis-item-content) { padding: 9px 12px; }
.explorer-vis-host :deep(.timeline-node-time) { display: block; margin-bottom: 4px; color: #7c936f; font-size: 9px; font-weight: 500; font-variant-numeric: tabular-nums; }
.explorer-vis-host :deep(.timeline-node-title) { display: block; max-width: 260px; white-space: normal; line-height: 1.5; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-box) { color: #8f6346 !important; background: #fbf3e8 !important; border-color: #cfad8e !important; }
.explorer-vis-host :deep(.timeline-node-yearless .timeline-node-time) { color: #af8d6c; }
.explorer-vis-host :deep(.vis-item.vis-selected.vis-box) { background: #e1efda !important; border-color: #4d7d4d !important; box-shadow: 0 0 0 2px #668c5522; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected.vis-box) { background: #f8e8d6 !important; border-color: #ab7850 !important; box-shadow: 0 0 0 2px #bd947422; }
.explorer-vis-host :deep(.vis-item.vis-line) { width: 0; border: 0; border-left: 1px solid #a3ba99 !important; border-radius: 0 !important; background: transparent !important; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-line) { border-left-color: #c9a586 !important; }
.explorer-vis-host :deep(.vis-item.vis-dot) { display: none; }
.is-dimensional .unified-lane { border-color: #dbe4d4; background: linear-gradient(160deg, #ffffff, #f7faf3); box-shadow: inset 0 1px 0 #fff, 0 3px 8px #2f472907; }
.is-dimensional .half-upper .lane-chart { background: radial-gradient(ellipse at 50% 100%, #dce8d858, transparent 75%); }
.is-dimensional .half-lower .lane-chart { background: radial-gradient(ellipse at 50% 0%, #e2ebda58, transparent 75%); }
.is-dimensional .shared-axis-line { top: -3px; height: 6px; background: linear-gradient(180deg, #edf3e7 0%, #bdcdb2 35%, #879e78 80%, #a4b69a 100%); box-shadow: inset 0 1px 0 #ffffffdb, 0 2px 0 #c4d1b9, 0 7px 12px #344c2b22; }
.is-dimensional .shared-axis-dot { width: 10px; height: 10px; top: -5px; background: #f9fcf5; box-shadow: inset 0 1px 0 #fff, 0 2px 0 #aac09d, 0 4px 6px #35532922; }
.is-dimensional .shared-axis-dot.is-yearless, .is-dimensional .shared-axis-dot.timeline-node-yearless { background: #fff9ef; box-shadow: inset 0 1px 0 #fff, 0 2px 0 #d5b79a, 0 4px 6px #6a4f2c22; }
.is-dimensional .shared-axis-dot.is-selected { border-color: #315c48; box-shadow: 0 0 0 4px #527a4530, 0 3px 6px #35532922; }
.is-dimensional .shared-axis-dot.is-yearless.is-selected, .is-dimensional .shared-axis-dot.timeline-node-yearless.is-selected { border-color: #ac7753; box-shadow: 0 0 0 4px #b7835a2b, 0 3px 6px #6a4f2c22; }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-box) { border-color: #a2b99a !important; background: linear-gradient(145deg, #ffffff 0%, #f6faef 52%, #eaf3e2 100%) !important; box-shadow: inset 0 1px 0 #fffffffa, inset 0 -1px 0 #d7e4ce80, 0 3px 0 #c7d6bc, 0 5px 0 #e0e9d8, 0 10px 16px #324a281b; }
.is-dimensional .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-box) { border-color: #cfad8e !important; background: linear-gradient(145deg, #fffdf9 0%, #fcf5e9 52%, #f7ead8 100%) !important; box-shadow: inset 0 1px 0 #fffffffa, inset 0 -1px 0 #ead5bb80, 0 3px 0 #dfc5a7, 0 5px 0 #eddecb, 0 10px 16px #6b46201b; }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-line) { border-left-width: 2px !important; filter: drop-shadow(2px 1px 0 #809c6e1f); }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-selected.vis-box) { border-color: #557d47 !important; background: linear-gradient(145deg, #f9fff3, #e4f0da) !important; box-shadow: inset 0 1px 0 #fff, 0 0 0 2px #668c5530, 0 3px 0 #adc399, 0 5px 0 #c4d5b7, 0 12px 22px #365e2a24; }
.is-dimensional .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected.vis-box) { border-color: #b28460 !important; background: linear-gradient(145deg, #fffaf2, #f8e5ce) !important; box-shadow: inset 0 1px 0 #fff, 0 0 0 2px #bd947430, 0 3px 0 #d6b698, 0 5px 0 #e6cdb5, 0 12px 22px #795b3024; }
@keyframes detail-appear { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 950px) { .explorer-toolbar { gap: 7px; padding: 11px 12px 8px; } .explorer-heading { gap: 6px; } .explorer-heading-icon { width: 32px; height: 32px; border-radius: 9px; } .explorer-heading strong { font-size: 13px; } .person-filter { min-width: 112px; } .explorer-button { padding: 0 9px; font-size: 11px; } .explorer-view-toggle button { padding: 0 8px; font-size: 11px; } .explorer-scale-row { padding: 0 12px 8px; } .explorer-hint { font-size: 10px; } .explorer-stage { padding: 10px; } .lane-heading { padding-inline: 12px; } .timeline-reference { padding-inline: 12px; } .unified-chart { margin-inline: 10px; } .lane-overview { margin-inline: 10px; } .detail-actions { max-width: 145px; } .detail-actions button { width: 100%; } }
@media (max-width: 650px) { .explorer-heading { width: calc(100% - 125px); } .person-filter { margin-left: auto; } .fit-button { margin-left: auto; } .explorer-scale { max-width: 100%; width: 100%; } .explorer-hint { display: none; } .lane-heading { gap: 6px 10px; } .timeline-legend { font-size: 9px; } .timeline-reference { font-size: 9px; } .shared-axis-tick > span { font-size: 9px; } .shared-axis-tick > small { font-size: 8px; } .explorer-vis-host :deep(.timeline-node-title) { max-width: 220px; } .event-detail { gap: 10px; padding: 12px 38px 12px 14px; } .detail-actions { max-width: 115px; } .detail-main h3 { font-size: 13px; } }
@media (prefers-reduced-motion: reduce) { .event-detail { animation: none; } .explorer-button, .explorer-view-toggle button { transition: none; } }
</style>
