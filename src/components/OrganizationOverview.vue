<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { classifyReview, type ReviewGroup } from '../services/reviewClassification'
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
  apiProvider: string
  canUndo?: boolean
  progress?: string
  pendingOcrCount?: number
  unfinishedTaskCount?: number
  organizationActive?: boolean
}>()
const emit = defineEmits<{
  analyze: []
  retrySource: [sourceNo: number]
  capture: []
  'retry-ocr': []
  resume: []
  discuss: []
  openWorkbench: []
  navigate: [view: 'clues' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings', section?: 'profiles' | 'relationships']
  openClue: [sourceNo: number, quote?: string]
  acceptPerson: [id: string]
  acceptRelationship: [id: string]
  acceptTimeline: [id: string]
  acceptCluePoint: [id: string]
  clearSuggestions: []
  bulkAccept: [selection: { kind: Suggestion['kind']; id: string }[]]
  bulkIgnore: [selection: { kind: Suggestion['kind']; id: string }[]]
  undo: []
}>()
const activeFilter = ref('all')
const activeGroup = ref<ReviewGroup | 'all' | null>(null)
const batchMessage = ref('')
const expandedIds = ref<string[]>([])
const reviewElement = ref<HTMLElement | null>(null)
const selectedKeys = ref<string[]>([])
const selectionKey = (suggestion: Suggestion) => `${suggestion.kind}:${suggestion.item.id}`
function focusSuggestions() {
  activeFilter.value = 'all'
  activeGroup.value = null
  reviewElement.value?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
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
const hasOcrText = computed(() => props.clues.some(clue => clue.ocrText.trim()))
type NextActionId = 'processing' | 'capture' | 'ocr' | 'resume' | 'review' | 'analyze' | 'configure' | 'discuss'
const nextAction = computed<{ id: NextActionId; label: string; detail: string }>(() => {
  if (props.organizationActive) return { id: 'processing', label: '整理中…', detail: '当前阶段会自动保存，可以在顶部暂停整理。' }
  if (!props.clues.length) return { id: 'capture', label: '拍照录入', detail: '拍下第一张线索，OCR 文字会自动识别并保存在本机。' }
  if (props.pendingOcrCount) return { id: 'ocr', label: '处理待识别照片', detail: `还有 ${props.pendingOcrCount} 张照片需要识别，先补齐文字再整理。` }
  if (props.unfinishedTaskCount) return { id: 'resume', label: '继续整理', detail: `还有 ${props.unfinishedTaskCount} 条线索待继续，已完成阶段会保留。` }
  if (pendingCount.value) return { id: 'review', label: '逐条录入', detail: `有 ${pendingCount.value} 条建议待确认，可以直接录入，也可按需查看原文。` }
  if (!hasOcrText.value) return { id: 'ocr', label: '处理待识别照片', detail: '已有照片尚无识别文字，先完成 OCR。' }
  if (!props.organization) return props.apiConfigured
    ? { id: 'analyze', label: '整理线索', detail: '已识别的文字可以整理为人物、关系、时间和线索点。' }
    : { id: 'configure', label: '配置 AI', detail: '照片与 OCR 已保存在本机，配置 AI 后可生成整理建议。' }
  return { id: 'discuss', label: '讨论查看', detail: '当前没有待确认建议，可以查阅已确认的人物、关系和时间。' }
})
const canAnalyze = computed(() => props.apiConfigured && hasOcrText.value && !props.busy)
const showAnalyzeSecondary = computed(() => ['review', 'discuss', 'resume', 'ocr'].includes(nextAction.value.id) && hasOcrText.value)
const emptyHeading = computed(() => ({ capture: '先收集第一条线索', ocr: '先补齐识别文字', resume: '已有进度，接着整理', analyze: '文字已就绪', configure: '开始整理已识别的文字', discuss: '待确认建议已处理', processing: '正在整理线索', review: '选择要加入档案的内容' })[nextAction.value.id] || '开始整理线索')
function runNextAction() {
  if (props.busy) return
  if (nextAction.value.id === 'capture') emit('capture')
  else if (nextAction.value.id === 'ocr') emit('retry-ocr')
  else if (nextAction.value.id === 'resume') emit('resume')
  else if (nextAction.value.id === 'review') emit('openWorkbench')
  else if (nextAction.value.id === 'analyze') emit('analyze')
  else if (nextAction.value.id === 'configure') emit('navigate', 'settings')
  else if (nextAction.value.id === 'discuss') emit('discuss')
}
const reviewInfo = computed(() => new Map(allSuggestions.value.map(suggestion => [selectionKey(suggestion), classifyReview(suggestion, props.clues)])))
const classification = (suggestion: Suggestion) => reviewInfo.value.get(selectionKey(suggestion))!
const groupLabel = (group: ReviewGroup) => ({ ready: '可直接录入', 'needs-content': '需要补充', 'needs-review': '需要修正' })[group]
const effectiveGroup = computed(() => activeGroup.value || (allSuggestions.value.some(suggestion => classification(suggestion).group === 'needs-review') ? 'needs-review' : allSuggestions.value.some(suggestion => classification(suggestion).group === 'needs-content') ? 'needs-content' : 'ready'))
const groupSuggestions = computed(() => effectiveGroup.value === 'all' ? allSuggestions.value : allSuggestions.value.filter(suggestion => classification(suggestion).group === effectiveGroup.value))
const kindSuggestions = computed(() => activeFilter.value === 'all' ? allSuggestions.value : allSuggestions.value.filter(suggestion => suggestion.kind === activeFilter.value))
const groups = computed(() => [
  { id: 'needs-review' as const, label: '需要修正', count: kindSuggestions.value.filter(suggestion => classification(suggestion).group === 'needs-review').length },
  { id: 'needs-content' as const, label: '需要补充', count: kindSuggestions.value.filter(suggestion => classification(suggestion).group === 'needs-content').length },
  { id: 'ready' as const, label: '可直接录入', count: kindSuggestions.value.filter(suggestion => classification(suggestion).group === 'ready').length },
  { id: 'all' as const, label: '全部', count: kindSuggestions.value.length },
])
const filters = computed(() => [
  { id: 'all', label: '全部', count: groupSuggestions.value.length },
  { id: 'people', label: '人物', count: groupSuggestions.value.filter(item => item.kind === 'people').length },
  { id: 'relationships', label: '关系', count: groupSuggestions.value.filter(item => item.kind === 'relationships').length },
  { id: 'timeline', label: '时间', count: groupSuggestions.value.filter(item => item.kind === 'timeline').length },
  { id: 'cluePoints', label: '线索点', count: groupSuggestions.value.filter(item => item.kind === 'cluePoints').length },
])
const visibleSuggestions = computed(() => activeFilter.value === 'all' ? groupSuggestions.value : groupSuggestions.value.filter(item => item.kind === activeFilter.value))
const selectedSuggestions = computed(() => allSuggestions.value.filter(item => selectedKeys.value.includes(selectionKey(item))))
const selectedCount = computed(() => selectedSuggestions.value.length)
const selectedAcceptable = computed(() => selectedSuggestions.value.filter(item => classification(item).group === 'ready'))
const hiddenSelectedCount = computed(() => selectedSuggestions.value.filter(item => !visibleSuggestions.value.includes(item)).length)
const blockedSelectedCount = computed(() => selectedCount.value - selectedAcceptable.value.length)
const allVisibleSelected = computed(() => visibleSuggestions.value.length > 0 && visibleSuggestions.value.every(item => selectedKeys.value.includes(selectionKey(item))))
watch(allSuggestions, items => {
  const available = new Set(items.map(selectionKey))
  selectedKeys.value = selectedKeys.value.filter(key => available.has(key))
})
watch(() => props.organization?.scriptId, () => {
  activeGroup.value = null
  selectedKeys.value = []
  batchMessage.value = ''
})
function viewSource(suggestion: Suggestion) {
  if (!classification(suggestion).sourceExists) return
  emit('openClue', suggestion.item.sourceNo, suggestion.item.quote)
}
function selectSuggestion(suggestion: Suggestion) {
  if (props.busy) return
  const key = selectionKey(suggestion)
  selectedKeys.value = selectedKeys.value.includes(key) ? selectedKeys.value.filter(value => value !== key) : [...selectedKeys.value, key]
}
function selectVisible() {
  if (props.busy) return
  const visible = new Set(visibleSuggestions.value.map(selectionKey))
  selectedKeys.value = allVisibleSelected.value ? selectedKeys.value.filter(key => !visible.has(key)) : [...new Set([...selectedKeys.value, ...visible])]
}
function bulk(action: 'accept' | 'ignore') {
  if (props.busy || !selectedCount.value) return
  const items = action === 'accept' ? selectedAcceptable.value : selectedSuggestions.value
  batchMessage.value = action === 'accept' && blockedSelectedCount.value ? `已跳过 ${blockedSelectedCount.value} 项需要补充或修正的建议，仍保留在列表中。` : ''
  const selection = items.map(item => ({ kind: item.kind, id: item.item.id }))
  if (!selection.length) return
  if (action === 'accept') emit('bulkAccept', selection)
  else emit('bulkIgnore', selection)
}
const analysisLabel = computed(() => {
  const analysis = props.organization?.analysis
  if (!analysis) return ''
  const provider = analysis.provider === 'local' ? `本地整理${analysis.localReason === 'offline' ? '（网络不可用）' : analysis.localReason === 'quota' ? '（API 余额不足）' : ''}` : analysis.provider === 'openai' ? 'GPT' : 'DeepSeek'
  return provider
})
const precisionLabel = (item: OrganizationTimelineSuggestion) => ({ date: '仅日期', hour: '精确到时', minute: '精确到分' })[item.precision || (/T\d{2}:\d{2}$/.test(item.startsAt) ? 'minute' : /T\d{2}$/.test(item.startsAt) ? 'hour' : 'date')]
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
  if (suggestion.kind === 'timeline') return `${dateLabel(suggestion.item.startsAt)}${suggestion.item.timeOfDay && !/T\d{2}/.test(suggestion.item.startsAt) ? ` ${suggestion.item.timeOfDay}` : ''} · ${suggestion.item.title}`
  return `${suggestion.item.title}${suggestion.item.category ? ` · ${suggestion.item.category}` : ''}`
}
const actionLabel = (suggestion: Suggestion) => ({ ready: '直接录入', 'needs-content': '补充事件', 'needs-review': '重新整理' })[classification(suggestion).group]


const isLongQuote = (item: Suggestion['item']) => item.quote.length > 115
function toggleQuote(id: string) {
  expandedIds.value = expandedIds.value.includes(id) ? expandedIds.value.filter(value => value !== id) : [...expandedIds.value, id]
}
function accept(suggestion: Suggestion) {
  if (props.busy) return
  if (classification(suggestion).group === 'needs-review') { emit('retrySource', suggestion.item.sourceNo); return }
  if (suggestion.kind === 'people') emit('acceptPerson', suggestion.item.id)
  else if (suggestion.kind === 'relationships') emit('acceptRelationship', suggestion.item.id)
  else if (suggestion.kind === 'timeline') emit('acceptTimeline', suggestion.item.id)
  else emit('acceptCluePoint', suggestion.item.id)
}
</script>

<template>
  <section class="page organization-page" :aria-busy="busy">
    <header class="organize-header">
      <div><h1>整理总览</h1></div>
      <div class="organize-header-actions">
        <button v-if="clues.length && nextAction.id !== 'discuss'" class="secondary-button discussion-entry" :disabled="busy" @click="emit('discuss')">讨论查看</button>
        <button v-if="showAnalyzeSecondary" class="secondary-button" :disabled="!canAnalyze" @click="emit('analyze')">{{ nextAction.id === 'review' ? '整理新增／修改' : '整理线索' }}</button>
        <button class="primary-button" :disabled="busy || organizationActive" @click="runNextAction"><span v-if="organizationActive" class="organize-spinner" aria-hidden="true"></span>{{ nextAction.label }}</button>
      </div>
    </header>

    <nav class="organize-shortcuts" aria-label="整理工具">
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
          <span class="shortcut-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="8" height="11" rx="1.5" /><rect x="8.5" y="6" width="8" height="11" rx="1.5" /><path d="M6 7h3M11 9h3M11 12h3" /></svg></span><span class="shortcut-label">记录对照</span><span class="shortcut-arrow">›</span>
        </button>
      </div>
    </nav>

    <section v-if="!pendingCount" class="review-section next-step-section">
      <div class="review-empty next-step-empty" role="status">
        <strong>{{ emptyHeading }}</strong>
        <p>{{ nextAction.detail }}</p>
      </div>
      <div v-if="canUndo" class="empty-undo"><button class="text-button" :disabled="busy" @click="emit('undo')">撤销上一步</button></div>
    </section>

    <section v-else class="review-section">
      <header class="review-heading"><div><h2><span>{{ pendingCount }}</span></h2></div><nav class="review-groups" aria-label="按处理步骤筛选">
        <button v-for="group in groups" :key="group.id" :class="{ active: effectiveGroup === group.id }" :aria-pressed="effectiveGroup === group.id" @click="activeGroup = group.id">{{ group.label }} <span>{{ group.count }}</span></button>
      </nav><div class="review-heading-actions"><button v-if="nextAction.id !== 'review'" class="workbench-entry" :disabled="busy" @click="emit('openWorkbench')">逐条录入 <span aria-hidden="true">↗</span></button><time v-if="organization">更新于 {{ dateLabel(organization.updatedAt) }}</time><button v-if="pendingCount" class="clear-suggestions-button" :disabled="busy" @click="emit('clearSuggestions')">清除全部</button></div></header>
      
      <nav class="review-filters" aria-label="筛选整理建议">
        <button v-for="filter in filters" :key="filter.id" :class="{ active: activeFilter === filter.id }" :aria-pressed="activeFilter === filter.id" @click="activeFilter = filter.id">{{ filter.label }} <span>{{ filter.count }}</span></button>
      </nav>
      <div ref="reviewElement" class="review-scroll-region">
      <div v-if="pendingCount || canUndo" class="review-batch">
        <label v-if="visibleSuggestions.length" class="batch-select"><input type="checkbox" :checked="allVisibleSelected" :disabled="busy" @change="selectVisible" /><span>全选当前 {{ visibleSuggestions.length }} 项</span></label>
        <span class="batch-count" role="status">共选 {{ selectedCount }} 项<span v-if="hiddenSelectedCount">（其中 {{ hiddenSelectedCount }} 项在其他筛选中）</span></span>
        <div class="batch-actions"><button :disabled="busy || !selectedAcceptable.length" class="batch-accept" @click="bulk('accept')">录入可用项{{ selectedAcceptable.length ? ` ${selectedAcceptable.length}` : '' }}</button><button :disabled="busy || !selectedCount" @click="bulk('ignore')">忽略所选{{ selectedCount ? ` ${selectedCount}` : '' }}</button><button :disabled="busy || !canUndo" @click="emit('undo')">撤销上一步</button></div>
        <p v-if="blockedSelectedCount" class="batch-incomplete">所选 {{ blockedSelectedCount }} 项需要补充或修正，将跳过录入；“忽略所选”仍适用于全部所选项。</p><p v-if="batchMessage" class="batch-incomplete" role="status">{{ batchMessage }}</p>
      </div>
      <div v-if="!visibleSuggestions.length" class="review-empty"><strong>当前筛选下没有建议</strong><button class="text-button" @click="focusSuggestions">显示待处理建议</button></div>
      <div v-else class="suggestion-list">
        <article v-for="suggestion in visibleSuggestions" :key="selectionKey(suggestion)" class="suggestion-row" :class="{ 'is-selected': selectedKeys.includes(selectionKey(suggestion)) }">
          <label class="suggestion-select"><input type="checkbox" :checked="selectedKeys.includes(selectionKey(suggestion))" :disabled="busy" :aria-label="`选择${title(suggestion)}`" @change="selectSuggestion(suggestion)" /></label>
          <div class="suggestion-main">
            <div class="suggestion-title"><span class="kind-pill" :class="`kind-${suggestion.kind}`">{{ kindLabel(suggestion.kind) }}</span><strong>{{ title(suggestion) }}</strong><span class="review-group-pill" :class="classification(suggestion).group">{{ groupLabel(classification(suggestion).group) }}</span><span v-if="suggestion.kind === 'timeline' && suggestion.item.startsAt.startsWith('--')" class="yearless-pill">无年份</span><span v-if="suggestion.kind === 'timeline'" class="precision-pill">{{ precisionLabel(suggestion.item) }}</span><span v-if="suggestion.kind === 'timeline' && suggestion.item.approximate" class="precision-pill is-approximate">约时</span><span v-if="suggestion.kind === 'timeline' && (suggestion.item.requiresTitle || !suggestion.item.title.trim())" class="needs-title-pill">需补充事件</span></div>
            <p :class="['evidence-quote', { expanded: expandedIds.includes(suggestion.item.id) }]">{{ quote(suggestion.item) }}</p>
            <div class="suggestion-meta"><button class="source-link" :disabled="!classification(suggestion).sourceExists" @click="viewSource(suggestion)">原线索 #{{ String(sourceNo(suggestion.item)).padStart(3, '0') }} <span>›</span></button><template v-if="suggestion.kind === 'timeline'"><button v-for="source in suggestion.item.evidence?.filter(item => item.sourceNo !== suggestion.item.sourceNo || item.quote !== suggestion.item.quote) || []" :key="`${source.clueId}:${source.quote}`" class="source-link" @click="emit('openClue', source.sourceNo, source.quote)">另见 #{{ String(source.sourceNo).padStart(3, '0') }} <span>›</span></button></template><button v-if="isLongQuote(suggestion.item)" class="quote-toggle" :aria-expanded="expandedIds.includes(suggestion.item.id)" @click="toggleQuote(suggestion.item.id)">{{ expandedIds.includes(suggestion.item.id) ? '收起摘录' : '展开摘录' }}</button></div>
            <p class="review-next-step" :class="classification(suggestion).group">{{ classification(suggestion).reason }}</p>
          </div>
          <div class="suggestion-actions"><button class="suggestion-action" :disabled="busy" @click="accept(suggestion)">{{ actionLabel(suggestion) }}</button></div>
        </article>
      </div>
      <footer class="review-footnote">录入后可以继续编辑或撤销。所有建议均保留原线索出处。</footer>
      </div>
    </section>
  </section>
</template>

<style scoped>
.organization-page {
  --overview-ink: var(--cv-ink);
  --overview-muted: var(--cv-muted);
  --overview-accent: var(--cv-accent);
  --overview-line: var(--cv-border);
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  width: 100%;
  box-sizing: border-box;
  color: var(--overview-ink);
}
.organize-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 24px; }
.organize-header h1 { margin: 0; color: var(--overview-ink); font-size: var(--cv-type-page); font-weight: 650; letter-spacing: 0; }
.organize-header p { max-width: 560px; margin: 6px 0 0; color: var(--overview-muted); font-size: 14px; line-height: 1.7; }
.organize-header-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; flex-shrink: 0; }
.organize-header-actions .discussion-entry { margin-left: 0; }
.organize-header-actions .secondary-button { min-height: 44px; padding: 0 16px; border: 1px solid var(--overview-line); border-radius: var(--cv-radius-control); background: var(--cv-surface); color: var(--cv-secondary); font-size: 13px; box-shadow: none; white-space: nowrap; }
.organize-header .primary-button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 44px; padding: 0 21px; border: 1px solid var(--overview-accent); border-radius: var(--cv-radius-control); background: var(--overview-accent); color: var(--cv-on-accent); font-size: 14px; font-weight: 600; white-space: nowrap; box-shadow: none; }
.organize-spinner { width: 15px; height: 15px; border: 2px solid color-mix(in srgb, var(--cv-on-accent) 35%, transparent); border-top-color: var(--cv-on-accent); border-radius: 50%; animation: organize-spin .8s linear infinite; }
.organize-status { display: flex; align-items: center; gap: 8px; min-height: 32px; margin-top: -13px; padding: 0; border: 0; background: transparent; color: var(--overview-muted); font-size: 12px; line-height: 1.6; }
.status-dot { flex: 0 0 5px; width: 5px; height: 5px; border-radius: 50%; background: var(--cv-muted); }
.organize-status.ready .status-dot { background: var(--cv-success); }
.status-dot.processing { animation: organize-pulse 1.25s ease-in-out infinite; }
.organize-status button { flex: 0 0 auto; min-width: 44px; min-height: 36px; margin-left: auto; padding: 4px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--overview-accent); font-size: 12px; }
.organize-shortcuts { display: flex; flex-shrink: 0; min-width: 0; }
.shortcut-list { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0; min-width: 0; width: 100%; padding: 3px; border: 1px solid var(--overview-line); border-radius: var(--cv-radius-panel); background: var(--cv-surface); }
.shortcut-button { display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; min-height: 42px; padding: 4px 8px; border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--cv-secondary); text-align: left; transition: background-color var(--cv-motion-press) var(--cv-ease), color var(--cv-motion-press) var(--cv-ease); }
.shortcut-button + .shortcut-button { position: relative; }
.shortcut-button + .shortcut-button:before { position: absolute; left: -1px; top: 10px; bottom: 10px; width: 1px; background: var(--cv-border); content: ''; }
.shortcut-icon { display: grid; flex: 0 0 21px; place-items: center; width: 21px; height: 21px; color: var(--cv-accent); }
.shortcut-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.shortcut-label { min-width: 0; color: inherit; font-size: 13px; font-weight: 550; line-height: 1.4; white-space: nowrap; }
.shortcut-arrow { display: none; }
.review-section { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; min-height: 0; scroll-margin-top: 20px; border: 1px solid var(--overview-line); border-radius: var(--cv-radius-panel); background: var(--cv-surface); overflow: hidden; box-shadow: none; }
.review-scroll-region { flex: 1 1 0; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
.review-heading { display: flex; flex: 0 0 auto; align-items: center; gap: 14px; padding: 18px 26px 14px; }
.review-heading h2 { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; margin: 0; color: var(--overview-ink); font-size: 20px; font-weight: 620; letter-spacing: 0; }
.review-heading h2 span { display: inline-grid; place-items: center; min-width: 23px; height: 23px; padding: 0 6px; border-radius: 7px; background: var(--cv-accent-soft); color: var(--overview-accent); font-size: var(--cv-type-meta); font-variant-numeric: tabular-nums; }
.review-heading p { margin: 0; color: var(--overview-muted); font-size: 13px; line-height: 1.6; }
.review-heading-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; }
.review-heading time { color: var(--cv-muted); font-size: var(--cv-type-meta); white-space: nowrap; }
.workbench-entry { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 13px; border: 1px solid var(--overview-line); border-radius: var(--cv-radius-control); color: var(--overview-accent); background: var(--cv-surface); font-size: 12px; font-weight: 550; white-space: nowrap; }
.clear-suggestions-button { min-height: 38px; padding: 0 8px; border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--cv-danger); font-size: 12px; white-space: nowrap; }
.review-groups { display: flex; flex: 1 1 auto; min-width: 0; gap: 18px; padding: 0; border-bottom: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.review-groups button { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; min-height: 38px; padding: 0 0 4px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--overview-muted); font-size: 13px; }
.review-groups button.active { border-bottom-color: var(--overview-accent); color: var(--overview-ink); font-weight: 600; }
.review-groups button span { font-size: var(--cv-type-meta); font-variant-numeric: tabular-nums; color: var(--cv-muted); }
.review-filters { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 15px 22px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.review-filters::-webkit-scrollbar, .review-groups::-webkit-scrollbar { display: none; }
.review-filters button { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; min-height: 34px; padding: 0 12px; border: 0; border-radius: var(--cv-radius-control); background: transparent; color: var(--overview-muted); font-size: 12px; white-space: nowrap; transition: background-color var(--cv-motion-press) var(--cv-ease), color var(--cv-motion-press) var(--cv-ease); }
.review-filters button.active { background: var(--cv-accent-soft); color: var(--overview-accent); font-weight: 600; }
.review-filters button.active:after { display: none; }
.review-filters button span { color: var(--cv-muted); font-size: var(--cv-type-meta); font-variant-numeric: tabular-nums; }
.review-batch { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 11px 26px; border-top: 1px solid var(--cv-border); border-bottom: 1px solid var(--cv-border); background: var(--cv-canvas); }
.batch-select { display: inline-flex; align-items: center; gap: 9px; min-height: 36px; color: var(--cv-secondary); font-size: 12px; cursor: pointer; }
.batch-select input, .suggestion-select input { width: 18px; height: 18px; margin: 0; accent-color: var(--overview-accent); cursor: pointer; }
.batch-count { color: var(--cv-muted); font-size: var(--cv-type-meta); }
.batch-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.batch-actions button { min-height: 36px; padding: 0 11px; border: 1px solid var(--overview-line); border-radius: var(--cv-radius-control); background: var(--cv-surface); color: var(--cv-secondary); font-size: 12px; }
.batch-actions .batch-accept { border-color: var(--cv-border); background: var(--cv-accent-soft); color: var(--overview-accent); font-weight: 550; }
.batch-incomplete { flex: 0 0 100%; margin: 0; color: var(--cv-warning); font-size: var(--cv-type-meta); line-height: 1.6; }
.suggestion-list { display: flex; flex-direction: column; min-width: 0; padding: 0 26px; }
.suggestion-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-width: 0; padding: 25px 0; border-bottom: 1px solid var(--cv-border); }
.suggestion-row:last-child { border-bottom: 0; }
.suggestion-select { display: flex; align-items: center; justify-content: flex-start; align-self: stretch; flex: 0 0 24px; min-width: 24px; cursor: pointer; }
.suggestion-main { flex: 1; min-width: 0; }
.suggestion-title { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.suggestion-title strong { flex-basis: calc(100% - 65px); color: var(--overview-ink); font-size: 16px; line-height: 1.65; font-weight: 600; overflow-wrap: anywhere; }
.kind-pill { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: 34px; height: 22px; padding: 0 7px; border-radius: var(--cv-radius-tag); background: var(--cv-surface-subtle); color: var(--cv-secondary); font-size: var(--cv-type-meta); white-space: nowrap; }
.kind-timeline { color: var(--cv-accent); background: var(--cv-accent-soft); }
.yearless-pill, .review-group-pill, .precision-pill, .needs-title-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: var(--cv-radius-tag); background: var(--cv-surface-subtle); color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: 1; white-space: nowrap; }
.review-group-pill.ready { display: none; }
.review-group-pill.needs-review, .needs-title-pill { color: var(--cv-warning); background: var(--cv-warning-soft); }
.review-group-pill.needs-content { color: var(--cv-accent); background: var(--cv-accent-soft); }
.yearless-pill, .precision-pill.is-approximate { background: var(--cv-warning-soft); color: var(--cv-warning); }
.evidence-quote { display: -webkit-box; max-width: 880px; margin: 10px 0 2px; color: var(--cv-secondary); font-size: 14px; line-height: 1.85; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.evidence-quote.expanded { display: block; overflow: visible; }
.suggestion-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.source-link, .quote-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 34px; margin: 0; padding: 0; border: 0; border-radius: var(--cv-radius-tag); background: transparent; color: var(--cv-accent); font-size: 12px; }
.source-link span { color: var(--cv-muted); font-size: 17px; }
.quote-toggle { color: var(--cv-muted); }
.review-next-step { margin: 4px 0 0; color: var(--cv-muted); font-size: 12px; line-height: 1.7; }
.review-next-step.ready { display: none; }
.review-next-step.needs-review { color: var(--cv-warning); }
.review-next-step.needs-content { color: var(--cv-secondary); }
.suggestion-actions { display: flex; flex-direction: column; align-items: stretch; gap: 5px; flex: 0 0 auto; }
.suggestion-action { min-height: 42px; padding: 0 17px; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-control); background: var(--cv-accent-soft); color: var(--overview-accent); font-size: 13px; font-weight: 550; white-space: nowrap; transition: background-color var(--cv-motion-press) var(--cv-ease); }
.suggestion-row.is-selected .suggestion-title strong { color: var(--overview-accent); }
.review-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 210px; padding: 30px; text-align: center; }
.next-step-empty { align-items: flex-start; min-height: 185px; padding: 30px; text-align: left; gap: 5px; background: var(--cv-surface); }
.next-step-label { color: var(--cv-muted); font-size: 12px; }
.review-empty strong { color: var(--overview-ink); font-size: 16px; font-weight: 600; }
.review-empty.next-step-empty strong { font-size: 20px; }
.review-empty p { max-width: 520px; margin: 7px 0 0; color: var(--overview-muted); font-size: 14px; line-height: 1.8; }
.review-empty > .text-button { margin-top: 12px; color: var(--overview-accent); }
.empty-undo { padding: 0 30px 20px; }
.review-footnote { padding: 14px 26px; border-top: 1px solid var(--cv-border); background: var(--cv-canvas); color: var(--cv-muted); font-size: var(--cv-type-meta); line-height: 1.7; }
button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
button:disabled { cursor: default; opacity: .45; }
button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.shortcut-button:active { background: var(--cv-accent-soft); }
.suggestion-action:active, .batch-actions button:active { background: var(--cv-accent-soft); }
@media (hover: hover) {
  .shortcut-button:hover { background: var(--cv-surface-subtle); color: var(--overview-accent); }
  .suggestion-action:hover { background: var(--cv-accent-soft); }
  .review-filters button:hover { background: var(--cv-surface-subtle); }
  .clear-suggestions-button:hover { background: var(--cv-warning-soft); }
  .source-link:hover, .quote-toggle:hover { color: var(--overview-accent); }
}
@keyframes organize-spin { to { transform: rotate(360deg); } }
@keyframes organize-pulse { 50% { opacity: .3; } }
@media (max-width: 1100px) {
  .organize-header { align-items: flex-start; }
  .organize-header-actions { flex-shrink: 1; }
  .review-heading time { display: none; }
  .shortcut-button { gap: 6px; min-height: 40px; padding: 4px 5px; }
  .shortcut-label { font-size: 12px; }
}
@media (max-width: 760px) {
  .organization-page { gap: 16px; }
  .organize-header { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
  .organize-header h1 { font-size: var(--cv-type-page); }
  .organize-header-actions { flex: 0 1 auto; margin-left: auto; justify-content: flex-end; }
  .organize-header-actions .secondary-button { padding: 0 13px; }
  .organize-header .primary-button { margin-left: 0; padding: 0 17px; }
  .organize-status { font-size: var(--cv-type-meta); }
  .shortcut-list { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 4px; }
  .shortcut-button { justify-content: flex-start; padding-left: 13px; gap: 9px; }
  .shortcut-button:nth-child(4):before { display: none; }
  .review-heading { align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px 20px; }
  .review-heading-actions { gap: 7px; }
  .review-heading h2 { font-size: 19px; }
  .review-heading p { font-size: 12px; }
  .review-groups { gap: 14px; padding: 0; }
  .review-filters { padding: 12px 15px; }
  .review-batch { padding: 10px 20px; }
  .batch-actions { width: 100%; margin-left: 27px; }
  .suggestion-list { padding: 0 20px; }
  .suggestion-row { gap: 11px; padding: 23px 0; }
  .suggestion-select { flex-basis: 20px; min-width: 20px; }
  .suggestion-title strong { font-size: 15px; }
  .evidence-quote { font-size: 13px; }
  .suggestion-action { padding: 0 13px; font-size: 12px; }
  .review-footnote { padding: 14px 20px; }
}
@media (max-width: 480px) {
  .organize-header-actions { flex: 1 0 100%; margin-left: 0; justify-content: flex-start; }
  .review-heading { gap: 10px; }
  .review-heading-actions { flex-direction: column; align-items: flex-end; }
  .suggestion-row { flex-wrap: wrap; }
  .suggestion-main { flex-basis: calc(100% - 55px); }
  .suggestion-actions { margin-left: 55px; }
  .suggestion-title strong { flex-basis: calc(100% - 56px); }
  .suggestion-action { min-height: 42px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *:before, *:after { animation: none !important; transition: none !important; }
}

.organization-page {
  --overview-ink: var(--cv-ink);
  --overview-muted: var(--cv-muted);
  --overview-accent: var(--cv-accent);
  --overview-line: var(--cv-border);
  font-family: var(--cv-font);
}
.organization-page :is(button, input):focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 3px; }
.organization-page button { min-height: var(--cv-control); transition: color var(--cv-motion-press) var(--cv-ease), background-color var(--cv-motion-press) var(--cv-ease), border-color var(--cv-motion-press) var(--cv-ease); }
.organization-page button:active:not(:disabled) { background: var(--cv-accent-soft); color: var(--cv-accent-strong); }
.organize-header .primary-button:active:not(:disabled) { background: var(--cv-accent-strong); color: var(--cv-on-accent); }
.batch-select { min-height: var(--cv-control); }
.suggestion-select { flex-basis: var(--cv-control); min-width: var(--cv-control); min-height: var(--cv-control); justify-content: center; touch-action: manipulation; }
.evidence-quote { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
@media (prefers-reduced-motion: reduce) { .organization-page *, .organization-page *:before, .organization-page *:after { animation: none !important; transition: none !important; } }
.shortcut-button, .review-groups button, .review-filters button, .batch-actions button,
.suggestion-action, .workbench-entry, .clear-suggestions-button, .source-link,
.quote-toggle, .organize-status button { min-height: var(--cv-control); }
</style>
