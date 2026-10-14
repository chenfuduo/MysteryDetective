<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { acquirePhotoPreview, discardPhotoPreview } from '../services/photoPreview'
import UiIcon from './UiIcon.vue'

const props = withDefaults(defineProps<{ path: string; alt?: string; rotation?: number; fit?: 'cover' | 'contain' }>(), { alt: '', rotation: 0, fit: 'cover' })
const frame = ref<HTMLElement | null>(null)
const visible = ref(false), failed = ref(false), source = ref(''), fallbackRotation = ref(0)
const originalSize = ref({ width: 0, height: 0 }), frameSize = ref({ width: 0, height: 0 })
const fallbackStyle = computed(() => {
  if (!fallbackRotation.value || !originalSize.value.width || !frameSize.value.width) return undefined
  const radians = fallbackRotation.value * Math.PI / 180, natural = originalSize.value, bounds = frameSize.value
  const width = Math.abs(Math.cos(radians)) * natural.width + Math.abs(Math.sin(radians)) * natural.height
  const height = Math.abs(Math.sin(radians)) * natural.width + Math.abs(Math.cos(radians)) * natural.height
  const scale = props.fit === 'contain' ? Math.min(bounds.width / width, bounds.height / height) : Math.max(bounds.width / width, bounds.height / height)
  return { position: 'absolute' as const, left: '50%', top: '50%', width: `${natural.width * scale}px`, height: `${natural.height * scale}px`, maxWidth: 'none', maxHeight: 'none', transform: `translate(-50%, -50%) rotate(${fallbackRotation.value}deg)` }
})
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let release: (() => void) | null = null
let sequence = 0
async function load() {
  const request = ++sequence
  release?.(); release = null; resizeObserver?.disconnect(); resizeObserver = null; source.value = ''; failed.value = false; fallbackRotation.value = 0
  if (!visible.value || !props.path) return
  const lease = acquirePhotoPreview(props.path, props.rotation)
  release = lease.release
  try {
    const preview = await lease.result
    if (request !== sequence) return
    originalSize.value = { width: preview.width, height: preview.height }
    fallbackRotation.value = preview.owned ? 0 : props.rotation
    if (fallbackRotation.value && frame.value) {
      const updateSize = () => { if (frame.value) frameSize.value = { width: frame.value.clientWidth, height: frame.value.clientHeight } }
      updateSize()
      resizeObserver?.disconnect()
      if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(updateSize); resizeObserver.observe(frame.value) }
    }
    source.value = preview.url
  } catch { if (request === sequence) failed.value = true }
}
function imageFailed() { failed.value = true; source.value = ''; release?.(); release = null; discardPhotoPreview(props.path, props.rotation) }
watch([() => props.path, () => props.rotation, visible], () => { void load() })
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible.value = true; return }
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visible.value = true
    observer?.disconnect(); observer = null
  }, { rootMargin: '240px' })
  if (frame.value) observer.observe(frame.value)
})
onBeforeUnmount(() => { sequence += 1; observer?.disconnect(); resizeObserver?.disconnect(); release?.() })
</script>

<template>
  <span ref="frame" class="clue-thumbnail" :style="{ '--thumbnail-fit': fit }" :aria-busy="Boolean(path && !source && !failed)">
    <img v-if="source" :src="source" :alt="alt" :style="fallbackStyle" loading="lazy" decoding="async" draggable="false" @error="imageFailed" @contextmenu.prevent />
    <span v-else class="thumbnail-placeholder" :role="failed ? 'status' : undefined"><UiIcon name="image" :size="22" /><span v-if="failed">照片加载失败</span><button v-if="failed" type="button" aria-label="重试加载照片" @click.stop="load" @pointerdown.stop @keydown.enter.stop @keydown.space.stop>重试</button></span>
  </span>
</template>

<style scoped>
.clue-thumbnail{position:relative;display:block;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:#edf2e8;color:#93a187;border-radius:inherit;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}.clue-thumbnail img{display:block;width:100%;height:100%;object-fit:var(--thumbnail-fit,cover);pointer-events:none}.thumbnail-placeholder{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;width:100%;height:100%;min-height:32px;font-size:10px;text-align:center}.thumbnail-placeholder button{min-height:32px;padding:3px 10px;border:1px solid #d3dfca;border-radius:7px;background:#fff;color:#496c40;font:inherit;cursor:pointer;touch-action:manipulation}.thumbnail-placeholder button:focus-visible{outline:2px solid #719d61;outline-offset:2px}
</style>
