<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { OcrRegion } from '../services/ocrLocation'
import { analyzePhotoQuality, clearPhotoQualityCache, type PhotoQualityReport } from '../services/photoQuality'

const props = defineProps<{ src: string; regions?: OcrRegion[]; busy?: boolean }>()
const emit = defineEmits<{ retake: []; correct: [] }>()
const report = ref<PhotoQualityReport | null>(null)
const checking = ref(false)
const error = ref('')
const expanded = ref(false)
const summary = computed(() => checking.value ? '正在本地检查照片…' : error.value ? '照片检查暂未完成' : report.value?.summary || '照片尚未载入')
let generation = 0
async function inspect() {
  const current = ++generation
  report.value = null
  error.value = ''
  if (!props.src) { checking.value = false; return }
  checking.value = true
  try {
    const result = await analyzePhotoQuality(props.src, props.regions || [])
    if (current === generation) report.value = result
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : '暂时无法检查，请重试'
  } finally {
    if (current === generation) checking.value = false
  }
}
function retry() { clearPhotoQualityCache(props.src); void inspect() }
watch(() => [props.src, props.regions] as const, () => { expanded.value = false; void inspect() }, { immediate: true })
onUnmounted(() => { generation++ })
</script>

<template>
  <section class="photo-quality-panel" :class="{ 'has-suggestions': report?.issues.length }" aria-label="照片质量辅助">
    <button class="quality-summary" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="quality-icon" aria-hidden="true">{{ checking ? '◌' : report?.issues.length ? '◈' : '◎' }}</span>
      <span class="quality-heading"><strong>{{ summary }}</strong><small>仅在设备本地检查</small></span>
      <span class="quality-chevron" :class="{ expanded }" aria-hidden="true">⌄</span>
    </button>
    <div v-if="expanded" class="quality-details">
      <p v-if="error" role="status">{{ error }} <button type="button" class="quality-retry" :disabled="checking" @click="retry">重试</button></p>
      <template v-else-if="report">
        <p class="quality-dimensions">原图 {{ report.width }} × {{ report.height }} 像素</p>
        <ul v-if="report.issues.length" class="quality-issues">
          <li v-for="issue in report.issues" :key="issue.kind"><strong>{{ issue.label }}</strong><p>{{ issue.detail }}</p></li>
        </ul>
        <p v-else>当前未发现明显的模糊、局部过亮或尺寸问题，仍可放大查看关键文字。</p>
        <p class="quality-method">依据照片边缘、亮度和原图尺寸估算，不代表 OCR 一定正确。{{ report.textAssessed ? '已结合已定位文字的大小检查。' : '暂无足够的文字定位，尚未判断文字是否过小。' }}</p>
      </template>
      <p v-else-if="checking" role="status">正在检查清晰度、亮度和图片尺寸，不会上传照片。</p>
      <div class="quality-actions">
        <button type="button" :disabled="busy || !src" @click="emit('retake')">重新拍摄</button>
        <button type="button" :disabled="busy || !src" @click="emit('correct')">四角校正</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.photo-quality-panel{color:#365447;background:#f4f7f3;border:1px solid #dfe7de;border-radius:14px;overflow:hidden;margin:12px 0}.photo-quality-panel.has-suggestions{background:#fcf8f2;border-color:#ead9c4}.quality-summary{width:100%;min-height:58px;display:flex;align-items:center;gap:10px;background:transparent;border:0;text-align:left;padding:10px 14px;color:inherit;cursor:pointer}.quality-icon{font-size:24px;flex-shrink:0}.has-suggestions .quality-icon{color:#a87249}.quality-heading{display:flex;flex:1;flex-direction:column;gap:3px}.quality-heading strong{font-size:13px;font-weight:650}.quality-heading small{font-size:11px;color:#7b897e}.quality-chevron{font-size:20px;transition:transform .18s ease}.quality-chevron.expanded{transform:rotate(180deg)}.quality-details{padding:0 14px 14px;font-size:13px;line-height:1.6}.quality-details>p{margin:8px 0}.quality-dimensions{font-variant-numeric:tabular-nums;color:#7a857d}.quality-issues{list-style:none;padding:0;margin:6px 0}.quality-issues li{padding:9px 0;border-top:1px solid #e9dfd3}.quality-issues strong{color:#97613b;font-weight:650}.quality-issues p{margin:4px 0 0}.quality-method{font-size:11px;color:#7a857d}.quality-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.quality-actions button,.quality-retry{min-height:44px;min-width:88px;background:#fff;border:1px solid #d4dfd5;color:#365f4b;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer}.quality-actions button:disabled,.quality-retry:disabled{opacity:.45;cursor:default}.quality-summary:focus-visible,.quality-actions button:focus-visible,.quality-retry:focus-visible{outline:2px solid #5d9271;outline-offset:-3px}@media(prefers-reduced-motion:reduce){.quality-chevron{transition:none}}
</style>
