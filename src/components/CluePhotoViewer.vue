<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { matchOcrRegions, type OcrRegion } from '../services/ocrLocation'

const props = defineProps<{ src: string; alt: string; rotation: number; zoom: boolean; regions?: OcrRegion[]; focusText?: string }>()
const emit = defineEmits<{ 'update:zoom': [value: boolean]; location: [count: number] }>()
const highlightedRegions = computed(() => matchOcrRegions(props.regions || [], props.focusText || ''))
const viewport = ref<HTMLElement | null>(null)
const fullscreenButton = ref<HTMLButtonElement | null>(null)
const fullscreen = ref(false)
const size = reactive({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 })
const rotatedSize = computed(() => {
  const radians = props.rotation * Math.PI / 180
  return {
    width: Math.abs(Math.cos(radians)) * size.imageWidth + Math.abs(Math.sin(radians)) * size.imageHeight,
    height: Math.abs(Math.sin(radians)) * size.imageWidth + Math.abs(Math.cos(radians)) * size.imageHeight,
  }
})
const fitScale = computed(() => rotatedSize.value.width && rotatedSize.value.height
  ? Math.min(Math.max(1, size.width - 50) / rotatedSize.value.width, Math.max(1, size.height - 50) / rotatedSize.value.height, 1)
  : 1)
const baseZoomScale = computed(() => Math.max(1, fitScale.value * 2))
const zoomMultiplier = ref(1)
const displayScale = computed(() => props.zoom
  ? Math.max(fitScale.value, Math.min(baseZoomScale.value * 8, baseZoomScale.value * zoomMultiplier.value))
  : fitScale.value)
const dimensions = computed(() => ({
  width: Math.max(size.width, rotatedSize.value.width * displayScale.value + 50),
  height: Math.max(size.height, rotatedSize.value.height * displayScale.value + 50),
  imageWidth: size.imageWidth * displayScale.value,
  imageHeight: size.imageHeight * displayScale.value,
}))
let observer: ResizeObserver | null = null
let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null
type Pointer = { x: number; y: number }
let pointers = new Map<number, Pointer>()
let pinch: { distance: number; scale: number } | null = null
let ignoreClick = false
let ignoreClickTimer: ReturnType<typeof setTimeout> | undefined
const dragging = ref(false)

