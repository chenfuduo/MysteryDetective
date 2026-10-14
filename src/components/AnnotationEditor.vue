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
  <div class="modal-backdrop annotation-backdrop" @click.self="emit('close')"><div class="annotation-modal" role="dialog" aria-modal="true" aria-label="照片标注"><div class="annotation-head"><div><strong>照片标注</strong><span>原图不会被修改，笔迹单独保存</span></div><button title="关闭" @click="emit('close')"><UiIcon name="close" :size="20" /></button></div><div class="annotation-toolbar"><div class="annotation-colors"><button v-for="option in colors" :key="option" :class="{ active: color === option }" :style="{ '--swatch': option }" :title="`选择颜色 ${option}`" @click="color = option"></button></div><div class="annotation-divider"></div><label class="annotation-width">笔宽<input v-model.number="strokeWidth" type="range" min="2" max="12" /></label><div class="annotation-spacer"></div><button :disabled="!strokes.length" @click="undo">撤销</button><button :disabled="!undone.length" @click="redo">重做</button></div><div ref="shell" class="annotation-stage"><v-stage ref="stage" :config="{ width, height }" @pointerdown="start" @pointermove="move" @pointerup="end" @pointerleave="end" @touchstart="start" @touchmove="move" @touchend="end"><v-layer><v-rect :config="{ x: 0, y: 0, width, height, fill: '#f4f4ef' }" /><v-image v-if="imageConfig" :config="imageConfig" /><v-line v-for="(line, index) in drawnStrokes" :key="index" :config="line" /></v-layer></v-stage></div><div class="annotation-footer"><span>{{ strokes.length }} 笔标注</span><div><button class="secondary-button" @click="emit('close')">取消</button><button class="primary-button" :disabled="saving" @click="save">保存标注</button></div></div></div></div>
</template>
