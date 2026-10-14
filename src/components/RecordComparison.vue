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
    <div class="comparison-toolbar"><div class="comparison-switch"><button :class="{ active: kind === 'events' }" @click="kind = 'events'">对照事件</button><button :class="{ active: kind === 'clues' }" @click="kind = 'clues'">对照线索</button></div><span>记录差异供你核对，不判断哪份为真。</span></div>
    <div class="comparison-selectors"><label>左侧记录<select v-model="leftId"><option value="">选择记录</option><option v-for="item in options" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label>右侧记录<select v-model="rightId"><option value="">选择记录</option><option v-for="item in options" :key="item.id" :value="item.id" :disabled="item.id === leftId">{{ item.label }}</option></select></label></div>
    <div v-if="leftId === rightId && leftId" class="comparison-empty">请选择两条不同记录。</div>
    <div v-else-if="left && right" class="comparison-records"><article v-for="(item, index) in [left, right]" :key="index"><header><small>{{ index ? '右侧' : '左侧' }}记录</small><h2>{{ item.title }}</h2><span>{{ item.precision }}</span></header><dl><dt>时间</dt><dd :class="{ different: left.time !== right.time }">{{ item.time }}</dd><dt>人物</dt><dd :class="{ different: left.names !== right.names }">{{ item.names }}</dd></dl><div v-if="item.imagePath" class="comparison-photo" @click="emit('open-clue', item.id)"><ClueThumbnail fit="contain" :path="item.imagePath" :rotation="item.rotation" :alt="item.title" /><button type="button" :aria-label="`查看${item.title}原始照片`" @click.stop="emit('open-clue', item.id)">查看原始照片</button></div><section class="comparison-original"><strong>原文记载</strong><p>{{ item.text || '暂无 OCR 原文，请打开原始照片核对。' }}</p></section><div class="comparison-sources"><button v-for="(source, at) in item.sources" :key="`${source.clueId}:${at}`" @click="emit('open-clue', source.clueId, source.quote)"><UiIcon name="image" :size="16" />原线索 #{{ String(source.sourceNo).padStart(3, '0') }}</button></div></article></div>
    <div v-else class="comparison-empty">选择两条事件或线索，即可并排核对人物、时间和原文。</div>
    <section v-if="left && right && leftId !== rightId" class="comparison-review"><label>人工核对状态<select v-model="status" :disabled="loading"><option value="pending">待核对</option><option value="checked">已核对</option></select></label><label class="comparison-note">核对备注<textarea v-model="note" :disabled="loading" rows="2" placeholder="记录你的核对结果，不会修改两份原文。"></textarea></label><span role="status">{{ message }}</span><button v-if="canMerge" class="secondary-button" :disabled="busy" @click="emit('merge-events', rightId, leftId)">确认是同一事件，合并到左侧</button><p v-else-if="kind === 'events'">时间不同的记录分别保留，可继续核对出处。</p></section>
  </section>
</template>

<style scoped>
.record-comparison{display:flex;flex-direction:column;gap:16px;min-width:0}.comparison-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.comparison-toolbar>span{font-size:12px;color:#8b9685}.comparison-switch{display:flex;padding:4px;border-radius:11px;background:#eef3e9}.comparison-switch button{min-height:38px;padding:0 15px;border-radius:8px;background:transparent;color:#84927c;font-size:13px}.comparison-switch button.active{color:#42613b;background:#fff;box-shadow:0 2px 7px #354f3612}.comparison-selectors,.comparison-records{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.comparison-selectors label,.comparison-review label{display:flex;flex-direction:column;gap:7px;font-size:12px;color:#7c8b73}.comparison-selectors select,.comparison-review select,.comparison-review textarea{width:100%;min-height:40px;padding:9px 11px;border:1px solid #dfe7d9;border-radius:9px;background:#fff;color:#405a38;font:inherit}.comparison-records>article{min-width:0;border:1px solid #e2e8dc;border-radius:14px;background:#fff;overflow:hidden}.comparison-records header{padding:17px 18px;border-bottom:1px solid #ecf0e7}.comparison-records header small{color:#a08662;font-size:10px}.comparison-records h2{font-size:16px;margin:6px 0;color:#304c32;line-height:1.6}.comparison-records header>span{font-size:11px;color:#8b997f}.comparison-records dl{display:grid;grid-template-columns:38px 1fr;gap:8px;margin:0;padding:15px 18px;font-size:12px;line-height:1.7}.comparison-records dt{color:#8d9b81}.comparison-records dd{margin:0;color:#4d6642;overflow-wrap:anywhere}.comparison-records .different{background:#fff0d8;color:#986332;border-radius:5px;padding:2px 5px}.comparison-photo{position:relative;display:block;width:100%;height:240px;padding:0;border:0;background:#edf2e8;cursor:pointer}.comparison-photo :deep(img){object-fit:contain}.comparison-photo>button{border:1px solid #dfe8d6;cursor:pointer;position:absolute;right:10px;bottom:9px;padding:6px 9px;border-radius:7px;background:#ffffffed;color:#567746;font-size:11px}.comparison-original{padding:15px 18px}.comparison-original strong{font-size:11px;color:#86967b}.comparison-original p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.9;color:#5d6d52;margin:10px 0}.comparison-sources{display:flex;flex-wrap:wrap;gap:7px;padding:0 18px 17px}.comparison-sources button{display:inline-flex;align-items:center;gap:5px;min-height:36px;padding:0 10px;border:1px solid #dfe8d6;border-radius:8px;background:#f5f9ef;color:#567746;font-size:11px}.comparison-review{display:flex;flex-wrap:wrap;align-items:flex-end;gap:13px;padding:16px;border:1px solid #e2e8da;border-radius:13px;background:#f8faf4}.comparison-note{flex:1;min-width:180px}.comparison-review>span,.comparison-review>p{font-size:11px;color:#8c997d}.comparison-review>p{width:100%;margin:0}.comparison-empty{padding:50px 20px;border:1px dashed #dfe6d6;border-radius:14px;text-align:center;font-size:13px;color:#93a086}@media(max-width:700px){.comparison-toolbar{align-items:flex-start;flex-direction:column}.comparison-records{gap:8px}.comparison-records header,.comparison-records dl,.comparison-original{padding:12px}.comparison-records h2{font-size:14px}.comparison-records dl{grid-template-columns:1fr;gap:3px}.comparison-original p{font-size:12px}.comparison-sources{padding:0 12px 12px}.comparison-selectors{gap:8px}.comparison-selectors select{font-size:12px}}
</style>
