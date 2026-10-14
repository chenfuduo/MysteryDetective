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
  navigate: [view: 'clues' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings']
  openClue: [sourceNo: number]
  acceptPerson: [id: string]
  acceptRelationship: [id: string]
  acceptTimeline: [id: string]
  acceptCluePoint: [id: string]
}>()
const activeFilter = ref('all')
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
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
const kindLabel = (kind: Suggestion['kind']) => ({ people: '人物', relationships: '关系', timeline: '时间', cluePoints: '线索点' })[kind]
const sourceNo = (item: Suggestion['item']) => item.sourceNo
const quote = (item: Suggestion['item']) => item.quote
const title = (suggestion: Suggestion) => {
  if (suggestion.kind === 'people') return `${suggestion.item.name}${suggestion.item.aliases.length ? ` · 又名 ${suggestion.item.aliases.join('、')}` : ''}`
  if (suggestion.kind === 'relationships') return `${suggestion.item.from}  ·  ${suggestion.item.label}  ·  ${suggestion.item.to}`
  if (suggestion.kind === 'timeline') return `${dateLabel(suggestion.item.startsAt)}  ·  ${suggestion.item.title}`
  return `${suggestion.item.title}${suggestion.item.category ? `  ·  ${suggestion.item.category}` : ''}`
}
const actionLabel = (kind: Suggestion['kind']) => ({ people: '加入人物', relationships: '确认关系', timeline: '确认时间', cluePoints: '应用到线索' })[kind]
function accept(suggestion: Suggestion) {
  if (suggestion.kind === 'people') emit('acceptPerson', suggestion.item.id)
  else if (suggestion.kind === 'relationships') emit('acceptRelationship', suggestion.item.id)
  else if (suggestion.kind === 'timeline') emit('acceptTimeline', suggestion.item.id)
  else emit('acceptCluePoint', suggestion.item.id)
}
</script>

<template>
  <section class="page organization-page">
    <header class="organize-header">
      <div><span class="organize-kicker">当前剧本</span><h1>整理线索</h1><p>把线索分成人物、关系、时间和线索点，逐条核对原文。</p></div>
      <button v-if="apiConfigured" class="primary-button" :disabled="busy || !clues.some(item => item.ocrText.trim())" @click="emit('analyze')">{{ busy ? '正在整理…' : '整理线索' }}</button>
      <button v-else class="primary-button" @click="emit('navigate', 'settings')">配置 AI 整理</button>
    </header>

    <div class="organize-strip">
      <button @click="emit('navigate', 'clues')"><strong>{{ clues.length }}</strong><span>条线索</span></button>
      <i></i><button @click="emit('navigate', 'people')"><strong>{{ people.length }}</strong><span>个人物</span></button>
      <i></i><button @click="emit('navigate', 'people')"><strong>{{ relationships.length }}</strong><span>条已确认关系</span></button>
      <i></i><button @click="emit('navigate', 'timeline')"><strong>{{ events.filter(item => item.confirmed).length }}</strong><span>个已确认时间</span></button>
      <i></i><button @click="emit('navigate', 'clues')"><strong>{{ cluePointCount }}</strong><span>个线索点</span></button>
    </div>

    <div class="organize-status" :class="{ ready: apiConfigured }">
      <span class="status-dot"></span>
      <span v-if="!apiConfigured">AI 整理未配置。照片和 OCR 仍保存在本机。</span>
      <span v-else-if="autoOrganize">新增线索会自动整理，OCR 文字将发送到 DeepSeek。</span>
      <span v-else>手动整理。仅发送 OCR 文字和线索编号，照片留在本机。</span>
      <button @click="emit('navigate', 'settings')">{{ autoOrganize ? '管理设置' : '设置' }}</button>
    </div>

    <nav class="organize-shortcuts" aria-label="整理工具">
      <button @click="emit('navigate', 'people')">人物档案 <span>›</span></button>
      <button @click="emit('navigate', 'timeline')">时间线 <span>›</span></button>
      <button @click="emit('navigate', 'board')">整理板 <span>›</span></button>
      <button @click="emit('navigate', 'notes')">笔记 <span>›</span></button>
      <button @click="emit('navigate', 'compare')">线索对照 <span>›</span></button>
    </nav>

    <section class="review-section">
      <header class="review-heading"><div><h2>待确认 <span>{{ pendingCount }}</span></h2><p>每条建议都附有原文出处，确认后才会写入档案。</p></div><time v-if="organization">{{ dateLabel(organization.updatedAt) }}</time></header>
      <nav class="review-filters" aria-label="筛选整理建议">
        <button v-for="filter in filters" :key="filter.id" :class="{ active: activeFilter === filter.id }" @click="activeFilter = filter.id">{{ filter.label }} <span>{{ filter.count }}</span></button>
      </nav>
      <div v-if="!organization" class="review-empty"><strong>还没有整理结果</strong><p>录入线索后，点击“整理线索”生成可核对的建议。</p></div>
      <div v-else-if="!visibleSuggestions.length" class="review-empty"><strong>{{ pendingCount ? '这个分类暂时没有建议' : '没有待确认的建议' }}</strong><p>{{ pendingCount ? '切换上方分类查看其他建议。' : '可以重新整理新录入的线索。' }}</p></div>
      <div v-else class="suggestion-list">
        <article v-for="suggestion in visibleSuggestions" :key="suggestion.item.id" class="suggestion-row">
          <div class="suggestion-main">
            <div class="suggestion-title"><span class="kind-pill" :class="`kind-${suggestion.kind}`">{{ kindLabel(suggestion.kind) }}</span><strong>{{ title(suggestion) }}</strong></div>
            <p class="evidence-quote">{{ quote(suggestion.item) }}</p>
            <button class="source-link" @click="emit('openClue', sourceNo(suggestion.item))">查看线索 #{{ String(sourceNo(suggestion.item)).padStart(3, '0') }} <span>›</span></button>
          </div>
          <button class="suggestion-action" @click="accept(suggestion)">{{ actionLabel(suggestion.kind) }}</button>
        </article>
      </div>
    </section>
    <p class="organize-footnote">整理结果由模型生成，可能有误。人物关系和时间节点需你确认；不会分析动机、因果或案件答案。</p>
  </section>
