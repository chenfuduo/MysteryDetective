<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import ClueThumbnail from './ClueThumbnail.vue'
import { getLocalState, saveLocalState, type ClueRecord, type PersonRecord, type TimelineRecord } from '../services/vault'
const props = defineProps<{ scriptId: string; clues: ClueRecord[]; events: TimelineRecord[]; people: PersonRecord[]; imageUrls: Record<string, string>; initialClueIds?: string[]; initialEventIds?: string[]; busy?: boolean }>()
const emit = defineEmits<{ 'open-clue': [id: string, quote?: string]; 'merge-events': [sourceId: string, targetId: string] }>()
const kind = ref<'events' | 'clues'>('events')
const leftId = ref(''), rightId = ref('')
const status = ref<'pending' | 'checked'>('pending'), note = ref(''), message = ref('')
const loading = ref(true)
let restoringView = true, sequence = 0
let saveQueue: Promise<void> = Promise.resolve()
const clues = computed(() => props.clues.filter(item => item.scriptId === props.scriptId))
const events = computed(() => props.events.filter(item => item.scriptId === props.scriptId && item.confirmed))
const people = computed(() => props.people.filter(item => item.scriptId === props.scriptId))
const options = computed(() => kind.value === 'events' ? events.value.map(item => ({ id: item.id, label: `${item.startsAt} · ${item.title}` })) : clues.value.map(item => ({ id: item.id, label: `#${String(item.number).padStart(3, '0')} ${item.title}` })))
function dateLabel(value: string) { return value.replace(/^--/, '无年份 · ').replace('T', ' ') }
function sourceFor(event: TimelineRecord) {
  const sources = (event.evidence || []).filter(item => clues.value.some(clue => clue.id === item.clueId && clue.number === item.sourceNo))
  const clue = clues.value.find(clue => clue.id === event.clueId)
  return clue && !sources.some(item => item.clueId === clue.id) ? [{ clueId: clue.id, sourceNo: clue.number, quote: '' }, ...sources] : sources
}
function record(id: string) {
  if (kind.value === 'clues') {
    const clue = clues.value.find(item => item.id === id)
    if (!clue) return null
    return { id, title: clue.title, time: '以 OCR 原文记载为准', names: people.value.filter(person => [person.name, ...person.aliases].some(name => name && clue.ocrText.includes(name))).map(person => person.name).join('、') || '未匹配到已建档人物', text: clue.ocrText, imagePath: clue.displayImagePath || clue.imagePath, rotation: clue.rotation, sources: [{ clueId: clue.id, sourceNo: clue.number, quote: clue.ocrText.slice(0, 600) }], precision: `第 ${clue.round} 轮 · ${clue.category || '未分类'}` }
  }
  const event = events.value.find(item => item.id === id)
  if (!event) return null
  const sources = sourceFor(event)
  return { id, title: event.title, time: dateLabel(event.startsAt), names: event.personIds.map(id => people.value.find(person => person.id === id)?.name).filter(Boolean).join('、') || '未关联已建档人物', text: sources.map(source => source.quote || clues.value.find(clue => clue.id === source.clueId)?.ocrText || '').filter(Boolean).join('\n\n'), imagePath: '', rotation: 0, sources, precision: `${event.approximate ? '约时 · ' : ''}${event.precision === 'date' ? '仅日期' : event.precision === 'hour' ? '到小时' : /T\d{2}:\d{2}/.test(event.startsAt) ? '到分钟' : /T\d{2}/.test(event.startsAt) ? '到小时' : '仅日期'}` }
}
const left = computed(() => record(leftId.value)), right = computed(() => record(rightId.value))
const canMerge = computed(() => kind.value === 'events' && leftId.value !== rightId.value && Boolean(left.value && right.value) && events.value.find(item => item.id === leftId.value)?.startsAt === events.value.find(item => item.id === rightId.value)?.startsAt)
const pairKey = () => leftId.value && rightId.value && leftId.value !== rightId.value ? `comparison:${kind.value}:${[leftId.value, rightId.value].sort().join(':')}` : ''
async function loadPair() {
  const request = ++sequence, scriptId = props.scriptId, key = pairKey()
  loading.value = true; status.value = 'pending'; note.value = ''; message.value = ''
  try {
    const saved = key ? await getLocalState<{ status: 'pending' | 'checked'; note: string }>(scriptId, key) : null
    if (request !== sequence || scriptId !== props.scriptId) return
    if (saved) { status.value = saved.status === 'checked' ? 'checked' : 'pending'; note.value = saved.note || '' }
    await saveLocalState(scriptId, 'comparison-view', { kind: kind.value, leftId: leftId.value, rightId: rightId.value })
  } catch { if (request === sequence) message.value = '对照标记暂未保存，请稍后重试' }
  finally { if (request === sequence) loading.value = false }
}
function chooseDefaults(ids: string[] = []) {
  const available = options.value.map(item => item.id)
  leftId.value = ids.find(id => available.includes(id)) || available[0] || ''
  rightId.value = ids.find(id => id !== leftId.value && available.includes(id)) || available.find(id => id !== leftId.value) || ''
}
watch(() => props.scriptId, async scriptId => {
  const request = ++sequence; loading.value = true; restoringView = true
  try {
    const saved = await getLocalState<{ kind: 'events' | 'clues'; leftId: string; rightId: string }>(scriptId, 'comparison-view')
    if (request !== sequence || scriptId !== props.scriptId) return
    const eventIds = props.initialEventIds || [], clueIds = props.initialClueIds || []
    kind.value = eventIds.length ? 'events' : clueIds.length ? 'clues' : saved?.kind || 'events'
    chooseDefaults(eventIds.length ? eventIds : clueIds.length ? clueIds : [saved?.leftId || '', saved?.rightId || ''])
    await loadPair()
    restoringView = false
  } catch { restoringView = false; message.value = '未能恢复上次对照'; loading.value = false }
}, { immediate: true })
watch([kind, leftId, rightId], () => { if (!restoringView) void loadPair() })
watch(() => kind.value, () => { if (!restoringView) chooseDefaults() })
watch(() => options.value.map(item => item.id).join('|'), () => { if (!restoringView && (!options.value.some(item => item.id === leftId.value) || !options.value.some(item => item.id === rightId.value))) chooseDefaults([leftId.value, rightId.value]) })
watch([status, note], () => {
  const key = pairKey()
  if (loading.value || !key) return
  const value = { status: status.value, note: note.value, updatedAt: new Date().toISOString() }
  const scriptId = props.scriptId, request = sequence
  saveQueue = saveQueue.catch(() => {}).then(() => saveLocalState(scriptId, key, value)).then(() => { if (request === sequence) message.value = '核对标记已保存' }).catch(() => { if (request === sequence) message.value = '标记未保存，请稍后重试' })
})
</script>

