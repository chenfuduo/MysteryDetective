<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'

const props = defineProps<{ src: string; alt: string; rotation: number; zoom: boolean }>()
const emit = defineEmits<{ 'update:zoom': [value: boolean] }>()
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
  if (viewport.value) {
    viewport.value.scrollLeft = (dimensions.value.width - viewport.value.clientWidth) / 2
    viewport.value.scrollTop = (dimensions.value.height - viewport.value.clientHeight) / 2
  }
})
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
      <img :key="src" :src="src" :alt="alt" draggable="false" :style="{ width: `${dimensions.imageWidth}px`, height: `${dimensions.imageHeight}px`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }" @load="loaded" />
    </div>
  </div>
</template>

<style scoped>
.clue-photo-viewer { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 0; cursor: zoom-in; overscroll-behavior: contain; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.clue-photo-viewer.zoomed { cursor: grab; touch-action: none; }
.clue-photo-viewer.dragging { cursor: grabbing; }
.photo-scroll-content { position: relative; }
.photo-scroll-content img { position: absolute; left: 50%; top: 50%; display: block; max-width: none; max-height: none; pointer-events: none; -webkit-user-drag: none; }
</style>