</template>

<style scoped>
.organization-page{gap:20px}.organize-header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.organize-kicker{font-size:11px;color:#728078;letter-spacing:.04em}.organize-header h1{font-size:30px;margin:5px 0 6px;color:#26362f;letter-spacing:-.025em}.organize-header p{font-size:14px;color:#76817a;margin:0;line-height:1.5}.organize-header .primary-button{height:44px;padding:0 19px;font-size:13px;white-space:nowrap}.organize-strip{display:flex;align-items:center;justify-content:space-between;min-height:75px;padding:12px 18px;background:#fff;border:1px solid #e6e9e4;border-radius:12px}.organize-strip button{display:flex;align-items:baseline;gap:7px;background:none;color:#657168;padding:6px;text-align:left}.organize-strip strong{font-size:22px;line-height:1;color:#32473c;font-weight:650}.organize-strip span{font-size:12px;color:#78837a}.organize-strip i{height:30px;width:1px;background:#e8ebe6}.organize-status{display:flex;align-items:center;gap:9px;min-height:40px;padding:8px 12px;border-radius:8px;background:#f2f3ef;color:#6f7c72;font-size:12px}.organize-status.ready{background:#f0f5f1;color:#486557}.status-dot{width:7px;height:7px;border-radius:50%;background:#a4aaa3;flex:0 0 auto}.organize-status.ready .status-dot{background:#5e8b70}.organize-status button{margin-left:auto;padding:4px 2px;background:none;color:#406957;font-size:12px;font-weight:650;white-space:nowrap}.organize-shortcuts{display:flex;align-items:center;gap:8px;overflow-x:auto;padding:1px 0 5px}.organize-shortcuts button{display:flex;align-items:center;gap:14px;min-height:38px;padding:0 13px;background:#fff;border:1px solid #e5e9e4;border-radius:7px;color:#536258;font-size:12px;white-space:nowrap}.organize-shortcuts button span{color:#9aa49c;font-size:16px}.organize-shortcuts button:hover{border-color:#b9c8be;background:#fafcf9}.review-section{background:#fff;border:1px solid #e5e9e4;border-radius:12px;overflow:hidden}.review-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:19px 21px 15px}.review-heading h2{margin:0 0 5px;color:#2f3e35;font-size:18px}.review-heading h2 span{display:inline-grid;place-items:center;min-width:21px;height:21px;margin-left:5px;padding:0 5px;border-radius:11px;background:#edf2ee;color:#53715e;font-size:11px;vertical-align:2px}.review-heading p{margin:0;color:#808b82;font-size:12px}.review-heading time{color:#9ba49b;font-size:11px;white-space:nowrap}.review-filters{display:flex;align-items:center;gap:4px;padding:0 20px;border-bottom:1px solid #edf0eb;overflow-x:auto}.review-filters button{position:relative;display:flex;align-items:center;gap:6px;min-height:42px;padding:0 10px;background:none;color:#768179;font-size:12px;white-space:nowrap}.review-filters button.active{color:#315c48;font-weight:650}.review-filters button.active:after{position:absolute;content:'';height:2px;left:8px;right:8px;bottom:0;background:#4f765f;border-radius:2px}.review-filters button span{color:#a0a9a0;font-size:10px}.suggestion-list{padding:0 20px}.suggestion-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 0;border-bottom:1px solid #eef0ec}.suggestion-row:last-child{border-bottom:0}.suggestion-main{min-width:0}.suggestion-title{display:flex;align-items:center;gap:9px}.suggestion-title strong{font-size:14px;line-height:1.45;color:#344239;font-weight:650}.kind-pill{display:inline-flex;align-items:center;justify-content:center;min-width:39px;height:22px;padding:0 7px;border-radius:5px;background:#f0f3ef;color:#607468;font-size:10px;white-space:nowrap}.kind-relationships{background:#f4f0eb;color:#8a6a4a}.kind-timeline{background:#edf2f5;color:#59758a}.kind-cluePoints{background:#f6f0e7;color:#977343}.evidence-quote{max-width:760px;margin:7px 0 6px;color:#69756c;font-size:13px;line-height:1.55;overflow-wrap:anywhere}.evidence-quote:before{content:'“';color:#a8b0a8}.evidence-quote:after{content:'”';color:#a8b0a8}.source-link{display:inline-flex;align-items:center;gap:4px;padding:0;background:none;color:#547561;font-size:11px}.source-link span{font-size:16px;line-height:10px}.suggestion-action{flex:0 0 auto;min-height:36px;padding:0 12px;border:1px solid #d8e2da;border-radius:7px;background:#f7faf7;color:#41634d;font-size:12px;white-space:nowrap}.suggestion-action:hover{background:#edf4ee;border-color:#b7caba}.review-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:160px;text-align:center}.review-empty strong{color:#415047;font-size:14px}.review-empty p{margin:7px 0 0;color:#909990;font-size:12px}.organize-footnote{margin:-7px 0 0;color:#929c93;font-size:11px;line-height:1.5}@media(max-width:850px){.organization-page{gap:15px}.organize-header h1{font-size:27px}.organize-strip{min-height:68px;padding:10px 12px}.organize-strip button{flex-direction:column;align-items:center;gap:4px;text-align:center}.organize-strip strong{font-size:19px}.organize-strip span{font-size:10px}.organize-shortcuts{gap:6px}.organize-shortcuts button{gap:8px;padding:0 10px;font-size:11px}.review-heading{padding:15px}.review-filters{padding:0 12px}.suggestion-list{padding:0 14px}.suggestion-row{gap:10px}.suggestion-title strong{font-size:13px}.evidence-quote{font-size:12px}}@media(max-width:520px){.organize-header{align-items:flex-start}.organize-header h1{font-size:24px}.organize-header p{font-size:12px;max-width:280px}.organize-header .primary-button{height:39px;padding:0 11px;font-size:11px}.organize-strip{overflow-x:auto;justify-content:flex-start;gap:7px}.organize-strip button{min-width:64px}.organize-strip i{flex:0 0 1px}.organize-status{font-size:11px}.review-heading{align-items:flex-start;flex-direction:column;gap:5px}.suggestion-row{align-items:flex-start;flex-direction:column}.suggestion-action{align-self:flex-end}.suggestion-title{align-items:flex-start}.suggestion-title strong{font-size:13px}}
</style>