<template>
  <section class="record-comparison">
    <div class="comparison-toolbar"><div class="comparison-switch"><button type="button" :class="{ active: kind === 'events' }" :aria-pressed="kind === 'events'" @click="kind = 'events'">对照事件</button><button type="button" :class="{ active: kind === 'clues' }" :aria-pressed="kind === 'clues'" @click="kind = 'clues'">对照线索</button></div></div>
    <div class="comparison-selectors"><label>左侧记录<select v-model="leftId"><option value="">选择记录</option><option v-for="item in options" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label>右侧记录<select v-model="rightId"><option value="">选择记录</option><option v-for="item in options" :key="item.id" :value="item.id" :disabled="item.id === leftId">{{ item.label }}</option></select></label></div>
    <div v-if="leftId === rightId && leftId" class="comparison-empty">请选择两条不同记录。</div>
    <div v-else-if="left && right" class="comparison-records"><article v-for="(item, index) in [left, right]" :key="index"><header><small>{{ index ? '右侧' : '左侧' }}记录</small><h2>{{ item.title }}</h2><span>{{ item.precision }}</span></header><dl><dt>时间</dt><dd :class="{ different: left.time !== right.time }"><span>{{ item.time }}</span><span v-if="left.time !== right.time" class="difference-label"><span aria-hidden="true">≠</span>时间不同</span></dd><dt>人物</dt><dd :class="{ different: left.names !== right.names }"><span>{{ item.names }}</span><span v-if="left.names !== right.names" class="difference-label"><span aria-hidden="true">≠</span>人物不同</span></dd></dl><div v-if="item.imagePath" class="comparison-photo" @click="emit('open-clue', item.id)"><ClueThumbnail fit="contain" :path="item.imagePath" :rotation="item.rotation" :alt="item.title" /><button type="button" :aria-label="`查看${item.title}原始照片`" @click.stop="emit('open-clue', item.id)">查看原始照片</button></div><section class="comparison-original"><strong>原文记载</strong><p>{{ item.text || '暂无 OCR 原文，请打开原始照片核对。' }}</p></section><div class="comparison-sources"><button v-for="(source, at) in item.sources" :key="`${source.clueId}:${at}`" @click="emit('open-clue', source.clueId, source.quote)"><UiIcon name="image" :size="16" />原线索 #{{ String(source.sourceNo).padStart(3, '0') }}</button></div></article></div>
    <div v-else class="comparison-empty">选择两条事件或线索，即可并排核对人物、时间和原文。</div>
    <section v-if="left && right && leftId !== rightId" class="comparison-review"><label>人工核对状态<select v-model="status" :disabled="loading"><option value="pending">待核对</option><option value="checked">已核对</option></select></label><label class="comparison-note">核对备注<textarea v-model="note" :disabled="loading" rows="2" placeholder="填写核对备注"></textarea></label><span role="status">{{ message }}</span><button v-if="canMerge" class="secondary-button" :disabled="busy" @click="emit('merge-events', rightId, leftId)">确认是同一事件，合并到左侧</button></section>
  </section>
