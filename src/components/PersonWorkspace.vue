<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClueRecord, PersonRecord, RelationshipRecord, TimelineRecord } from '../services/vault'
import UiIcon from './UiIcon.vue'

type Evidence = { clueId: string; sourceNo?: number; quote: string }
type LinkedEvent = TimelineRecord & { evidence?: Evidence[]; precision?: 'date' | 'hour' | 'minute'; approximate?: boolean }
const props = defineProps<{
  personId: string
  scriptId: string
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  events: TimelineRecord[]
  clues: ClueRecord[]
  imageUrls: Record<string, string>
}>()
const emit = defineEmits<{
  close: []
  'open-clue': [clueId: string, quote?: string]
  'focus-event': [event: TimelineRecord]
  'open-person': [personId: string]
  'edit-person': [personId: string]
  'merge-person': [id: string]
  'compare-event': [eventId: string]
}>()
const tab = ref<'events' | 'clues' | 'relationships'>('events')
const panel = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const people = computed(() => props.people.filter(person => person.scriptId === props.scriptId))
const peopleById = computed(() => new Map(people.value.map(person => [person.id, person])))
const person = computed(() => peopleById.value.get(props.personId))
const clues = computed(() => props.clues.filter(clue => clue.scriptId === props.scriptId))
const cluesById = computed(() => new Map(clues.value.map(clue => [clue.id, clue])))
const names = computed(() => [...new Set([person.value?.name || '', ...(person.value?.aliases || [])].map(name => name.trim()).filter(Boolean))])
const hasName = (text: string) => names.value.some(name => text.includes(name))
function sourcesFor(event: LinkedEvent): Evidence[] {
  const sources = (event.evidence || []).filter(source => cluesById.value.has(source.clueId)).map(source => ({ ...source, sourceNo: cluesById.value.get(source.clueId)?.number }))
  if (event.clueId && cluesById.value.has(event.clueId) && !sources.some(source => source.clueId === event.clueId)) sources.unshift({ clueId: event.clueId, sourceNo: cluesById.value.get(event.clueId)?.number, quote: '' })
  return sources.filter((source, index) => sources.findIndex(other => other.clueId === source.clueId && other.quote === source.quote) === index)
}
const referenceYear = computed(() => {
  const years = props.events.filter(event => event.scriptId === props.scriptId && event.confirmed && /^\d{4}-/.test(event.startsAt)).map(event => Number(event.startsAt.slice(0, 4)))
  return years.length ? Math.min(...years) : 2000
})
const events = computed(() => props.events.filter((event: LinkedEvent) => event.scriptId === props.scriptId && event.confirmed && (event.personIds.includes(props.personId) || hasName(event.title) || sourcesFor(event).some(source => hasName(source.quote)))).sort((a, b) => a.startsAt.replace(/^--/, `${referenceYear.value}-`).localeCompare(b.startsAt.replace(/^--/, `${referenceYear.value}-`)) || a.id.localeCompare(b.id)))
const relatedClueIds = computed(() => new Set(events.value.flatMap(event => sourcesFor(event).map(source => source.clueId))))
const relatedClues = computed(() => clues.value.filter(clue => relatedClueIds.value.has(clue.id) || hasName([clue.title, clue.ocrText, clue.notes].join('\n'))).sort((a, b) => a.number - b.number))
const relationships = computed(() => props.relationships.filter(relationship => relationship.scriptId === props.scriptId && peopleById.value.has(relationship.fromId) && peopleById.value.has(relationship.toId) && (relationship.fromId === props.personId || relationship.toId === props.personId)))
const photo = computed(() => person.value ? props.imageUrls[person.value.photoPath] || props.imageUrls[person.value.id] || '' : '')
function otherPerson(relationship: RelationshipRecord) { return peopleById.value.get(relationship.fromId === props.personId ? relationship.toId : relationship.fromId) }
function dateLabel(value: string) {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?(?::(\d{2}))?)?/)
  if (!match) return value || '时间待补充'
  return `${match[1] ? `${match[1]}年` : ''}${Number(match[2])}月${Number(match[3])}日${match[4] ? ` ${match[4]}${match[5] ? `:${match[5]}${match[6] ? `:${match[6]}` : ''}` : '时'}` : ''}`
}
function precisionLabel(event: LinkedEvent) {
  const explicit = event.precision === 'date' ? '仅日期' : event.precision === 'hour' ? '到小时' : event.precision === 'minute' ? '到分钟' : /T\d{2}:\d{2}:\d{2}/.test(event.startsAt) ? '到秒' : /T\d{2}:\d{2}/.test(event.startsAt) ? '到分钟' : /T\d{2}/.test(event.startsAt) ? '到小时' : '仅日期'
  return `${event.approximate ? '约时间 · ' : ''}${explicit}`
}
function sameAction(event: TimelineRecord) { return event.title.replace(/[\s，。！？、,.!?；;：:]/g, '') }
function differingRecords(event: TimelineRecord) { return events.value.some(other => other.id !== event.id && other.startsAt !== event.startsAt && sameAction(other) === sameAction(event) && Boolean(sameAction(event))) }
function clueExcerpt(clue: ClueRecord) {
  const text = clue.ocrText.trim()
  const hits = names.value.map(name => text.indexOf(name)).filter(index => index >= 0)
  const at = hits.length ? Math.min(...hits) : 0
  const start = Math.max(0, at - 35)
  return `${start ? '…' : ''}${text.slice(start, start + 180)}${text.length > start + 180 ? '…' : ''}`
}
function clueImage(clue: ClueRecord) { return props.imageUrls[clue.displayImagePath] || props.imageUrls[clue.imagePath] || props.imageUrls[clue.id] || '' }
function changeTab(value: typeof tab.value) { tab.value = value; if (scroller.value) scroller.value.scrollTop = 0 }
let previousOverflow = ''
let previousFocus: HTMLElement | null = null
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, textarea, select, summary, [tabindex="0"]')].filter(element => element.getClientRects().length)
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(() => props.personId, async () => { tab.value = 'events'; await nextTick(); if (scroller.value) scroller.value.scrollTop = 0 })
onMounted(async () => {
  previousOverflow = document.body.style.overflow
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.style.overflow = 'hidden'
  await nextTick(); panel.value?.focus()
})
onBeforeUnmount(() => { if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow; previousFocus?.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="person-workspace-backdrop" @click.self="emit('close')">
      <section ref="panel" class="person-workspace" role="dialog" aria-modal="true" :aria-label="`${person?.name || '人物'}的线索与事件`" tabindex="-1" @keydown="keydown">
        <header class="workspace-header"><div><span>人物工作台</span><h2>线索与事件</h2></div><button type="button" class="workspace-icon" aria-label="关闭人物工作台" @click="emit('close')"><UiIcon name="close" /></button></header>
        <template v-if="person">
          <div class="workspace-profile"><div class="workspace-avatar"><img v-if="photo" :src="photo" alt="" /><span v-else>{{ person.name.slice(0, 1) }}</span></div><div class="workspace-person"><h3>{{ person.name }}</h3><p>{{ person.aliases.length ? `别名：${person.aliases.join('、')}` : '未设置别名' }}</p></div><div class="workspace-profile-actions"><button v-if="people.length >= 2" type="button" class="workspace-edit" @click="emit('merge-person', person.id)">合并人物</button><button type="button" class="workspace-edit" @click="emit('edit-person', person.id)"><UiIcon name="edit" :size="16" />编辑</button></div></div>
          <p v-if="person.notes" class="workspace-notes">{{ person.notes }}</p>
          <nav class="workspace-tabs" aria-label="人物相关信息"><button type="button" :class="{ active: tab === 'events' }" :aria-current="tab === 'events' ? 'page' : undefined" @click="changeTab('events')">事件<span>{{ events.length }}</span></button><button type="button" :class="{ active: tab === 'clues' }" :aria-current="tab === 'clues' ? 'page' : undefined" @click="changeTab('clues')">线索<span>{{ relatedClues.length }}</span></button><button type="button" :class="{ active: tab === 'relationships' }" :aria-current="tab === 'relationships' ? 'page' : undefined" @click="changeTab('relationships')">关系<span>{{ relationships.length }}</span></button></nav>
          <div ref="scroller" class="workspace-content">
            <template v-if="tab === 'events'">
              <p class="workspace-caption">已确认事件 · 点击定位时间线，展开出处核对原文。</p>
              <article v-for="event in events" :key="event.id" class="workspace-event">
                <button type="button" class="event-focus" @click="emit('focus-event', event)"><span class="event-date"><UiIcon name="clock" :size="15" />{{ dateLabel(event.startsAt) }}</span><strong>{{ event.title }}</strong><span class="event-locate">定位时间线<UiIcon name="chevron" :size="14" /></span></button>
                <div class="event-badges"><span>{{ precisionLabel(event) }}</span><span v-if="event.startsAt.startsWith('--') && !event.yearlessMarkerIgnored" class="yearless-badge">无年份</span><span v-if="sourcesFor(event).length > 1">{{ sourcesFor(event).length }} 个出处</span></div>
                <button type="button" class="source-button event-compare" @click="emit('compare-event', event.id)">对照此记录</button>
                <p v-if="differingRecords(event)" class="record-note">同一事件的记录时间不同，需核对原文。</p>
                <details v-for="(source, index) in sourcesFor(event)" :key="`${source.clueId}:${index}`" class="event-evidence"><summary>原线索 #{{ String(source.sourceNo || 0).padStart(3, '0') }}<span>查看原文</span></summary><blockquote v-if="source.quote">{{ source.quote }}</blockquote><blockquote v-else>{{ cluesById.get(source.clueId)?.ocrText || '该线索暂无识别文字，可打开原始照片核对。' }}</blockquote><button type="button" class="source-button" @click="emit('open-clue', source.clueId, source.quote)"><UiIcon name="image" :size="16" />查看原始线索<UiIcon name="chevron" :size="14" /></button></details>
                <p v-if="!sourcesFor(event).length" class="manual-event">手动事件 · 未关联原线索</p>
              </article>
              <div v-if="!events.length" class="workspace-empty"><UiIcon name="timeline" :size="32" /><strong>还没有相关的已确认事件</strong><p>与该人物关联，或原文明确提及其姓名、别名的事件会显示在这里。</p></div>
            </template>
            <template v-else-if="tab === 'clues'">
              <p class="workspace-caption">来自姓名、别名的明确匹配及事件关联。</p>
              <article v-for="clue in relatedClues" :key="clue.id" class="workspace-clue"><button type="button" class="clue-open" @click="emit('open-clue', clue.id)"><img v-if="clueImage(clue)" :src="clueImage(clue)" alt="" /><span v-else class="clue-placeholder"><UiIcon name="image" :size="25" /></span><span class="clue-heading"><small>线索 #{{ String(clue.number).padStart(3, '0') }}</small><strong>{{ clue.title || '未命名线索' }}</strong><span>{{ clue.category || '未分类' }} · 第 {{ clue.round }} 轮</span></span><UiIcon name="chevron" :size="17" /></button><p v-if="clue.ocrText" class="clue-excerpt">{{ clueExcerpt(clue) }}</p><details v-if="clue.ocrText" class="clue-text"><summary>展开 OCR 原文</summary><p>{{ clue.ocrText }}</p></details></article>
              <div v-if="!relatedClues.length" class="workspace-empty"><UiIcon name="archive" :size="32" /><strong>还没有相关线索</strong><p>拍摄录入后，可通过姓名、别名或事件关联查找。</p></div>
            </template>
            <template v-else>
              <p class="workspace-caption">仅展示玩家手动建立的关系。</p>
              <button v-for="relationship in relationships" :key="relationship.id" type="button" class="workspace-relation" @click="emit('open-person', otherPerson(relationship)!.id)"><span class="relation-avatar">{{ otherPerson(relationship)?.name.slice(0, 1) }}</span><span class="relation-copy"><strong>{{ otherPerson(relationship)?.name }}</strong><span>{{ relationship.label || '关联' }}</span></span><UiIcon name="chevron" :size="18" /></button>
              <div v-if="!relationships.length" class="workspace-empty"><UiIcon name="relationship" :size="32" /><strong>尚未建立人物关系</strong><p>在关系图中长按人物，再连接目标人物。</p></div>
            </template>
          </div>
        </template>
        <div v-else class="workspace-empty"><UiIcon name="person" :size="32" /><strong>当前剧本中找不到该人物</strong><button type="button" class="source-button" @click="emit('close')">关闭</button></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.person-workspace-backdrop, .person-workspace-backdrop * { box-sizing: border-box; }
.person-workspace-backdrop { position: fixed; z-index: 1250; inset: 0; display: flex; justify-content: flex-end; background: #152f263f; backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.person-workspace { display: flex; flex-direction: column; width: min(520px, 90vw); min-width: 0; height: 100%; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); background: #fcfdfb; color: #2e4939; box-shadow: -12px 0 50px #1d392526; outline: none; animation: workspace-enter .2s ease-out; }
.workspace-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px 16px; }
.workspace-header span { color: #8b9c8b; font-size: 11px; letter-spacing: .08em; }
.workspace-header h2 { margin: 5px 0 0; font-size: 22px; letter-spacing: -.03em; }
.workspace-icon { display: grid; place-items: center; flex-shrink: 0; width: 44px; height: 44px; border: 0; border-radius: 13px; background: #eef3eb; color: #6f866e; }
.workspace-profile { display: flex; flex-wrap: wrap; flex-shrink: 0; align-items: center; gap: 13px; margin: 0 24px; padding: 16px; border: 1px solid #e1e9dc; border-radius: 17px; background: linear-gradient(135deg, #f4f8ef, #fff); }
.workspace-avatar { display: grid; place-items: center; flex-shrink: 0; width: 54px; height: 54px; overflow: hidden; border-radius: 16px; background: #dfeadd; color: #4d7458; font-size: 25px; font-weight: 650; }
.workspace-avatar img { width: 100%; height: 100%; object-fit: cover; }
.workspace-person { flex: 1 1 100px; min-width: 0; }
.workspace-profile-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-left: auto; }
.workspace-person h3 { margin: 0; font-size: 21px; overflow-wrap: anywhere; }
.workspace-person p { margin: 6px 0 0; color: #849780; font-size: 12px; overflow-wrap: anywhere; }
.workspace-edit { display: flex; align-items: center; justify-content: center; flex-shrink: 0; gap: 5px; min-height: 42px; padding: 0 10px; border: 1px solid #dbe5d6; border-radius: 10px; background: #fff; color: #53764f; font: inherit; font-size: 12px; }
.workspace-notes { flex-shrink: 0; max-height: 90px; overflow-y: auto; margin: 14px 28px 0; color: #7e8c76; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.workspace-tabs { display: flex; flex-shrink: 0; gap: 8px; padding: 17px 24px 0; border-bottom: 1px solid #e4ebde; }
.workspace-tabs button { display: flex; flex: 1; align-items: center; justify-content: center; gap: 8px; min-height: 47px; padding: 8px 5px 13px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: #8d9b87; font: inherit; font-size: 14px; }
.workspace-tabs button.active { border-bottom-color: #4b7552; color: #365c3e; font-weight: 650; }
.workspace-tabs button span { padding: 2px 6px; border-radius: 6px; background: #edf3e8; font-size: 10px; }
.workspace-content { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 0 24px 24px; }
.workspace-caption { margin: 17px 0 14px; color: #8c9a84; font-size: 11px; line-height: 1.6; }
.workspace-event { position: relative; margin: 0 0 13px; padding: 15px 16px 12px; border: 1px solid #dfe7d9; border-radius: 14px; background: #fff; }
.event-focus { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; }
.event-date { display: flex; align-items: center; gap: 6px; color: #9b6c4a; font-size: 12px; font-weight: 650; }
.event-focus strong { font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
.event-locate { display: inline-flex; align-items: center; gap: 3px; min-height: 28px; margin-top: -3px; color: #6d8a63; font-size: 11px; }
.event-badges { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0 10px; }
.event-badges > span { padding: 3px 6px; border-radius: 5px; background: #f0f4ec; color: #829579; font-size: 10px; }
.event-badges > .yearless-badge { background: #f7eee4; color: #af8157; }
.event-compare { margin: 0 0 5px; }
.record-note { margin: 9px 0; padding: 8px 10px; border-radius: 7px; background: #fbf2e5; color: #aa7b4d; font-size: 11px; line-height: 1.6; }
.event-evidence { margin-top: 7px; border-top: 1px solid #edf1e7; }
.event-evidence summary { min-height: 39px; padding-top: 12px; color: #738d66; font-size: 11px; cursor: pointer; }
.event-evidence summary span { float: right; color: #9aa58f; font-size: 10px; }
.event-evidence blockquote { max-height: 230px; overflow-y: auto; margin: 2px 0 8px; padding: 10px; border-left: 2px solid #d6e0ca; border-radius: 0 8px 8px 0; background: #f8faf5; color: #788770; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.source-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 5px 9px; border: 1px solid #dfe7d8; border-radius: 9px; background: #fff; color: #5c8054; font: inherit; font-size: 11px; }
.manual-event { margin: 10px 0 0; color: #9ba58e; font-size: 10px; }
.workspace-clue { margin-bottom: 12px; padding: 13px; border: 1px solid #e0e7d9; border-radius: 14px; background: #fff; }
.clue-open { display: flex; align-items: center; gap: 12px; width: 100%; padding: 0; border: 0; background: transparent; color: #35533a; text-align: left; font: inherit; }
.clue-open > img, .clue-placeholder { flex-shrink: 0; width: 52px; height: 68px; object-fit: cover; border-radius: 8px; background: #edf2e8; }
.clue-placeholder { display: grid; place-items: center; color: #9bad8e; }
.clue-heading { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; }
.clue-heading small { color: #a17a56; font-size: 10px; }
.clue-heading strong { overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; }
.clue-heading > span { color: #94a087; font-size: 10px; }
.clue-excerpt { margin: 13px 0 3px; padding: 10px; border-radius: 8px; background: #f7f9f3; color: #849078; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.clue-text { margin-top: 8px; }
.clue-text summary { min-height: 34px; padding-top: 8px; color: #80956f; font-size: 11px; cursor: pointer; }
.clue-text p { margin: 6px 0; color: #7d8c72; font-size: 12px; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; }
.workspace-relation { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 82px; margin-bottom: 10px; padding: 12px 15px; border: 1px solid #dfe8d7; border-radius: 14px; background: #fff; color: #4d704c; text-align: left; font: inherit; }
.relation-avatar { display: grid; place-items: center; width: 43px; height: 43px; border-radius: 12px; background: #edf3e7; font-size: 20px; }
.relation-copy { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.relation-copy strong { font-size: 15px; }
.relation-copy > span { color: #a17c5b; font-size: 12px; }
.workspace-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 55px 20px; color: #b0bba6; text-align: center; }
.workspace-empty strong { color: #77916d; font-size: 15px; }
.workspace-empty p { max-width: 280px; margin: 0; color: #9aa78e; font-size: 12px; line-height: 1.9; }
button { cursor: pointer; touch-action: manipulation; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
button:focus-visible, summary:focus-visible { outline: 3px solid #bfd4b5; outline-offset: 3px; }
@keyframes workspace-enter { from { transform: translateX(30px); opacity: .5; } to { transform: translateX(0); opacity: 1; } }
@media (max-width: 600px) { .person-workspace { width: 100%; } .workspace-header { padding: 17px 18px 14px; } .workspace-profile { margin: 0 18px; } .workspace-tabs { padding-left: 18px; padding-right: 18px; } .workspace-content { padding-left: 18px; padding-right: 18px; } }
@media (prefers-reduced-motion: reduce) { .person-workspace { animation: none; } }
</style>
