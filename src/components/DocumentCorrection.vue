<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { correctDocumentPerspective, defaultDocumentQuad, loadDocumentImage, validDocumentQuad, type DocumentQuad } from '../services/documentCorrection'

const props = defineProps<{ src: string; title: string; busy: boolean }>()
const emit = defineEmits<{ close: []; save: [dataUrl: string] }>()
const frame = ref<HTMLElement | null>(null)
const canvasHost = ref<HTMLElement | null>(null)
const quad = ref<DocumentQuad>(defaultDocumentQuad())
const selected = ref(0)
const loading = ref(true), processing = ref(false), previewOpen = ref(false)
const preview = ref(''), error = ref('')
const size = reactive({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 })
const locked = computed(() => props.busy || processing.value || loading.value)
const names = ['左上角', '右上角', '右下角', '左下角']
const imageRect = computed(() => {
  const scale = Math.min(size.width / (size.imageWidth || 1), size.height / (size.imageHeight || 1))
  const width = size.imageWidth * scale, height = size.imageHeight * scale
  return { left: (size.width - width) / 2, top: (size.height - height) / 2, width, height }
})
const polygon = computed(() => quad.value.map(point => `${imageRect.value.left + point.x * imageRect.value.width},${imageRect.value.top + point.y * imageRect.value.height}`).join(' '))
const imageStyle = computed(() => ({ left: `${imageRect.value.left}px`, top: `${imageRect.value.top}px`, width: `${imageRect.value.width}px`, height: `${imageRect.value.height}px` }))
let source: HTMLCanvasElement | null = null
let controller: AbortController | null = null
let observer: ResizeObserver | null = null
let sequence = 0
let dragging: { id: number; corner: number; element: HTMLElement } | null = null
function releaseDrag() {
  if (dragging?.element.hasPointerCapture(dragging.id)) dragging.element.releasePointerCapture(dragging.id)
  dragging = null
}
watch(frame, element => {
  observer?.disconnect()
  if (!element) return
  const measure = () => { size.width = element.clientWidth; size.height = element.clientHeight }
  measure(); observer = new ResizeObserver(measure); observer.observe(element)
})
watch(() => props.src, async src => {
  const request = ++sequence
  controller?.abort(); controller = new AbortController()
  releaseDrag(); preview.value = ''; previewOpen.value = false; error.value = ''; processing.value = false; loading.value = true
  if (source) { source.width = 0; source.height = 0; source = null }
  size.imageWidth = 0; size.imageHeight = 0; quad.value = defaultDocumentQuad()
  try {
    const decoded = await loadDocumentImage(src, controller.signal)
    if (request !== sequence) { decoded.width = 0; decoded.height = 0; return }
    source = decoded; size.imageWidth = decoded.width; size.imageHeight = decoded.height
    await nextTick()
    canvasHost.value?.replaceChildren(decoded)
  } catch (reason) {
    if (request === sequence && !(reason instanceof DOMException && reason.name === 'AbortError')) error.value = reason instanceof Error ? reason.message : '无法载入原始照片。'
  } finally {
    if (request === sequence) loading.value = false
  }
}, { immediate: true })
function moveCorner(index: number, x: number, y: number) {
  const next = quad.value.map(point => ({ ...point })) as DocumentQuad
  next[index] = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  if (!validDocumentQuad(next)) return
  quad.value = next; preview.value = ''; previewOpen.value = false; error.value = ''
}
function startDrag(event: PointerEvent, index: number) {
  if (locked.value || previewOpen.value || (event.pointerType === 'mouse' && event.button !== 0) || dragging) return
  const element = event.currentTarget as HTMLElement
  selected.value = index; element.focus({ preventScroll: true }); element.setPointerCapture(event.pointerId)
  dragging = { id: event.pointerId, corner: index, element }; event.preventDefault()
}
function moveDrag(event: PointerEvent) {
  if (!dragging || dragging.id !== event.pointerId || locked.value || !frame.value) return
  const bounds = frame.value.getBoundingClientRect(), rect = imageRect.value
  if (!rect.width || !rect.height) return
  moveCorner(dragging.corner, (event.clientX - bounds.left - rect.left) / rect.width, (event.clientY - bounds.top - rect.top) / rect.height)
  event.preventDefault()
}
function endDrag(event: PointerEvent) {
  if (dragging?.id === event.pointerId) releaseDrag()
}
function keyCorner(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  if (locked.value || previewOpen.value) return
  const point = quad.value[index]!, step = event.shiftKey ? .02 : .005
  moveCorner(index, point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))
}
function reset() {
  if (locked.value) return
  releaseDrag(); quad.value = defaultDocumentQuad(); selected.value = 0; preview.value = ''; previewOpen.value = false; error.value = ''
}
async function calculate() {
  if (locked.value || !source) return
  releaseDrag(); error.value = ''; processing.value = true
  controller?.abort(); controller = new AbortController()
  const request = ++sequence
  try {
    const result = await correctDocumentPerspective(source, quad.value, controller.signal)
    if (request !== sequence) return
    preview.value = result; previewOpen.value = true
  } catch (reason) {
    if (request === sequence && !(reason instanceof DOMException && reason.name === 'AbortError')) error.value = reason instanceof Error ? reason.message : '校正失败，请重新选择四角。'
  } finally {
    if (request === sequence) processing.value = false
  }
}
function cancelProcessing() {
  if (props.busy || !processing.value) return
  ++sequence; controller?.abort(); processing.value = false
}
function close() {
  if (props.busy || processing.value) return
  controller?.abort(); emit('close')
}
function save() {
  if (!locked.value && preview.value) emit('save', preview.value)
}
watch(() => props.busy, busy => { if (busy) releaseDrag() })
onUnmounted(() => {
  ++sequence; controller?.abort(); observer?.disconnect(); releaseDrag()
  if (source) { source.width = 0; source.height = 0; source = null }
})
</script>

