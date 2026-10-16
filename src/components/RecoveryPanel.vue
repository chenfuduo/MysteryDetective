<script setup lang="ts">
import { ref, watch } from 'vue'
import { listTrash, restoreTrash } from '../services/vault'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ scriptId: string }>()
const emit = defineEmits<{ close: []; restored: [] }>()
const entries = ref<Awaited<ReturnType<typeof listTrash>>>([]), loading = ref(false), restoring = ref(''), error = ref('')
let sequence = 0
async function load() {
  const request = ++sequence, scriptId = props.scriptId; loading.value = true; error.value = ''
  try { const value = await listTrash(scriptId); if (request === sequence && props.scriptId === scriptId) entries.value = value }
  catch (failure) { if (request === sequence) error.value = failure instanceof Error ? failure.message : '回收站暂不可用' }
  finally { if (request === sequence) loading.value = false }
}
async function restore(id: string) {
  if (restoring.value) return
  restoring.value = id; error.value = ''
  try { await restoreTrash(props.scriptId, id); await load(); emit('restored') }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '恢复未完成，请保留回收记录稍后重试' }
  finally { restoring.value = '' }
}
watch(() => props.scriptId, load, { immediate: true })
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
</script>
<template><Teleport to="body"><div class="modal-backdrop recovery-backdrop" @click.self="!restoring && emit('close')"><section class="modal recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-heading" @keydown.esc.stop="!restoring && emit('close')"><header class="modal-head"><div><h2 id="recovery-heading">回收站与恢复</h2><p>仅显示当前剧本。照片及相关记录保留在本机，恢复时会检查后续修改。</p></div><button :disabled="Boolean(restoring)" aria-label="关闭回收站" @click="emit('close')"><UiIcon name="close" :size="20" /></button></header><p v-if="error" class="recovery-error" role="alert">{{ error }}</p><p v-if="loading" class="recovery-empty" role="status">正在读取回收记录…</p><div v-else-if="entries.length" class="recovery-list"><article v-for="entry in entries" :key="entry.id"><div><strong>{{ entry.label }}</strong><span>{{ dateLabel(entry.deletedAt) }}</span></div><button class="secondary-button" :disabled="Boolean(restoring)" @click="restore(entry.id)">{{ restoring === entry.id ? '恢复中…' : '恢复线索及关联' }}</button></article></div><div v-else class="recovery-empty"><UiIcon name="archive" :size="30" /><strong>回收站为空</strong><span>本轮开始删除的线索会保留在这里。</span></div><footer><button class="secondary-button" :disabled="Boolean(restoring)" @click="load">刷新</button><button class="primary-button" :disabled="Boolean(restoring)" @click="emit('close')">完成</button></footer></section></div></Teleport></template>
<style scoped>
.recovery-backdrop{z-index:1350}.recovery-dialog{width:min(640px,calc(100vw - 32px));padding:22px}.recovery-dialog .modal-head p{font-size:12px;line-height:1.8;color:#8b977e;margin:9px 0 0;max-width:470px}.recovery-list{display:flex;flex-direction:column}.recovery-list article{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 0;border-top:1px solid #edf0e6}.recovery-list article>div{display:flex;flex-direction:column;gap:6px;min-width:0}.recovery-list strong{font-size:14px;color:#4b6940;overflow-wrap:anywhere}.recovery-list span{font-size:11px;color:#94a087}.recovery-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.recovery-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:45px 15px;color:#96a187;font-size:12px;text-align:center}.recovery-empty strong{font-size:15px;color:#677e57}.recovery-error{padding:12px;border-radius:9px;background:#fff4e7;color:#ad7650;font-size:12px;line-height:1.8}@media(max-width:600px){.recovery-list article{align-items:flex-start;flex-direction:column}.recovery-list button{align-self:flex-end}}

.recovery-dialog .modal-head p { color: var(--cv-muted); }
.recovery-list article { border-color: var(--cv-border); }
.recovery-list strong { color: var(--cv-ink); }
.recovery-list span, .recovery-empty { color: var(--cv-muted); }
.recovery-empty strong { color: var(--cv-secondary); }
.recovery-error { background: var(--cv-warning-soft); color: var(--cv-warning); }
</style>
