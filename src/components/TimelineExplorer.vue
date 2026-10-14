<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Timeline } from 'vis-timeline/standalone'
import UiIcon from './UiIcon.vue'
import type { ClueRecord, PersonRecord, TimelineRecord } from '../services/vault'

type Lane = 'dated' | 'yearless'
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
const rootElement = ref<HTMLElement | null>(null)
const datedElement = ref<HTMLElement | null>(null)
const yearlessElement = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
const dimensional = ref(true)
const selectedId = ref('')
const windows = reactive<Record<Lane, TimeWindow | null>>({ dated: null, yearless: null })
const instances: Record<Lane, Timeline | null> = { dated: null, yearless: null }
let appliedScale = props.scale || 1
let resizeObserver: ResizeObserver | null = null
let redrawFrame = 0
let previousOverflow = ''
let returnFocus: HTMLElement | null = null
let chartPointer: { x: number; y: number; moved: boolean } | null = null
defineExpose({ enterFullscreen: () => { fullscreen.value = true } })

const allEvents = computed(() => props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && Number.isFinite(eventTime(event))))
const visibleEvents = computed(() => allEvents.value.filter(event => !props.personId || event.personIds.includes(props.personId)))
const lanes = computed<Lane[]>(() => ['dated', 'yearless'].filter(lane => laneEvents(lane as Lane).length) as Lane[])
const selectedEvent = computed(() => visibleEvents.value.find(event => event.id === selectedId.value))
const selectedPeople = computed(() => props.people.filter(person => selectedEvent.value?.personIds.includes(person.id)))
const selectedClue = computed(() => props.clues.find(clue => clue.id === selectedEvent.value?.clueId))

