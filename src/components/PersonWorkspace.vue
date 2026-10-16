<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClueRecord, PersonRecord, RelationshipRecord, TimelineRecord } from '../services/vault'
import UiIcon from './UiIcon.vue'
import ClueThumbnail from './ClueThumbnail.vue'

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
  'correct-name': [id: string]
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
const names = computed(() => [...new Set([person.value?.name || '', ...(person.value?.aliases || []), ...(person.value?.ocrNames || [])].map(name => name.trim()).filter(Boolean))])
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
          <div class="workspace-profile"><div class="workspace-avatar"><img v-if="photo" :src="photo" alt="" /><span v-else>{{ person.name.slice(0, 1) }}</span></div><div class="workspace-person"><h3>{{ person.name }}</h3><p>{{ person.aliases.length ? `别名：${person.aliases.join('、')}` : '未设置别名' }}</p></div><div class="workspace-profile-actions"><button type="button" class="workspace-edit" @click="emit('correct-name', person.id)">姓名识别纠错</button><button v-if="people.length >= 2" type="button" class="workspace-edit" @click="emit('merge-person', person.id)">合并人物</button><button type="button" class="workspace-edit" @click="emit('edit-person', person.id)"><UiIcon name="edit" :size="16" />编辑</button></div></div>
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
              <div v-if="!events.length" class="workspace-empty"><UiIcon name="timeline" :size="32" /><strong>还没有相关的已确认事件</strong><p>与该人物关联，或原文明确提及其姓名、别名及已确认识别错名的事件会显示在这里。</p></div>
            </template>
            <template v-else-if="tab === 'clues'">
              <p class="workspace-caption">来自姓名、别名、已确认识别错名的明确匹配及事件关联。</p>
              <article v-for="clue in relatedClues" :key="clue.id" class="workspace-clue"><div class="clue-open"><span class="clue-photo" @click="emit('open-clue', clue.id)"><ClueThumbnail :path="clue.displayImagePath || clue.imagePath" :rotation="clue.rotation" :alt="clue.title" /></span><button type="button" class="clue-heading" @click="emit('open-clue', clue.id)"><small>线索 #{{ String(clue.number).padStart(3, '0') }}</small><strong>{{ clue.title || '未命名线索' }}</strong><span>{{ clue.category || '未分类' }} · 第 {{ clue.round }} 轮</span></button><UiIcon name="chevron" :size="17" /></div><p v-if="clue.ocrText" class="clue-excerpt">{{ clueExcerpt(clue) }}</p><details v-if="clue.ocrText" class="clue-text"><summary>展开 OCR 原文</summary><p>{{ clue.ocrText }}</p></details></article>
              <div v-if="!relatedClues.length" class="workspace-empty"><UiIcon name="archive" :size="32" /><strong>还没有相关线索</strong><p>拍摄录入后，可通过姓名、别名、已确认识别错名或事件关联查找。</p></div>
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
.person-workspace-backdrop,
.person-workspace-backdrop * { box-sizing: border-box; }
.person-workspace-backdrop {
  position: fixed;
  z-index: 1250;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: rgb(36 49 61 / 32%);
}
.person-workspace {
  display: flex;
  flex-direction: column;
  width: min(560px, 94vw);
  min-width: 0;
  height: 100%;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0;
  background: var(--cv-surface);
  color: var(--cv-ink);
  box-shadow: var(--cv-shadow-raised);
  outline: none;
  animation: workspace-enter var(--cv-motion-panel) var(--cv-ease);
}
.workspace-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--cv-space-4);
  padding: var(--cv-space-4) var(--cv-space-6);
}
.workspace-header span { color: var(--cv-muted); font-size: var(--cv-type-meta); letter-spacing: .02em; }
.workspace-header h2 { margin: var(--cv-space-1) 0 0; color: var(--cv-ink); font-size: 22px; font-weight: 650; line-height: 1.35; }
.workspace-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--cv-control);
  height: var(--cv-control);
  border: 1px solid var(--cv-border);
  border-radius: var(--cv-radius-control);
  background: var(--cv-surface-subtle);
  color: var(--cv-secondary);
}
.workspace-profile {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cv-space-3);
  margin: 0 var(--cv-space-6);
  padding: var(--cv-space-4);
  border: 1px solid var(--cv-border);
  border-radius: var(--cv-radius-panel);
  background: var(--cv-surface);
}
.workspace-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border-radius: 12px;
  background: var(--cv-accent-soft);
  color: var(--cv-accent-strong);
  font-size: 24px;
  font-weight: 650;
}
.workspace-avatar img { width: 100%; height: 100%; object-fit: cover; }
.workspace-person { flex: 1 1 100px; min-width: 0; }
.workspace-person h3 { margin: 0; color: var(--cv-ink); font-size: 20px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.workspace-person p { margin: var(--cv-space-1) 0 0; color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: var(--cv-leading-ui); overflow-wrap: anywhere; }
.workspace-profile-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--cv-space-2); margin-left: auto; }
.workspace-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  gap: var(--cv-space-1);
  min-height: var(--cv-control);
  padding: 0 var(--cv-space-3);
  border: 1px solid var(--cv-border);
  border-radius: var(--cv-radius-control);
  background: var(--cv-surface);
  color: var(--cv-secondary);
  font: inherit;
  font-size: var(--cv-type-meta);
  font-weight: 550;
}
.workspace-notes {
  flex: none;
  max-height: 90px;
  overflow-y: auto;
  margin: var(--cv-space-3) var(--cv-space-6) 0;
  color: var(--cv-secondary);
  font-size: var(--cv-type-summary);
  line-height: var(--cv-leading-reading);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.workspace-tabs {
  display: flex;
  flex: none;
  gap: var(--cv-space-2);
  margin: var(--cv-space-3) var(--cv-space-6) 0;
  border-bottom: 1px solid var(--cv-border);
}
.workspace-tabs button {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--cv-space-2);
  min-width: 0;
  min-height: 52px;
  padding: var(--cv-space-2) var(--cv-space-1);
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--cv-secondary);
  font: inherit;
  font-size: var(--cv-type-label);
}
.workspace-tabs button.active { border-bottom-color: var(--cv-accent); color: var(--cv-accent-strong); font-weight: 650; }
.workspace-tabs button span {
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  min-height: 24px;
  padding-inline: var(--cv-space-1);
  border-radius: var(--cv-radius-tag);
  background: var(--cv-surface-subtle);
  color: var(--cv-muted);
  font-size: var(--cv-type-meta);
}
.workspace-tabs button.active span { background: var(--cv-accent-soft); color: var(--cv-accent-strong); }
.workspace-content {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 0 var(--cv-space-6) var(--cv-space-6);
}
.workspace-caption { margin: var(--cv-space-4) 0 var(--cv-space-2); color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: var(--cv-leading-reading); }
.workspace-event { position: relative; margin: 0; padding: var(--cv-space-4) 0; border-bottom: 1px solid var(--cv-border); background: transparent; }
.event-focus {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--cv-space-2);
  width: 100%;
  min-height: var(--cv-control);
  padding: var(--cv-space-1) 0;
  border: 0;
  background: transparent;
  color: var(--cv-ink);
  text-align: left;
  font: inherit;
}
.event-date { display: flex; align-items: center; gap: var(--cv-space-2); color: var(--cv-accent-strong); font-size: var(--cv-type-meta); font-weight: 600; }
.event-focus strong { color: var(--cv-ink); font-size: var(--cv-type-title); font-weight: 600; line-height: var(--cv-leading-reading); overflow-wrap: anywhere; }
.event-locate { display: inline-flex; align-items: center; gap: var(--cv-space-1); min-height: var(--cv-control); margin-top: calc(-1 * var(--cv-space-2)); color: var(--cv-accent-strong); font-size: var(--cv-type-meta); }
.event-badges { display: flex; flex-wrap: wrap; gap: var(--cv-space-2); margin: var(--cv-space-2) 0; }
.event-badges > span { display: inline-flex; align-items: center; min-height: 28px; padding: 0 var(--cv-space-2); border-radius: var(--cv-radius-tag); background: var(--cv-surface-subtle); color: var(--cv-secondary); font-size: var(--cv-type-meta); }
.event-badges > .yearless-badge { background: var(--cv-warning-soft); color: var(--cv-warning); }
.event-compare { margin: 0 0 var(--cv-space-1); }
.record-note { margin: var(--cv-space-2) 0; padding: var(--cv-space-2) var(--cv-space-3); border-radius: var(--cv-radius-tag); background: var(--cv-warning-soft); color: var(--cv-warning); font-size: var(--cv-type-meta); line-height: var(--cv-leading-reading); }
.event-evidence { margin-top: var(--cv-space-2); border-top: 1px solid var(--cv-border); }
.event-evidence summary { display: flex; align-items: center; justify-content: space-between; gap: var(--cv-space-2); min-height: var(--cv-control); color: var(--cv-secondary); font-size: var(--cv-type-meta); cursor: pointer; }
.event-evidence summary span { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.event-evidence blockquote { max-height: 230px; overflow-y: auto; margin: 0 0 var(--cv-space-2); padding: var(--cv-space-3); border-left: 2px solid var(--cv-border-strong); border-radius: 0 var(--cv-radius-tag) var(--cv-radius-tag) 0; background: var(--cv-surface-subtle); color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); white-space: pre-wrap; overflow-wrap: anywhere; }
.source-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--cv-space-2);
  min-width: var(--cv-control);
  min-height: var(--cv-control);
  padding: 0 var(--cv-space-3);
  border: 1px solid var(--cv-border);
  border-radius: var(--cv-radius-control);
  background: var(--cv-surface);
  color: var(--cv-accent-strong);
  font: inherit;
  font-size: var(--cv-type-meta);
  font-weight: 550;
}
.manual-event { margin: var(--cv-space-2) 0 0; color: var(--cv-muted); font-size: var(--cv-type-meta); }
.workspace-clue { margin: 0; padding: var(--cv-space-4) 0; border-bottom: 1px solid var(--cv-border); background: transparent; }
.clue-open { display: flex; align-items: center; gap: var(--cv-space-3); width: 100%; min-width: 0; color: var(--cv-ink); text-align: left; font: inherit; }
.clue-photo { display: block; flex: none; width: 56px; height: 72px; overflow: hidden; border-radius: var(--cv-radius-tag); background: var(--cv-image); }
.clue-photo :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.clue-placeholder { display: grid; place-items: center; color: var(--cv-muted); }
.clue-heading {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--cv-space-1);
  min-width: 0;
  min-height: var(--cv-control);
  padding: var(--cv-space-1) 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.clue-heading small { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.clue-heading strong { color: var(--cv-ink); font-size: var(--cv-type-label); font-weight: 600; line-height: var(--cv-leading-reading); overflow-wrap: anywhere; }
.clue-heading > span { color: var(--cv-secondary); font-size: var(--cv-type-meta); line-height: var(--cv-leading-ui); }
.clue-excerpt { margin: var(--cv-space-3) 0 0; padding: var(--cv-space-3); border-radius: var(--cv-radius-tag); background: var(--cv-surface-subtle); color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); overflow-wrap: anywhere; }
.clue-text { margin-top: var(--cv-space-2); }
.clue-text summary { min-height: var(--cv-control); padding-block: var(--cv-space-3); color: var(--cv-accent-strong); font-size: var(--cv-type-meta); cursor: pointer; }
.clue-text p { margin: var(--cv-space-2) 0; color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); white-space: pre-wrap; overflow-wrap: anywhere; }
.workspace-relation {
  display: flex;
  align-items: center;
  gap: var(--cv-space-3);
  width: 100%;
  min-height: 72px;
  margin: 0;
  padding: var(--cv-space-3) 0;
  border: 0;
  border-bottom: 1px solid var(--cv-border);
  background: transparent;
  color: var(--cv-secondary);
  text-align: left;
  font: inherit;
}
.relation-avatar { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 12px; background: var(--cv-accent-soft); color: var(--cv-accent-strong); font-size: 18px; }
.relation-copy { display: flex; flex: 1; flex-direction: column; gap: var(--cv-space-1); min-width: 0; overflow-wrap: anywhere; }
.relation-copy strong { color: var(--cv-ink); font-size: var(--cv-type-label); font-weight: 600; }
.relation-copy > span { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.workspace-empty { display: flex; flex-direction: column; align-items: center; gap: var(--cv-space-3); padding: var(--cv-space-8) var(--cv-space-6); color: var(--cv-accent); text-align: center; }
.workspace-empty strong { color: var(--cv-ink); font-size: var(--cv-type-title); font-weight: 600; }
.workspace-empty p { max-width: 320px; margin: 0; color: var(--cv-secondary); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); }
.person-workspace :is(button, summary) { cursor: pointer; touch-action: manipulation; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.person-workspace :is(button, summary) { transition: color var(--cv-motion-press) var(--cv-ease), background-color var(--cv-motion-press) var(--cv-ease), border-color var(--cv-motion-press) var(--cv-ease); }
.person-workspace :is(button, summary):focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.person-workspace :is(button, summary):active { background-color: var(--cv-accent-soft); }
@keyframes workspace-enter { from { transform: translateX(20px); opacity: .7; } to { transform: translateX(0); opacity: 1; } }
@media (max-width: 600px) {
  .person-workspace { width: 100%; }
  .workspace-header { padding: var(--cv-space-4) 18px var(--cv-space-3); }
  .workspace-profile { margin-inline: 18px; }
  .workspace-tabs { margin-inline: 18px; }
  .workspace-content { padding-inline: 18px; }
}
@media (prefers-reduced-motion: reduce) { .person-workspace { animation: none; } }
</style>