</template>

<style scoped>
.record-comparison {
  display: flex;
  flex-direction: column;
  gap: var(--cv-space-4);
  min-width: 0;
  color: var(--cv-ink);
  font-family: var(--cv-font);
}
.record-comparison :is(button, select, textarea) { font: inherit; touch-action: manipulation; }
.record-comparison button { cursor: pointer; transition: color var(--cv-motion-press) var(--cv-ease), background-color var(--cv-motion-press) var(--cv-ease), border-color var(--cv-motion-press) var(--cv-ease); }
.record-comparison button:active:not(:disabled) { background: var(--cv-accent-soft); color: var(--cv-accent-strong); }
.record-comparison :is(button, select, textarea):focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.comparison-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--cv-space-3); }
.comparison-toolbar > span { color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: var(--cv-leading-reading); }
.comparison-switch { display: flex; flex: none; gap: var(--cv-space-1); padding: var(--cv-space-1); border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface-subtle); }
.comparison-switch button { min-height: var(--cv-control); padding: 0 var(--cv-space-3); border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--cv-secondary); font-size: var(--cv-type-meta); font-weight: 550; }
.comparison-switch button.active { border-color: var(--cv-border); background: var(--cv-surface); color: var(--cv-accent-strong); }
.comparison-selectors,
.comparison-records { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--cv-space-4); }
.comparison-selectors label,
.comparison-review label { display: flex; flex-direction: column; gap: var(--cv-space-2); min-width: 0; color: var(--cv-secondary); font-size: var(--cv-type-meta); line-height: var(--cv-leading-ui); }
.comparison-selectors select,
.comparison-review select,
.comparison-review textarea {
  width: 100%;
  min-height: var(--cv-control);
  padding: var(--cv-space-2) var(--cv-space-3);
  border: 1px solid var(--cv-border);
  border-radius: var(--cv-radius-control);
  background: var(--cv-surface);
  color: var(--cv-ink);
  font-size: var(--cv-type-input);
}
.comparison-selectors select:focus-visible,
.comparison-review :is(select, textarea):focus-visible { border-color: var(--cv-focus); }
.comparison-records > article { min-width: 0; overflow: hidden; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); }
.comparison-records header { padding: var(--cv-space-4) var(--cv-space-4) var(--cv-space-3); border-bottom: 1px solid var(--cv-border); }
.comparison-records header small { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.comparison-records h2 { margin: var(--cv-space-2) 0; color: var(--cv-ink); font-size: var(--cv-type-title); font-weight: 600; line-height: var(--cv-leading-reading); overflow-wrap: anywhere; }
.comparison-records header > span { color: var(--cv-secondary); font-size: var(--cv-type-meta); }
.comparison-records dl { display: grid; grid-template-columns: minmax(40px, auto) minmax(0, 1fr); gap: var(--cv-space-2) var(--cv-space-3); margin: 0; padding: var(--cv-space-4); color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); }
.comparison-records dt { color: var(--cv-muted); }
.comparison-records dd { min-width: 0; margin: 0; color: var(--cv-ink); overflow-wrap: anywhere; }
.comparison-records .different { padding: var(--cv-space-2); border-radius: var(--cv-radius-tag); background: var(--cv-warning-soft); color: var(--cv-warning); }
.difference-label { display: inline-flex; align-items: center; gap: var(--cv-space-1); margin-left: var(--cv-space-2); color: var(--cv-warning); font-size: var(--cv-type-meta); font-weight: 600; white-space: nowrap; }
.comparison-photo { position: relative; display: block; width: 100%; height: clamp(180px, 28vw, 260px); padding: 0; border: 0; background: var(--cv-image); cursor: pointer; }
.comparison-photo :deep(img) { width: 100%; height: 100%; object-fit: contain; }
.comparison-photo > button { position: absolute; right: var(--cv-space-2); bottom: var(--cv-space-2); min-height: var(--cv-control); padding: 0 var(--cv-space-3); border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface); color: var(--cv-accent-strong); font-size: var(--cv-type-meta); }
.comparison-original { padding: var(--cv-space-4); }
.comparison-original strong { color: var(--cv-secondary); font-size: var(--cv-type-meta); font-weight: 600; }
.comparison-original p { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; margin: var(--cv-space-2) 0 0; color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); white-space: pre-wrap; overflow-wrap: anywhere; }
.comparison-sources { display: flex; flex-wrap: wrap; gap: var(--cv-space-2); padding: 0 var(--cv-space-4) var(--cv-space-4); }
.comparison-sources button { display: inline-flex; align-items: center; justify-content: center; gap: var(--cv-space-2); min-width: var(--cv-control); min-height: var(--cv-control); padding: 0 var(--cv-space-3); border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-surface); color: var(--cv-accent-strong); font-size: var(--cv-type-meta); }
.comparison-review { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--cv-space-3); padding: var(--cv-space-4); border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); }
.comparison-note { flex: 1; min-width: 180px; }
.comparison-review textarea { min-height: 88px; resize: vertical; line-height: var(--cv-leading-reading); }
.comparison-review > span,
.comparison-review > p { color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: var(--cv-leading-reading); }
.comparison-review > p { width: 100%; margin: 0; }
.comparison-review > .secondary-button { min-height: var(--cv-control); padding-inline: var(--cv-space-4); border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-accent); color: var(--cv-on-accent); font-size: var(--cv-type-meta); font-weight: 600; }
.comparison-review > .secondary-button:disabled { opacity: .5; }
.comparison-empty { display: grid; min-height: 128px; place-items: center; padding: var(--cv-space-6); border: 1px dashed var(--cv-border-strong); border-radius: var(--cv-radius-panel); background: var(--cv-surface); color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); text-align: center; }
@media (max-width: 700px) {
  .comparison-toolbar { align-items: flex-start; flex-direction: column; }
  .comparison-toolbar > span { max-width: 100%; }
}
@media (max-width: 620px) {
  .comparison-selectors,
  .comparison-records { grid-template-columns: minmax(0, 1fr); gap: var(--cv-space-3); }
  .comparison-records header,
  .comparison-records dl,
  .comparison-original { padding: var(--cv-space-3); }
  .comparison-records dl { grid-template-columns: minmax(40px, auto) minmax(0, 1fr); }
  .comparison-sources { padding: 0 var(--cv-space-3) var(--cv-space-3); }
  .comparison-review { align-items: stretch; flex-direction: column; }
  .comparison-note { width: 100%; min-width: 0; }
  .comparison-review > .secondary-button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) { .record-comparison button { transition: none; } }
</style>
