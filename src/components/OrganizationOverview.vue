<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  ClueRecord,
  OrganizationCluePointSuggestion,
  OrganizationPersonSuggestion,
  OrganizationRelationshipSuggestion,
  OrganizationSnapshot,
  OrganizationTimelineSuggestion,
  PersonRecord,
  RelationshipRecord,
  TimelineRecord,
} from '../services/vault'

type Suggestion =
  | { kind: 'people'; item: OrganizationPersonSuggestion }
  | { kind: 'relationships'; item: OrganizationRelationshipSuggestion }
  | { kind: 'timeline'; item: OrganizationTimelineSuggestion }
  | { kind: 'cluePoints'; item: OrganizationCluePointSuggestion }

const props = defineProps<{
  clues: ClueRecord[]
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  events: TimelineRecord[]
  organization: OrganizationSnapshot | null
  busy: boolean
  autoOrganize: boolean
  apiConfigured: boolean
}>()
const emit = defineEmits<{
  analyze: []
  navigate: [view: 'clues' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings', section?: 'profiles' | 'relationships']
  openClue: [sourceNo: number]
  acceptPerson: [id: string]
  acceptRelationship: [id: string]
  acceptTimeline: [id: string]
  acceptCluePoint: [id: string]
  clearSuggestions: []
}>()
const activeFilter = ref('all')
const expandedIds = ref<string[]>([])
const reviewElement = ref<HTMLElement | null>(null)
function focusSuggestions() {
  activeFilter.value = 'all'
  reviewElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const allSuggestions = computed<Suggestion[]>(() => {
  const result = props.organization
  if (!result) return []
  return [
    ...result.people.map(item => ({ kind: 'people' as const, item })),
    ...result.relationships.map(item => ({ kind: 'relationships' as const, item })),
    ...result.timeline.map(item => ({ kind: 'timeline' as const, item })),
    ...result.cluePoints.map(item => ({ kind: 'cluePoints' as const, item })),
  ]
})
const pendingCount = computed(() => allSuggestions.value.length)
const cluePointCount = computed(() => new Set((props.organization?.cluePoints || []).map(item => item.sourceNo)).size)
const filters = computed(() => [
  { id: 'all', label: '全部', count: pendingCount.value },
  { id: 'people', label: '人物', count: props.organization?.people.length || 0 },
  { id: 'relationships', label: '关系', count: props.organization?.relationships.length || 0 },
  { id: 'timeline', label: '时间', count: props.organization?.timeline.length || 0 },
  { id: 'cluePoints', label: '线索点', count: props.organization?.cluePoints.length || 0 },
])
const visibleSuggestions = computed(() => activeFilter.value === 'all'
  ? allSuggestions.value
  : allSuggestions.value.filter(item => item.kind === activeFilter.value))
const dateLabel = (value: string) => {
  const partial = value.match(/^--(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (partial) return `${Number(partial[1])}月${Number(partial[2])}日${partial[3] ? ` ${partial[4] ? `${partial[3]}:${partial[4]}` : `${partial[3]}时`}` : ''}`
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
const kindLabel = (kind: Suggestion['kind']) => ({ people: '人物', relationships: '关系', timeline: '时间', cluePoints: '线索点' })[kind]
const sourceNo = (item: Suggestion['item']) => item.sourceNo
const quote = (item: Suggestion['item']) => item.quote
const title = (suggestion: Suggestion) => {
  if (suggestion.kind === 'people') return `${suggestion.item.name}${suggestion.item.aliases.length ? ` · 又名 ${suggestion.item.aliases.join('、')}` : ''}`
  if (suggestion.kind === 'relationships') return `${suggestion.item.from} · ${suggestion.item.label} · ${suggestion.item.to}`
  if (suggestion.kind === 'timeline') return `${dateLabel(suggestion.item.startsAt)} · ${suggestion.item.title}`
  return `${suggestion.item.title}${suggestion.item.category ? ` · ${suggestion.item.category}` : ''}`
}
const actionLabel = (suggestion: Suggestion) => {
  if (suggestion.kind === 'timeline' && suggestion.item.startsAt.startsWith('--')) return '录入无年份'
  if (suggestion.kind === 'timeline' && (suggestion.item.requiresTitle || !/T\d{2}:\d{2}$/.test(suggestion.item.startsAt))) return '补充并确认'
  return ({ people: '加入人物', relationships: '确认关系', timeline: '加入时间线', cluePoints: '应用到线索' })[suggestion.kind]
}
const isLongQuote = (item: Suggestion['item']) => item.quote.length > 115
function toggleQuote(id: string) {
  expandedIds.value = expandedIds.value.includes(id) ? expandedIds.value.filter(value => value !== id) : [...expandedIds.value, id]
}
function accept(suggestion: Suggestion) {
  if (props.busy) return
  if (suggestion.kind === 'people') emit('acceptPerson', suggestion.item.id)
  else if (suggestion.kind === 'relationships') emit('acceptRelationship', suggestion.item.id)
  else if (suggestion.kind === 'timeline') emit('acceptTimeline', suggestion.item.id)
  else emit('acceptCluePoint', suggestion.item.id)
}
</script>

<template>
  <section class="page organization-page" :aria-busy="busy">
    <header class="organize-header">
      <div><h1>整理线索</h1><p>人物、关系、时间和线索点都在这里核对。</p></div>
      <button v-if="apiConfigured" class="primary-button" :disabled="busy || !clues.some(item => item.ocrText.trim())" @click="emit('analyze')"><span v-if="busy" class="organize-spinner" aria-hidden="true"></span>{{ busy ? '整理中…' : '整理线索' }}</button>
      <button v-else class="primary-button" @click="emit('navigate', 'settings')">配置 AI</button>
    </header>

    <div class="organize-summary">
      <button @click="emit('navigate', 'clues')"><strong>{{ clues.length }}</strong><span>条线索</span></button>
      <button class="pending-summary" @click="focusSuggestions"><strong>{{ pendingCount }}</strong><span>待确认建议</span></button>
      <button @click="emit('navigate', 'people', 'profiles')"><strong>{{ people.length }}</strong><span>个人物</span></button>
      <button @click="emit('navigate', 'people', 'relationships')"><strong>{{ relationships.length }}</strong><span>条关系</span></button>
      <button @click="emit('navigate', 'timeline')"><strong>{{ events.filter(item => item.confirmed).length }}</strong><span>个时间节点</span></button>
      <button @click="emit('navigate', 'clues')"><strong>{{ cluePointCount }}</strong><span>个线索点</span></button>
    </div>

    <div class="organize-status" :class="{ ready: apiConfigured }">
      <span class="status-dot" :class="{ processing: busy }"></span>
      <span v-if="busy" role="status" aria-live="polite">正在整理 OCR 文字，完成后建议会显示在下方。</span>
      <span v-else-if="!apiConfigured">照片和 OCR 保存在本机；AI 整理尚未配置。</span>
      <span v-else-if="autoOrganize">自动整理已开启 · 只发送 OCR 文字，照片留在 iPad。</span>
      <span v-else>手动整理 · 只发送 OCR 文字，照片留在 iPad。</span>
      <button @click="emit('navigate', 'settings')">设置</button>
    </div>

    <nav class="organize-shortcuts" aria-label="整理工具">
      <div class="shortcut-heading"><strong>整理工具</strong><span>快速进入</span></div>
      <div class="shortcut-list">
        <button class="shortcut-button" @click="emit('navigate', 'people', 'profiles')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.2" r="3" /><path d="M4.5 16.5c.5-3 2.3-4.5 5.5-4.5s5 1.5 5.5 4.5" /></svg></span><span class="shortcut-label">人物档案</span><span class="shortcut-arrow">›</span>
        </button>
        <button class="shortcut-button" @click="emit('navigate', 'people', 'relationships')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="2.2" /><circle cx="15" cy="5" r="2.2" /><circle cx="15" cy="15" r="2.2" /><path d="m7 9 5.8-3M7 11l5.8 3" /></svg></span><span class="shortcut-label">人物关系</span><span class="shortcut-arrow">›</span>
        </button>
        <button class="shortcut-button" @click="emit('navigate', 'timeline')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4v12M4 6h11M4 10h8M4 14h10" /><circle cx="4" cy="6" r="1.2" /><circle cx="4" cy="10" r="1.2" /><circle cx="4" cy="14" r="1.2" /></svg></span><span class="shortcut-label">时间线</span><span class="shortcut-arrow">›</span>
        </button>
        <button class="shortcut-button" @click="emit('navigate', 'board')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="2" /><path d="M7 7h2v2H7zM11 7h2M7 11h2M11 11h2" /></svg></span><span class="shortcut-label">整理板</span><span class="shortcut-arrow">›</span>
        </button>
        <button class="shortcut-button" @click="emit('navigate', 'notes')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h7l3 3v10H5zM12 3.5v3h3M7.5 10h5M7.5 13h5" /></svg></span><span class="shortcut-label">笔记</span><span class="shortcut-arrow">›</span>
        </button>
        <button class="shortcut-button" @click="emit('navigate', 'compare')">
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="8" height="11" rx="1.5" /><rect x="8.5" y="6" width="8" height="11" rx="1.5" /><path d="M6 7h3M11 9h3M11 12h3" /></svg></span><span class="shortcut-label">线索对照</span><span class="shortcut-arrow">›</span>
        </button>
      </div>
    </nav>

    <section ref="reviewElement" class="review-section">
      <header class="review-heading"><div><h2>待确认建议 <span>{{ pendingCount }}</span></h2><p>核对出处后再加入档案。</p></div><div class="review-heading-actions"><time v-if="organization">更新于 {{ dateLabel(organization.updatedAt) }}</time><button v-if="pendingCount" class="clear-suggestions-button" :disabled="busy" @click="emit('clearSuggestions')">清除全部</button></div></header>
      <nav class="review-filters" aria-label="筛选整理建议">
        <button v-for="filter in filters" :key="filter.id" :class="{ active: activeFilter === filter.id }" :aria-pressed="activeFilter === filter.id" @click="activeFilter = filter.id">{{ filter.label }} <span>{{ filter.count }}</span></button>
      </nav>
      <div v-if="!organization" class="review-empty"><strong>还没有整理结果</strong><p>点击右上角“整理线索”生成待核对建议。</p></div>
      <div v-else-if="!visibleSuggestions.length" class="review-empty"><strong>{{ pendingCount ? '这个分类暂时没有建议' : '没有待确认的建议' }}</strong><p>{{ pendingCount ? '切换分类查看其他建议。' : '录入新线索后可以再次整理。' }}</p></div>
      <div v-else class="suggestion-list">
        <article v-for="suggestion in visibleSuggestions" :key="suggestion.item.id" class="suggestion-row">
          <div class="suggestion-main">
            <div class="suggestion-title"><span class="kind-pill" :class="`kind-${suggestion.kind}`">{{ kindLabel(suggestion.kind) }}</span><strong>{{ title(suggestion) }}</strong><span v-if="suggestion.kind === 'timeline' && suggestion.item.startsAt.startsWith('--')" class="yearless-pill">无年份</span></div>
            <p :class="['evidence-quote', { expanded: expandedIds.includes(suggestion.item.id) }]">{{ quote(suggestion.item) }}</p>
            <div class="suggestion-meta"><button class="source-link" @click="emit('openClue', sourceNo(suggestion.item))">原线索 #{{ String(sourceNo(suggestion.item)).padStart(3, '0') }} <span>›</span></button><button v-if="isLongQuote(suggestion.item)" class="quote-toggle" :aria-expanded="expandedIds.includes(suggestion.item.id)" @click="toggleQuote(suggestion.item.id)">{{ expandedIds.includes(suggestion.item.id) ? '收起摘录' : '展开摘录' }}</button></div>
          </div>
          <button class="suggestion-action" :disabled="busy" @click="accept(suggestion)">{{ actionLabel(suggestion) }}</button>
        </article>
      </div>
      <footer class="review-footnote">AI 结果可能有误；关系和时间需人工确认，不推断动机、因果或答案。</footer>
    </section>
  </section>
</template>

<style scoped>
.organization-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  box-sizing: border-box;
}
.organize-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.organize-header h1 { margin: 0 0 6px; color: #253d31; font-size: 30px; font-weight: 720; letter-spacing: -.035em; }
.organize-header p { margin: 0; color: #7a857f; font-size: 14px; line-height: 1.6; }
.organize-header .primary-button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 46px; padding: 0 21px; border-radius: 12px; font-size: 14px; white-space: nowrap; }
.organize-spinner { width: 15px; height: 15px; border: 2px solid #ffffff59; border-top-color: #fff; border-radius: 50%; animation: organize-spin .8s linear infinite; }
.organize-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.organize-summary > button { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; min-width: 0; min-height: 80px; padding: 15px 16px; border: 1px solid #e7ebe7; border-radius: 14px; background: #fff; text-align: left; transition: background .18s ease, border-color .18s ease, transform .18s ease; }
.organize-summary strong { color: #315c48; font-size: 26px; font-weight: 680; line-height: 1; font-variant-numeric: tabular-nums; }
.organize-summary span { color: #7b8780; font-size: 12px; white-space: nowrap; }
.organize-summary .pending-summary { border-color: #eedfd6; background: #fcf7f3; }
.organize-summary .pending-summary strong { color: #b66b4d; }
.organize-status { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 5px 13px; border: 1px solid #e9ede8; border-radius: 10px; background: #f6f8f5; color: #7a847e; font-size: 12px; line-height: 1.5; }
.organize-status.ready { border-color: #e1ebe3; background: #f0f6f1; color: #567461; }
.status-dot { flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: #a3aaa4; }
.organize-status.ready .status-dot { background: #659475; }
.status-dot.processing { animation: organize-pulse 1.25s ease-in-out infinite; }
.organize-status button { flex: 0 0 auto; min-width: 44px; min-height: 34px; margin-left: auto; padding: 4px 6px; border-radius: 7px; background: transparent; color: #315c48; font-size: 12px; font-weight: 650; }
.organize-shortcuts { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.shortcut-heading { display: flex; align-items: baseline; gap: 9px; padding: 1px 2px; }
.shortcut-heading strong { color: #53675b; font-size: 13px; font-weight: 650; }
.shortcut-heading span { color: #a0aaa3; font-size: 11px; }
.shortcut-list { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 9px; min-width: 0; }
.shortcut-button { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 52px; padding: 8px 10px; border: 1px solid #e3eae4; border-radius: 12px; background: #fff; color: #3b5a48; text-align: left; transition: background .18s ease, border-color .18s ease, transform .18s ease; }
.shortcut-icon { display: grid; flex: 0 0 30px; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: #edf4ee; color: #4d765d; }
.shortcut-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.shortcut-label { min-width: 0; color: #365440; font-size: 12px; font-weight: 620; line-height: 1.4; white-space: nowrap; }
.shortcut-arrow { margin-left: auto; color: #a4b1a7; font-size: 20px; line-height: 1; }
.review-section { display: flex; flex-direction: column; min-width: 0; scroll-margin-top: 20px; border: 1px solid #e3e8e2; border-radius: 17px; background: #fff; box-shadow: 0 4px 18px #263b2c04; }
.review-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 20px 22px 15px; }
.review-heading h2 { display: flex; align-items: center; gap: 9px; margin: 0 0 5px; color: #2a4434; font-size: 19px; font-weight: 670; letter-spacing: -.025em; }
.review-heading h2 span { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 7px; border-radius: 8px; background: #edf4ee; color: #4d785c; font-size: 11px; font-variant-numeric: tabular-nums; }
.review-heading p { margin: 0; color: #89938c; font-size: 12px; line-height: 1.5; }
.review-heading time { color: #9aa49d; font-size: 11px; white-space: nowrap; }
.review-heading-actions { display: flex; align-items: center; gap: 12px; }
.clear-suggestions-button { min-height: 36px; padding: 0 11px; border: 1px solid #ecdcd2; border-radius: 9px; background: #fff; color: #a36d55; font-size: 12px; white-space: nowrap; }
.review-filters { display: flex; align-items: center; gap: 4px; padding: 0 18px 12px; border-bottom: 1px solid #edf0eb; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.review-filters::-webkit-scrollbar { display: none; }
.review-filters button { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; min-height: 36px; padding: 0 13px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #7c8b80; font-size: 13px; white-space: nowrap; transition: background .18s ease, color .18s ease; }
.review-filters button.active { border-color: #e2ece4; background: #edf4ee; color: #315c48; font-weight: 650; }
.review-filters button.active:after { display: none; }
.review-filters button span { color: #98a69c; font-size: 11px; font-variant-numeric: tabular-nums; }
.review-filters button.active span { color: #668771; }
.suggestion-list { display: flex; flex-direction: column; min-width: 0; padding: 0 21px; }
.suggestion-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 0; min-height: 106px; padding: 19px 0; border-bottom: 1px solid #eef1ec; }
.suggestion-row:last-child { border-bottom: 0; }
.suggestion-main { flex: 1; min-width: 0; }
.suggestion-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.suggestion-title strong { color: #314837; font-size: 15px; line-height: 1.55; font-weight: 650; overflow-wrap: anywhere; }
.kind-pill { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: 36px; height: 22px; padding: 0 7px; border-radius: 6px; background: #edf4ee; color: #67846d; font-size: 11px; white-space: nowrap; }
.kind-relationships { background: #f4efe9; color: #8b7251; }
.kind-timeline { background: #edf3f7; color: #688597; }
.kind-cluePoints { background: #f7f1e7; color: #9c8555; }
.yearless-pill { display: inline-flex; align-items: center; height: 21px; padding: 0 7px; border-radius: 6px; background: #f9f0e7; color: #b07b53; font-size: 10px; white-space: nowrap; }
.evidence-quote { display: -webkit-box; max-width: 850px; margin: 7px 0 4px; color: #768278; font-size: 13px; line-height: 1.7; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.evidence-quote:before { content: '“'; color: #a9b4ab; }
.evidence-quote:after { content: '”'; color: #a9b4ab; }
.evidence-quote.expanded { display: block; overflow: visible; }
.suggestion-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 13px; }
.source-link, .quote-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 32px; margin: 0; padding: 0 2px; border-radius: 5px; background: transparent; color: #66866d; font-size: 12px; }
.source-link span { color: #8ea695; font-size: 18px; }
.quote-toggle { color: #a0aaa3; }
.suggestion-action { flex: 0 0 auto; min-height: 42px; padding: 0 15px; border: 1px solid #d4e2d7; border-radius: 10px; background: #edf4ee; color: #315c48; font-size: 13px; font-weight: 620; white-space: nowrap; transition: background .18s ease, transform .18s ease; }
.review-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 190px; padding: 25px; text-align: center; }
.review-empty strong { color: #4c6253; font-size: 15px; font-weight: 620; }
.review-empty p { margin: 9px 0 0; color: #94a097; font-size: 13px; line-height: 1.6; }
.review-footnote { padding: 13px 21px; border-top: 1px solid #edf0eb; border-radius: 0 0 17px 17px; background: #fafbf9; color: #9aa49c; font-size: 11px; line-height: 1.6; }
button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
button:disabled { cursor: default; opacity: .48; }
button:focus-visible { outline: 2px solid #638772; outline-offset: 3px; }
.organize-summary > button:active, .shortcut-button:active, .suggestion-action:active { transform: scale(.98); }
@media (hover: hover) {
  .organize-summary > button:hover, .shortcut-button:hover { border-color: #bed3c4; background: #f6f9f4; }
  .suggestion-action:hover { background: #e0eddf; border-color: #bccfbe; }
  .review-filters button:hover { background: #f4f7f3; }
  .clear-suggestions-button:hover { background: #fcf5ef; }
  .source-link:hover, .quote-toggle:hover { color: #315c48; }
}
@keyframes organize-spin { to { transform: rotate(360deg); } }
@keyframes organize-pulse { 50% { opacity: .3; } }
@media (max-width: 1050px) {
  .shortcut-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .shortcut-button { padding: 10px 13px; }
  .shortcut-label { font-size: 13px; }
  .organize-summary > button { padding: 13px 11px; }
  .organize-summary span { font-size: 11px; }
  .review-heading-actions { gap: 8px; }
  .review-heading time { display: none; }
}
@media (max-width: 700px) {
  .organization-page { gap: 15px; }
  .organize-header h1 { font-size: 27px; }
  .organize-header p { font-size: 13px; }
  .organize-header .primary-button { min-height: 44px; padding: 0 15px; font-size: 13px; }
  .organize-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .organize-summary > button { min-height: 73px; padding: 13px; }
  .organize-summary strong { font-size: 23px; }
  .organize-summary span { font-size: 12px; }
  .organize-status { font-size: 11px; }
  .review-heading { padding: 18px 17px 14px; }
  .review-heading h2 { font-size: 18px; }
  .review-filters { padding: 0 12px 10px; }
  .review-filters button { gap: 5px; padding: 0 10px; font-size: 12px; }
  .suggestion-list { padding: 0 16px; }
  .suggestion-row { gap: 13px; padding: 17px 0; }
  .suggestion-title strong { font-size: 14px; }
  .suggestion-action { padding: 0 11px; font-size: 12px; }
}
@media (max-width: 480px) {
  .organize-header { align-items: flex-start; gap: 12px; }
  .organize-header h1 { font-size: 25px; }
  .organize-header p { max-width: 215px; font-size: 12px; }
  .organize-header .primary-button { padding: 0 12px; font-size: 12px; }
  .shortcut-list { gap: 7px; }
  .shortcut-button { gap: 6px; padding: 9px 8px; }
  .shortcut-icon { flex-basis: 25px; width: 25px; height: 25px; border-radius: 7px; }
  .shortcut-icon svg { width: 16px; height: 16px; }
  .shortcut-label { font-size: 11px; }
  .shortcut-arrow { display: none; }
  .review-heading { gap: 8px; }
  .review-heading p { font-size: 11px; }
  .clear-suggestions-button { padding: 0 8px; font-size: 11px; }
  .suggestion-row { flex-wrap: wrap; gap: 8px; }
  .suggestion-main { flex-basis: 100%; }
  .suggestion-action { min-height: 40px; margin-left: auto; }
  .review-footnote { padding: 12px 16px; font-size: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *:before, *:after { animation: none !important; transition: none !important; }
}
</style>
