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
    <p v-else class="archive-message">当前剧本尚未生成档案。可将照片和整理内容一起导出，方便自己留存。</p>
  </section>
</template>

<style scoped>
.archive-status{border:1px solid #e5eadf;border-radius:16px;background:#fcfdf9;padding:20px;color:#45633c}.archive-status header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.archive-heading{display:flex;align-items:center;gap:11px}.archive-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#edf3e7;color:#5b784c;flex:none}.archive-heading h3{margin:0;font-size:15px}.archive-heading p{margin:5px 0 0;font-size:11px;line-height:1.6;color:#8a977e}.archive-export{display:flex;align-items:center;gap:7px;white-space:nowrap;font-size:12px;padding:10px 13px;min-height:40px}.archive-latest{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid #e9ede4}.archive-latest>div{display:flex;flex-direction:column;gap:5px}.archive-caption{font-size:10px;color:#8c997f}.archive-latest strong{font-size:13px;font-weight:600}.archive-badge{font-size:10px;line-height:1.6;color:#688453;background:#eef4e8;border-radius:7px;padding:5px 8px}.archive-badge.changed{color:#a87548;background:#faf0e3}.archive-filename{margin:10px 0 7px;font-size:11px;color:#87947b;overflow-wrap:anywhere}.archive-counts{display:flex;flex-wrap:wrap;gap:7px;margin:0;font-size:11px;color:#7f8f73;line-height:1.8}.archive-counts span{color:#c1cbb7}.archive-message{margin:18px 0 0;font-size:12px;line-height:1.8;color:#87947b}.archive-retry{display:flex;align-items:center;gap:12px}.archive-retry button{color:#547348;background:none;border:0;font-size:12px;text-decoration:underline;padding:3px 6px}@media(max-width:600px){.archive-status{padding:16px}.archive-status header{align-items:center}.archive-heading p{max-width:200px}.archive-latest{align-items:flex-start;flex-direction:column}.archive-export{padding:9px 10px}}
</style>