watch(viewport, element => {
  observer?.disconnect()
  if (!element) return
  const measure = () => { size.width = element.clientWidth; size.height = element.clientHeight }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(element)
})
watch(() => [props.src, props.rotation, size.width, size.height, size.imageWidth, size.imageHeight], async () => {
  drag = null
  pinch = null
  pointers.clear()
  dragging.value = false
  await nextTick()
  centerOnSource()
})
watch(() => props.zoom, value => {
  if (!value) {
    zoomMultiplier.value = 1
    drag = null
    pinch = null
    dragging.value = false
  }
})
watch(highlightedRegions, async matches => {
  emit('location', matches.length)
  if (matches.length && !props.zoom) emit('update:zoom', true)
  await nextTick()
  centerOnSource()
}, { immediate: true })
function centerOnSource() {
  const element = viewport.value
  if (!element) return
  const points = highlightedRegions.value.flatMap(region => [
    [region.x, region.y], [region.x + region.width, region.y],
    [region.x, region.y + region.height], [region.x + region.width, region.y + region.height],
  ])
  const radians = props.rotation * Math.PI / 180
  const positions = points.map(([x, y]) => {
    const dx = (x - 0.5) * dimensions.value.imageWidth
    const dy = (y - 0.5) * dimensions.value.imageHeight
    return { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) }
  })
  const centerX = positions.length ? (Math.min(...positions.map(point => point.x)) + Math.max(...positions.map(point => point.x))) / 2 : 0
  const centerY = positions.length ? (Math.min(...positions.map(point => point.y)) + Math.max(...positions.map(point => point.y))) / 2 : 0
  element.scrollLeft = dimensions.value.width / 2 + centerX - element.clientWidth / 2
  element.scrollTop = dimensions.value.height / 2 + centerY - element.clientHeight / 2
}
watch(() => props.src, () => { size.imageWidth = 0; size.imageHeight = 0 })
function loaded(event: Event) {
  const image = event.target as HTMLImageElement
  size.imageWidth = image.naturalWidth
  size.imageHeight = image.naturalHeight
}
function startDrag(event: PointerEvent) {
  if (!props.zoom || !viewport.value || drag || (event.pointerType === 'mouse' && event.button !== 0)) return
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop, moved: false }
  event.preventDefault()
}
function setScaleAt(nextScale: number, point: Pointer) {
  const element = viewport.value
  if (!element) return
  const oldScale = displayScale.value
  const oldDimensions = dimensions.value
  const rect = element.getBoundingClientRect()
  const localX = point.x - rect.left
  const localY = point.y - rect.top
  const anchorX = (element.scrollLeft + localX - oldDimensions.width / 2) / oldScale
  const anchorY = (element.scrollTop + localY - oldDimensions.height / 2) / oldScale
  const scale = Math.max(fitScale.value, Math.min(baseZoomScale.value * 8, nextScale))
  zoomMultiplier.value = scale / baseZoomScale.value
  if (!props.zoom) emit('update:zoom', true)
  nextTick(() => {
    if (!viewport.value) return
    viewport.value.scrollLeft = dimensions.value.width / 2 + anchorX * displayScale.value - localX
    viewport.value.scrollTop = dimensions.value.height / 2 + anchorY * displayScale.value - localY
  })
}
function startPointer(event: PointerEvent) {
  if ((event.pointerType === 'mouse' && event.button !== 0) || !viewport.value) return
  if (!pointers.size) { ignoreClick = false; if (ignoreClickTimer) clearTimeout(ignoreClickTimer) }
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  viewport.value.setPointerCapture(event.pointerId)
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: displayScale.value }
    drag = null
    dragging.value = false
    ignoreClick = true
    if (!props.zoom) {
      zoomMultiplier.value = displayScale.value / baseZoomScale.value
      emit('update:zoom', true)
    }
    return
  }
  startDrag(event)
}
function movePointer(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const distanceRatio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance
    setScaleAt(pinch.scale * Math.pow(distanceRatio, 1.7), point)
    return
  }
  moveDrag(event)
}
function endDrag(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const wasPinching = Boolean(pinch)
  pointers.delete(event.pointerId)
  if (wasPinching) {
    pinch = null
    drag = null
    ignoreClick = true
    if (ignoreClickTimer) clearTimeout(ignoreClickTimer)
    ignoreClickTimer = setTimeout(() => { ignoreClick = false }, 500)
    if (pointers.size === 1 && props.zoom && viewport.value) {
      const [id, point] = [...pointers.entries()][0]
      drag = { id, x: point.x, y: point.y, left: viewport.value.scrollLeft, top: viewport.value.scrollTop, moved: true }
      dragging.value = true
    } else dragging.value = false
  } else if (drag?.id === event.pointerId) {
    ignoreClick = drag.moved || event.type === 'pointercancel'
    if (ignoreClick) {
      if (ignoreClickTimer) clearTimeout(ignoreClickTimer)
      ignoreClickTimer = setTimeout(() => { ignoreClick = false }, 500)
    }
    drag = null
    dragging.value = false
  }
  if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId)
}
function toggleZoom() {
  if (ignoreClick) { ignoreClick = false; if (ignoreClickTimer) clearTimeout(ignoreClickTimer); return }
  if (props.zoom) emit('update:zoom', false)
  else { zoomMultiplier.value = 1; emit('update:zoom', true) }
}
function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
  nextTick(() => fullscreenButton.value?.focus())
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !fullscreen.value) return
  event.preventDefault()
  event.stopImmediatePropagation()
  fullscreen.value = false
  nextTick(() => fullscreenButton.value?.focus())
}
onMounted(() => window.addEventListener('keydown', handleKeydown, true))
onUnmounted(() => {
  observer?.disconnect()
  if (ignoreClickTimer) clearTimeout(ignoreClickTimer)
  window.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <div class="photo-viewer-shell" :class="{ fullscreen }" :role="fullscreen ? 'dialog' : undefined" :aria-modal="fullscreen ? 'true' : undefined" :aria-label="fullscreen ? '原始照片全屏查看' : undefined">
      <div ref="viewport" class="clue-photo-viewer" :class="{ zoomed: zoom, dragging }" aria-label="原始照片，可双指自由缩放，放大后可拖动" @pointerdown="startPointer" @pointermove="movePointer" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @click="toggleZoom" @contextmenu.prevent>
        <div class="photo-scroll-content" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }">
          <div class="photo-image-plane" :style="{ width: `${dimensions.imageWidth}px`, height: `${dimensions.imageHeight}px`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }">
            <img :key="src" :src="src" :alt="alt" draggable="false" @load="loaded" />
            <div class="photo-source-regions" aria-hidden="true">
              <span v-for="(region, index) in highlightedRegions" :key="index" class="photo-source-region" :style="{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }" />
            </div>
          </div>
        </div>
      </div>
      <button ref="fullscreenButton" type="button" class="photo-viewer-fullscreen-button" :aria-label="fullscreen ? '退出全屏查看' : '全屏查看原图'" :title="fullscreen ? '退出全屏查看（Esc）' : '全屏查看原图'" @click.stop="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏查看' }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
.clue-photo-viewer { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 0; cursor: zoom-in; touch-action: none; overscroll-behavior: contain; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.clue-photo-viewer.zoomed { cursor: grab; touch-action: none; }
.clue-photo-viewer.dragging { cursor: grabbing; }
.photo-scroll-content { position: relative; }
.photo-image-plane { position: absolute; left: 50%; top: 50%; pointer-events: none; }
.photo-image-plane img { display: block; width: 100%; height: 100%; max-width: none; max-height: none; -webkit-user-drag: none; }
.photo-source-regions { position: absolute; inset: 0; pointer-events: none; }
.photo-source-region { position: absolute; box-sizing: border-box; border: 2px solid #d88a20; background: #ffcf4938; box-shadow: 0 0 0 1px #fff9; border-radius: 2px; }
.photo-viewer-shell { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.photo-viewer-shell.fullscreen { position: fixed; inset: 0; z-index: 2147483000; box-sizing: border-box; width: 100vw; width: 100dvw; height: 100vh; height: 100dvh; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); background: #171d19; touch-action: none; overscroll-behavior: none; }
.photo-viewer-shell.fullscreen .clue-photo-viewer { width: 100%; height: 100%; }
.photo-viewer-fullscreen-button { position: absolute; z-index: 1; top: 12px; right: 12px; min-height: 44px; padding: 0 14px; border: 1px solid #ffffff80; border-radius: 9px; background: #172019d9; color: #fff; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; touch-action: manipulation; }
.photo-viewer-shell.fullscreen .photo-viewer-fullscreen-button { top: calc(env(safe-area-inset-top, 0px) + 12px); right: calc(env(safe-area-inset-right, 0px) + 12px); }
.photo-viewer-fullscreen-button:focus-visible { outline: 3px solid #f3bd72; outline-offset: 2px; }
</style>
