<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { getArchiveStatus, type ArchiveStatus } from '../services/vault'
import UiIcon from './UiIcon.vue'
const props = withDefaults(defineProps<{ scriptId: string; revisionKey: string; busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ export: [] }>()
const status = ref<ArchiveStatus | null>(null)
const loading = ref(false)
const failed = ref(false)
let sequence = 0
async function load() {
  const request = ++sequence, scriptId = props.scriptId
  loading.value = true; failed.value = false; status.value = null
  if (!scriptId) { loading.value = false; return }
  try {
    const result = await getArchiveStatus(scriptId)
    if (request === sequence && props.scriptId === scriptId) status.value = result
  } catch { if (request === sequence) failed.value = true }
  finally { if (request === sequence) loading.value = false }
}
function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}
watch(() => [props.scriptId, props.revisionKey], load, { immediate: true })
onUnmounted(() => { sequence += 1 })
</script>

<template>
  <section class="archive-status" aria-labelledby="archive-status-title" :aria-busy="loading">
    <header>
      <div class="archive-heading"><span class="archive-icon"><UiIcon name="archive" :size="20" /></span><div><h3 id="archive-status-title">档案导出</h3><p>档案生成后，仍需在系统面板中保存。</p></div></div>
      <button class="secondary-button archive-export" :disabled="busy || !scriptId" @click="emit('export')"><UiIcon name="download" :size="16" />{{ busy ? '处理中…' : status ? '重新导出' : '生成档案' }}</button>
    </header>
    <p v-if="loading" class="archive-message" role="status">正在读取档案状态…</p>
    <div v-else-if="failed" class="archive-message archive-retry"><span>档案状态加载失败</span><button :disabled="busy" @click="load">重试</button></div>
    <template v-else-if="status">
      <div class="archive-latest"><div><span class="archive-caption">最新档案</span><strong>{{ dateLabel(status.generatedAt) }} 已生成</strong></div><span class="archive-badge" :class="{ changed: status.changed }">{{ status.changed ? '有新修改，建议重新导出' : '内容与当前资料一致' }}</span></div>
      <p class="archive-filename">{{ status.fileName }}</p>
      <p class="archive-counts">{{ status.clueCount }} 条线索<span>·</span>{{ status.personCount }} 个人物<span>·</span>{{ status.eventCount }} 个时间节点<span>·</span>{{ status.noteCount }} 条笔记</p>
    </template>
    <p v-else class="archive-message">当前剧本尚未生成档案</p>
  </section>
</template>

<style scoped>
.archive-status{border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);background:var(--cv-surface);padding:20px;color:var(--cv-ink)}.archive-status header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.archive-heading{display:flex;align-items:center;gap:11px}.archive-icon{display:grid;place-items:center;width:38px;height:38px;border-radius: var(--cv-radius-control);background:var(--cv-accent-soft);color:var(--cv-accent);flex:none}.archive-heading h3{margin:0;font-size:15px}.archive-heading p{margin:5px 0 0;font-size: var(--cv-type-meta);line-height:1.6;color:var(--cv-muted)}.archive-export{display:flex;align-items:center;gap:7px;white-space:nowrap;font-size:12px;padding:10px 13px;min-height: var(--cv-control)}.archive-latest{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--cv-border)}.archive-latest>div{display:flex;flex-direction:column;gap:5px}.archive-caption{font-size: var(--cv-type-meta);color:var(--cv-muted)}.archive-latest strong{font-size:13px;font-weight:600}.archive-badge{font-size: var(--cv-type-meta);line-height:1.6;color:var(--cv-accent);background:var(--cv-accent-soft);border-radius:7px;padding:5px 8px}.archive-badge.changed{color:var(--cv-warning);background:var(--cv-warning-soft)}.archive-filename{margin:10px 0 7px;font-size: var(--cv-type-meta);color:var(--cv-muted);overflow-wrap:anywhere}.archive-counts{display:flex;flex-wrap:wrap;gap:7px;margin:0;font-size: var(--cv-type-meta);color:var(--cv-secondary);line-height:1.8}.archive-counts span{color:var(--cv-muted)}.archive-message{margin:18px 0 0;font-size:12px;line-height:1.8;color:var(--cv-muted)}.archive-retry{display:flex;align-items:center;gap:12px}.archive-retry button{color:var(--cv-secondary);background:none;border:0;font-size:12px;text-decoration:underline;padding:3px 6px}@media(max-width:600px){.archive-status{padding:16px}.archive-status header{align-items:center}.archive-heading p{max-width:200px}.archive-latest{align-items:flex-start;flex-direction:column}.archive-export{padding:9px 10px}}

.archive-status { font-family: var(--cv-font); background: var(--cv-surface); }
.archive-heading, .archive-heading > div, .archive-latest > div { min-width: 0; }
.archive-heading h3, .archive-heading p, .archive-latest strong, .archive-badge { overflow-wrap: anywhere; }
.archive-status button { min-height: var(--cv-control); transition: background-color var(--cv-motion-press) var(--cv-ease); touch-action: manipulation; }
.archive-status button:not(:disabled):active { filter: brightness(.94); }
.archive-status button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.archive-badge { line-height: var(--cv-leading-ui); }
.archive-retry { flex-wrap: wrap; }
@media (max-width: 480px) { .archive-status header { flex-wrap: wrap; } .archive-export { margin-left: auto; } }
@media (prefers-reduced-motion: reduce) { .archive-status, .archive-status * { animation: none !important; transition: none !important; } }

</style>
