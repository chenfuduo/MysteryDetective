<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { matchOcrRegions, type OcrRegion } from '../services/ocrLocation'

const props = defineProps<{ src: string; alt: string; rotation: number; zoom: boolean; regions?: OcrRegion[]; focusText?: string }>()
const emit = defineEmits<{ 'update:zoom': [value: boolean]; location: [count: number] }>()
const highlightedRegions = computed(() => matchOcrRegions(props.regions || [], props.focusText || ''))
const viewport = ref<HTMLElement | null>(null)
const size = reactive({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 })
const dimensions = computed(() => {
  const radians = props.rotation * Math.PI / 180
  const width = Math.abs(Math.cos(radians)) * size.imageWidth + Math.abs(Math.sin(radians)) * size.imageHeight
  const height = Math.abs(Math.sin(radians)) * size.imageWidth + Math.abs(Math.cos(radians)) * size.imageHeight
  const fit = width && height ? Math.min(Math.max(1, size.width - 50) / width, Math.max(1, size.height - 50) / height, 1) : 1
  const scale = props.zoom ? Math.max(1, fit * 2) : fit
  return {
    width: Math.max(size.width, width * scale + 50),
    height: Math.max(size.height, height * scale + 50),
    imageWidth: size.imageWidth * scale,
    imageHeight: size.imageHeight * scale,
  }
})
let observer: ResizeObserver | null = null
let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null
let ignoreClick = false
const dragging = ref(false)

watch(viewport, element => {
  observer?.disconnect()
  if (!element) return
  const measure = () => { size.width = element.clientWidth; size.height = element.clientHeight }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(element)
})
watch(() => [props.src, props.zoom, props.rotation, size.width, size.height, size.imageWidth, size.imageHeight], async () => {
  drag = null
  dragging.value = false
  await nextTick()
  centerOnSource()
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
  ignoreClick = false
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop, moved: false }
  viewport.value.setPointerCapture(event.pointerId)
  event.preventDefault()
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId || !viewport.value) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (Math.hypot(dx, dy) > 5) { drag.moved = true; dragging.value = true }
  if (drag.moved) {
    viewport.value.scrollLeft = drag.left - dx
    viewport.value.scrollTop = drag.top - dy
  }
}
function endDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  ignoreClick = drag.moved || event.type === 'pointercancel'
  drag = null
  dragging.value = false
  if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId)
}
function toggleZoom() {
  if (ignoreClick) { ignoreClick = false; return }
  emit('update:zoom', !props.zoom)
}
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div ref="viewport" class="clue-photo-viewer" :class="{ zoomed: zoom, dragging }" aria-label="原始照片，放大后可上下左右拖动" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @click="toggleZoom" @contextmenu.prevent>
    <div class="photo-scroll-content" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }">
      <div class="photo-image-plane" :style="{ width: `${dimensions.imageWidth}px`, height: `${dimensions.imageHeight}px`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }">
        <img :key="src" :src="src" :alt="alt" draggable="false" @load="loaded" />
        <div class="photo-source-regions" aria-hidden="true">
          <span v-for="(region, index) in highlightedRegions" :key="index" class="photo-source-region" :style="{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.clue-photo-viewer { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 0; cursor: zoom-in; overscroll-behavior: contain; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.clue-photo-viewer.zoomed { cursor: grab; touch-action: none; }
.clue-photo-viewer.dragging { cursor: grabbing; }
.photo-scroll-content { position: relative; }
.photo-image-plane { position: absolute; left: 50%; top: 50%; pointer-events: none; }
.photo-image-plane img { display: block; width: 100%; height: 100%; max-width: none; max-height: none; -webkit-user-drag: none; }
.photo-source-regions { position: absolute; inset: 0; pointer-events: none; }
.photo-source-region { position: absolute; box-sizing: border-box; border: 2px solid #d88a20; background: #ffcf4938; box-shadow: 0 0 0 1px #fff9; border-radius: 2px; }
</style>
