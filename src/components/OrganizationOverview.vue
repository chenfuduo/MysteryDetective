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
}>()
const activeFilter = ref('all')
const expandedIds = ref<string[]>([])
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
  if (suggestion.kind === 'relationships') return `${suggestion.item.from} · ${suggestion.item.label} · ${suggestion.item.to}`
  if (suggestion.kind === 'timeline') return `${dateLabel(suggestion.item.startsAt)} · ${suggestion.item.title}`
  return `${suggestion.item.title}${suggestion.item.category ? ` · ${suggestion.item.category}` : ''}`
}
const actionLabel = (kind: Suggestion['kind']) => ({ people: '加入人物', relationships: '确认关系', timeline: '加入时间线', cluePoints: '应用到线索' })[kind]
const isLongQuote = (item: Suggestion['item']) => item.quote.length > 115
function toggleQuote(id: string) {
  expandedIds.value = expandedIds.value.includes(id) ? expandedIds.value.filter(value => value !== id) : [...expandedIds.value, id]
}
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
      <div><h1>整理线索</h1><p>人物、关系、时间和线索点都在这里核对。</p></div>
      <button v-if="apiConfigured" class="primary-button" :disabled="busy || !clues.some(item => item.ocrText.trim())" @click="emit('analyze')">{{ busy ? '整理中…' : '整理线索' }}</button>
      <button v-else class="primary-button" @click="emit('navigate', 'settings')">配置 AI</button>
    </header>

    <div class="organize-summary">
      <button @click="emit('navigate', 'clues')"><strong>{{ clues.length }}</strong><span>条线索</span></button>
      <div><strong>{{ pendingCount }}</strong><span>条待确认</span></div>
      <button @click="emit('navigate', 'people')"><strong>{{ people.length }}</strong><span>个人物</span></button>
      <button @click="emit('navigate', 'people')"><strong>{{ relationships.length }}</strong><span>条关系</span></button>
      <button @click="emit('navigate', 'timeline')"><strong>{{ events.filter(item => item.confirmed).length }}</strong><span>个时间节点</span></button>
      <button @click="emit('navigate', 'clues')"><strong>{{ cluePointCount }}</strong><span>个线索点</span></button>
    </div>

    <div class="organize-status" :class="{ ready: apiConfigured }">
      <span class="status-dot"></span>
      <span v-if="!apiConfigured">照片和 OCR 保存在本机；AI 整理尚未配置。</span>
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

    <section class="review-section">
      <header class="review-heading"><div><h2>待确认建议 <span>{{ pendingCount }}</span></h2><p>核对出处后再加入档案。</p></div><time v-if="organization">更新于 {{ dateLabel(organization.updatedAt) }}</time></header>
      <nav class="review-filters" aria-label="筛选整理建议">
        <button v-for="filter in filters" :key="filter.id" :class="{ active: activeFilter === filter.id }" @click="activeFilter = filter.id">{{ filter.label }} <span>{{ filter.count }}</span></button>
      </nav>
      <div v-if="!organization" class="review-empty"><strong>还没有整理结果</strong><p>点击右上角“整理线索”生成待核对建议。</p></div>
      <div v-else-if="!visibleSuggestions.length" class="review-empty"><strong>{{ pendingCount ? '这个分类暂时没有建议' : '没有待确认的建议' }}</strong><p>{{ pendingCount ? '切换分类查看其他建议。' : '录入新线索后可以再次整理。' }}</p></div>
      <div v-else class="suggestion-list">
        <article v-for="suggestion in visibleSuggestions" :key="suggestion.item.id" class="suggestion-row">
          <div class="suggestion-main">
            <div class="suggestion-title"><span class="kind-pill" :class="`kind-${suggestion.kind}`">{{ kindLabel(suggestion.kind) }}</span><strong>{{ title(suggestion) }}</strong></div>
            <p :class="['evidence-quote', { expanded: expandedIds.includes(suggestion.item.id) }]">{{ quote(suggestion.item) }}</p>
            <div class="suggestion-meta"><button class="source-link" @click="emit('openClue', sourceNo(suggestion.item))">原线索 #{{ String(sourceNo(suggestion.item)).padStart(3, '0') }} <span>›</span></button><button v-if="isLongQuote(suggestion.item)" class="quote-toggle" @click="toggleQuote(suggestion.item.id)">{{ expandedIds.includes(suggestion.item.id) ? '收起摘录' : '展开摘录' }}</button></div>
          </div>
          <button class="suggestion-action" @click="accept(suggestion)">{{ actionLabel(suggestion.kind) }}</button>
        </article>
      </div>
      <footer class="review-footnote">AI 结果可能有误；关系和时间需人工确认，不推断动机、因果或答案。</footer>
    </section>
  </section>
