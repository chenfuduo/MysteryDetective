<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import { getAnnotation, saveAnnotation } from '../services/vault'

interface Stroke { points: number[]; color: string; width: number }
const props = defineProps<{ clueId: string; imageUrl: string; rotation: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const shell = ref<HTMLElement | null>(null)
const stage = ref<any>(null)
const width = ref(800)
const height = ref(520)
const loadedImage = ref<HTMLImageElement | null>(null)
const strokes = ref<Stroke[]>([])
const undone = ref<Stroke[]>([])
const current = ref<Stroke | null>(null)
const color = ref('#dc6548')
const strokeWidth = ref(3)
const saving = ref(false)
const colors = ['#dc6548', '#e5b13e', '#3986b5', '#4e8f72', '#2a2b2c']
let resizeObserver: ResizeObserver | null = null
const imageConfig = computed(() => {
  if (!loadedImage.value) return null
  const naturalWidth = loadedImage.value.naturalWidth
  const naturalHeight = loadedImage.value.naturalHeight
  const rotated = props.rotation % 180 !== 0
  const sourceWidth = rotated ? naturalHeight : naturalWidth
  const sourceHeight = rotated ? naturalWidth : naturalHeight
  const scale = Math.min(width.value / sourceWidth, height.value / sourceHeight)
  return {
    image: loadedImage.value,
    x: width.value / 2,
    y: height.value / 2,
    width: naturalWidth * scale,
    height: naturalHeight * scale,
    offsetX: naturalWidth * scale / 2,
    offsetY: naturalHeight * scale / 2,
    rotation: props.rotation,
  }
})
const drawnStrokes = computed(() => [...strokes.value, ...(current.value ? [current.value] : [])].map(stroke => ({
  points: stroke.points.map((point, index) => point * (index % 2 ? height.value : width.value)),
  stroke: stroke.color, strokeWidth: stroke.width, lineCap: 'round', lineJoin: 'round', tension: .12,
})))
function resize() {
  if (!shell.value) return
  width.value = Math.max(280, Math.round(shell.value.clientWidth))
  height.value = Math.max(240, Math.round(shell.value.clientHeight))
}
function point() {
  const position = stage.value?.getNode()?.getPointerPosition()
  if (!position) return null
  return [Math.max(0, Math.min(1, position.x / width.value)), Math.max(0, Math.min(1, position.y / height.value))]
}
function start() {
  const next = point()
  if (!next) return
  current.value = { points: next, color: color.value, width: strokeWidth.value }
  undone.value = []
}
function move() {
  if (!current.value) return
  const next = point()
  if (!next) return
  current.value = { ...current.value, points: [...current.value.points, ...next] }
}
function end() {
  if (!current.value) return
  if (current.value.points.length === 2) current.value.points.push(...current.value.points)
  strokes.value = [...strokes.value, current.value]
  current.value = null
}
function undo() {
  if (!strokes.value.length) return
  undone.value = [...undone.value, strokes.value[strokes.value.length - 1]]
  strokes.value = strokes.value.slice(0, -1)
}
function redo() {
  if (!undone.value.length) return
  strokes.value = [...strokes.value, undone.value[undone.value.length - 1]]
  undone.value = undone.value.slice(0, -1)
}
async function save() {
  saving.value = true
  try { await saveAnnotation(props.clueId, strokes.value); emit('saved') }
  finally { saving.value = false }
}
watch(() => props.imageUrl, value => {
  if (!value) return
  const image = new Image()
  image.onload = () => { loadedImage.value = image }
  image.src = value
}, { immediate: true })
onMounted(async () => {
  try { const record = await getAnnotation(props.clueId); strokes.value = Array.isArray(record?.strokes) ? record.strokes as Stroke[] : [] } catch { strokes.value = [] }
  await nextTick(); resize()
  if (shell.value) { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(shell.value) }
})
onUnmounted(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="modal-backdrop annotation-backdrop" @click.self="emit('close')"><div class="annotation-modal" role="dialog" aria-modal="true" aria-label="照片标注"><div class="annotation-head"><div><strong>照片标注</strong></div><button type="button" title="关闭" aria-label="关闭照片标注" @click="emit('close')"><UiIcon name="close" :size="20" /></button></div><div class="annotation-toolbar"><div class="annotation-colors"><button type="button" v-for="(option, index) in colors" :key="option" :class="{ active: color === option }" :style="{ '--swatch': option }" :title="`选择${['红色', '黄色', '蓝色', '绿色', '黑色'][index]}画笔`" :aria-label="`选择${['红色', '黄色', '蓝色', '绿色', '黑色'][index]}画笔`" :aria-pressed="color === option" @click="color = option"></button></div><div class="annotation-divider"></div><label class="annotation-width">笔宽<input v-model.number="strokeWidth" type="range" min="2" max="12" /></label><div class="annotation-spacer"></div><button type="button" :disabled="!strokes.length" @click="undo">撤销</button><button type="button" :disabled="!undone.length" @click="redo">重做</button></div><div ref="shell" class="annotation-stage"><v-stage ref="stage" :config="{ width, height }" @pointerdown="start" @pointermove="move" @pointerup="end" @pointerleave="end" @touchstart="start" @touchmove="move" @touchend="end"><v-layer><v-rect :config="{ x: 0, y: 0, width, height, fill: '#f5f7f9' }" /><v-image v-if="imageConfig" :config="imageConfig" /><v-line v-for="(line, index) in drawnStrokes" :key="index" :config="line" /></v-layer></v-stage></div><div class="annotation-footer"><span>{{ strokes.length }} 笔标注</span><div><button type="button" class="secondary-button" @click="emit('close')">取消</button><button type="button" class="primary-button" :disabled="saving" @click="save">{{ saving ? '正在保存…' : '保存标注' }}</button></div></div></div></div>
</template>
<style scoped>
.annotation-backdrop { padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
.annotation-modal { min-width: 0; border: 1px solid var(--cv-border); border-radius: 14px; background: var(--cv-surface); color: var(--cv-ink); font-family: var(--cv-font); box-shadow: 0 16px 48px rgb(36 49 61 / .16); }
.annotation-modal :where(button) { min-width: 44px; min-height: 44px; border-radius: 10px; color: var(--cv-accent); font: inherit; font-size: 14px; cursor: pointer; touch-action: manipulation; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.annotation-modal button:focus-visible, .annotation-width input:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.annotation-modal button:disabled { background: var(--cv-surface-subtle); color: var(--cv-muted); opacity: .55; cursor: default; }
.annotation-modal button:enabled:active { background: var(--cv-accent-soft); color: var(--cv-accent-strong); border-color: var(--cv-border-strong); }
.annotation-head { min-width: 0; padding: 16px 20px; border-bottom: 1px solid var(--cv-border); }
.annotation-head strong { font-size: 18px; font-weight: 650; line-height: 1.5; }
.annotation-head > button { display: grid; flex: 0 0 44px; place-items: center; padding: 0; border: 0; background: transparent; color: var(--cv-secondary); }
.annotation-toolbar { flex-wrap: wrap; gap: 8px 12px; padding: 12px 20px; border-bottom: 1px solid var(--cv-border); background: var(--cv-surface); }
.annotation-colors { display: flex; flex-wrap: wrap; gap: 8px; }
.annotation-modal .annotation-colors button { position: relative; width: 44px; height: 44px; padding: 0; border: 1px solid transparent; border-radius: 10px; background: transparent; }
.annotation-colors button::before { content: ''; position: absolute; inset: 10px; border: 1px solid rgb(36 49 61 / .18); border-radius: 50%; background: var(--swatch); }
.annotation-modal .annotation-colors button.active { border: 2px solid var(--cv-accent); background: var(--cv-accent-soft); box-shadow: none; }
.annotation-colors button.active::after { content: '✓'; position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 15px; font-weight: 700; text-shadow: 0 1px 2px rgb(0 0 0 / .7); }
.annotation-divider { align-self: stretch; background: var(--cv-border); }
.annotation-width { display: flex; align-items: center; gap: 8px; min-height: 44px; color: var(--cv-secondary); font-size: 13px; }
.annotation-width input { min-height: 44px; width: clamp(80px, 12vw, 150px); margin: 0; accent-color: var(--cv-accent); cursor: pointer; }
.annotation-toolbar > button { padding: 0 12px; border: 1px solid var(--cv-border); background: var(--cv-surface); }
.annotation-stage { min-width: 0; background: var(--cv-canvas); }
.annotation-footer { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--cv-border); background: var(--cv-surface); }
.annotation-footer > span { color: var(--cv-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.annotation-footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.annotation-footer .secondary-button { padding: 0 16px; border: 1px solid var(--cv-border); background: var(--cv-surface); color: var(--cv-accent); }
.annotation-footer .primary-button { min-width: 104px; padding: 0 16px; border: 1px solid var(--cv-accent); background: var(--cv-accent); color: var(--cv-surface); }
.annotation-modal .primary-button:enabled:active { border-color: var(--cv-accent-strong); background: var(--cv-accent-strong); color: var(--cv-surface); }
@media (max-width: 700px) { .annotation-head, .annotation-toolbar, .annotation-footer { padding-inline: 14px; } .annotation-divider { display: none; } .annotation-spacer { flex-basis: 0; } .annotation-footer { align-items: center; } .annotation-footer > div { margin-left: auto; } }
@media (prefers-reduced-motion: reduce) { .annotation-modal button { transition: none; } }
</style>
