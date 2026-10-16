<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { previewPersonMerge, type PersonMergePreview } from '../services/personMerge'
import type { PersonRecord } from '../services/vault'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ scriptId: string; sourceId: string; people: PersonRecord[]; busy?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [sourceId: string, targetId: string] }>()
const targetId = ref(''), preview = ref<PersonMergePreview | null>(null), loading = ref(false), error = ref('')
const select = ref<HTMLSelectElement | null>(null)
const source = computed(() => props.people.find(person => person.scriptId === props.scriptId && person.id === props.sourceId))
const targets = computed(() => props.people.filter(person => person.scriptId === props.scriptId && person.id !== props.sourceId))
const aliases = computed(() => preview.value ? [...new Set([preview.value.source.name, ...preview.value.source.aliases, ...preview.value.target.aliases])].filter(name => name !== preview.value?.target.name) : [])
let request = 0
watch(() => [props.scriptId, props.sourceId], async () => { request++; targetId.value = ''; preview.value = null; error.value = ''; await nextTick(); select.value?.focus() }, { immediate: true })
watch(targetId, async id => {
  const current = ++request; preview.value = null; error.value = ''
  if (!id) { loading.value = false; return }
  loading.value = true
  try { const value = await previewPersonMerge(props.scriptId, props.sourceId, id); if (request === current) preview.value = value }
  catch (failure) { if (request === current) error.value = failure instanceof Error ? failure.message : '无法生成合并预览' }
  finally { if (request === current) loading.value = false }
})
onBeforeUnmount(() => { request++ })
</script>
<template>
  <Teleport to="body"><div class="modal-backdrop person-merge-backdrop" @click.self="!busy && emit('close')"><section class="modal compact-modal person-merge-dialog" role="dialog" aria-modal="true" aria-labelledby="person-merge-heading" @keydown.esc.stop="!busy && emit('close')"><header class="modal-head"><div><h2 id="person-merge-heading">合并同一人物</h2><p>{{ source?.name || '原人物' }} 的记录将迁移到你选定的人物。</p></div><button :disabled="busy" aria-label="关闭合并预览" @click="emit('close')"><UiIcon name="close" :size="19" /></button></header><div class="form-stack"><label>保留哪位人物的主姓名<select ref="select" v-model="targetId" :disabled="busy"><option value="">选择同一人物的另一份档案</option><option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }}</option></select></label><p v-if="loading" role="status">正在生成关联迁移预览…</p><p v-if="error" class="merge-error" role="alert">{{ error }}</p><section v-if="preview" class="person-merge-preview"><h3>保留 {{ preview.target.name }}</h3><p v-if="aliases.length">以下写法保留为别名：{{ aliases.join('、') }}</p><dl><dt>事件</dt><dd>{{ preview.eventCount }} 条</dd><dt>关系</dt><dd>{{ preview.relationshipCount }} 条</dd><dt>关联线索</dt><dd>{{ preview.clueCount }} 条</dd><dt>笔记</dt><dd>{{ preview.noteCount }} 条</dd><dt>人物板卡</dt><dd>{{ preview.boardCount }} 张</dd></dl><p>确认后迁移关联、合并别名和说明，去掉自连线与完全重复关系。原始线索文字保留，合并可在重启后撤销。</p></section></div><footer class="modal-actions"><button class="secondary-button" :disabled="busy" @click="emit('close')">取消</button><button class="primary-button" :disabled="busy || loading || !preview" @click="emit('confirm', sourceId, targetId)">{{ busy ? '合并中…' : '确认是同一人物并合并' }}</button></footer></section></div></Teleport>
</template>
<style scoped>
.person-merge-backdrop{z-index:1350}.person-merge-dialog{width:min(470px,calc(100vw - 32px));padding:22px}.person-merge-dialog .modal-head p{font-size:12px;line-height:1.7;color:#8a957f;margin:8px 0 0}.person-merge-preview{padding:15px;border:1px solid #e0e7d9;border-radius:11px;background:#f8faf4}.person-merge-preview h3{font-size:15px;color:#41623b;margin:0 0 8px}.person-merge-preview p{font-size:12px;line-height:1.8;color:#88967b;margin:7px 0}.person-merge-preview dl{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px}.person-merge-preview dt{color:#849276}.person-merge-preview dd{margin:0;text-align:right;color:#4f6a40}.merge-error{font-size:12px;color:#ad6b4a}.person-merge-dialog .modal-actions{flex-wrap:wrap}

.person-merge-dialog .modal-head p { color: var(--cv-muted); }
.person-merge-preview { border-color: var(--cv-border); background: var(--cv-surface-subtle); }
.person-merge-preview h3 { color: var(--cv-accent-strong); }
.person-merge-preview p { color: var(--cv-muted); }
.person-merge-preview dt { color: var(--cv-secondary); }
.person-merge-preview dd { color: var(--cv-ink); }
.merge-error { color: var(--cv-danger); }
</style>