function setLaneElement(lane: Lane, element: unknown) {
  if (lane === 'dated') datedElement.value = element instanceof HTMLElement ? element : null
  else yearlessElement.value = element instanceof HTMLElement ? element : null
}
function eventTime(event: TimelineRecord) {
  return Date.parse(event.startsAt.startsWith('--') ? `2000-${event.startsAt.slice(2)}` : event.startsAt)
}
function laneEvents(lane: Lane, visible = false) {
  return (visible ? visibleEvents.value : allEvents.value).filter(event => event.startsAt.startsWith('--') === (lane === 'yearless'))
}
function dateLabel(value: string) {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!match) return value
  return `${match[1] ? `${match[1]}年` : ''}${Number(match[2])}月${Number(match[3])}日${match[4] ? ` ${match[4]}:${match[5]}` : ''}`
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
function axisLabel(input: unknown, unit: string, yearless: boolean, major = false) {
  const date = (input as { toDate?: () => Date }).toDate?.() ?? new Date(input as string)
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('zh-CN-u-ca-gregory-nu-latn', options).format(date)
  const year = yearless ? {} : { year: 'numeric' as const }
  if (unit === 'millisecond') return `${String(date.getMilliseconds()).padStart(3, '0')}毫秒`
  if (unit === 'second') return format({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  if (unit === 'minute' || unit === 'hour') return major ? format({ ...year, month: 'numeric', day: 'numeric' }) : format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  if (unit === 'day' || unit === 'week' || unit === 'weekday') return format(major ? { ...year, month: 'numeric' } : { month: 'numeric', day: 'numeric' })
  if (unit === 'month') return format({ ...year, month: 'numeric' })
  return format({ ...year, month: 'numeric', day: 'numeric' })
}
function fullWindow(lane: Lane, scale = 1): TimeWindow {
  const times = laneEvents(lane).map(eventTime)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const span = Math.max(last - first, 3 * 60 * 60_000) * 1.18 / scale
  const center = (first + last) / 2
  return { start: new Date(center - span / 2), end: new Date(center + span / 2) }
}
function bounds(lane: Lane) {
  const range = fullWindow(lane)
  const span = range.end.getTime() - range.start.getTime()
  return { min: new Date(range.start.getTime() - span * .35), max: new Date(range.end.getTime() + span * .35), zoomMin: 60_000, zoomMax: span * 1.7 }
}
function items(lane: Lane) {
  return laneEvents(lane, true).map(event => ({
    id: event.id,
    start: new Date(eventTime(event)),
    content: eventContent(event),
    className: `${lane === 'yearless' ? 'timeline-node-yearless' : 'timeline-node-dated'}${event.yearlessMarkerIgnored ? ' timeline-marker-ignored' : ''}`,
  }))
}
function applyWindow(lane: Lane, range: TimeWindow, animate = false) {
  windows[lane] = range
  instances[lane]?.setWindow(range.start, range.end, { animation: animate ? { duration: 260, easingFunction: 'easeInOutQuad' } : false })
}
function scheduleRedraw() {
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  redrawFrame = requestAnimationFrame(() => { instances.dated?.redraw(); instances.yearless?.redraw(); redrawFrame = 0 })
}
async function syncCharts() {
  await nextTick()
  for (const lane of ['dated', 'yearless'] as Lane[]) {
    if (!laneEvents(lane).length) { instances[lane]?.destroy(); instances[lane] = null; windows[lane] = null; continue }
    const element = lane === 'dated' ? datedElement.value : yearlessElement.value
    if (!element) continue
    if (instances[lane]) {
      const range = instances[lane]!.getWindow()
      instances[lane]!.setOptions(bounds(lane))
      instances[lane]!.setItems(items(lane))
      applyWindow(lane, range)
      continue
    }
    const range = windows[lane] ?? fullWindow(lane, props.scale || 1)
    const yearless = lane === 'yearless'
    const instance = new Timeline(element, items(lane), {
      ...bounds(lane), start: range.start, end: range.end,
      locale: 'zh-cn', locales: { 'zh-cn': { current: '现在', time: '时间', deleteSelected: '删除所选项' } },
      format: { minorLabels: (date, unit) => axisLabel(date, unit, yearless), majorLabels: (date, unit) => axisLabel(date, unit, yearless, true) },
      height: '100%', stack: true, selectable: true, showCurrentTime: false,
      zoomKey: 'ctrlKey', horizontalScroll: true, verticalScroll: true,
      margin: { item: { horizontal: 18, vertical: 18 }, axis: 22 },
      orientation: { axis: 'bottom', item: 'bottom' },
      tooltip: { followMouse: false },
    })
    instances[lane] = instance
    windows[lane] = range
    instance.on('select', (properties: { items?: Array<string | number> }) => {
      const id = properties.items?.[0]
      if (id === undefined) return
      selectedId.value = String(id)
      for (const other of lanes.value) if (other !== lane) instances[other]?.setSelection([])
    })
    instance.on('rangechanged', () => { windows[lane] = instance.getWindow() })
  }
  if (selectedId.value && !selectedEvent.value) selectedId.value = ''
  if (selectedEvent.value) instances[selectedEvent.value.startsAt.startsWith('--') ? 'yearless' : 'dated']?.setSelection([selectedId.value])
  scheduleRedraw()
}
function fitAll() {
  appliedScale = 1
  emit('update:scale', 1)
  for (const lane of lanes.value) applyWindow(lane, fullWindow(lane), true)
}
function zoom(factor: number) {
  for (const lane of lanes.value) {
    const range = instances[lane]?.getWindow() ?? windows[lane]
    if (!range) continue
    const center = (range.start.getTime() + range.end.getTime()) / 2
    const span = Math.max(60_000, (range.end.getTime() - range.start.getTime()) / factor)
    applyWindow(lane, { start: new Date(center - span / 2), end: new Date(center + span / 2) })
  }
}
function overviewMarkers(lane: Lane) {
  const range = fullWindow(lane)
  const span = range.end.getTime() - range.start.getTime()
  return laneEvents(lane).map(event => ({ id: event.id, left: `${(eventTime(event) - range.start.getTime()) / span * 100}%`, visible: !props.personId || event.personIds.includes(props.personId) }))
}
function overviewWindow(lane: Lane) {
  const whole = fullWindow(lane)
  const current = windows[lane] ?? whole
  const span = whole.end.getTime() - whole.start.getTime()
  const left = Math.max(0, (current.start.getTime() - whole.start.getTime()) / span * 100)
  const right = Math.min(100, (current.end.getTime() - whole.start.getTime()) / span * 100)
  return { left: `${left}%`, width: `${Math.max(1, right - left)}%` }
}
function navigateOverview(lane: Lane, event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const whole = fullWindow(lane)
  const current = instances[lane]?.getWindow() ?? whole
  const span = current.end.getTime() - current.start.getTime()
  const center = whole.start.getTime() + fraction * (whole.end.getTime() - whole.start.getTime())
  applyWindow(lane, { start: new Date(center - span / 2), end: new Date(center + span / 2) }, true)
}
function beginChartPointer(event: PointerEvent) {
  chartPointer = { x: event.clientX, y: event.clientY, moved: false }
}
function moveChartPointer(event: PointerEvent) {
  if (chartPointer && Math.hypot(event.clientX - chartPointer.x, event.clientY - chartPointer.y) > 8) chartPointer.moved = true
}
function selectChartEvent(lane: Lane, event: MouseEvent) {
  if (chartPointer?.moved) { chartPointer = null; return }
  chartPointer = null
  const target = event.target as HTMLElement
  const content = target?.closest<HTMLElement>('.timeline-event-content') ?? target?.closest('.vis-item')?.querySelector<HTMLElement>('.timeline-event-content')
  const id = content?.dataset.eventId
  if (!id || !visibleEvents.value.some(item => item.id === id)) return
  selectedId.value = id
  instances[lane]?.setSelection([id])
  for (const other of lanes.value) if (other !== lane) instances[other]?.setSelection([])
}
function closeDetail() {
  selectedId.value = ''
  instances.dated?.setSelection([])
  instances.yearless?.setSelection([])
  scheduleRedraw()
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (selectedId.value) closeDetail()
    else if (fullscreen.value) fullscreen.value = false
  }
}
watch(() => [props.events, props.personId], syncCharts, { deep: true })
watch(() => props.scale, next => {
  if (!Number.isFinite(next) || next <= 0) return
  zoom(next / appliedScale)
  appliedScale = next
})
watch(() => props.scriptId, async () => {
  for (const lane of ['dated', 'yearless'] as Lane[]) { instances[lane]?.destroy(); instances[lane] = null; windows[lane] = null }
  selectedId.value = ''
  appliedScale = props.scale || 1
  await syncCharts()
})
watch([dimensional, selectedId], async () => { await nextTick(); scheduleRedraw() })
watch(fullscreen, async active => {
  emit('fullscreen-change', active)
  if (active) {
    previousOverflow = document.body.style.overflow
    returnFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = previousOverflow
    returnFocus?.focus()
  }
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
  instances.dated?.destroy(); instances.yearless?.destroy()
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
      <div v-if="allEvents.length" class="explorer-stage" :class="{ 'has-two-lanes': lanes.length === 2 }">
        <article v-for="lane in lanes" :key="lane" class="timeline-lane" :class="{ 'is-yearless': lane === 'yearless' }">
          <div class="lane-heading"><strong>{{ lane === 'yearless' ? '无年份时间线' : '已知年份时间线' }}</strong><span>{{ lane === 'yearless' ? '按月日与时刻排列' : '按日期与时刻排列' }}</span><small>{{ laneEvents(lane, true).length }} 个事件</small></div>
          <div class="lane-chart" @pointerdown.capture="beginChartPointer" @pointermove.capture="moveChartPointer" @click.capture="selectChartEvent(lane, $event)"><div :ref="element => setLaneElement(lane, element)" class="explorer-vis-host"></div><div v-if="!laneEvents(lane, true).length" class="lane-empty"><UiIcon name="filter" :size="24" /><span>这条时间线上没有该人物的事件</span><button @click="emit('update:personId', '')">查看全部人物</button></div></div>
          <div class="lane-overview" aria-label="时间线全局导航" @pointerdown="navigateOverview(lane, $event)"><span class="overview-window" :style="overviewWindow(lane)"></span><i v-for="marker in overviewMarkers(lane)" :key="marker.id" :style="{ left: marker.left }" :class="{ 'is-hidden': !marker.visible }"></i></div>
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
.explorer-stage { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; gap: 12px; padding: 14px; overflow: hidden; }
.timeline-lane { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid #e2e8de; border-radius: 14px; background: #fcfdfb; }
.lane-heading { display: flex; align-items: center; gap: 10px; flex-shrink: 0; padding: 11px 14px 8px; color: #405e48; }
.lane-heading strong { font-size: 12px; font-weight: 650; }
.lane-heading > span { font-size: 10px; color: #94a091; }
.lane-heading small { margin-left: auto; font-size: 10px; color: #8a988b; }
.is-yearless .lane-heading strong { color: #a17156; }
.lane-chart { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.explorer-vis-host { flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.lane-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #829381; font-size: 12px; background: #fcfdfbef; }
.lane-empty button { min-height: 40px; padding: 0 12px; background: #eff4ed; border: 0; border-radius: 9px; color: #42604a; font: inherit; font-size: 12px; }
.lane-overview { position: relative; height: 26px; flex-shrink: 0; margin: 5px 14px 10px; border-radius: 7px; background: #f0f3eb; overflow: hidden; cursor: pointer; touch-action: none; }
.lane-overview i { position: absolute; top: 7px; width: 3px; height: 12px; border-radius: 2px; background: #5f8a69; transform: translateX(-50%); pointer-events: none; }
.is-yearless .lane-overview i { background: #bc8c6c; }
.lane-overview i.is-hidden { opacity: .16; }
.overview-window { position: absolute; inset-block: 0; border: 1px solid #628a6c55; border-radius: 6px; background: #789b7b15; pointer-events: none; }
.is-yearless .overview-window { border-color: #b4866955; background: #b4866912; }
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
.explorer-vis-host :deep(.vis-panel.vis-center), .explorer-vis-host :deep(.vis-panel.vis-bottom), .explorer-vis-host :deep(.vis-panel.vis-top) { border-color: #e8ede4; }
.explorer-vis-host :deep(.vis-time-axis .vis-text) { color: #8a9983; font-size: 10px; }
.explorer-vis-host :deep(.vis-time-axis .vis-text.vis-major) { color: #617358; font-size: 10px; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-minor) { border-color: #e8eee3; }
.explorer-vis-host :deep(.vis-time-axis .vis-grid.vis-major) { border-color: #dbe4d5; }
.explorer-vis-host :deep(.vis-item) { border: 1px solid #99b198; border-color: #99b198 !important; border-radius: 8px !important; color: #345c3d !important; background: #f0f6eb !important; font-size: 12px !important; }
.explorer-vis-host :deep(.vis-item .vis-item-content) { padding: 8px 11px; }
.explorer-vis-host :deep(.timeline-node-time) { display: block; margin-bottom: 3px; color: #7c936f; font-size: 9px; font-weight: 500; font-variant-numeric: tabular-nums; }
.explorer-vis-host :deep(.timeline-node-title) { display: block; max-width: 280px; white-space: normal; line-height: 1.45; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless) { color: #8f6346 !important; background: #fbf3e8 !important; border-color: #cfad8e !important; }
.explorer-vis-host :deep(.timeline-node-yearless .timeline-node-time) { color: #af8d6c; }
.explorer-vis-host :deep(.vis-item.vis-selected) { background: #e1efda !important; border-color: #4d7d4d !important; box-shadow: 0 0 0 2px #668c5522; }
.explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected) { background: #f8e8d6 !important; border-color: #ab7850 !important; box-shadow: 0 0 0 2px #bd947422; }
.explorer-vis-host :deep(.vis-item.vis-line), .explorer-vis-host :deep(.vis-item.vis-dot) { border-color: #97b190 !important; }
.is-yearless .explorer-vis-host :deep(.vis-item.vis-line), .is-yearless .explorer-vis-host :deep(.vis-item.vis-dot) { border-color: #c9a586 !important; }
.is-dimensional .lane-chart { background: radial-gradient(ellipse at 45% 80%, #e9f1e272, transparent 75%), linear-gradient(180deg, #fff0, #e8eee41a); }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-box) { box-shadow: 0 2px 0 #cad9c0, 0 4px 0 #dce7d4, 0 10px 18px #324a2814; background: linear-gradient(150deg, #fcfdf9, #edf5e6) !important; border-color: #a2b99a !important; }
.is-dimensional .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-box) { box-shadow: 0 2px 0 #e2c9ad, 0 4px 0 #ebdcc8, 0 10px 18px #6b462014; background: linear-gradient(150deg, #fffaf2, #f8edde) !important; border-color: #cfad8e !important; }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-line) { border-left-width: 2px; filter: drop-shadow(3px 2px 0 #809c6e12); }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-dot) { width: 8px; height: 8px; border-width: 3px; border-radius: 50% !important; background: #fcfdfb !important; box-shadow: 0 3px 4px #345c3220; }
.is-dimensional .explorer-vis-host :deep(.vis-item.vis-selected.vis-box) { background: linear-gradient(150deg, #eff8e8, #e3eed9) !important; border-color: #557d47 !important; box-shadow: 0 2px 0 #adc399, 0 4px 0 #c4d5b7, 0 12px 24px #365e2a20; }
.is-dimensional .explorer-vis-host :deep(.vis-item.timeline-node-yearless.vis-selected.vis-box) { background: linear-gradient(150deg, #fff5e9, #f8e5ce) !important; border-color: #b28460 !important; box-shadow: 0 2px 0 #d6b698, 0 4px 0 #e6cdb5, 0 12px 24px #795b3020; }
@keyframes detail-appear { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 950px) { .explorer-toolbar { gap: 7px; padding: 11px 12px 8px; } .explorer-heading { gap: 6px; } .explorer-heading-icon { width: 32px; height: 32px; border-radius: 9px; } .explorer-heading strong { font-size: 13px; } .person-filter { min-width: 112px; } .explorer-button { padding: 0 9px; font-size: 11px; } .explorer-view-toggle button { padding: 0 8px; font-size: 11px; } .explorer-scale-row { padding: 0 12px 8px; } .explorer-hint { font-size: 10px; } .explorer-stage { padding: 10px; gap: 8px; } .detail-actions { max-width: 145px; } .detail-actions button { width: 100%; } }
@media (max-width: 650px) { .explorer-heading { width: calc(100% - 125px); } .person-filter { margin-left: auto; } .fit-button { margin-left: auto; } .explorer-scale { max-width: 100%; width: 100%; } .explorer-hint { display: none; } .lane-heading > span { display: none; } .event-detail { gap: 10px; padding: 12px 38px 12px 14px; } .detail-actions { max-width: 115px; } .detail-main h3 { font-size: 13px; } }
@media (prefers-reduced-motion: reduce) { .event-detail { animation: none; } .explorer-button, .explorer-view-toggle button { transition: none; } }
</style>