</template>

<style scoped>
.organization-page{gap:15px;min-height:calc(100dvh - 145px);box-sizing:border-box}.organize-header{display:flex;align-items:center;justify-content:space-between;gap:20px}.organize-header h1{font-size:29px;margin:0 0 5px;color:#263a30;letter-spacing:-.025em}.organize-header p{font-size:13px;color:#69776e;margin:0;line-height:1.5}.organize-header .primary-button{height:43px;padding:0 18px;font-size:13px;white-space:nowrap}.organize-summary{display:flex;align-items:center;justify-content:space-between;min-height:54px;padding:0 4px;border-top:1px solid #e5e9e4;border-bottom:1px solid #e5e9e4}.organize-summary>button,.organize-summary>div{display:flex;align-items:baseline;gap:6px;padding:8px 4px;background:none;color:#748078;white-space:nowrap}.organize-summary strong{font-size:17px;line-height:1;color:#314b3d;font-weight:650}.organize-summary span{font-size:11px;color:#738077}.organize-summary>:nth-child(2)>strong{color:#b06b3f}.organize-status{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 10px;border-radius:6px;background:#f0f3ef;color:#5f6e63;font-size:11px}.organize-status.ready{background:#edf4ef;color:#3f6650}.status-dot{width:7px;height:7px;border-radius:50%;background:#a2aaa3;flex:0 0 auto}.organize-status.ready .status-dot{background:#568466}.organize-status button{margin-left:auto;padding:4px 2px;background:none;color:#385f47;font-size:11px;font-weight:650}.organize-shortcuts{display:flex;align-items:center;gap:12px;min-width:0;padding:2px 0}.shortcut-heading{display:flex;flex:0 0 auto;flex-direction:column;gap:2px;min-width:54px}.shortcut-heading strong{color:#385b43;font-size:11px;font-weight:700;white-space:nowrap}.shortcut-heading span{color:#929d94;font-size:9px;white-space:nowrap}.shortcut-list{display:flex;flex:1;gap:8px;min-width:0;overflow-x:auto;scrollbar-width:none}.shortcut-list::-webkit-scrollbar{display:none}.shortcut-button{display:inline-flex;flex:1 0 92px;align-items:center;gap:7px;min-width:0;min-height:43px;padding:6px 9px;border:1px solid #e1e8e1;border-radius:9px;background:#fbfcfa;color:#42584a;text-align:left;white-space:nowrap;transition:background-color .16s ease,border-color .16s ease,transform .16s ease}.shortcut-button:hover{border-color:#b8cabb;background:#f2f7f2}.shortcut-button:active{transform:translateY(1px)}.shortcut-button:focus-visible{outline:2px solid #477653;outline-offset:2px}.shortcut-icon{display:grid;flex:0 0 26px;place-items:center;width:26px;height:26px;border-radius:7px;background:#eaf1eb;color:#46704f}.shortcut-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.shortcut-label{overflow:hidden;font-size:10px;font-weight:600;text-overflow:ellipsis}.shortcut-arrow{margin-left:auto;color:#8c9a8e;font-size:16px;line-height:1}.review-section{display:flex;flex:1;min-height:365px;flex-direction:column;overflow:hidden;border:1px solid #e0e6e0;border-radius:10px;background:#fff}.review-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:15px 18px 12px}.review-heading h2{margin:0 0 4px;color:#2f4136;font-size:17px}.review-heading h2 span{display:inline-grid;place-items:center;min-width:19px;height:19px;margin-left:5px;padding:0 5px;border-radius:11px;background:#edf3ee;color:#456d52;font-size:10px;vertical-align:2px}.review-heading p{margin:0;color:#7f8a81;font-size:11px}.review-heading time{color:#8e9a91;font-size:10px;white-space:nowrap}.review-filters{display:flex;align-items:center;gap:3px;padding:0 17px;border-bottom:1px solid #e8ede8;overflow-x:auto}.review-filters button{position:relative;display:flex;align-items:center;gap:5px;min-height:38px;padding:0 9px;background:none;color:#65736a;font-size:11px;white-space:nowrap}.review-filters button.active{color:#315b43;font-weight:700}.review-filters button.active:after{position:absolute;content:'';height:2px;left:7px;right:7px;bottom:0;background:#477653;border-radius:2px}.review-filters button span{color:#89958c;font-size:10px}.suggestion-list{display:flex;flex:1;flex-direction:column;padding:0 17px}.suggestion-row{display:flex;flex:1;align-items:center;justify-content:space-between;gap:15px;min-height:108px;padding:13px 2px;border-bottom:1px solid #edf0ec}.suggestion-row:last-child{border-bottom:0}.suggestion-main{min-width:0;flex:1}.suggestion-title{display:flex;align-items:center;gap:8px}.suggestion-title strong{font-size:13px;line-height:1.4;color:#34453a;font-weight:650}.kind-pill{display:inline-flex;align-items:center;justify-content:center;min-width:39px;height:20px;padding:0 6px;border-radius:4px;background:#edf3ee;color:#4e6d56;font-size:10px;white-space:nowrap}.kind-relationships{background:#f2eee8;color:#846644}.kind-timeline{background:#edf2f5;color:#587288}.kind-cluePoints{background:#f4efe6;color:#8f7445}.evidence-quote{display:-webkit-box;max-width:820px;margin:6px 0 5px;color:#59685e;font-size:12px;line-height:1.55;overflow:hidden;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}.evidence-quote:before{content:'“';color:#99a69b}.evidence-quote:after{content:'”';color:#99a69b}.evidence-quote.expanded{display:block;overflow:visible}.suggestion-meta{display:flex;align-items:center;gap:12px}.source-link,.quote-toggle{display:inline-flex;align-items:center;gap:4px;padding:0;background:none;color:#426b4e;font-size:10px}.source-link span{font-size:15px;line-height:10px}.quote-toggle{color:#7e8c81}.suggestion-action{flex:0 0 auto;min-height:34px;padding:0 11px;border:1px solid #315c48;border-radius:6px;background:#315c48;color:#fff;font-size:11px;white-space:nowrap}.suggestion-action:hover{background:#284d3b}.review-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;min-height:155px;text-align:center}.review-empty strong{color:#3d4d41;font-size:14px}.review-empty p{margin:7px 0 0;color:#7d897f;font-size:11px}.review-footnote{padding:9px 17px;border-top:1px solid #edf0ec;color:#7f8b81;font-size:10px;line-height:1.45;background:#fbfcfa}@media(max-width:850px){.organization-page{gap:12px;min-height:calc(100dvh - 132px)}.organize-header h1{font-size:25px}.organize-header p{font-size:12px}.organize-header .primary-button{height:40px;padding:0 13px;font-size:12px}.organize-summary{overflow-x:auto;justify-content:flex-start;gap:16px;min-height:47px}.organize-summary>button,.organize-summary>div{gap:4px}.organize-summary strong{font-size:16px}.organize-summary span{font-size:10px}.organize-shortcuts{gap:9px}.shortcut-heading{min-width:48px}.shortcut-button{flex-basis:86px;gap:5px;padding:6px 7px}.shortcut-icon{flex-basis:24px;width:24px;height:24px}.shortcut-label{font-size:9px}.shortcut-arrow{font-size:14px}.review-section{min-height:360px}.review-heading{padding:13px 14px 10px}.review-filters{padding:0 11px}.suggestion-list{padding:0 12px}.suggestion-row{min-height:100px;gap:10px}.evidence-quote{font-size:11px}.suggestion-action{padding:0 9px;font-size:10px}}@media(max-width:520px){.organization-page{gap:10px;min-height:calc(100dvh - 122px)}.organize-header{align-items:flex-start}.organize-header h1{font-size:23px}.organize-header p{max-width:225px;font-size:11px}.organize-header .primary-button{height:37px;padding:0 9px;font-size:10px}.organize-summary{gap:11px}.organize-summary>button,.organize-summary>div{flex-direction:column;align-items:center;gap:3px}.organize-status{font-size:10px}.organize-shortcuts{align-items:flex-start;flex-direction:column;gap:6px}.shortcut-heading{flex-direction:row;align-items:baseline;gap:7px}.shortcut-heading strong{font-size:10px}.shortcut-list{width:100%;flex:none}.shortcut-button{flex:0 0 auto;min-width:91px;min-height:40px}.shortcut-label{font-size:10px}.review-section{min-height:350px}.review-heading{align-items:flex-start;flex-direction:column;gap:4px}.review-heading time{display:none}.review-filters{padding:0 7px}.review-filters button{min-height:36px;padding:0 8px;font-size:10px}.suggestion-row{align-items:flex-start;min-height:114px;flex-direction:column;gap:8px;padding:12px 1px}.suggestion-title{align-items:flex-start}.suggestion-title strong{font-size:12px}.evidence-quote{font-size:11px}.suggestion-action{align-self:flex-end;min-height:31px;font-size:10px}.review-footnote{font-size:9px}}
</style>
