<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { getOperationHistory, type OperationHistoryState } from '../services/reviewActions'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ scriptId: string; revisionKey: string; busy: boolean }>()
const emit = defineEmits<{ close: []; undo: []; redo: [] }>()
const history = ref<OperationHistoryState>({ undo: [], redo: [] })
const loading = ref(false), error = ref(''), dialog = ref<HTMLElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null)
const previouslyFocused = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
let sequence = 0
async function load() {
  const request = ++sequence, scriptId = props.scriptId
  loading.value = true; error.value = ''
  try { const value = await getOperationHistory(scriptId); if (request === sequence && props.scriptId === scriptId) history.value = value }
  catch (failure) { if (request === sequence) error.value = failure instanceof Error ? failure.message : '操作记录暂时无法读取' }
  finally { if (request === sequence) loading.value = false }
}
function dateLabel(value: string) {
  if (!value) return '从上个版本保留'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!props.busy) emit('close'); return }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])]
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus() }
}
watch(() => [props.scriptId, props.revisionKey], load, { immediate: true })
watch(() => props.busy, (busy, previous) => { if (previous && !busy) void load() })
onMounted(async () => { await nextTick(); (closeButton.value?.disabled ? dialog.value : closeButton.value)?.focus() })
onUnmounted(() => { sequence++; if (previouslyFocused?.isConnected) previouslyFocused.focus() })
</script>

<template>
  <Teleport to="body"><div class="modal-backdrop operation-history-backdrop" @click.self="!busy && emit('close')">
    <section ref="dialog" class="modal operation-history-dialog" role="dialog" aria-modal="true" aria-labelledby="operation-history-title" tabindex="-1" @keydown="keydown">
      <header class="modal-head"><div><h2 id="operation-history-title">操作历史</h2><p>最近 20 步 · 新修改会清空重做记录。</p></div><button ref="closeButton" :disabled="busy" aria-label="关闭操作历史" @click="emit('close')"><UiIcon name="close" :size="20" /></button></header>
      <p v-if="error" class="operation-history-error" role="alert">{{ error }}</p>
      <div class="operation-history-actions"><button class="secondary-button" :disabled="busy || loading || !history.undo.length" @click="emit('undo')">撤销一步<span v-if="history.undo[0]">{{ history.undo[0].label }}</span></button><button class="secondary-button" :disabled="busy || loading || !history.redo.length" @click="emit('redo')">重做一步<span v-if="history.redo[0]">{{ history.redo[0].label }}</span></button></div>
      <p v-if="loading" class="operation-history-status" role="status">正在读取操作历史…</p>
      <div v-else class="operation-history-columns">
        <section><header><h3>可以撤销</h3><span>{{ history.undo.length }} 步</span></header><ol v-if="history.undo.length"><li v-for="(entry, index) in history.undo" :key="entry.id" :class="{ next: index === 0 }"><span class="operation-history-number">{{ index + 1 }}</span><div><strong>{{ entry.label }}</strong><time>{{ dateLabel(entry.createdAt) }}</time></div><small v-if="index === 0">下一步</small></li></ol><p v-else class="operation-history-empty">还没有可以撤销的操作</p></section>
        <section><header><h3>可以重做</h3><span>{{ history.redo.length }} 步</span></header><ol v-if="history.redo.length"><li v-for="(entry, index) in history.redo" :key="entry.id" :class="{ next: index === 0 }"><span class="operation-history-number">{{ index + 1 }}</span><div><strong>{{ entry.label }}</strong><time>{{ dateLabel(entry.createdAt) }}</time></div><small v-if="index === 0">下一步</small></li></ol><p v-else class="operation-history-empty">撤销后，可在这里逐步重做</p></section>
      </div>
      <footer><span>关联资料已有后续修改时，会保留现状并提示。</span><button class="primary-button" :disabled="busy" @click="emit('close')">完成</button></footer>
    </section>
  </div></Teleport>
</template>

<style scoped>
.operation-history-backdrop{z-index:1350}.operation-history-dialog{width:min(800px,calc(100vw - 32px));max-height:calc(100dvh - 40px);display:flex;flex-direction:column;padding:22px;outline:none}.operation-history-dialog .modal-head p{font-size:12px;line-height:1.7;color:var(--cv-muted);margin:8px 0 0}.operation-history-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:22px 0 18px}.operation-history-actions button{display:flex;flex-direction:column;align-items:flex-start;gap:5px;text-align:left;min-width:0}.operation-history-actions button span{font-size: var(--cv-type-meta);font-weight:400;overflow-wrap:anywhere}.operation-history-columns{display:grid;grid-template-columns:1fr 1fr;gap:22px;overflow:auto;min-height:0;overscroll-behavior:contain}.operation-history-columns section{min-width:0}.operation-history-columns header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 2px 12px}.operation-history-columns h3{font-size:14px;color:#456343;margin:0}.operation-history-columns header>span{font-size: var(--cv-type-meta);color:var(--cv-muted)}.operation-history-columns ol{list-style:none;padding:0;margin:0}.operation-history-columns li{display:flex;align-items:center;gap:9px;padding:13px 9px;border-top:1px solid var(--cv-border)}.operation-history-columns li.next{border-radius: var(--cv-radius-control);background:var(--cv-accent-soft);border-top-color:transparent}.operation-history-number{display:grid;place-items:center;flex:0 0 24px;height:24px;border-radius:50%;background:var(--cv-accent-soft);color:var(--cv-muted);font-size: var(--cv-type-meta)}.operation-history-columns li>div{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}.operation-history-columns strong{font-size:12px;font-weight:600;color:var(--cv-ink);overflow-wrap:anywhere}.operation-history-columns time{font-size: var(--cv-type-meta);color:var(--cv-muted)}.operation-history-columns small{font-size: var(--cv-type-meta);flex-shrink:0;color:var(--cv-secondary)}.operation-history-empty,.operation-history-status{font-size:12px;line-height:1.8;color:var(--cv-muted);text-align:center;padding:35px 8px}.operation-history-error{padding:11px;border-radius: var(--cv-radius-control);background:var(--cv-warning-soft);color:var(--cv-warning);font-size:12px;line-height:1.8}.operation-history-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:18px;margin-top:15px;border-top:1px solid var(--cv-border)}.operation-history-dialog footer span{font-size: var(--cv-type-meta);color:var(--cv-muted);line-height:1.7}@media(max-width:600px){.operation-history-dialog{padding:18px;max-height:calc(100dvh - 28px)}.operation-history-columns{grid-template-columns:1fr;gap:18px}.operation-history-actions{gap:8px;margin-top:17px}.operation-history-dialog footer{align-items:flex-end}}

.operation-history-dialog { font-family: var(--cv-font); color: var(--cv-ink); }
.operation-history-dialog .modal-head > div { min-width: 0; overflow-wrap: anywhere; }
.operation-history-dialog button { min-height: var(--cv-control); transition: background-color var(--cv-motion-press) var(--cv-ease); touch-action: manipulation; }
.operation-history-dialog .modal-head > button { min-width: var(--cv-control); }
.operation-history-dialog button:not(:disabled):active { filter: brightness(.94); }
.operation-history-dialog button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.operation-history-columns strong { font-size: var(--cv-type-summary); line-height: var(--cv-leading-ui); }
.operation-history-dialog footer { flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) { .operation-history-dialog, .operation-history-dialog * { animation: none !important; transition: none !important; } }

</style>