<template>
  <Teleport to="body">
    <section class="document-correction" role="dialog" aria-modal="true" aria-labelledby="document-correction-title" @contextmenu.prevent @keydown.esc.prevent="close">
      <header class="correction-header">
        <div><span class="correction-eyebrow">透视校正</span><h2 id="document-correction-title">{{ title || '校正线索照片' }}</h2></div>
        <button type="button" class="correction-close" :disabled="busy || processing" aria-label="关闭校正" @click="close">×</button>
      </header>
      <p class="correction-instruction">拖动四角，贴合纸张边缘。</p>
      <div class="correction-tabs" role="group" aria-label="校正查看方式">
        <button type="button" :class="{ active: !previewOpen }" :aria-pressed="!previewOpen" :disabled="locked" @click="previewOpen = false">原图调整</button>
        <button type="button" :class="{ active: previewOpen }" :aria-pressed="previewOpen" :disabled="locked || !preview" @click="previewOpen = true">校正预览</button>
      </div>
      <div ref="frame" class="correction-stage" :class="{ 'is-adjusting': !previewOpen }" @dragstart.prevent @selectstart.prevent>
        <div v-show="!previewOpen" ref="canvasHost" class="correction-image" :style="imageStyle" />
        <img v-if="previewOpen && preview" class="correction-preview" :src="preview" alt="透视校正预览" draggable="false">
        <svg v-if="!loading && !previewOpen && source" class="correction-overlay" :width="size.width" :height="size.height" aria-hidden="true">
          <defs><mask id="document-correction-mask"><rect width="100%" height="100%" fill="white"/><polygon :points="polygon" fill="black"/></mask></defs>
          <rect width="100%" height="100%" fill="rgba(36,49,61,.5)" mask="url(#document-correction-mask)"/>
          <polygon :points="polygon" class="correction-area" stroke-width="2" stroke-linejoin="round"/>
        </svg>
        <template v-if="!loading && !previewOpen && source">
          <button v-for="(point, index) in quad" :key="index" type="button" class="correction-handle" :class="{ selected: selected === index }" :style="{ left: `${imageRect.left + point.x * imageRect.width}px`, top: `${imageRect.top + point.y * imageRect.height}px` }" :aria-label="`${names[index]}，拖动或用方向键调整`" :disabled="locked" @focus="selected = index" @pointerdown="startDrag($event, index)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @keydown="keyCorner($event, index)"><span>{{ index + 1 }}</span></button>
        </template>
        <div v-if="loading || processing" class="correction-progress" role="status"><span class="correction-spinner"/>{{ loading ? '正在载入原始照片…' : '正在逐行校正照片…' }}<button v-if="processing" type="button" @click="cancelProcessing">取消处理</button></div>
      </div>
      <p v-if="error" class="correction-error" role="alert">{{ error }}</p>
      <footer class="correction-footer">
        <button type="button" class="correction-secondary" :disabled="locked || !source" @click="reset">重置四角</button>
        <button type="button" class="correction-secondary" :disabled="locked || !source" @click="calculate">{{ preview ? '重新生成预览' : '预览校正' }}</button>
        <button type="button" class="correction-primary" :disabled="locked || !preview" @click="save">{{ busy ? '正在保存…' : '保存校正副本' }}</button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.document-correction { position: fixed; inset: 0; z-index: 1450; display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: calc(env(safe-area-inset-top) + 16px) max(16px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 16px) max(16px, env(safe-area-inset-left)); background: var(--cv-canvas); color: var(--cv-ink); font-family: var(--cv-font); user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; overflow: hidden; box-sizing: border-box; }
