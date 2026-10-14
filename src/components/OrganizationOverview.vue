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
}>()
const emit = defineEmits<{
  analyze: []
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
const reviewedKeys = ref<string[]>([])
const openedSourceKeys = ref<string[]>([])
const batchMessage = ref('')
const expandedIds = ref<string[]>([])
const reviewElement = ref<HTMLElement | null>(null)
const selectedKeys = ref<string[]>([])
const selectionKey = (suggestion: Suggestion) => `${suggestion.kind}:${suggestion.item.id}`
function focusSuggestions() {
  activeFilter.value = 'all'
  activeGroup.value = null
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
const reviewInfo = computed(() => new Map(allSuggestions.value.map(suggestion => [selectionKey(suggestion), classifyReview(suggestion, props.clues, props.organization?.timelineAudit, reviewedKeys.value.includes(selectionKey(suggestion)))])))
const classification = (suggestion: Suggestion) => reviewInfo.value.get(selectionKey(suggestion))!
const groupLabel = (group: ReviewGroup) => ({ ready: '可直接录入', 'needs-content': '需要补充', 'needs-review': '需要核对' })[group]
const effectiveGroup = computed(() => activeGroup.value || (allSuggestions.value.some(suggestion => classification(suggestion).group === 'needs-review') ? 'needs-review' : allSuggestions.value.some(suggestion => classification(suggestion).group === 'needs-content') ? 'needs-content' : 'ready'))
const groupSuggestions = computed(() => effectiveGroup.value === 'all' ? allSuggestions.value : allSuggestions.value.filter(suggestion => classification(suggestion).group === effectiveGroup.value))
const kindSuggestions = computed(() => activeFilter.value === 'all' ? allSuggestions.value : allSuggestions.value.filter(suggestion => suggestion.kind === activeFilter.value))
const groups = computed(() => [
  { id: 'needs-review' as const, label: '需要核对', count: kindSuggestions.value.filter(suggestion => classification(suggestion).group === 'needs-review').length },
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
  reviewedKeys.value = reviewedKeys.value.filter(key => available.has(key))
  openedSourceKeys.value = openedSourceKeys.value.filter(key => available.has(key))
})
watch(() => props.organization?.scriptId, () => {
  activeGroup.value = null
  reviewedKeys.value = []
  openedSourceKeys.value = []
  selectedKeys.value = []
  batchMessage.value = ''
})
function viewSource(suggestion: Suggestion) {
  if (!classification(suggestion).sourceExists) return
  const key = selectionKey(suggestion)
  if (!openedSourceKeys.value.includes(key)) openedSourceKeys.value.push(key)
  emit('openClue', suggestion.item.sourceNo, suggestion.item.quote)
}
function confirmReviewed(suggestion: Suggestion) {
  if (props.busy || !classification(suggestion).canConfirm || !openedSourceKeys.value.includes(selectionKey(suggestion))) return
  reviewedKeys.value = [...new Set([...reviewedKeys.value, selectionKey(suggestion)])]
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
  batchMessage.value = action === 'accept' && blockedSelectedCount.value ? `已跳过 ${blockedSelectedCount.value} 项需要补充或核对的建议，仍保留在列表中。` : ''
  const selection = items.map(item => ({ kind: item.kind, id: item.item.id }))
  if (!selection.length) return
  if (action === 'accept') emit('bulkAccept', selection)
  else emit('bulkIgnore', selection)
}
const auditTotals = computed(() => (props.organization?.timelineAudit || []).reduce((total, audit) => ({ clocks: total.clocks + audit.clocks, covered: total.covered + audit.covered, review: total.review + (audit.status === 'review' ? 1 : 0) }), { clocks: 0, covered: 0, review: 0 }))
const analysisLabel = computed(() => {
  const analysis = props.organization?.analysis
  if (!analysis) return ''
  const provider = analysis.provider === 'local' ? `本地整理${analysis.localReason === 'offline' ? '（网络不可用）' : analysis.localReason === 'quota' ? '（API 余额不足）' : ''}` : analysis.provider === 'openai' ? 'GPT' : 'DeepSeek'
  return `${provider} · ${analysis.reviewed ? '已复核时间覆盖' : '时间覆盖待核对'}`
})
const auditOriginal = (sourceNo: number) => props.clues.find(clue => clue.number === sourceNo)?.ocrText || '当前线索暂无 OCR 原文。'
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
  if (suggestion.kind === 'timeline') return `${dateLabel(suggestion.item.startsAt)} · ${suggestion.item.title}`
  return `${suggestion.item.title}${suggestion.item.category ? ` · ${suggestion.item.category}` : ''}`
}
const actionLabel = (suggestion: Suggestion) => ({ ready: '直接录入', 'needs-content': '补充事件', 'needs-review': '查看原文' })[classification(suggestion).group]


const isLongQuote = (item: Suggestion['item']) => item.quote.length > 115
function toggleQuote(id: string) {
  expandedIds.value = expandedIds.value.includes(id) ? expandedIds.value.filter(value => value !== id) : [...expandedIds.value, id]
}
function accept(suggestion: Suggestion) {
  if (props.busy) return
  if (classification(suggestion).group === 'needs-review') { viewSource(suggestion); return }
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
      <span v-if="progress || busy" role="status" aria-live="polite">{{ progress || '正在整理 OCR 文字，完成后建议会显示在下方。' }}</span>
      <span v-else-if="analysisLabel">{{ analysisLabel }} · 只整理 OCR 文字，照片保存在本机。</span>
      <span v-else-if="!apiConfigured">照片和 OCR 保存在本机；AI 整理尚未配置。</span>
      <span v-else-if="autoOrganize">自动整理已开启 · OCR 文字发送到 {{ apiProvider }}，照片留在 iPad。</span>
      <span v-else>手动整理 · OCR 文字发送到 {{ apiProvider }}，照片留在 iPad。</span>
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

    <details v-if="organization?.timelineAudit?.length" class="timeline-audit">
      <summary><span class="audit-summary-title">时间提取核对</span><span class="audit-total">{{ auditTotals.covered }} / {{ auditTotals.clocks }} 处时间已覆盖</span><span class="audit-state" :class="{ 'needs-review': auditTotals.review }">{{ auditTotals.review ? `${auditTotals.review} 条线索需核对` : '覆盖完整' }}</span><span class="audit-expand">展开 ›</span></summary>
      <div class="audit-items">
        <article v-for="audit in organization.timelineAudit" :key="audit.sourceNo" class="audit-row">
          <div class="audit-row-heading"><button class="source-link" @click="emit('openClue', audit.sourceNo, auditOriginal(audit.sourceNo))">原线索 #{{ String(audit.sourceNo).padStart(3, '0') }} ›</button><span class="audit-state" :class="{ 'needs-review': audit.status === 'review' }">{{ audit.status === 'review' ? '需核对' : '覆盖完整' }}</span><span>{{ audit.covered }} / {{ audit.clocks }} 处</span><button v-if="audit.status === 'review'" class="audit-retry" :disabled="busy" @click="emit('analyze')">重试核对</button></div>
          <p>{{ audit.message }}</p>
          <details class="audit-source"><summary>展开 OCR 原文</summary><p>{{ auditOriginal(audit.sourceNo) }}</p></details>
        </article>
      </div>
    </details>

    <section ref="reviewElement" class="review-section">
      <header class="review-heading"><div><h2>待确认建议 <span>{{ pendingCount }}</span></h2><p>核对出处后再加入档案。</p></div><div class="review-heading-actions"><button v-if="pendingCount" class="workbench-entry" :disabled="busy" @click="emit('openWorkbench')">逐条核对 <span aria-hidden="true">↗</span></button><time v-if="organization">更新于 {{ dateLabel(organization.updatedAt) }}</time><button v-if="pendingCount" class="clear-suggestions-button" :disabled="busy" @click="emit('clearSuggestions')">清除全部</button></div></header>
      <nav class="review-groups" aria-label="按处理步骤筛选">
        <button v-for="group in groups" :key="group.id" :class="{ active: effectiveGroup === group.id }" :aria-pressed="effectiveGroup === group.id" @click="activeGroup = group.id">{{ group.label }} <span>{{ group.count }}</span></button>
      </nav>
      <nav class="review-filters" aria-label="筛选整理建议">
        <button v-for="filter in filters" :key="filter.id" :class="{ active: activeFilter === filter.id }" :aria-pressed="activeFilter === filter.id" @click="activeFilter = filter.id">{{ filter.label }} <span>{{ filter.count }}</span></button>
      </nav>
      <div v-if="pendingCount || canUndo" class="review-batch">
        <label v-if="visibleSuggestions.length" class="batch-select"><input type="checkbox" :checked="allVisibleSelected" :disabled="busy" @change="selectVisible" /><span>全选当前 {{ visibleSuggestions.length }} 项</span></label>
        <span class="batch-count" role="status">共选 {{ selectedCount }} 项<span v-if="hiddenSelectedCount">（其中 {{ hiddenSelectedCount }} 项在其他筛选中）</span></span>
        <div class="batch-actions"><button :disabled="busy || !selectedAcceptable.length" class="batch-accept" @click="bulk('accept')">录入可用项{{ selectedAcceptable.length ? ` ${selectedAcceptable.length}` : '' }}</button><button :disabled="busy || !selectedCount" @click="bulk('ignore')">忽略所选{{ selectedCount ? ` ${selectedCount}` : '' }}</button><button :disabled="busy || !canUndo" @click="emit('undo')">撤销上一步</button></div>
        <p v-if="blockedSelectedCount" class="batch-incomplete">所选 {{ blockedSelectedCount }} 项需要补充或核对，将跳过录入；“忽略所选”仍适用于全部所选项。</p><p v-if="batchMessage" class="batch-incomplete" role="status">{{ batchMessage }}</p>
      </div>
      <div v-if="!organization" class="review-empty"><strong>还没有整理结果</strong><p>点击右上角“整理线索”生成待核对建议。</p></div>
      <div v-else-if="!visibleSuggestions.length" class="review-empty"><strong>{{ pendingCount ? '当前筛选下没有建议' : '没有待确认的建议' }}</strong><p>{{ pendingCount ? '切换处理分组或人物、关系等分类查看其他建议。' : '录入新线索后可以再次整理。' }}</p></div>
      <div v-else class="suggestion-list">
        <article v-for="suggestion in visibleSuggestions" :key="selectionKey(suggestion)" class="suggestion-row" :class="{ 'is-selected': selectedKeys.includes(selectionKey(suggestion)) }">
          <label class="suggestion-select"><input type="checkbox" :checked="selectedKeys.includes(selectionKey(suggestion))" :disabled="busy" :aria-label="`选择${title(suggestion)}`" @change="selectSuggestion(suggestion)" /></label>
          <div class="suggestion-main">
            <div class="suggestion-title"><span class="kind-pill" :class="`kind-${suggestion.kind}`">{{ kindLabel(suggestion.kind) }}</span><strong>{{ title(suggestion) }}</strong><span class="review-group-pill" :class="classification(suggestion).group">{{ groupLabel(classification(suggestion).group) }}</span><span v-if="suggestion.kind === 'timeline' && suggestion.item.startsAt.startsWith('--')" class="yearless-pill">无年份</span><span v-if="suggestion.kind === 'timeline'" class="precision-pill">{{ precisionLabel(suggestion.item) }}</span><span v-if="suggestion.kind === 'timeline' && suggestion.item.approximate" class="precision-pill is-approximate">约时</span><span v-if="suggestion.kind === 'timeline' && (suggestion.item.requiresTitle || !suggestion.item.title.trim())" class="needs-title-pill">需补充事件</span></div>
            <p :class="['evidence-quote', { expanded: expandedIds.includes(suggestion.item.id) }]">{{ quote(suggestion.item) }}</p>
            <div class="suggestion-meta"><button class="source-link" :disabled="!classification(suggestion).sourceExists" @click="viewSource(suggestion)">原线索 #{{ String(sourceNo(suggestion.item)).padStart(3, '0') }} <span>›</span></button><template v-if="suggestion.kind === 'timeline'"><button v-for="source in suggestion.item.evidence?.filter(item => item.sourceNo !== suggestion.item.sourceNo || item.quote !== suggestion.item.quote) || []" :key="`${source.clueId}:${source.quote}`" class="source-link" @click="emit('openClue', source.sourceNo, source.quote)">另见 #{{ String(source.sourceNo).padStart(3, '0') }} <span>›</span></button></template><button v-if="isLongQuote(suggestion.item)" class="quote-toggle" :aria-expanded="expandedIds.includes(suggestion.item.id)" @click="toggleQuote(suggestion.item.id)">{{ expandedIds.includes(suggestion.item.id) ? '收起摘录' : '展开摘录' }}</button></div>
            <p class="review-next-step" :class="classification(suggestion).group">{{ classification(suggestion).reason }}</p>
            <label v-if="classification(suggestion).canConfirm" class="review-confirm"><input type="checkbox" :disabled="busy || !openedSourceKeys.includes(selectionKey(suggestion))" @change="confirmReviewed(suggestion)" /><span>{{ openedSourceKeys.includes(selectionKey(suggestion)) ? '已核对，允许录入' : '先查看原文，再确认允许录入' }}</span></label>
          </div>
          <div class="suggestion-actions"><button class="suggestion-action" :disabled="busy || (classification(suggestion).group === 'needs-review' && !classification(suggestion).sourceExists)" @click="accept(suggestion)">{{ actionLabel(suggestion) }}</button><button v-if="classification(suggestion).retry" class="retry-suggestion" :disabled="busy" @click="emit('analyze')">{{ classification(suggestion).canConfirm ? '重试核对' : '重新整理' }}</button></div>
        </article>
      </div>
      <footer class="review-footnote">AI 结果可能有误；关系和时间需人工确认，不推断动机、因果或答案。</footer>
    </section>
  </section>
</template>

<style scoped>
.workbench-entry { display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 15px; border: 1px solid #cbdccf; border-radius: 10px; color: #315c48; background: #eff5f0; font-size: 13px; font-weight: 650; white-space: nowrap; }
.workbench-entry:disabled { opacity: .5; }
.organization-page {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
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

.review-groups { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 21px 12px; }
.review-groups button { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 12px; border: 1px solid #e2e8e1; border-radius: 9px; background: #fafbf8; color: #7c897e; font-size: 12px; }
.review-groups button.active { border-color: #b9cdbd; background: #eaf2e9; color: #315c48; font-weight: 650; }
.review-groups button span { font-size: 11px; font-variant-numeric: tabular-nums; }
.review-group-pill { display: inline-flex; padding: 3px 6px; border-radius: 5px; background: #edf4ed; color: #64846a; font-size: 10px; }
.review-group-pill.needs-review { background: #fbf0e5; color: #ad7548; }
.review-group-pill.needs-content { background: #edf3f7; color: #688597; }
.review-next-step { margin: 6px 0 0; color: #8b9a8b; font-size: 11px; line-height: 1.6; }
.review-next-step.needs-review { color: #a2774f; }
.review-next-step.needs-content { color: #738b9a; }
.review-confirm { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; margin-top: 4px; color: #657d69; font-size: 12px; }
.review-confirm input { width: 18px; height: 18px; margin: 0; accent-color: #3f7052; }
.suggestion-actions { display: flex; flex-direction: column; align-items: stretch; gap: 5px; flex: 0 0 auto; }
.retry-suggestion, .audit-retry { min-height: 34px; padding: 0 8px; border-radius: 7px; background: transparent; color: #8c7959; font-size: 12px; }
.audit-retry { margin-left: auto; }
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
.timeline-audit { border: 1px solid #e2e9df; border-radius: 13px; background: #fbfcf9; color: #53695a; font-size: 12px; }
.timeline-audit > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; min-height: 48px; padding: 10px 16px; cursor: pointer; list-style: none; }
.timeline-audit > summary::-webkit-details-marker { display: none; }
.audit-summary-title { color: #38543f; font-weight: 650; }
.audit-total { color: #758277; font-variant-numeric: tabular-nums; }
.audit-expand { margin-left: auto; color: #7f9082; }
.timeline-audit[open] .audit-expand { transform: rotate(90deg); }
.audit-state { display: inline-flex; padding: 3px 7px; border-radius: 6px; background: #edf4ed; color: #52755a; font-size: 11px; white-space: nowrap; }
.audit-state.needs-review { background: #fbf0e5; color: #ad7548; }
.audit-items { padding: 0 16px; border-top: 1px solid #e7ede3; }
.audit-row { padding: 10px 0 12px; border-bottom: 1px solid #e8ede4; }
.audit-row:last-child { border-bottom: none; }
.audit-row-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-variant-numeric: tabular-nums; }
.audit-row > p { margin: 3px 0 8px; color: #7b877e; line-height: 1.6; }
.audit-source > summary { color: #64836a; cursor: pointer; min-height: 32px; line-height: 32px; }
.audit-source > p { max-height: 260px; margin: 8px 0 0; padding: 12px; overflow: auto; border-radius: 9px; background: #f2f6ef; color: #657569; white-space: pre-wrap; line-height: 1.8; }
.review-batch { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 21px; border-bottom: 1px solid #e7eee5; background: #f8fbf6; }
.batch-select { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; color: #536f58; font-size: 12px; cursor: pointer; }
.batch-select input, .suggestion-select input { width: 19px; height: 19px; margin: 0; accent-color: #3f7052; cursor: pointer; }
.batch-count { color: #7b8d7e; font-size: 11px; }
.batch-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-left: auto; }
.batch-actions button { min-height: 36px; padding: 0 11px; border: 1px solid #dbe5d7; border-radius: 8px; background: #fff; color: #5c765f; font-size: 12px; }
.batch-actions .batch-accept { border-color: #3a654a; background: #3a654a; color: #fff; }
.batch-incomplete { flex: 0 0 100%; margin: 0; color: #a47649; font-size: 11px; line-height: 1.6; }
.suggestion-select { display: flex; align-items: center; justify-content: center; align-self: stretch; flex: 0 0 28px; min-width: 28px; cursor: pointer; }
.suggestion-row.is-selected .suggestion-title strong { color: #2f6842; }
.precision-pill, .needs-title-pill { display: inline-flex; align-items: center; padding: 3px 6px; border-radius: 5px; background: #f0f4f6; color: #7b8b96; font-size: 10px; white-space: nowrap; }
.precision-pill.is-approximate, .needs-title-pill { background: #fcf2e7; color: #b18452; }
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
  .review-groups { padding: 0 16px 10px; }
  .review-filters { padding: 0 12px 10px; }
  .review-filters button { gap: 5px; padding: 0 10px; font-size: 12px; }
  .suggestion-list { padding: 0 16px; }
  .suggestion-row { gap: 9px; padding: 17px 0; }
  .review-batch { padding: 10px 16px; gap: 7px; }
  .batch-actions { flex-basis: 100%; margin-left: 27px; }
  .suggestion-select { flex-basis: 22px; min-width: 22px; }
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
  .suggestion-actions { margin-left: auto; }
  .suggestion-action { min-height: 40px; }
  .review-footnote { padding: 12px 16px; font-size: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *:before, *:after { animation: none !important; transition: none !important; }
}
</style>
