<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ArchiveImportPreview } from '../services/vault'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ preview: ArchiveImportPreview; busy?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const counts = computed(() => [
  { label: '线索', count: props.preview.counts.clues }, { label: '人物', count: props.preview.counts.people },
  { label: '人物关系', count: props.preview.counts.relationships }, { label: '时间事件', count: props.preview.counts.events },
  { label: '笔记', count: props.preview.counts.notes }, { label: '整理板卡片', count: props.preview.counts.boardItems },
  { label: '照片', count: props.preview.counts.images }, { label: '手写标注', count: props.preview.counts.annotations },
  { label: '待确认建议', count: props.preview.counts.suggestions },
])
function close() { if (!props.busy) emit('close') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])]
  if (!controls.length) { event.preventDefault(); dialog.value?.focus(); return }
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { previousFocus = document.activeElement as HTMLElement | null; await nextTick(); dialog.value?.focus() })
onBeforeUnmount(() => { previousFocus?.focus() })
</script>
<template>
  <Teleport to="body"><div class="modal-backdrop archive-import-backdrop" @click.self="close">
    <section ref="dialog" class="modal archive-import-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-import-heading" tabindex="-1" :aria-busy="busy" @keydown="keydown">
      <header class="modal-head"><div><span class="archive-import-eyebrow">导入前预览</span><h2 id="archive-import-heading">{{ preview.scriptName || '无法识别剧本档案' }}</h2><p>{{ preview.fileName }}<span v-if="preview.playDate"> · {{ preview.playDate }}</span></p></div><button :disabled="busy" aria-label="关闭导入预览" @click="close"><UiIcon name="close" :size="20" /></button></header>
      <div class="archive-import-body">
        <p class="archive-import-note">导入容量：ZIP 最大 512 MiB，解压后总计最大 1 GiB，单张图片最大 64 MiB，清单最大 32 MiB；最多 5000 个文件。</p>
        <div v-if="preview.canImport" class="archive-import-success"><UiIcon name="check" :size="18" /><span>预检通过，可以导入为独立剧本。</span></div>
        <dl v-if="preview.canImport" class="archive-import-counts"><div v-for="item in counts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.count }}</dd></div></dl>
        <section v-if="preview.issues.length" class="archive-import-issues" role="alert"><h3>请先处理这些问题</h3><ul><li v-for="issue in preview.issues" :key="issue">{{ issue }}</li></ul><p>此次预检没有写入照片或剧本资料。</p></section>
        <section v-if="preview.warnings.length" class="archive-import-warnings"><h3>导入说明</h3><ul><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul></section>
        <p v-if="preview.canImport" class="archive-import-note">人物、时间线、整理板及出处随档案恢复。导入后的剧本拥有独立资料库，可在剧本管理中切换。</p>
      </div>
      <footer class="modal-actions"><button class="secondary-button" :disabled="busy" @click="close">{{ preview.canImport ? '取消' : '关闭预览' }}</button><button v-if="preview.canImport" class="primary-button" :disabled="busy || preview.issues.length > 0" @click="emit('confirm')">{{ busy ? '正在导入…' : '确认导入独立副本' }}</button></footer>
    </section>
  </div></Teleport>
</template>
<style scoped>
.archive-import-backdrop{z-index:1350;padding:16px}.archive-import-dialog{display:flex;flex-direction:column;width:min(600px,100%);max-height:calc(100dvh - 48px);padding:24px;outline:none}.archive-import-dialog .modal-head{align-items:flex-start;flex:none}.archive-import-eyebrow{display:block;margin-bottom:7px;font-size:11px;letter-spacing:1px;color:#9a8067}.archive-import-dialog h2{font-size:22px;margin:0;overflow-wrap:anywhere}.archive-import-dialog .modal-head p{font-size:12px;color:#849078;line-height:1.7;overflow-wrap:anywhere;margin:8px 0 0}.archive-import-body{min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:20px 0}.archive-import-success{display:flex;gap:8px;align-items:center;color:#41623b;font-size:13px;background:#edf3e7;padding:12px;border-radius:10px}.archive-import-counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#e4e9dd;border:1px solid #e4e9dd;border-radius:12px;overflow:hidden;margin:16px 0}.archive-import-counts div{padding:13px 15px;background:#fbfcf8}.archive-import-counts dt{font-size:11px;color:#87967c}.archive-import-counts dd{font-size:23px;font-weight:600;color:#47663c;margin:6px 0 0;font-variant-numeric:tabular-nums}.archive-import-issues,.archive-import-warnings{padding:14px;border-radius:10px;font-size:12px;line-height:1.8;overflow-wrap:anywhere}.archive-import-issues{background:#fbf0e9;color:#995c3b;border:1px solid #eed6c7}.archive-import-warnings{background:#f8f6ee;color:#8b7d60;border:1px solid #ece7d9;margin-top:14px}.archive-import-issues h3,.archive-import-warnings h3{font-size:13px;margin:0 0 6px}.archive-import-issues ul,.archive-import-warnings ul{margin:0;padding-left:17px}.archive-import-issues p{margin:8px 0 0}.archive-import-note{font-size:12px;color:#859377;line-height:1.8;margin:14px 0 0}.archive-import-dialog .modal-actions{flex:none;flex-wrap:wrap;border-top:1px solid #e7ebdf;padding-top:16px}@media(max-width:480px){.archive-import-dialog{padding:18px}.archive-import-counts div{padding:11px}.archive-import-counts dd{font-size:20px}.archive-import-dialog .modal-actions button{flex:1}}

.archive-import-eyebrow { color: var(--cv-accent); }
.archive-import-dialog .modal-head p, .archive-import-note { color: var(--cv-muted); }
.archive-import-success { border: 1px solid var(--cv-border); background: var(--cv-accent-soft); color: var(--cv-success); }
.archive-import-counts { border-color: var(--cv-border); background: var(--cv-border); }
.archive-import-counts div { background: var(--cv-surface-subtle); }
.archive-import-counts dt { color: var(--cv-muted); }
.archive-import-counts dd { color: var(--cv-ink); }
.archive-import-issues { border-color: color-mix(in srgb, var(--cv-danger) 22%, white); background: color-mix(in srgb, var(--cv-danger) 7%, white); color: var(--cv-danger); }
.archive-import-warnings { border-color: color-mix(in srgb, var(--cv-warning) 20%, white); background: var(--cv-warning-soft); color: var(--cv-warning); }
.archive-import-dialog .modal-actions { border-color: var(--cv-border); }
</style>