.document-correction :where(button) { font: inherit; cursor: pointer; touch-action: manipulation; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.document-correction button:disabled { opacity: .5; cursor: default; }
.document-correction button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.document-correction button:enabled:active { background: var(--cv-accent-soft); color: var(--cv-accent-strong); border-color: var(--cv-border-strong); }
.correction-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex: none; }
.correction-header > div { min-width: 0; }
.correction-eyebrow { font-size: 12px; color: var(--cv-muted); line-height: 1.5; }
.correction-header h2 { font-size: 21px; font-weight: 650; line-height: 1.5; margin: 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.correction-close { flex: 0 0 44px; width: 44px; height: 44px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); font-size: 28px; color: var(--cv-secondary); }
.correction-instruction { font-size: 14px; line-height: 1.7; color: var(--cv-secondary); margin: 8px 0 12px; }
.correction-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; flex: none; }
.correction-tabs button { min-height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--cv-border); background: var(--cv-surface); color: var(--cv-secondary); font-size: 14px; }
.correction-tabs button.active { background: var(--cv-accent-soft); border-color: var(--cv-border-strong); color: var(--cv-accent-strong); font-weight: 600; }
.correction-stage { position: relative; min-height: 0; flex: 1; overflow: hidden; background: var(--cv-ink); border: 1px solid var(--cv-border); border-radius: 14px; }
.correction-stage.is-adjusting { touch-action: none; }
.correction-image { position: absolute; pointer-events: none; }
.correction-image :deep(canvas) { display: block; width: 100%; height: 100%; }
.correction-preview { display: block; position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.correction-overlay { position: absolute; inset: 0; pointer-events: none; }
.correction-area { fill: rgb(70 104 121 / .08); stroke: var(--cv-accent-soft); }
.correction-handle { position: absolute; width: 44px; height: 44px; transform: translate(-50%, -50%); display: grid; place-items: center; border: 0; background: transparent; padding: 0; touch-action: none !important; -webkit-tap-highlight-color: transparent; }
.correction-handle span { display: grid; place-items: center; width: 28px; height: 28px; border: 3px solid var(--cv-surface); border-radius: 50%; background: var(--cv-accent); color: var(--cv-surface); box-shadow: 0 2px 12px rgb(0 0 0 / .4); font-size: 13px; font-weight: 700; }
.correction-handle.selected span { background: var(--cv-accent-strong); outline: 2px solid var(--cv-surface); outline-offset: 3px; }
.document-correction .correction-handle:enabled:active { background: transparent; }
.document-correction .correction-handle:focus-visible { outline: 2px solid var(--cv-surface); border-radius: 50%; }
.correction-progress { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; background: rgb(36 49 61 / .88); color: var(--cv-surface); font-size: 14px; padding: 20px; }
.correction-progress button { min-height: 44px; border: 1px solid var(--cv-border); background: var(--cv-surface); border-radius: 10px; color: var(--cv-accent); padding: 0 14px; }
.correction-spinner { width: 18px; height: 18px; border: 2px solid rgb(255 255 255 / .3); border-top-color: var(--cv-surface); border-radius: 50%; animation: correction-spin 1s linear infinite; }
.correction-error { margin: 12px 0 0; color: var(--cv-danger); font-size: 14px; line-height: 1.6; flex: none; }
.correction-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 12px; flex: none; }
.correction-secondary, .correction-primary { min-height: 44px; padding: 10px 16px; border: 1px solid var(--cv-border); border-radius: 10px; background: var(--cv-surface); color: var(--cv-accent); font-size: 14px; line-height: 1.5; }
.correction-primary { background: var(--cv-accent); border-color: var(--cv-accent); color: var(--cv-surface); font-weight: 600; }
.document-correction .correction-primary:enabled:active { background: var(--cv-accent-strong); border-color: var(--cv-accent-strong); color: var(--cv-surface); }
@keyframes correction-spin { to { transform: rotate(360deg); } }
@media (max-width: 700px) { .document-correction { padding-right: max(12px, env(safe-area-inset-right)); padding-left: max(12px, env(safe-area-inset-left)); } .correction-footer button { flex: 1 1 auto; padding: 10px 12px; font-size: 13px; } .correction-header h2 { font-size: 18px; } }
@media (max-height: 550px) { .document-correction { padding-top: calc(env(safe-area-inset-top) + 8px); padding-bottom: calc(env(safe-area-inset-bottom) + 8px); } .correction-instruction { margin: 4px 0 8px; } .correction-tabs { margin-bottom: 8px; } .correction-footer { padding-top: 8px; } }
@media (prefers-reduced-motion: reduce) { .document-correction button { transition: none; } .correction-spinner { animation: none; } }
</style>
