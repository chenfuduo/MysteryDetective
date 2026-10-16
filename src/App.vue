<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { IonApp } from '@ionic/vue'
import { Capacitor } from '@capacitor/core'
import { VueFlow, type Connection, type Node, type Edge } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import UiIcon from './components/UiIcon.vue'
import AnnotationEditor from './components/AnnotationEditor.vue'
import CluePhotoViewer from './components/CluePhotoViewer.vue'
import ClueThumbnail from './components/ClueThumbnail.vue'
import OrganizationOverview from './components/OrganizationOverview.vue'
import SourceRevisionNotice from './components/SourceRevisionNotice.vue'
import TimelineExtractionIssues from './components/TimelineExtractionIssues.vue'
import { getSourceRevisionReviews, acknowledgeSourceRevision, type SourceRevisionReview } from './services/sourceRevision'
import RelationshipExplorer from './components/RelationshipExplorer.vue'
import TimelineExplorer from './components/TimelineExplorer.vue'
import PersonWorkspace from './components/PersonWorkspace.vue'
import PersonMergeDialog from './components/PersonMergeDialog.vue'
import RecoveryPanel from './components/RecoveryPanel.vue'
import RecordComparison from './components/RecordComparison.vue'
import WorkspaceSearch from './components/WorkspaceSearch.vue'
import WorkspaceGuide from './components/WorkspaceGuide.vue'
import ClueBatchEditor from './components/ClueBatchEditor.vue'
import ReviewWorkbench from './components/ReviewWorkbench.vue'
import OperationHistory from './components/OperationHistory.vue'
import PersonNameCorrections from './components/PersonNameCorrections.vue'
import ArchiveImportDialog from './components/ArchiveImportDialog.vue'
import PhotoQualityPanel from './components/PhotoQualityPanel.vue'
import DocumentCorrection from './components/DocumentCorrection.vue'
import DiscussionWorkspace from './components/DiscussionWorkspace.vue'
import { analyzePhotoQuality, type PhotoQualityReport } from './services/photoQuality'
import ArchiveStatus from './components/ArchiveStatus.vue'
import { updateCluesInBatch, type BatchCluePatch } from './services/clueBatch'
import { getDraft, saveDraft, removeDraft, flushDrafts } from './services/drafts'
import { mergePeople } from './services/personMerge'
import { organizeIncrementally, getOrganizationTaskStates, type OrganizationTaskState } from './services/organizationWorkflow'
import { reviewSuggestions, timelineEvidence, recordUndo, loadLastUndo, loadLastRedo, mergeConfirmedEvents, type ReviewSelection, type ReviewUndo } from './services/reviewActions'
import * as organizer from './services/organizer'
import { aiRoute, initializeAiRouting, providerLabel, type AiProvider } from './services/aiProvider'
import * as vault from './services/vault'
import type { ScriptRecord, ClueRecord, PersonRecord, RelationshipRecord, TimelineRecord, BoardItemRecord, BoardLinkRecord, NoteRecord, OrganizationSnapshot, OrganizationTimelineSuggestion } from './services/vault'

const scripts = ref<ScriptRecord[]>([])
const clues = ref<ClueRecord[]>([])
const people = ref<PersonRecord[]>([])
const relationships = ref<RelationshipRecord[]>([])
const events = ref<TimelineRecord[]>([])
const boardItems = ref<BoardItemRecord[]>([])
const boardLinks = ref<BoardLinkRecord[]>([])
const notes = ref<NoteRecord[]>([])
const organization = ref<OrganizationSnapshot | null>(null)
type TimeIssueDismissals = Record<string, { ocrText: string; ids: string[] }>
const timeIssueDismissals = ref<TimeIssueDismissals>({})
const timeExtractionIssues = computed(() => organizer.timelineExtractionIssues(clues.value, organization.value, events.value).filter(issue => {
  const clue = clues.value.find(clue => clue.scriptId === activeScriptId.value && clue.number === issue.sourceNo)
  const ignored = clue && timeIssueDismissals.value[clue.id]
  return clue && !(ignored?.ocrText === clue.ocrText && ignored.ids.includes(issue.id))
}))
const pendingTimeIssue = ref<organizer.TimelineExtractionIssue | null>(null)
const sourceRevisionReviews = ref<SourceRevisionReview[]>([])
const sourceReviewEventIds = computed(() => [...new Set(sourceRevisionReviews.value.flatMap(review => review.affectedEvents.map(event => event.id)))])
const selectedClueSourceReviews = computed(() => sourceRevisionReviews.value.filter(review => review.clueId === selectedClue.value?.id))
const organizationProgress = ref('')
const organizationActive = ref(false)
const organizationPauseRequested = ref(false)
const organizationStartedAt = ref(0)
const organizationElapsed = ref(0)
const organizationPaused = ref(false)
let organizationElapsedTimer: ReturnType<typeof setInterval> | undefined
const taskStates = ref<OrganizationTaskState[]>([])
const unfinishedTasks = computed(() => taskStates.value.filter(task => ['extracting', 'checking', 'failed', 'local', 'paused'].includes(task.stage)))
const captureRound = ref('1')
const captureRoundReady = ref(false)
const recentCaptureOpen = ref(false)
const pendingOcrClues = computed(() => clues.value.filter(clue => clue.ocrStatus === 'pending' || clue.ocrStatus === 'failed' || !clue.ocrText.trim()))
const recentClues = computed(() => [...clues.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5))
const captureRoundOptions = computed(() => [...new Set(['1', '2', '3', '4', '5', captureRound.value, String(Math.max(1, Number(captureRound.value) || 1, ...clues.value.map(clue => Number(clue.round) || 1)) + 1), ...rounds.value.map(String)])].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })))
const recoveryOpen = ref(false)
const workspaceSearchOpen = ref(false)
const workspaceGuideOpen = ref(false)
const personMergeSourceId = ref('')
const comparisonEventIds = ref<string[]>([])
const reviewUndo = ref<ReviewUndo | null>(null)
const reviewRedo = ref<ReviewUndo | null>(null)
const operationHistoryOpen = ref(false)
const correctionPersonId = ref('')
const importPreview = ref<vault.ArchiveImportPreview | null>(null)
const importDialogOpen = ref(false)
const personWorkspaceId = ref('')
const sourceExcerpt = ref('')
const aiStatusOpen = ref(false)
const apiKeyDrafts = reactive<Record<AiProvider, string>>({ deepseek: '', openai: '' })
const apiKeysConfigured = reactive<Record<AiProvider, boolean>>({ deepseek: false, openai: false })
const apiKeyConfigured = ref(false)
const selectedProviderLabel = computed(() => aiRoute.provider ? providerLabel(aiRoute.provider) : 'AI')
const aiModelStatus = computed(() => {
  const run = organizer.organizationRun
  const provider = organizationActive.value ? run.provider : aiRoute.provider
  if (!provider || provider === 'local') return { model: '', reason: '' }
  const analysis = organization.value?.analysis
  const model = run.provider === provider && run.model ? run.model : analysis?.provider === provider ? (analysis.models || []).join(' → ') : ''
  return { model, reason: run.provider === provider ? run.modelReason || '' : '' }
})
const aiStatusLabel = computed(() => {
  const run = organizer.organizationRun
  if (run.phase === 'extracting' || run.phase === 'checking') return `${providerLabel(run.provider === 'local' ? null : run.provider)} · ${run.phase === 'checking' ? '核对中' : '提取中'}`
  if (run.phase === 'paused') return '整理已暂停'
  if (run.phase === 'local') return '本地整理'
  if (run.phase === 'error') return '整理未完成'
  if (aiRoute.phase === 'checking') return '检测中'
  if (aiRoute.phase === 'offline') return '离线'
  if (aiRoute.phase !== 'ready' || !aiRoute.provider) return '待检测'
  return apiKeyConfigured.value ? `已选 ${providerLabel(aiRoute.provider)}` : `${providerLabel(aiRoute.provider)} · 未配置`
})
const aiStatusTone = computed(() => {
  if (organizer.organizationRun.phase === 'error' || organizer.organizationRun.phase === 'local' || organizer.organizationRun.phase === 'paused') return 'warning'
  if (aiRoute.phase === 'checking' || aiRoute.phase === 'offline') return 'muted'
  if (aiRoute.phase !== 'ready' || !aiRoute.provider || !apiKeyConfigured.value) return 'warning'
  return aiRoute.provider
})
const aiStatusTitle = computed(() => {
  if (organizer.organizationRun.message) return `${organizer.organizationRun.message}${organizer.organizationRun.lastError ? `：${organizer.organizationRun.lastError}` : ''}`
  if (aiRoute.phase === 'checking') return '正在检测出口 IP 所在地，首页可正常使用'
  if (aiRoute.phase !== 'ready' || !aiRoute.provider) return `${aiRoute.message || '暂时无法选择 AI 服务'}；点击重新检测`
  return `当前服务已选择：${providerLabel(aiRoute.provider)}${aiRoute.countryCode ? `（${aiRoute.countryCode} IP）` : ''}。${apiKeyConfigured.value ? '密钥已配置，尚未验证 API 连通性' : '请先配置此服务的 API Key'}；点击管理设置`
})
const autoOrganize = ref(localStorage.getItem('clue-vault:auto-organize') === 'true')
const activeScriptId = ref('')
const view = ref<'clues' | 'organize' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings'>('clues')
const mode = ref<'capture' | 'organize'>('capture')
const busy = ref(false)
const toast = ref('')
const query = ref('')
const filterRound = ref('')
const filterCategory = ref('')
const filterTag = ref('')
const clueSort = ref<'newest' | 'oldest' | 'number' | 'title'>('newest')
const clueSelectionMode = ref(false)
const cluePageSize = ref(60)
const selectedClueIds = ref<string[]>([])
const clueBatchOpen = ref(false)
const reviewWorkbenchOpen = ref(false)
const sourceLocationCount = ref(0)
const archiveRevision = ref('')
const filterPerson = ref('')
const favoriteOnly = ref(false)
const layout = ref<'grid' | 'list'>('list')
const searchIds = ref<string[] | null>(null)
const imageUrls = reactive<Record<string, string>>({})
const compareIds = ref<string[]>([])
const detailId = ref('')
const scriptDialog = ref(false)
const clueDialog = ref(false)
const personDialog = ref(false)
const relationshipDialog = ref(false)
const relationFromGraph = ref(false)
const relationLabelInput = ref<HTMLInputElement | null>(null)
const eventDialog = ref(false)
const noteDialog = ref(false)
const boardDialog = ref(false)
const boardLinkDialog = ref(false)
const annotationOpen = ref(false)
const cropDialog = ref(false)
const documentCorrectionOpen = ref(false)
const discussionOpen = ref(false)
const showCorrectedPhoto = ref(false)
const recentPhotoQuality = ref<{ clueId: string; title: string; report: PhotoQualityReport } | null>(null)
let recentPhotoQualitySequence = 0
const cropImage = ref<HTMLImageElement | null>(null)
const cropStart = ref<{ x: number; y: number } | null>(null)
const cropEnd = ref<{ x: number; y: number } | null>(null)
const cropping = ref(false)
const relationGraph = ref(false)
const photoZoom = ref(false)
const noteId = ref('')
const editingScriptId = ref('')
const editingPersonId = ref('')
const editingEventId = ref('')
const pendingTimelineSuggestionId = ref('')
const mergeTargetId = ref('')
const mergeTargets = computed(() => {
  const source = events.value.find(event => event.id === editingEventId.value)
  return source ? events.value.filter(event => event.confirmed && event.id !== source.id && event.startsAt === source.startsAt) : []
})
const editingBoardId = ref('')
const selectedBoardId = ref('')
const boardZoom = ref(1)
const scriptForm = reactive({ name: '', playDate: '', coverPath: '' })
const clueForm = reactive({ title: '', ocrText: '', round: '', category: '', tags: '', notes: '' })
const personForm = reactive({ name: '', aliases: '', notes: '', photoPath: '' })
const relationForm = reactive({ fromId: '', toId: '', label: '' })
const eventForm = reactive({ title: '', startsAt: '', timeOfDay: '', yearless: false, personIds: [] as string[], clueId: '' })
const noteForm = reactive({ text: '', clueId: '', personId: '' })
const boardForm = reactive({ kind: 'note' as BoardItemRecord['kind'], refId: '', text: '', color: '#f2cc88', group: '' })
const boardLinkForm = reactive({ fromId: '', toId: '', label: '' })
const timelinePersonFilter = ref('')
const timelineDisplayMode = ref<'axis' | 'list'>((() => {
  try { return localStorage.getItem('cluevault:timeline-display') === 'list' ? 'list' : 'axis' } catch { return 'axis' }
})())
const timelineImmersive = ref(false)
const timelineExplorer = ref<{ enterFullscreen: () => void; focusEvent: (eventId: string) => void } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let searchSequence = 0
let workspaceLocationHydrating = false
let loadedWorkspaceScriptId = ''
let captureRoundHydrating = false
let clueDraftHydrating = false
let noteDraftHydrating = false
let clueDraftSequence = 0
let noteDraftSequence = 0
let clueDraftBaseline = ''
let noteDraftBaseline = ''
const clueDraftStatus = ref('')
const noteDraftStatus = ref('')
const clueDraftConflict = ref(false)
const noteDraftConflict = ref(false)
let clueDraftContext: { scriptId: string; recordId: string } | null = null
let noteDraftContext: { scriptId: string; recordId: string } | null = null
let clueDraftWrite = 0
let noteDraftWrite = 0

const nav = [
  { id: 'clues', label: '线索库', icon: 'archive' },
  { id: 'organize', label: '整理总览', icon: 'board' },
  { id: 'settings', label: '剧本管理', icon: 'file' },
] as const
const toolNav = [
  { id: 'profiles', label: '人物档案', icon: 'person', view: 'people', section: 'profiles' },
  { id: 'relationships', label: '人物关系', icon: 'relationship', view: 'people', section: 'relationships' },
  { id: 'timeline', label: '时间线', icon: 'clock', view: 'timeline' },
  { id: 'board', label: '整理板', icon: 'board', view: 'board' },
  { id: 'notes', label: '笔记', icon: 'note', view: 'notes' },
  { id: 'compare', label: '记录对照', icon: 'compare', view: 'compare' },
] as const
const activeToolId = computed(() => view.value === 'people' ? relationGraph.value ? 'relationships' : 'profiles' : view.value)
const activeNavId = computed(() => ['people', 'timeline', 'board', 'notes', 'compare'].includes(view.value) ? 'organize' : view.value)
const viewLabel = computed(() => view.value === 'people' && relationGraph.value ? '人物关系' : ({ clues: '线索库', organize: '整理总览', people: '人物档案', timeline: '时间线', board: '自由整理板', notes: '笔记', compare: '记录对照', settings: '剧本管理' })[view.value])
const activeScript = computed(() => scripts.value.find(item => item.id === activeScriptId.value))
const selectedClue = computed(() => clues.value.find(item => item.id === detailId.value))
const selectedPhotoPath = computed(() => showCorrectedPhoto.value && selectedClue.value?.displayImagePath ? selectedClue.value.displayImagePath : selectedClue.value?.imagePath || '')
const selectedPhotoLabel = computed(() => !showCorrectedPhoto.value || !selectedClue.value?.displayImagePath ? '原始照片' : selectedClue.value.displayImageKind === 'retake' ? '补拍照片' : selectedClue.value.displayImageKind === 'perspective' ? '四角校正视图' : '裁剪视图')
const selectedBoardItem = computed(() => boardItems.value.find(item => item.id === selectedBoardId.value))
const compareClues = computed(() => compareIds.value.map(id => clues.value.find(item => item.id === id)).filter((item): item is ClueRecord => Boolean(item)))
const confirmedEvents = computed(() => events.value.filter(item => item.confirmed))
const sortedConfirmedEvents = computed(() => [...confirmedEvents.value].sort((a, b) => Number(a.startsAt.startsWith('--')) - Number(b.startsAt.startsWith('--')) || a.startsAt.localeCompare(b.startsAt) || timeOfDayRank(a.timeOfDay) - timeOfDayRank(b.timeOfDay)))
const visibleTimelineEvents = computed(() => sortedConfirmedEvents.value.filter(event => !timelinePersonFilter.value || event.personIds.includes(timelinePersonFilter.value)))
const candidateEvents = computed(() => events.value.filter(item => !item.confirmed))
const cropStyle = computed(() => {
  if (!cropStart.value || !cropEnd.value) return {}
  const left = Math.min(cropStart.value.x, cropEnd.value.x) * 100
  const top = Math.min(cropStart.value.y, cropEnd.value.y) * 100
  return { left: `${left}%`, top: `${top}%`, width: `${Math.abs(cropStart.value.x - cropEnd.value.x) * 100}%`, height: `${Math.abs(cropStart.value.y - cropEnd.value.y) * 100}%` }
})
const rounds = computed(() => [...new Set(clues.value.map(item => item.round).filter(Boolean))].sort())
const clueTags = computed(() => [...new Set(clues.value.flatMap(clue => clue.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const selectedBatchClues = computed(() => clues.value.filter(clue => clue.scriptId === activeScriptId.value && selectedClueIds.value.includes(clue.id)))
const hiddenSelectedClueCount = computed(() => selectedBatchClues.value.filter(clue => !visibleClues.value.some(visible => visible.id === clue.id)).length)
const allVisibleCluesSelected = computed(() => visibleClues.value.length > 0 && visibleClues.value.every(clue => selectedClueIds.value.includes(clue.id)))
const categories = computed(() => [...new Set(clues.value.map(item => item.category).filter(Boolean))].sort())
const visibleClues = computed(() => clues.value.filter(item => {
  if (searchIds.value && !searchIds.value.includes(item.id)) return false
  if (filterRound.value && String(item.round) !== String(filterRound.value)) return false
  if (filterCategory.value && item.category !== filterCategory.value) return false
  if (filterTag.value && !item.tags.includes(filterTag.value)) return false
  if (favoriteOnly.value && !item.favorite) return false
  if (filterPerson.value) {
    const person = people.value.find(value => value.id === filterPerson.value)
    if (person && ![person.name, ...person.aliases, ...(person.ocrNames || [])].some(name => name && `${item.title} ${item.ocrText} ${item.notes}`.includes(name))) return false
  }
  return true
}).sort((a, b) => clueSort.value === 'number' ? a.number - b.number : clueSort.value === 'title' ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true }) || a.number - b.number : (clueSort.value === 'oldest' ? a.createdAt.localeCompare(b.createdAt) || a.number - b.number : b.createdAt.localeCompare(a.createdAt) || b.number - a.number)))
const displayedClues = computed(() => visibleClues.value.slice(0, cluePageSize.value))
const elapsedLabel = computed(() => {
  const seconds = Math.floor(organizationElapsed.value / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
})
function requestOrganizationPause() {
  if (!organizationActive.value || organizationPauseRequested.value) return
  organizationPauseRequested.value = true
  organizationProgress.value = '已请求暂停，当前请求结束并保存后停止，不再发送后续请求'
}
const hasClueFilters = computed(() => Boolean(query.value.trim() || filterRound.value || filterCategory.value || filterTag.value || filterPerson.value || favoriteOnly.value))
const activeClueFilters = computed(() => [
  ...(query.value.trim() ? [{ kind: 'query', label: `搜索：${query.value.trim()}` }] : []),
  ...(filterRound.value ? [{ kind: 'round', label: `第 ${filterRound.value} 轮` }] : []),
  ...(filterCategory.value ? [{ kind: 'category', label: filterCategory.value }] : []),
  ...(filterTag.value ? [{ kind: 'tag', label: `标签：${filterTag.value}` }] : []),
  ...(filterPerson.value ? [{ kind: 'person', label: people.value.find(person => person.id === filterPerson.value)?.name || '人物筛选' }] : []),
  ...(favoriteOnly.value ? [{ kind: 'favorite', label: '仅收藏' }] : []),
])
function clearClueFilter(kind?: string) {
  if (!kind || kind === 'query') { query.value = ''; searchIds.value = null; ++searchSequence }
  if (!kind || kind === 'round') filterRound.value = ''
  if (!kind || kind === 'category') filterCategory.value = ''
  if (!kind || kind === 'tag') filterTag.value = ''
  if (!kind || kind === 'person') filterPerson.value = ''
  if (!kind || kind === 'favorite') favoriteOnly.value = false
}
// Navigation preferences are local UI state, scoped by script like the workspace data.
function saveWorkspaceLocation() {
  if (workspaceLocationHydrating || !activeScriptId.value) return
  try {
    localStorage.setItem(`clue-vault:workspace-location:${activeScriptId.value}`, JSON.stringify({
      version: 1, view: view.value, query: query.value, round: String(filterRound.value),
      category: filterCategory.value, tag: filterTag.value, sort: clueSort.value, personId: filterPerson.value, favoriteOnly: favoriteOnly.value,
      layout: layout.value, timelinePersonId: timelinePersonFilter.value, relationGraph: relationGraph.value,
    }))
  } catch { /* Storage pressure must not interrupt reading or capturing clues. */ }
}
function restoreWorkspaceLocation(scriptId: string) {
  workspaceLocationHydrating = true
  try {
    let saved: Record<string, unknown> = {}
    try {
      const raw = JSON.parse(localStorage.getItem(`clue-vault:workspace-location:${scriptId}`) || 'null')
      if (raw && raw.version === 1) saved = raw
    } catch { /* Old or unavailable UI preferences use the default workspace. */ }
    const views = ['clues', 'organize', 'people', 'timeline', 'board', 'notes', 'compare', 'settings']
    view.value = typeof saved.view === 'string' && views.includes(saved.view) ? saved.view as typeof view.value : 'clues'
    mode.value = view.value === 'clues' ? 'capture' : 'organize'
    query.value = typeof saved.query === 'string' ? saved.query : ''
    filterRound.value = typeof saved.round === 'string' ? saved.round : ''
    filterCategory.value = typeof saved.category === 'string' ? saved.category : ''
    filterTag.value = typeof saved.tag === 'string' ? saved.tag : ''
    clueSort.value = saved.sort === 'oldest' || saved.sort === 'number' || saved.sort === 'title' ? saved.sort : 'newest'
    filterPerson.value = typeof saved.personId === 'string' ? saved.personId : ''
    favoriteOnly.value = saved.favoriteOnly === true
    layout.value = saved.layout === 'grid' ? 'grid' : 'list'
    timelinePersonFilter.value = typeof saved.timelinePersonId === 'string' ? saved.timelinePersonId : ''
    relationGraph.value = saved.relationGraph === true
    searchIds.value = query.value.trim() ? [] : null
    ++searchSequence
  } finally { workspaceLocationHydrating = false }
}
function toggleClueSelection(id: string) {
  if (busy.value || !clues.value.some(clue => clue.id === id && clue.scriptId === activeScriptId.value)) return
  selectedClueIds.value = selectedClueIds.value.includes(id) ? selectedClueIds.value.filter(value => value !== id) : [...selectedClueIds.value, id]
}
function toggleVisibleClueSelection() {
  if (busy.value) return
  const visible = new Set(visibleClues.value.map(clue => clue.id))
  selectedClueIds.value = allVisibleCluesSelected.value ? selectedClueIds.value.filter(id => !visible.has(id)) : [...new Set([...selectedClueIds.value, ...visible])]
}
function finishClueSelection() {
  if (busy.value) return
  clueSelectionMode.value = false
  selectedClueIds.value = []
  clueBatchOpen.value = false
}
async function applyClueBatch(patch: BatchCluePatch) {
  const scriptId = activeScriptId.value, ids = selectedBatchClues.value.map(clue => clue.id)
  if (!scriptId || !ids.length) return
  await action(async () => {
    const result = await updateCluesInBatch(scriptId, ids, patch)
    if (result.undo) reviewUndo.value = result.undo
    clueBatchOpen.value = false
    await loadWorkspace()
    notify(result.changed ? `已更新 ${result.changed} 条线索${result.unchanged ? `，${result.unchanged} 条无需修改` : ''}，可撤销` : '所选线索已是这些设置，无需修改')
  })
}
function openWorkspaceSearch() {
  if (!activeScriptId.value) return
  workspaceGuideOpen.value = false
  aiStatusOpen.value = false
  workspaceSearchOpen.value = true
}
function openSearchClue(id: string, quote = '') { workspaceSearchOpen.value = false; openTimelineClue(id, quote) }
function openSearchPerson(id: string) { workspaceSearchOpen.value = false; openPersonWorkspace(id) }
async function openSearchEvent(id: string) {
  const event = events.value.find(item => item.id === id && item.scriptId === activeScriptId.value && item.confirmed)
  if (!event) return
  workspaceSearchOpen.value = false
  await focusWorkspaceEvent(event)
}
function openSearchNote(id: string) {
  const note = notes.value.find(item => item.id === id && item.scriptId === activeScriptId.value)
  if (!note) return
  workspaceSearchOpen.value = false
  switchView('notes')
  void openNoteDialog(note)
}
function navigateFromGuide(next: typeof view.value, section?: 'profiles' | 'relationships') {
  workspaceGuideOpen.value = false
  switchView(next, section)
}
function handleWorkspaceShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
  if (clueDialog.value || noteDialog.value || personDialog.value || eventDialog.value || relationshipDialog.value || scriptDialog.value || boardDialog.value || boardLinkDialog.value || recoveryOpen.value || personMergeSourceId.value || clueBatchOpen.value || reviewWorkbenchOpen.value || operationHistoryOpen.value || correctionPersonId.value || importDialogOpen.value || discussionOpen.value || documentCorrectionOpen.value) return
  if (!activeScriptId.value) return
  event.preventDefault()
  openWorkspaceSearch()
}
const personClueCount = (person: PersonRecord) => clues.value.filter(clue => [person.name, ...person.aliases, ...(person.ocrNames || [])].some(name => name && `${clue.title} ${clue.ocrText}`.includes(name))).length
const boardNodes = computed<Node[]>(() => boardItems.value.map(item => ({
  id: item.id,
  type: 'default',
  position: { x: item.x, y: item.y },
  data: { label: item.kind === 'clue' ? clues.value.find(clue => clue.id === item.refId)?.title || '线索' : item.kind === 'person' ? people.value.find(person => person.id === item.refId)?.name || '人物' : item.text || '便签' },
  class: `board-node board-node-${item.kind}`,
  style: { background: item.color || '#fffaf0' },
})))
const boardEdges = computed<Edge[]>(() => boardLinks.value.map(link => ({ id: link.id, source: link.fromId, target: link.toId, label: link.label || undefined, animated: false, style: { stroke: '#8b7f70', strokeWidth: 2 } })))
const personClueCounts = computed(() => Object.fromEntries(people.value.map(person => [person.id, personClueCount(person)])))

function notify(message: string) {
  toast.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3300)
}
function dateLabel(value: string) {
  if (!value) return '未设置日期'
  const partial = value.match(/^--(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2})(?::\d{2})?)?)?$/)
  if (partial) return `${Number(partial[1])}月${Number(partial[2])}日${partial[3] ? ` ${partial[4] ? `${partial[3]}:${partial[4]}` : `${partial[3]}时`}` : ''}`
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
function timeOfDayRank(value = '') { return ['凌晨', '深夜', '半夜', '清晨', '早晨', '早上', '上午', '中午', '下午', '午后', '傍晚', '晚上', '晚间', '夜里', '夜间'].indexOf(value) }
function timelineDateLabel(value: string, timeOfDay = '') {
  const time = value.match(/T(\d{2}):(\d{2})/)
  return `${dateLabel(value)}${time && !value.startsWith('--') ? ` ${time[1]}:${time[2]}` : ''}${timeOfDay && !/T\d{2}/.test(value) ? ` ${timeOfDay}` : ''}`
}
function timelineEventTitle(event: TimelineRecord) {
  const title = event.title.trim()
  const match = event.startsAt.match(/^(?:--|\d{4}-)(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return title
  const month = Number(match[1])
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  const datePrefix = new RegExp(`^\\s*(?:\\d{4}\\s*年\\s*)?0?${month}\\s*月\\s*0?${day}\\s*(?:日|号)?`)
  const timePrefix = new RegExp(`^\\s*(?:(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|晚上)\\s*)?0?${hour}\\s*(?:[:：点时])\\s*0?${minute}\\s*(?:分)?`)
  const cleaned = title.replace(datePrefix, '').replace(timePrefix, '').replace(/^[\s,，、:：·—-]+/, '').trim()
  return cleaned || title
}
function shortText(value: string, length = 100) { return value.length > length ? `${value.slice(0, length)}…` : value }
function highlight(value: string) {
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
  const safe = escape(value)
  const terms = query.value.trim().split(/\s+/).filter(Boolean).map(escape)
  if (!terms.length) return safe
  return safe.replace(new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<mark>$1</mark>')
}
const pendingImageRequests = new Map<string, Promise<void>>()
const recentFullImagePaths = new Set<string>()
async function loadImagePath(path: string) {
  if (!path || imageUrls[path]) return
  const pending = pendingImageRequests.get(path)
  if (pending) return pending
  const request = vault.imageUrl(path).then(url => { imageUrls[path] = url }).finally(() => pendingImageRequests.delete(path))
  pendingImageRequests.set(path, request)
  return request
}
async function requestClueImage(path: string) {
  if (!clues.value.some(clue => clue.scriptId === activeScriptId.value && (clue.imagePath === path || clue.displayImagePath === path))) return
  try {
    await loadImagePath(path)
    recentFullImagePaths.delete(path); recentFullImagePaths.add(path)
    while (recentFullImagePaths.size > 8) {
      const oldest = recentFullImagePaths.values().next().value!
      recentFullImagePaths.delete(oldest)
      if (!clueDialog.value || selectedClue.value?.imagePath !== oldest) delete imageUrls[oldest]
    }
  } catch { /* The requesting viewer keeps its missing-image state. */ }
}
async function loadImages() {
  const paths = [...new Set([...scripts.value.map(item => item.coverPath), ...people.value.map(item => item.photoPath)].filter(Boolean))]
  const keep = new Set([...paths, ...clues.value.flatMap(clue => [clue.imagePath, clue.displayImagePath])])
  for (const path of Object.keys(imageUrls)) if (!keep.has(path)) delete imageUrls[path]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (next < paths.length) {
      const path = paths[next++]
      try { await loadImagePath(path) } catch { /* File may have been removed outside the app. */ }
    }
  }))
}
async function loadScripts() {
  scripts.value = await vault.listScripts()
  if (activeScriptId.value && !scripts.value.some(item => item.id === activeScriptId.value)) activeScriptId.value = ''
  if (!activeScriptId.value && scripts.value.length) {
    let previousId = ''
    try { previousId = localStorage.getItem('clue-vault:last-script') || '' } catch {}
    activeScriptId.value = scripts.value.some(script => script.id === previousId) ? previousId : scripts.value[0].id
  }
  await loadImages()
}
async function loadWorkspace() {
  const id = activeScriptId.value
  if (!id) {
    loadedWorkspaceScriptId = ''
    clues.value = []; people.value = []; relationships.value = []; events.value = []
    boardItems.value = []; boardLinks.value = []; notes.value = []; organization.value = null; compareIds.value = []; comparisonEventIds.value = []; taskStates.value = []; sourceRevisionReviews.value = []; timeIssueDismissals.value = {}; pendingTimeIssue.value = null; reviewUndo.value = null; reviewRedo.value = null
    return
  }
  if (id !== loadedWorkspaceScriptId) {
    loadedWorkspaceScriptId = id
    clues.value = []; people.value = []; relationships.value = []; events.value = []
    boardItems.value = []; boardLinks.value = []; notes.value = []; organization.value = null; compareIds.value = []; comparisonEventIds.value = []; taskStates.value = []; sourceRevisionReviews.value = []; timeIssueDismissals.value = {}; pendingTimeIssue.value = null; reviewUndo.value = null; reviewRedo.value = null
  }
  const [nextClues, nextPeople, nextRelationships, nextEvents, nextBoardItems, nextBoardLinks, nextNotes, nextOrganization, nextUndo, nextRedo, nextCaptureRound, nextSourceReviews, nextTimeIssueDismissals] = await Promise.all([
    vault.listClues(id), vault.listPeople(id), vault.listRelationships(id), vault.listTimelineEvents(id),
    vault.listBoardItems(id), vault.listBoardLinks(id), vault.listNotes(id), vault.getOrganization(id), loadLastUndo(id), loadLastRedo(id), vault.getLocalState<string>(id, 'capture-round'), getSourceRevisionReviews(id), vault.getLocalState<TimeIssueDismissals>(id, 'timeline-issue-dismissals'),
  ])
  if (id !== activeScriptId.value) return
  const scopedClues = nextClues.filter(item => item.scriptId === id)
  clues.value = scopedClues
  people.value = nextPeople.filter(item => item.scriptId === id)
  if (filterPerson.value && !people.value.some(person => person.id === filterPerson.value)) filterPerson.value = ''
  if (timelinePersonFilter.value && !people.value.some(person => person.id === timelinePersonFilter.value)) timelinePersonFilter.value = ''
  relationships.value = nextRelationships.filter(item => item.scriptId === id)
  events.value = nextEvents.filter(item => item.scriptId === id)
  boardItems.value = nextBoardItems.filter(item => item.scriptId === id)
  boardLinks.value = nextBoardLinks.filter(item => item.scriptId === id)
  notes.value = nextNotes.filter(item => item.scriptId === id)
  organization.value = nextOrganization?.scriptId === id ? nextOrganization : null
  sourceRevisionReviews.value = nextSourceReviews.filter(review => review.scriptId === id)
  timeIssueDismissals.value = nextTimeIssueDismissals || {}
  reviewUndo.value = nextUndo?.scriptId === id ? nextUndo : null
  reviewRedo.value = nextRedo?.scriptId === id ? nextRedo : null
  captureRoundHydrating = true
  captureRound.value = nextCaptureRound?.trim() || '1'
  captureRoundHydrating = false
  captureRoundReady.value = true
  const nextTaskStates = await getOrganizationTaskStates(id, scopedClues)
  if (id !== activeScriptId.value) return
  taskStates.value = nextTaskStates
  compareIds.value = compareIds.value.filter(value => scopedClues.some(clue => clue.id === value))
  comparisonEventIds.value = comparisonEventIds.value.filter(value => events.value.some(event => event.id === value))
  selectedClueIds.value = selectedClueIds.value.filter(value => scopedClues.some(clue => clue.id === value))
  archiveRevision.value = crypto.randomUUID()
  await loadImages()
}
async function action(work: () => Promise<unknown>, success?: string) {
  if (busy.value) return
  busy.value = true
  try { await work(); if (success) notify(success) }
  catch (error) { notify(error instanceof Error ? error.message : '操作未完成，请重试') }
  finally { busy.value = false }
}
function switchView(next: typeof view.value, section?: 'profiles' | 'relationships') {
  view.value = next
  if (next === 'people' && section) relationGraph.value = section === 'relationships'
  mode.value = next === 'clues' ? 'capture' : 'organize'
}
function openTool(item: typeof toolNav[number]) { switchView(item.view, 'section' in item ? item.section : undefined) }
function openGraphPerson(id: string) { const person = people.value.find(item => item.id === id); if (person) openPersonDialog(person) }
function viewPersonClues(id: string) { query.value = ''; filterRound.value = ''; filterCategory.value = ''; filterTag.value = ''; favoriteOnly.value = false; filterPerson.value = id; switchView('clues') }
function openTimelineClue(id: string, quote = '') { const clue = clues.value.find(item => item.id === id && item.scriptId === activeScriptId.value); if (clue) openClue(clue, quote) }
function showPendingOcr() {
  switchView('organize')
  nextTick(() => document.querySelector('[data-pending-processing]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
async function acknowledgeSourceReviews(items: { clueId: string; revision: number }[]) {
  const scriptId = activeScriptId.value
  if (!scriptId) return
  await action(async () => {
    try {
      for (const item of items) await acknowledgeSourceRevision(scriptId, item.clueId, item.revision)
    } finally {
      const reviews = await getSourceRevisionReviews(scriptId)
      if (scriptId === activeScriptId.value) sourceRevisionReviews.value = reviews
    }
  }, '已记录本次来源核对')
}
function acknowledgeOneSource(clueId: string, revision: number) { return acknowledgeSourceReviews([{ clueId, revision }]) }
async function focusSourceReviewEvent(id: string) {
  const event = events.value.find(event => event.id === id && event.scriptId === activeScriptId.value)
  if (!event) return
  clueDialog.value = false
  reviewWorkbenchOpen.value = false
  await focusWorkspaceEvent(event)
}
function openSourceReviews() {
  switchView('organize')
  nextTick(() => document.querySelector('[data-source-reviews]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
function openPersonWorkspace(id: string) { if (people.value.some(person => person.id === id && person.scriptId === activeScriptId.value)) personWorkspaceId.value = id }
async function focusWorkspaceEvent(event: TimelineRecord) {
  if (event.scriptId !== activeScriptId.value) return
  personWorkspaceId.value = ''
  timelinePersonFilter.value = ''
  switchView('timeline')
  await nextTick()
  if (timelineExplorer.value) timelineExplorer.value.focusEvent(event.id)
  else document.querySelector(`[data-event-id="${CSS.escape(event.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
function openTimelineFullscreen() {
  timelineImmersive.value = true
  nextTick(() => {
    if (timelineDisplayMode.value === 'axis') timelineExplorer.value?.enterFullscreen()
    else document.querySelector<HTMLElement>('.timeline-reading-list')?.focus({ preventScroll: true })
  })
}
async function setTimelineDisplayMode(value: 'axis' | 'list') {
  if (timelineDisplayMode.value === value) return
  const stayFullscreen = timelineImmersive.value
  timelineDisplayMode.value = value
  try { localStorage.setItem('cluevault:timeline-display', value) } catch { /* The selected view still works without storage. */ }
  await nextTick()
  timelineImmersive.value = stayFullscreen
  if (stayFullscreen && value === 'axis') timelineExplorer.value?.enterFullscreen()
}
function openRelationshipDialog(fromId = '', toId = '') {
  const from = people.value.find(person => person.id === fromId && person.scriptId === activeScriptId.value)
  const to = people.value.find(person => person.id === toId && person.scriptId === activeScriptId.value && person.id !== from?.id)
  relationForm.fromId = from?.id || ''
  relationForm.toId = to?.id || ''
  relationForm.label = ''
  relationFromGraph.value = Boolean(from && to)
  relationshipDialog.value = true
  nextTick(() => relationLabelInput.value?.focus())
}
function selectScript(id: string) {
  if (busy.value) return notify('当前操作完成后再切换剧本')
  activeScriptId.value = id
}
function openScriptDialog(script?: ScriptRecord) {
  editingScriptId.value = script?.id || ''
  scriptForm.name = script?.name || ''
  scriptForm.playDate = script?.playDate || ''
  scriptForm.coverPath = script?.coverPath || ''
  scriptDialog.value = true
}
async function chooseCover() {
  await action(async () => { scriptForm.coverPath = await vault.pickLocalImage() })
}
async function saveScript() {
  if (!scriptForm.name.trim()) return notify('请填写剧本名称')
  await action(async () => {
    if (editingScriptId.value) await vault.updateScript(editingScriptId.value, { name: scriptForm.name.trim(), playDate: scriptForm.playDate, coverPath: scriptForm.coverPath })
    else {
      const created = await vault.createScript({ name: scriptForm.name.trim(), playDate: scriptForm.playDate, coverPath: scriptForm.coverPath })
      activeScriptId.value = created.id
    }
    scriptDialog.value = false
    await loadScripts()
    await loadWorkspace()
  }, '剧本已保存')
}
async function removeScript(script: ScriptRecord) {
  if (!window.confirm(`删除「${script.name}」及其中全部线索、人物和笔记？此操作无法撤销。`)) return
  await action(async () => {
    await vault.deleteScript(script.id)
    try { localStorage.removeItem(`clue-vault:workspace-location:${script.id}`); if (localStorage.getItem('clue-vault:last-script') === script.id) localStorage.removeItem('clue-vault:last-script') } catch {}
    activeScriptId.value = ''
    await loadScripts()
    if (activeScriptId.value) await loadWorkspace()
    else { clues.value = []; people.value = []; events.value = []; boardItems.value = []; notes.value = [] }
  }, '剧本已删除')
}
async function performOrganization(retryClueIds?: string[]) {
  const scriptId = activeScriptId.value
  if (!scriptId) throw new Error('请先打开一个剧本')
  organizationActive.value = true
  organizationPauseRequested.value = false
  organizationPaused.value = false
  organizationElapsed.value = 0
  organizationStartedAt.value = Date.now()
  if (organizationElapsedTimer) clearInterval(organizationElapsedTimer)
  organizationElapsedTimer = setInterval(() => { organizationElapsed.value = Date.now() - organizationStartedAt.value }, 1000)
  organizationProgress.value = '正在检查新增与修改的 OCR 文字…'
  try {
    const result = await organizeIncrementally({
      scriptId, clues: clues.value, people: people.value, relationships: relationships.value, events: events.value,
      previous: await vault.getOrganization(scriptId), retryClueIds, shouldPause: () => organizationPauseRequested.value,
      onProgress: ({ processed, total, clue, stage, message }) => { if (activeScriptId.value === scriptId) organizationProgress.value = organizationPauseRequested.value ? '已请求暂停，当前请求结束并保存后停止' : `已完成 ${processed} / ${total} 条 · #${String(clue.number).padStart(3, '0')} ${message || (stage === 'checking' ? '正在核对时间' : '正在提取信息')}` },
    }, organizer.organizeClues)
    if (activeScriptId.value === scriptId) {
      organization.value = result.snapshot
      events.value = await vault.listTimelineEvents(scriptId)
      organizationPaused.value = result.paused
      organizationProgress.value = result.paused ? `整理已暂停，已完成 ${result.processed} / ${result.total} 条，剩余 ${result.remaining} 条；当前结果已保存` : result.processed ? `本次整理 ${result.processed} 条，跳过 ${result.skipped} 条未变更线索` : '没有新增或修改的 OCR，已有整理结果已保留'
    }
  } catch (error) {
    if (activeScriptId.value === scriptId) {
      organization.value = await vault.getOrganization(scriptId)
      organizationProgress.value = '已完成的结果已保存，可再次整理继续剩余线索'
    }
    throw error
  } finally {
    organizationActive.value = false
    organizationElapsed.value = Date.now() - organizationStartedAt.value
    if (organizationElapsedTimer) clearInterval(organizationElapsedTimer)
    organizationElapsedTimer = undefined
    const states = await getOrganizationTaskStates(scriptId, await vault.listClues(scriptId))
    if (activeScriptId.value === scriptId) taskStates.value = states
  }
}
async function runOrganization() {
  if (!clues.value.some(item => item.ocrText.trim())) return notify('当前剧本没有可整理的 OCR 文字')
  await action(async () => { await performOrganization(); notify(organizationPaused.value ? '进度已保存，整理已暂停' : '整理建议已更新') })
}
async function retryTimeExtraction(sourceNo: number) {
  const clue = clues.value.find(clue => clue.scriptId === activeScriptId.value && clue.number === sourceNo)
  if (!clue || !clue.ocrText.trim()) return notify('这条线索暂无 OCR 文字，请先完成识别')
  reviewWorkbenchOpen.value = false
  await action(async () => {
    await performOrganization([clue.id])
    await loadWorkspace()
    notify(organizationPaused.value ? '已保存进度，可稍后继续' : '重新查找完成；到“整理建议”里点“直接录入”，即可把新时间加入时间线')
  })
}
async function ignoreTimeIssues(ids: string[]) {
  const scriptId = activeScriptId.value
  const issues = timeExtractionIssues.value.filter(issue => ids.includes(issue.id))
  if (!scriptId || !issues.length) return
  await action(async () => {
    const next: TimeIssueDismissals = JSON.parse(JSON.stringify(timeIssueDismissals.value))
    for (const issue of issues) {
      const clue = clues.value.find(clue => clue.scriptId === scriptId && clue.number === issue.sourceNo)
      if (!clue) continue
      const previous = next[clue.id]
      next[clue.id] = { ocrText: clue.ocrText, ids: [...new Set([...(previous?.ocrText === clue.ocrText ? previous.ids : []), issue.id])] }
    }
    await vault.saveLocalState(scriptId, 'timeline-issue-dismissals', next)
    if (activeScriptId.value === scriptId) timeIssueDismissals.value = next
  }, '已忽略提示，线索和事件均保留')
}
function addTimeIssue(issue: organizer.TimelineExtractionIssue) {
  if (!timeExtractionIssues.value.some(current => current.id === issue.id)) return
  const clue = clues.value.find(clue => clue.scriptId === activeScriptId.value && clue.number === issue.sourceNo)
  if (!clue) return
  openEventDialog()
  pendingTimeIssue.value = issue
  eventForm.startsAt = issue.startsAt || ''
  eventForm.timeOfDay = issue.timeOfDay || ''
  eventForm.yearless = !issue.startsAt || issue.startsAt.startsWith('--')
  eventForm.clueId = clue.id
  nextTick(() => document.querySelector<HTMLInputElement>('[data-event-title]')?.focus())
}
async function capture() {
  if (!activeScriptId.value || busy.value) return
  if (!captureRoundReady.value) return notify('正在读取当前剧本，请稍候')
  let message = '', completed = false
  await action(async () => {
    const scriptId = activeScriptId.value, round = Number(captureRound.value) || 1
    let result: Awaited<ReturnType<typeof vault.captureClues>>
    try { result = await vault.captureClues(scriptId, round) }
    finally { await loadWorkspace() }
    if (!result.clues.length) { message = '这条线索已存在，已跳过重复录入'; completed = true; return }
    const missing = result.clues.filter(clue => !clue.ocrText.trim()).length
    const latest = result.clues[result.clues.length - 1]
    if (latest) void assessRecentPhoto(latest)
    message = missing ? '照片已保存，识别未完成，可重试识别' : '照片已保存，可继续拍摄'
    if (autoOrganize.value && result.clues.some(clue => clue.ocrText.trim())) {
      try { await performOrganization(); message = organizationPaused.value ? '照片已录入，整理已暂停，可稍后继续' : '照片已录入，整理建议已更新' }
      catch (error) { message = `照片已保存，整理未完成：${error instanceof Error ? error.message : '请重试'}` }
    }
    completed = true
  })
  if (completed) notify(message)
}
async function importPhotos() {
  if (!activeScriptId.value || busy.value) return
  if (!captureRoundReady.value) return notify('正在读取当前剧本，请稍候')
  let message = '', completed = false
  await action(async () => {
    const scriptId = activeScriptId.value, round = Number(captureRound.value) || 1
    let result: Awaited<ReturnType<typeof vault.importCluePhotos>>
    try { result = await vault.importCluePhotos(scriptId, round) }
    finally { await loadWorkspace() }
    const imported = result.clues
    const latest = imported[imported.length - 1]
    if (latest) void assessRecentPhoto(latest)
    const skipped = result.skippedDuplicates ? `，跳过 ${result.skippedDuplicates} 张重复照片` : ''
    const missing = imported.filter(clue => !clue.ocrText.trim()).length
    message = imported.length ? `已保存 ${imported.length} 张图片${missing ? `，${missing} 张待重新识别` : ''}${skipped}` : '所选图片均为重复线索，已跳过'
    if (imported.some(clue => clue.ocrText.trim()) && autoOrganize.value) {
      try { await performOrganization(); message = `图片已录入，${organizationPaused.value ? '整理已暂停' : '整理建议已更新'}${missing ? `，${missing} 张待重新识别` : ''}${skipped}` }
      catch (error) { message = `图片已保存，整理未完成：${error instanceof Error ? error.message : '请重试'}${skipped}` }
    }
    completed = true
  })
  if (completed) notify(message)
}
async function retryOcr(clue: ClueRecord) {
  const scriptId = activeScriptId.value
  if (clue.scriptId !== scriptId) return
  await action(async () => {
    const result = await vault.retryClueOcr(scriptId, clue.id)
    await loadWorkspace()
    if (result.ocrStatus !== 'complete') throw new Error(result.ocrError || '仍未识别到文字，照片已保留')
    notify('文字识别完成，可以继续整理')
  })
}
async function recoverLegacyBrowserOcr() {
  const scriptId = activeScriptId.value
  if (!scriptId || Capacitor.isNativePlatform()) return
  const legacyError = '未识别到文字，原始照片已保存，可以重新识别或手动输入'
  const pending = (await vault.listClues(scriptId)).filter(clue => !clue.ocrText.trim() && clue.ocrStatus === 'failed' && clue.ocrError === legacyError)
  for (const clue of pending) {
    if (activeScriptId.value !== scriptId) return
    try {
      const result = await vault.retryClueOcr(scriptId, clue.id)
      clues.value = clues.value.map(item => item.id === result.id ? result : item)
    } catch {
      // Keep older clues available for a manual retry if browser OCR cannot initialize.
    }
  }
}
async function changeRecentRound(clueId: string, round: string) {
  if (!clues.value.some(clue => clue.id === clueId && clue.scriptId === activeScriptId.value)) return
  await action(async () => { await vault.updateClue(clueId, { round: Number(round) || 1 }); await loadWorkspace() }, '轮次已更新')
}
async function assessRecentPhoto(clue: ClueRecord) {
  const sequence = ++recentPhotoQualitySequence, scriptId = clue.scriptId
  recentPhotoQuality.value = null
  try {
    const path = clue.displayImagePath || clue.imagePath
    const url = await vault.imageUrl(path)
    const report = await analyzePhotoQuality(url, path === clue.ocrImagePath ? clue.ocrRegions : [])
    if (sequence === recentPhotoQualitySequence && scriptId === activeScriptId.value && clues.value.some(item => item.id === clue.id && item.scriptId === scriptId) && report.issues.length) recentPhotoQuality.value = { clueId: clue.id, title: clue.title, report }
  } catch { /* The detail panel provides a visible retry if its local check fails. */ }
}
function openDiscussion() {
  if (busy.value || !activeScript.value) return
  aiStatusOpen.value = false
  workspaceGuideOpen.value = false
  discussionOpen.value = true
}
async function saveDocumentCorrection(dataUrl: string) {
  const clue = selectedClue.value, scriptId = activeScriptId.value
  if (!clue || clue.scriptId !== scriptId) return
  await action(async () => {
    const result = await vault.saveCorrectedCluePhoto(scriptId, clue.id, dataUrl)
    reviewUndo.value = result.undo
    await loadWorkspace()
    await requestClueImage(result.clue.displayImagePath)
    showCorrectedPhoto.value = true
    photoZoom.value = false
    documentCorrectionOpen.value = false
    void assessRecentPhoto(result.clue)
  }, '已保存校正副本，原图和 OCR 文字保留，可撤销')
}
async function retakeSelectedPhoto() {
  const clue = selectedClue.value, scriptId = activeScriptId.value
  if (!clue || clue.scriptId !== scriptId) return
  await action(async () => {
    const result = await vault.retakeCluePhoto(scriptId, clue.id)
    reviewUndo.value = result.undo
    await loadWorkspace()
    await requestClueImage(result.clue.displayImagePath)
    showCorrectedPhoto.value = true
    photoZoom.value = false
    void assessRecentPhoto(result.clue)
  }, '补拍已保存到这条线索，原图和 OCR 文字保留，可撤销')
}
async function refreshApiKeyConfiguration(provider: AiProvider) {
  try { apiKeysConfigured[provider] = await organizer.hasApiKey(provider) }
  catch { apiKeysConfigured[provider] = false }
  if (aiRoute.provider === provider) apiKeyConfigured.value = apiKeysConfigured[provider]
}
async function saveProviderKey(provider: AiProvider) {
  await action(async () => {
    await organizer.saveApiKey(apiKeyDrafts[provider], provider)
    apiKeyDrafts[provider] = ''
    apiKeysConfigured[provider] = true
    if (aiRoute.provider === provider) apiKeyConfigured.value = true
  }, `${providerLabel(provider)} API Key 已保存到 ${Capacitor.isNativePlatform() ? 'iPad Keychain' : '当前浏览器本地存储'}`)
}
async function removeProviderKey(provider: AiProvider) {
  await action(async () => {
    await organizer.removeApiKey(provider)
    apiKeysConfigured[provider] = false
    if (aiRoute.provider === provider) {
      apiKeyConfigured.value = false
      autoOrganize.value = false
      localStorage.setItem('clue-vault:auto-organize', 'false')
    }
  }, `${providerLabel(provider)} API Key 已从${Capacitor.isNativePlatform() ? ' iPad' : '当前浏览器'}移除`)
}
function openAiStatus() { aiStatusOpen.value = !aiStatusOpen.value }
async function retryAiService() {
  await initializeAiRouting()
  if (aiRoute.provider) await refreshApiKeyConfiguration(aiRoute.provider)
}
function saveAutoOrganize() {
  if (autoOrganize.value && !apiKeyConfigured.value) {
    autoOrganize.value = false
    return notify(aiRoute.provider ? `请先保存 ${providerLabel(aiRoute.provider)} API Key` : '请先检测并配置 AI 服务')
  }
  localStorage.setItem('clue-vault:auto-organize', String(autoOrganize.value))
}
async function refreshOrganization() {
  if (activeScriptId.value) organization.value = await vault.getOrganization(activeScriptId.value)
}
async function applyReviewSelection(selection: ReviewSelection[], mode: 'accept' | 'ignore') {
  const scriptId = activeScriptId.value
  if (!scriptId || !selection.length) return
  await action(async () => {
    const result = await reviewSuggestions(scriptId, selection, mode)
    if (result.undo) reviewUndo.value = result.undo
    await loadWorkspace()
    notify(`${mode === 'accept' ? '已录入' : '已忽略'} ${result.applied} 条${result.skipped ? `，${result.skipped} 条需补充后录入` : ''}${result.warning ? `；${result.warning}` : ''}`)
  })
}
function acceptPersonSuggestion(id: string) { return applyReviewSelection([{ kind: 'people', id }], 'accept') }
function acceptRelationshipSuggestion(id: string) { return applyReviewSelection([{ kind: 'relationships', id }], 'accept') }
function acceptCluePointSuggestion(id: string) { return applyReviewSelection([{ kind: 'cluePoints', id }], 'accept') }
function acceptTimelineSuggestion(id: string) {
  const item = organization.value?.timeline.find(value => value.id === id)
  if (!item) return
  if (item.requiresTitle || item.title === '待补充事件') { openTimelineSuggestionDialog(item); return }
  return applyReviewSelection([{ kind: 'timeline', id }], 'accept')
}
function acceptWorkbenchSuggestion(selection: ReviewSelection) {
  if (selection.kind === 'timeline') return acceptTimelineSuggestion(selection.id)
  return applyReviewSelection([selection], 'accept')
}
async function locateClueSource(id: string) {
  const scriptId = activeScriptId.value
  if (!scriptId || !clues.value.some(clue => clue.id === id && clue.scriptId === scriptId)) return
  await action(async () => {
    await vault.locateClueText(scriptId, id)
    if (scriptId === activeScriptId.value) await loadWorkspace()
  }, '原图文字定位已补充，已有 OCR 文字保持不变')
}
async function undoLastChange() {
  const undo = reviewUndo.value
  if (!undo || undo.scriptId !== activeScriptId.value) return
  await action(async () => {
    await undo.run()
    await loadWorkspace()
  }, '已撤销上一步')
}
async function redoLastChange() {
  const redo = reviewRedo.value
  if (!redo || redo.scriptId !== activeScriptId.value) return
  await action(async () => { await redo.run(); await loadWorkspace() }, '已重做上一步')
}
function openNameCorrections(personId: string) {
  if (!people.value.some(person => person.id === personId && person.scriptId === activeScriptId.value)) return
  personWorkspaceId.value = ''
  personDialog.value = false
  correctionPersonId.value = personId
}
async function nameCorrectionChanged(undo: ReviewUndo) {
  if (undo.scriptId !== activeScriptId.value) return
  await action(async () => { reviewUndo.value = undo; await loadWorkspace() }, '姓名识别纠错规则已保存')
}
function clearOrganizationSuggestions() {
  const current = organization.value
  if (!current) return
  const selection = (['people', 'relationships', 'timeline', 'cluePoints'] as const).flatMap(kind => current[kind].map(item => ({ kind, id: item.id })))
  return applyReviewSelection(selection, 'ignore')
}
function openSourceClue(sourceNo: number, quote = '') {
  const clue = clues.value.find(item => item.number === sourceNo)
  if (clue) openClue(clue, quote)
}
async function openClue(clue: ClueRecord, quote = '') {
  const scriptId = activeScriptId.value
  if (!scriptId || clue.scriptId !== scriptId) return
  clueDialog.value = false
  const sequence = ++clueDraftSequence
  clueDraftHydrating = true
  clueDraftContext = { scriptId, recordId: clue.id }
  detailId.value = clue.id
  sourceExcerpt.value = quote && clue.ocrText.includes(quote) ? quote : ''
  sourceLocationCount.value = 0
  showCorrectedPhoto.value = Boolean(clue.displayImagePath && !sourceExcerpt.value)
  Object.assign(clueForm, { title: clue.title, ocrText: clue.ocrText, round: clue.round, category: clue.category, tags: clue.tags.join('，'), notes: clue.notes })
  clueDraftBaseline = JSON.stringify(clueForm)
  clueDraftStatus.value = '没有未保存修改'
  clueDraftConflict.value = false
  try {
    await Promise.all([requestClueImage(clue.imagePath), ...(clue.displayImagePath ? [requestClueImage(clue.displayImagePath)] : [])])
    const draft = await getDraft<typeof clueForm>(scriptId, 'clue', clue.id)
    if (sequence !== clueDraftSequence || scriptId !== activeScriptId.value || detailId.value !== clue.id) return
    if (draft && JSON.stringify(draft.values) !== draft.baseline) {
      Object.assign(clueForm, draft.values)
      clueDraftConflict.value = draft.baseline !== clueDraftBaseline
      clueDraftBaseline = draft.baseline
      clueDraftStatus.value = '已恢复未保存草稿；正式线索尚未修改'
    }
  } catch { if (sequence === clueDraftSequence) clueDraftStatus.value = '草稿读取失败，当前显示正式线索' }
  finally { if (sequence === clueDraftSequence && scriptId === activeScriptId.value) { clueDraftHydrating = false; photoZoom.value = Boolean(sourceExcerpt.value); clueDialog.value = true } }
}
async function discardClueDraft() {
  const context = clueDraftContext
  const clue = selectedClue.value
  if (!context || !clue || busy.value) return
  await removeDraft(context.scriptId, 'clue', context.recordId)
  if (context.scriptId === activeScriptId.value && detailId.value === context.recordId) await openClue(clue, sourceExcerpt.value)
}
async function saveClue() {
  const clue = selectedClue.value, scriptId = activeScriptId.value
  if (!clue || clue.scriptId !== scriptId) return
  const input = { title: clueForm.title.trim() || `线索 ${clue.number}`, ocrText: clueForm.ocrText, round: Number(clueForm.round) || 1, category: clueForm.category, tags: clueForm.tags.split(/[，,]/).map(value => value.trim()).filter(Boolean), notes: clueForm.notes }
  await action(async () => {
    await vault.updateClue(clue.id, input)
    await removeDraft(scriptId, 'clue', clue.id)
    clueDraftContext = null
    clueDraftStatus.value = '已保存到正式线索'
    clueDialog.value = false
    await loadWorkspace()
  }, '线索已保存')
}
async function toggleFavorite(clue: ClueRecord) {
  await action(async () => { await vault.updateClue(clue.id, { favorite: !clue.favorite }); await loadWorkspace() })
}
async function rotatePhoto(clue: ClueRecord) {
  await action(async () => { await vault.updateClue(clue.id, { rotation: (clue.rotation + 90) % 360 }); await loadWorkspace() })
}
function openCrop() {
  cropStart.value = null; cropEnd.value = null; cropDialog.value = true
}
function pointOnCrop(event: PointerEvent) {
  const rect = cropImage.value?.getBoundingClientRect()
  if (!rect) return null
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
}
function beginCrop(event: PointerEvent) {
  const point = pointOnCrop(event)
  if (!point) return
  cropStart.value = point; cropEnd.value = point; cropping.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveCrop(event: PointerEvent) { if (cropping.value) cropEnd.value = pointOnCrop(event) }
function endCrop() { cropping.value = false }
async function applyCrop() {
  if (!selectedClue.value || !cropStart.value || !cropEnd.value) return
  const x = Math.min(cropStart.value.x, cropEnd.value.x)
  const y = Math.min(cropStart.value.y, cropEnd.value.y)
  const width = Math.abs(cropStart.value.x - cropEnd.value.x)
  const height = Math.abs(cropStart.value.y - cropEnd.value.y)
  if (width < .03 || height < .03) return notify('请拖出更大的裁剪范围')
  await action(async () => { await vault.cropCluePhoto(selectedClue.value!.id, { x, y, width, height }); cropDialog.value = false; await loadWorkspace(); if (selectedClue.value?.displayImagePath) await requestClueImage(selectedClue.value.displayImagePath); showCorrectedPhoto.value = true }, '已保存裁剪视图，原图仍保留')
}
async function removeClue(clue: ClueRecord) {
  if (!window.confirm(`删除线索「${clue.title}」？可在“回收站与恢复”中找回。`)) return
  await action(async () => { await vault.deleteClue(clue.id); await removeDraft(clue.scriptId, 'clue', clue.id); clueDraftContext = null; clueDialog.value = false; await loadWorkspace() }, '线索已移入回收站')
}
function toggleCompare(id: string) {
  compareIds.value = compareIds.value.includes(id) ? compareIds.value.filter(value => value !== id) : [...compareIds.value, id]
}
function openPersonDialog(person?: PersonRecord) {
  editingPersonId.value = person?.id || ''
  personForm.name = person?.name || ''
  personForm.aliases = person?.aliases.join('，') || ''
  personForm.notes = person?.notes || ''
  personForm.photoPath = person?.photoPath || ''
  personDialog.value = true
}
function openPersonMerge(id: string) {
  if (!people.value.some(person => person.id === id && person.scriptId === activeScriptId.value)) return
  personMergeSourceId.value = id
  personDialog.value = false
  personWorkspaceId.value = ''
}
async function confirmPersonMerge(sourceId: string, targetId: string) {
  const scriptId = activeScriptId.value
  await action(async () => {
    reviewUndo.value = await mergePeople(scriptId, sourceId, targetId)
    await loadWorkspace()
    if (scriptId === activeScriptId.value) { personMergeSourceId.value = ''; openPersonWorkspace(targetId) }
  }, '人物已合并，原名保留为别名，可撤销')
}
function compareWorkspaceEvent(eventId: string) {
  if (!events.value.some(event => event.id === eventId && event.scriptId === activeScriptId.value)) return
  comparisonEventIds.value = [eventId]
  personWorkspaceId.value = ''
  switchView('compare')
}
async function mergeComparisonEvents(sourceId: string, targetId: string) {
  const scriptId = activeScriptId.value
  await action(async () => {
    reviewUndo.value = await mergeConfirmedEvents(scriptId, sourceId, targetId)
    await loadWorkspace()
    if (scriptId === activeScriptId.value) comparisonEventIds.value = [targetId]
  }, '事件已合并，出处已保留，可撤销')
}
async function choosePersonPhoto() {
  await action(async () => { personForm.photoPath = await vault.pickLocalImage() })
}
async function savePerson() {
  if (!personForm.name.trim() || !activeScriptId.value) return notify('请填写人物姓名')
  const input = { name: personForm.name.trim(), aliases: personForm.aliases.split(/[，,]/).map(value => value.trim()).filter(Boolean), notes: personForm.notes, photoPath: personForm.photoPath }
  await action(async () => {
    if (editingPersonId.value) await vault.updatePerson(editingPersonId.value, input)
    else await vault.createPerson(activeScriptId.value, input)
    await loadWorkspace(); personDialog.value = false
  }, '人物已保存')
}
async function removePerson(person: PersonRecord) {
  if (!window.confirm(`删除人物「${person.name}」？`)) return
  await action(async () => { await vault.deletePerson(person.id); await loadWorkspace() }, '人物已删除')
}
async function saveRelationship() {
  if (!activeScriptId.value || !relationForm.fromId || !relationForm.toId || relationForm.fromId === relationForm.toId || !relationForm.label.trim()) return notify('请选择两位不同人物并填写关系')
  const label = relationForm.label.trim()
  const duplicate = relationships.value.some(relation => relation.scriptId === activeScriptId.value && relation.label.trim() === label && ((relation.fromId === relationForm.fromId && relation.toId === relationForm.toId) || (relation.fromId === relationForm.toId && relation.toId === relationForm.fromId)))
  if (duplicate) { relationshipDialog.value = false; return notify('这条人物关系已存在') }
  await action(async () => {
    const created = await vault.createRelationship(activeScriptId.value, { fromId: relationForm.fromId, toId: relationForm.toId, label })
    reviewUndo.value = await recordUndo(activeScriptId.value, '添加人物关系', 'relationships', null, created)
    await loadWorkspace(); relationshipDialog.value = false
  }, '关系已添加')
}
async function removeRelationship(id: string) {
  const previous = relationships.value.find(item => item.id === id)
  if (!previous) return
  await action(async () => { await vault.deleteRelationship(id); reviewUndo.value = await recordUndo(activeScriptId.value, '删除人物关系', 'relationships', previous, null); await loadWorkspace() }, '关系已删除，可撤销')
}
function openEventDialog(event?: TimelineRecord) {
  pendingTimeIssue.value = null
  mergeTargetId.value = ''
  pendingTimelineSuggestionId.value = ''
  editingEventId.value = event?.id || ''
  eventForm.title = event?.title || ''
  eventForm.startsAt = event?.startsAt || ''
  eventForm.timeOfDay = event?.timeOfDay || ''
  eventForm.yearless = Boolean(event?.startsAt.startsWith('--'))
  eventForm.personIds = event?.personIds ? [...event.personIds] : []
  eventForm.clueId = event?.clueId || ''
  eventDialog.value = true
}
function openTimelineSuggestionDialog(item: OrganizationTimelineSuggestion) {
  pendingTimeIssue.value = null
  mergeTargetId.value = ''
  pendingTimelineSuggestionId.value = item.id
  editingEventId.value = ''
  eventForm.title = item.requiresTitle ? '' : item.title
  eventForm.yearless = item.startsAt.startsWith('--')
  eventForm.startsAt = item.startsAt
  eventForm.timeOfDay = item.timeOfDay || ''
  eventForm.personIds = people.value.filter(person => item.people.some(name => name === person.name || person.aliases.includes(name))).map(person => person.id)
  eventForm.clueId = clues.value.find(clue => clue.number === item.sourceNo)?.id || ''
  eventDialog.value = true
}
function toggleEventYearless() {
  if (eventForm.yearless) {
    eventForm.yearless = false
    eventForm.startsAt = ''
    return
  }
  const dated = eventForm.startsAt.match(/^\d{4}-(\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/)
  eventForm.startsAt = dated ? `--${dated[1]}${dated[2] ? `T${dated[2]}` : ''}` : '--'
  eventForm.yearless = true
}
async function toggleYearlessMarker(event: TimelineRecord) {
  await action(async () => {
    const saved = await vault.updateTimelineEvent(event.id, { yearlessMarkerIgnored: !event.yearlessMarkerIgnored })
    reviewUndo.value = await recordUndo(activeScriptId.value, '切换无年份标记', 'timeline', event, saved)
    await loadWorkspace()
  }, event.yearlessMarkerIgnored ? '已显示无年份标记' : '已忽略无年份标记')
}
async function saveEvent() {
  const startsAt = eventForm.startsAt.trim()
  if (!activeScriptId.value || !eventForm.title.trim() || !startsAt) return notify('请填写事件与时间')
  if (eventForm.yearless && !/^--\d{2}-\d{2}(?:T\d{2}(?::\d{2})?)?$/.test(startsAt)) return notify('无年份时间请按 --月-日 或 --月-日T时:分 填写')
  const existingEvent = events.value.find(event => event.id === editingEventId.value)
  const suggestion = organization.value?.timeline.find(item => item.id === pendingTimelineSuggestionId.value)
  const issue = pendingTimeIssue.value
  const issueClue = issue && clues.value.find(clue => clue.id === eventForm.clueId && clue.scriptId === activeScriptId.value && clue.number === issue.sourceNo && clue.ocrText.includes(issue.quote))
  const issueEvidence = issue && issueClue && issue.quote ? [{ clueId: issueClue.id, sourceNo: issueClue.number, quote: issue.quote }] : undefined
  const input = { evidence: suggestion ? timelineEvidence(suggestion, clues.value) : issueEvidence || existingEvent?.evidence, precision: (/T\d{2}:\d{2}/.test(startsAt) ? 'minute' : /T\d{2}/.test(startsAt) ? 'hour' : 'date') as 'minute' | 'hour' | 'date', approximate: suggestion?.approximate ?? issue?.approximate ?? existingEvent?.approximate, timeOfDay: suggestion?.timeOfDay || issue?.timeOfDay || eventForm.timeOfDay || existingEvent?.timeOfDay, title: eventForm.title.trim(), startsAt, personIds: [...eventForm.personIds], clueId: eventForm.clueId, confirmed: true, yearlessMarkerIgnored: eventForm.yearless ? existingEvent?.yearlessMarkerIgnored ?? false : false }
  await action(async () => {
    const previousEvents = await vault.listTimelineEvents(activeScriptId.value)
    const organizationBefore = await vault.getOrganization(activeScriptId.value)
    const saved = editingEventId.value ? await vault.updateTimelineEvent(editingEventId.value, input) : await vault.createTimelineEvent(activeScriptId.value, input)
    if (pendingTimelineSuggestionId.value) await vault.resolveOrganizationSuggestion(activeScriptId.value, 'timeline', pendingTimelineSuggestionId.value)
    pendingTimelineSuggestionId.value = ''
    reviewUndo.value = await recordUndo(activeScriptId.value, '保存时间节点', 'timeline', previousEvents.find(item => item.id === saved.id) || null, saved, organizationBefore)
    await loadWorkspace(); eventDialog.value = false; pendingTimeIssue.value = null
  }, '时间节点已保存')
}
async function mergeEvent() {
  if (!editingEventId.value || !mergeTargetId.value) return
  await action(async () => {
    reviewUndo.value = await mergeConfirmedEvents(activeScriptId.value, editingEventId.value, mergeTargetId.value)
    await loadWorkspace()
    eventDialog.value = false
    mergeTargetId.value = ''
  }, '事件已合并，所有出处已保留，可撤销')
}
async function removeEvent(id: string) {
  const previous = events.value.find(event => event.id === id)
  if (!previous) return
  await action(async () => { await vault.deleteTimelineEvent(id); reviewUndo.value = await recordUndo(activeScriptId.value, '删除时间节点', 'timeline', previous, null); await loadWorkspace() }, '时间节点已删除，可撤销')
}
async function openNoteDialog(note?: NoteRecord) {
  const scriptId = activeScriptId.value
  if (!scriptId || (note && note.scriptId !== scriptId)) return
  noteDialog.value = false
  const sequence = ++noteDraftSequence, recordId = note?.id || 'new'
  noteDraftHydrating = true
  noteDraftContext = { scriptId, recordId }
  noteId.value = note?.id || ''
  Object.assign(noteForm, { text: note?.text || '', clueId: note?.clueId || '', personId: note?.personId || '' })
  noteDraftBaseline = JSON.stringify(noteForm)
  noteDraftStatus.value = '没有未保存修改'
  noteDraftConflict.value = false
  try {
    const draft = await getDraft<typeof noteForm>(scriptId, 'note', recordId)
    if (sequence !== noteDraftSequence || scriptId !== activeScriptId.value || (noteId.value || 'new') !== recordId) return
    if (draft && JSON.stringify(draft.values) !== draft.baseline) {
      Object.assign(noteForm, draft.values)
      noteDraftConflict.value = draft.baseline !== noteDraftBaseline
      noteDraftBaseline = draft.baseline
      if (noteForm.clueId && !clues.value.some(clue => clue.id === noteForm.clueId && clue.scriptId === scriptId)) { noteForm.clueId = ''; noteDraftConflict.value = true }
      if (noteForm.personId && !people.value.some(person => person.id === noteForm.personId && person.scriptId === scriptId)) { noteForm.personId = ''; noteDraftConflict.value = true }
      noteDraftStatus.value = '已恢复未保存草稿；正式笔记尚未修改'
    }
  } catch { if (sequence === noteDraftSequence) noteDraftStatus.value = '草稿读取失败，当前显示正式笔记' }
  finally { if (sequence === noteDraftSequence && scriptId === activeScriptId.value) { noteDraftHydrating = false; noteDialog.value = true } }
}
async function discardNoteDraft() {
  const context = noteDraftContext
  if (!context || busy.value) return
  await removeDraft(context.scriptId, 'note', context.recordId)
  if (context.scriptId === activeScriptId.value && (noteId.value || 'new') === context.recordId) await openNoteDialog(notes.value.find(note => note.id === noteId.value))
}
async function saveNote() {
  const scriptId = activeScriptId.value, recordId = noteId.value || 'new'
  if (!scriptId || !noteForm.text.trim()) return notify('请写下笔记内容')
  const input = { text: noteForm.text.trim(), clueId: noteForm.clueId, personId: noteForm.personId }
  await action(async () => {
    if (recordId !== 'new') await vault.updateNote(recordId, input)
    else await vault.createNote(scriptId, input)
    await removeDraft(scriptId, 'note', recordId)
    noteDraftContext = null
    noteDraftStatus.value = '已保存到正式笔记'
    noteDialog.value = false
    await loadWorkspace()
  }, '笔记已保存')
}
async function removeNote(id: string) {
  if (!window.confirm('删除这条笔记？')) return
  await action(async () => { await vault.deleteNote(id); await loadWorkspace() }, '笔记已删除')
}
function openBoardDialog(kind: BoardItemRecord['kind'] = 'note', item?: BoardItemRecord) {
  editingBoardId.value = item?.id || ''
  boardForm.kind = item?.kind || kind
  boardForm.refId = item?.refId || ''
  boardForm.text = item?.text || ''
  boardForm.color = item?.color || '#f2cc88'
  boardForm.group = item?.group || ''
  boardDialog.value = true
}
async function saveBoardItem() {
  if (!activeScriptId.value) return
  if ((boardForm.kind === 'clue' || boardForm.kind === 'person') && !boardForm.refId) return notify('请选择要放上整理板的内容')
  if (boardForm.kind === 'note' && !boardForm.text.trim()) return notify('请填写便签内容')
  const original = boardItems.value.find(item => item.id === editingBoardId.value)
  await action(async () => {
    await vault.upsertBoardItem(activeScriptId.value, {
      ...(original ? { id: original.id } : {}), kind: boardForm.kind, refId: boardForm.refId,
      text: boardForm.text, color: boardForm.color, group: boardForm.group,
      x: original?.x ?? 140 + (boardItems.value.length % 4) * 80,
      y: original?.y ?? 120 + (boardItems.value.length % 3) * 60,
    })
    await loadWorkspace(); boardDialog.value = false
  }, '卡片已保存')
}
async function removeBoardItem(id: string) {
  await action(async () => { await vault.deleteBoardItem(id); selectedBoardId.value = ''; await loadWorkspace() }, '卡片已移除')
}
async function onBoardDragStop(payload: { node: Node }) {
  const item = boardItems.value.find(value => value.id === payload.node.id)
  if (!item || !activeScriptId.value) return
  await vault.upsertBoardItem(activeScriptId.value, { ...item, x: payload.node.position.x, y: payload.node.position.y })
}
async function onBoardConnect(connection: Connection) {
  if (!activeScriptId.value || !connection.source || !connection.target) return
  await action(async () => {
    await vault.createBoardLink(activeScriptId.value, { fromId: connection.source, toId: connection.target, label: '' })
    await loadWorkspace()
  }, '卡片已连接')
}
async function saveBoardLink() {
  if (!activeScriptId.value || !boardLinkForm.fromId || !boardLinkForm.toId || boardLinkForm.fromId === boardLinkForm.toId) return notify('请选择两张不同卡片')
  await action(async () => {
    await vault.createBoardLink(activeScriptId.value, { ...boardLinkForm })
    await loadWorkspace(); boardLinkDialog.value = false
  }, '连接已添加')
}
async function removeBoardLink(id: string) {
  await action(async () => { await vault.deleteBoardLink(id); await loadWorkspace() }, '连接已删除')
}
async function exportArchive() {
  if (!activeScriptId.value) return
  await action(async () => { await vault.exportScript(activeScriptId.value); archiveRevision.value = crypto.randomUUID() }, '档案已生成，请在系统面板中保存')
}
async function importArchive() {
  await action(async () => {
    const preview = await vault.previewScriptImport()
    if (!preview) return
    if (importPreview.value) vault.discardScriptImportPreview(importPreview.value.token)
    importPreview.value = preview
    importDialogOpen.value = true
  })
}
function closeImportPreview() {
  if (busy.value) return
  if (importPreview.value) vault.discardScriptImportPreview(importPreview.value.token)
  importPreview.value = null
  importDialogOpen.value = false
}
async function confirmArchiveImport() {
  const preview = importPreview.value
  if (!preview) return
  await action(async () => {
    const imported = await vault.importPreparedScript(preview.token)
    importPreview.value = null
    importDialogOpen.value = false
    activeScriptId.value = imported.id
    await loadScripts(); await loadWorkspace()
  }, '档案已导入为独立剧本')
}
function flushEditorDrafts() { void flushDrafts().catch(() => notify('草稿尚未保存成功，请保留当前页面后重试')) }
function refreshAiRoutingOnVisibility() {
  if (document.visibilityState === 'visible') void initializeAiRouting()
  else flushEditorDrafts()
}
function refreshAiRoutingOnNetwork() {
  void initializeAiRouting()
}
watch(activeScriptId, () => { captureRoundReady.value = false; flushEditorDrafts(); ++clueDraftSequence; ++noteDraftSequence; clueDialog.value = false; noteDialog.value = false; clueDraftContext = null; noteDraftContext = null; personWorkspaceId.value = ''; personMergeSourceId.value = ''; recoveryOpen.value = false; reviewUndo.value = null; reviewRedo.value = null; operationHistoryOpen.value = false; correctionPersonId.value = ''; discussionOpen.value = false; documentCorrectionOpen.value = false; recentPhotoQuality.value = null; ++recentPhotoQualitySequence; taskStates.value = []; sourceRevisionReviews.value = []; timeIssueDismissals.value = {}; pendingTimeIssue.value = null; organizationProgress.value = ''; aiStatusOpen.value = false; workspaceSearchOpen.value = false; workspaceGuideOpen.value = false; clueSelectionMode.value = false; selectedClueIds.value = []; clueBatchOpen.value = false; reviewWorkbenchOpen.value = false; sourceLocationCount.value = 0; organizationPaused.value = false; cluePageSize.value = 60; if (activeScriptId.value) { restoreWorkspaceLocation(activeScriptId.value); try { localStorage.setItem('clue-vault:last-script', activeScriptId.value) } catch {} } }, { flush: 'sync' })
watch(captureRound, (value, previous) => {
  if (captureRoundHydrating || !activeScriptId.value) return
  const round = value.trim() || '1', scriptId = activeScriptId.value
  if (filterRound.value === previous) filterRound.value = round
  void vault.saveLocalState(scriptId, 'capture-round', round).catch(() => notify('当前轮次保存失败，请重试'))
}, { flush: 'sync' })
watch(() => JSON.stringify(clueForm), value => {
  const context = clueDraftContext
  if (clueDraftHydrating || !clueDialog.value || !context || context.scriptId !== activeScriptId.value || context.recordId !== detailId.value) return
  const sequence = clueDraftSequence, write = ++clueDraftWrite
  clueDraftStatus.value = '正在保存草稿…'
  void saveDraft(context.scriptId, 'clue', context.recordId, JSON.parse(value), clueDraftBaseline).then(() => {
    if (sequence === clueDraftSequence && write === clueDraftWrite) clueDraftStatus.value = value === clueDraftBaseline ? '没有未保存修改' : '草稿已保存，尚未写入正式线索'
  }).catch(() => { if (sequence === clueDraftSequence) clueDraftStatus.value = '草稿保存失败，请点击保存修改' })
}, { flush: 'sync' })
watch(() => JSON.stringify(noteForm), value => {
  const context = noteDraftContext
  if (noteDraftHydrating || !noteDialog.value || !context || context.scriptId !== activeScriptId.value || context.recordId !== (noteId.value || 'new')) return
  const sequence = noteDraftSequence, write = ++noteDraftWrite
  noteDraftStatus.value = '正在保存草稿…'
  void saveDraft(context.scriptId, 'note', context.recordId, JSON.parse(value), noteDraftBaseline).then(() => {
    if (sequence === noteDraftSequence && write === noteDraftWrite) noteDraftStatus.value = value === noteDraftBaseline ? '没有未保存修改' : '草稿已保存，尚未写入正式笔记'
  }).catch(() => { if (sequence === noteDraftSequence) noteDraftStatus.value = '草稿保存失败，请点击保存笔记' })
}, { flush: 'sync' })
watch(clueDialog, open => { if (!open) { ++clueDraftSequence; flushEditorDrafts() } }, { flush: 'sync' })
watch(noteDialog, open => { if (!open) { ++noteDraftSequence; flushEditorDrafts() } }, { flush: 'sync' })
watch(view, next => { mode.value = next === 'clues' ? 'capture' : 'organize'; if (next !== 'timeline') timelineImmersive.value = false })
watch(activeScriptId, async () => { timelineImmersive.value = false; await loadWorkspace() })
watch(() => [query.value, filterRound.value, filterCategory.value, filterTag.value, filterPerson.value, favoriteOnly.value, clueSort.value, activeScriptId.value], () => { cluePageSize.value = 60 })
watch(() => [view.value, query.value, filterRound.value, filterCategory.value, filterTag.value, clueSort.value, filterPerson.value, favoriteOnly.value, layout.value, timelinePersonFilter.value, relationGraph.value], saveWorkspaceLocation, { flush: 'sync' })
watch([query, activeScriptId], async ([value, scriptId]) => {
  const sequence = ++searchSequence
  if (!value.trim() || !scriptId) { searchIds.value = null; return }
  searchIds.value = []
  try {
    const results = await vault.searchClues(scriptId, value.trim())
    if (sequence === searchSequence && scriptId === activeScriptId.value) searchIds.value = results.filter(item => item.scriptId === scriptId).map(item => item.id)
  } catch { if (sequence === searchSequence && scriptId === activeScriptId.value) searchIds.value = [] }
})
watch(() => aiRoute.provider, provider => {
  apiKeyConfigured.value = provider ? apiKeysConfigured[provider] : false
  if (provider) void refreshApiKeyConfiguration(provider)
}, { immediate: true })
onMounted(async () => {
  document.addEventListener('keydown', handleWorkspaceShortcut)
  document.addEventListener('visibilitychange', refreshAiRoutingOnVisibility)
  window.addEventListener('pagehide', flushEditorDrafts)
  window.addEventListener('online', refreshAiRoutingOnNetwork)
  window.addEventListener('offline', refreshAiRoutingOnNetwork)
  void initializeAiRouting()
  void refreshApiKeyConfiguration('deepseek')
  void refreshApiKeyConfiguration('openai')
  await action(async () => { await vault.initVault(); await loadScripts(); await loadWorkspace() })
  void recoverLegacyBrowserOcr()
})
onUnmounted(() => { if (importPreview.value) vault.discardScriptImportPreview(importPreview.value.token); if (organizationElapsedTimer) clearInterval(organizationElapsedTimer); organizationPauseRequested.value = true; document.removeEventListener('keydown', handleWorkspaceShortcut); flushEditorDrafts(); window.removeEventListener('pagehide', flushEditorDrafts); document.removeEventListener('visibilitychange', refreshAiRoutingOnVisibility); window.removeEventListener('online', refreshAiRoutingOnNetwork); window.removeEventListener('offline', refreshAiRoutingOnNetwork); if (toastTimer) clearTimeout(toastTimer) })
</script>

<template>
  <IonApp>
    <div class="app-shell" :inert="discussionOpen || undefined">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark"><UiIcon name="archive" :size="22" /></div><div><strong>迹册</strong><small>线索整理工具</small></div></div>
        <div class="script-switcher" v-if="activeScript">
          <div class="switcher-label">当前剧本</div>
          <button class="script-switcher-button" @click="view = 'settings'"><span class="script-cover-mini" :style="activeScript.coverPath && imageUrls[activeScript.coverPath] ? { backgroundImage: `url(${imageUrls[activeScript.coverPath]})` } : {}"><UiIcon v-if="!activeScript.coverPath" name="file" :size="18" /></span><span class="switcher-name">{{ activeScript.name }}<small>{{ dateLabel(activeScript.playDate) }}</small></span><UiIcon name="chevron" :size="16" /></button>
        </div>
        <div class="sidebar-section-title">工作空间</div>
        <nav class="primary-nav" aria-label="主导航"><button v-for="item in nav" :key="item.id" :class="['nav-item', { active: view === item.id }]" @click="switchView(item.id)"><UiIcon :name="item.icon" :size="19" /><span>{{ item.label }}</span></button></nav><template v-if="activeScript"><div class="sidebar-section-title tools-section-title">整理工具</div><nav class="tools-nav" aria-label="整理工具导航"><button v-for="item in toolNav" :key="item.id" :class="['nav-item', { active: activeToolId === item.id }]" @click="openTool(item)"><UiIcon :name="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'compare' && compareIds.length" class="nav-count">{{ compareIds.length }}</span></button></nav></template>
        <div class="sidebar-bottom"><div class="offline-chip"><span class="offline-dot"></span>本机保存 · AI 可选</div><button class="sidebar-small-button" @click="openScriptDialog()"><UiIcon name="plus" :size="16" />新建剧本</button></div>
      </aside>
      <main class="main-panel">
        <header class="topbar"><div class="topbar-title"><button v-if="activeNavId === 'organize' && view !== 'organize'" class="icon-button breadcrumb-back" title="返回整理总览" @click="switchView('organize')"><UiIcon name="arrowLeft" :size="18" /></button><span class="topbar-parent">{{ activeScript?.name || '我的剧本' }}</span><UiIcon name="chevron" :size="14" /><strong>{{ viewLabel }}</strong></div><div class="topbar-actions"><button v-if="activeScript" class="icon-button workspace-search-trigger" title="搜索当前剧本（⌘ / Ctrl + K）" aria-label="搜索当前剧本的线索、人物、事件和笔记" @click="openWorkspaceSearch"><UiIcon name="search" :size="20" /></button><button v-if="activeScript" class="icon-button workspace-guide-trigger" title="使用指南" aria-label="打开使用指南" @click="workspaceGuideOpen = true; aiStatusOpen = false"><UiIcon name="info" :size="19" /></button><div class="ai-service-menu"><button class="ai-route-indicator" :class="aiStatusTone" :title="aiStatusTitle" :aria-expanded="aiStatusOpen" @click="openAiStatus"><span class="ai-route-dot" aria-hidden="true"></span><span aria-live="polite">{{ aiStatusLabel }}</span></button><section v-if="aiStatusOpen" class="ai-service-popover" aria-label="AI 服务状态"><header><strong>AI 服务状态</strong><button aria-label="关闭服务状态" @click="aiStatusOpen = false"><UiIcon name="close" :size="17" /></button></header><dl><dt>当前选择</dt><dd>{{ selectedProviderLabel }} · {{ aiRoute.countryCode || '地区待检测' }}</dd><dt>整理状态</dt><dd>{{ organizer.organizationRun.message || aiRoute.message }}</dd><template v-if="aiModelStatus.model"><dt>实际模型</dt><dd>{{ aiModelStatus.model }}</dd></template><template v-if="aiModelStatus.reason"><dt>选择原因</dt><dd>{{ aiModelStatus.reason }}</dd></template></dl><p v-if="organizer.organizationRun.lastError" class="service-error">{{ organizer.organizationRun.lastError }}</p><p v-if="organization?.analysis?.provider === 'local'">{{ organization.analysis.localReason === 'quota' ? 'API 额度不足，本次使用本地整理。' : '网络不可用，本次使用本地整理。' }}</p><div><button :disabled="busy || aiRoute.phase === 'checking'" @click="retryAiService">重新检测</button><button :disabled="busy || !clues.length" @click="aiStatusOpen = false; runOrganization()">继续整理</button><button @click="aiStatusOpen = false; switchView('settings')">管理密钥</button></div></section></div><div class="topbar-edit-tools" role="group" aria-label="撤销与历史操作"><button v-if="reviewUndo && reviewUndo.scriptId === activeScriptId" class="secondary-button topbar-undo" :disabled="busy" :title="`撤销${reviewUndo.label}`" aria-label="撤销上一步" @click="undoLastChange"><UiIcon name="rotate" :size="17" />撤销</button><button v-if="organizationActive" class="organization-pause-button" :disabled="organizationPauseRequested" @click="requestOrganizationPause">{{ organizationPauseRequested ? '正在暂停' : '暂停整理' }}</button><button v-if="reviewRedo && reviewRedo.scriptId === activeScriptId" class="secondary-button topbar-undo" :disabled="busy" :title="`重做${reviewRedo.label}`" aria-label="重做上一步" @click="redoLastChange"><UiIcon name="rotate" :size="17" class="redo-icon" />重做</button><button v-if="activeScript" class="icon-button topbar-history" title="操作历史" aria-label="打开操作历史，逐步撤销或重做" @click="operationHistoryOpen = true"><UiIcon name="clock" :size="19" /></button></div><span v-if="busy" class="working-state" role="status"><span></span>处理中</span><button v-if="activeScript && view !== 'clues'" class="secondary-button topbar-capture" :disabled="busy" @click="capture"><UiIcon name="camera" :size="17" />拍照</button><button class="icon-button topbar-export" title="导出剧本档案" :disabled="!activeScript" @click="exportArchive"><UiIcon name="download" :size="19" /></button></div></header>
        <div v-if="!activeScript" class="empty-home"><div class="empty-art"><div class="art-paper art-paper-one"></div><div class="art-paper art-paper-two"></div><div class="art-paper art-paper-three"><UiIcon name="search" :size="38" /></div></div><h1>从一个剧本开始</h1><p>拍下线索，OCR 文字在本机识别。需要时可选择 AI 整理。</p><div class="empty-home-actions"><button class="primary-button" @click="openScriptDialog()"><UiIcon name="plus" :size="18" />新建剧本</button><button class="secondary-button" @click="importArchive"><UiIcon name="upload" :size="18" />导入档案</button></div></div>
        <template v-else>
          <section v-if="view === 'clues'" class="page page-clues" aria-label="线索库">
            <div class="page-header capture-header">
              <h1>线索库</h1>
              <div class="header-actions capture-actions">
                <label class="capture-round-control"><select v-model="captureRound" :disabled="busy || !captureRoundReady" aria-label="当前搜证轮次"><option v-for="round in captureRoundOptions" :key="round" :value="round">第 {{ round }} 轮</option></select></label>
                <button class="secondary-button capture-import" :disabled="busy || !captureRoundReady" aria-label="选择照片录入线索" @click="importPhotos"><UiIcon name="image" :size="20" /><span>选照片</span></button>
                <button class="primary-button capture-primary" :disabled="busy || !captureRoundReady" @click="capture"><UiIcon name="camera" :size="20" />拍照录入</button>
              </div>
            </div>
            <aside v-if="recentPhotoQuality" class="recent-quality-hint"><UiIcon name="image" :size="20" /><div><strong>照片质量提示 · {{ recentPhotoQuality.title }}</strong><span>{{ recentPhotoQuality.report.issues.map(issue => issue.label).join(' · ') }} · 本地估计</span></div><button @click="openTimelineClue(recentPhotoQuality.clueId)">查看照片</button><button class="icon-button" aria-label="收起照片质量提示" @click="recentPhotoQuality = null"><UiIcon name="close" :size="20" /></button></aside>
            <details v-if="recentClues.length" class="recent-capture" :open="recentCaptureOpen" @toggle="recentCaptureOpen = ($event.target as HTMLDetailsElement).open">
              <summary><UiIcon name="clock" :size="18" /><strong>最近录入</strong><span>{{ recentClues.length }} 张</span><UiIcon class="disclosure-chevron" name="chevron" :size="16" /></summary>
              <div class="recent-capture-list"><article v-for="clue in recentClues" :key="clue.id"><button class="recent-clue-source" @click="openClue(clue)"><ClueThumbnail class="recent-clue-thumbnail" :path="clue.displayImagePath || clue.imagePath" :alt="clue.title" :rotation="clue.rotation" /><span><strong>#{{ String(clue.number).padStart(3, '0') }} {{ clue.title }}</strong><small>{{ clue.ocrStatus === 'failed' ? '识别失败' : clue.ocrStatus === 'pending' ? '等待识别' : clue.ocrText.trim() ? 'OCR 已保存' : '暂无识别文字' }}</small></span></button><select :value="clue.round" :disabled="busy" aria-label="调整线索轮次" @change="changeRecentRound(clue.id, ($event.target as HTMLSelectElement).value)"><option v-for="round in captureRoundOptions" :key="round" :value="round">第 {{ round }} 轮</option></select><button v-if="!clue.ocrText.trim()" class="text-button" :disabled="busy" @click="retryOcr(clue)">重试识别</button><button class="icon-button" aria-label="删除最近录入线索" :disabled="busy" @click="removeClue(clue)"><UiIcon name="trash" :size="20" /></button></article></div>
            </details>
            <div class="library-control-panel">
              <div class="clue-toolbar">
                <label class="search-field"><UiIcon name="search" :size="20" /><input v-model="query" placeholder="搜索线索文字" aria-label="搜索线索" /><button v-if="query" class="text-clear" aria-label="清除搜索文字" @click="query = ''"><UiIcon name="close" :size="18" /></button></label>
                <details class="filter-disclosure" @keydown.esc.stop.prevent="($event.currentTarget as HTMLDetailsElement).open = false"><summary><UiIcon name="filter" :size="18" />筛选<span v-if="hasClueFilters" class="filter-active-dot" aria-label="已启用筛选"></span><UiIcon class="disclosure-chevron" name="chevron" :size="16" /></summary><div class="toolbar-selects">
                  <label><select v-model="filterRound" aria-label="筛选轮次"><option value="">全部轮次</option><option v-for="round in rounds" :key="round" :value="round">第 {{ round }} 轮</option></select></label>
                  <label><select v-model="filterCategory" aria-label="筛选分类"><option value="">全部分类</option><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
                  <label><select v-model="filterTag" aria-label="筛选标签"><option value="">全部标签</option><option v-for="tag in clueTags" :key="tag" :value="tag">{{ tag }}</option></select></label>
                  <label><select v-model="filterPerson" aria-label="筛选人物"><option value="">全部人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label>
                  <div class="filter-panel-footer"><button :class="['filter-favorite', { active: favoriteOnly }]" :aria-pressed="favoriteOnly" @click="favoriteOnly = !favoriteOnly"><UiIcon :name="favoriteOnly ? 'check' : 'heart'" :size="18" />仅看收藏</button><button class="filter-panel-done" @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">完成</button></div>
                </div></details>
              </div>
              <div class="result-bar">
                <div class="library-result-summary"><div class="round-quick-filter" role="group" aria-label="快速筛选轮次"><button :class="{ active: filterRound === captureRound }" :aria-pressed="filterRound === captureRound" @click="filterRound = captureRound">本轮</button><button :class="{ active: !filterRound }" :aria-pressed="!filterRound" @click="filterRound = ''">全部轮次</button></div><span class="library-result-count" role="status" aria-live="polite" aria-atomic="true">{{ visibleClues.length }} 条线索<span v-if="visibleClues.length > displayedClues.length"> · 已显示 {{ displayedClues.length }} 条</span><span v-if="query"> · 搜索「{{ query }}」</span></span></div>
                <div class="clue-result-actions"><label class="clue-sort-control"><select v-model="clueSort" aria-label="线索排序"><option value="newest">最新录入</option><option value="oldest">最早录入</option><option value="number">编号顺序</option><option value="title">标题顺序</option></select></label><button v-if="!clueSelectionMode" class="clue-select-trigger" :disabled="busy || !clues.length" @click="clueSelectionMode = true">多选</button><button v-else class="clue-select-trigger" :disabled="busy" @click="finishClueSelection">完成</button><div class="view-toggle" role="group" aria-label="线索展示方式"><button :class="{ active: layout === 'grid' }" aria-label="网格视图" title="网格视图" :aria-pressed="layout === 'grid'" @click="layout = 'grid'"><UiIcon name="grid" :size="20" /></button><button :class="{ active: layout === 'list' }" aria-label="列表视图" title="列表视图" :aria-pressed="layout === 'list'" @click="layout = 'list'"><UiIcon name="list" :size="20" /></button></div></div>
              </div>
              <div v-if="hasClueFilters" class="active-clue-filters" aria-label="当前筛选条件"><button v-for="filter in activeClueFilters" :key="filter.kind" :aria-label="`移除${filter.label}筛选`" @click="clearClueFilter(filter.kind)">{{ filter.label }}<UiIcon name="close" :size="14" /></button><button class="clear-all-filters" @click="clearClueFilter()">清除全部</button></div>
              <div v-if="clueSelectionMode" class="clue-selection-bar" role="region" aria-label="批量编辑已选线索"><div><strong>已选 {{ selectedBatchClues.length }} 条</strong><span v-if="hiddenSelectedClueCount">其中 {{ hiddenSelectedClueCount }} 条不在当前筛选内</span></div><div><button :disabled="busy || !visibleClues.length" :aria-pressed="allVisibleCluesSelected" @click="toggleVisibleClueSelection">{{ allVisibleCluesSelected ? '取消当前结果' : '选择当前结果' }}</button><button :disabled="busy || !selectedBatchClues.length" @click="selectedClueIds = []">清空选择</button><button class="clue-batch-primary" :disabled="busy || !selectedBatchClues.length" @click="clueBatchOpen = true"><UiIcon name="edit" :size="18" />批量编辑</button></div></div>
            </div>
            <div class="library-content" tabindex="0" aria-label="线索浏览区">
              <div v-if="!visibleClues.length" class="section-empty"><div class="section-empty-icon"><UiIcon :name="clues.length ? 'search' : 'camera'" :size="28" /></div><h2>{{ clues.length ? '没有符合条件的线索' : '还没有线索' }}</h2><p>{{ clues.length ? '试着调整搜索词或筛选条件。' : '拍摄或导入第一张线索照片。' }}</p><button v-if="clues.length && hasClueFilters" class="secondary-button" @click="clearClueFilter()">清除筛选</button><button v-if="!clues.length" class="primary-button" @click="capture"><UiIcon name="camera" :size="20" />拍摄线索</button></div>
              <div v-else :class="['clue-collection', layout]">
                <article v-for="clue in displayedClues" :key="clue.id" :data-clue-id="clue.id" class="clue-card" :class="{ 'clue-card-selected': clueSelectionMode && selectedClueIds.includes(clue.id) }" @click="clueSelectionMode ? toggleClueSelection(clue.id) : openClue(clue)">
                  <button v-if="clueSelectionMode" class="clue-selection-check" role="checkbox" :aria-checked="selectedClueIds.includes(clue.id)" :aria-label="`选择线索 #${clue.number} ${clue.title}`" :disabled="busy" @click.stop="toggleClueSelection(clue.id)"><UiIcon v-if="selectedClueIds.includes(clue.id)" name="check" :size="20" /></button>
                  <div class="clue-image"><ClueThumbnail :path="clue.displayImagePath || clue.imagePath" :alt="clue.title" :rotation="clue.rotation" fit="contain" /><span class="clue-number">#{{ String(clue.number).padStart(3, '0') }}</span><button :class="['favorite-button', { active: clue.favorite }]" :aria-label="`${clue.favorite ? '取消收藏' : '收藏'}线索 #${clue.number}`" :aria-pressed="clue.favorite" @click.stop="toggleFavorite(clue)"><UiIcon name="heart" :size="20" /></button></div>
                  <div class="clue-card-body">
                    <div class="clue-card-meta"><span v-if="clue.round" class="clue-round">第 {{ clue.round }} 轮</span><span v-if="clue.category" class="clue-category">{{ clue.category }}</span></div>
                    <h2><button class="clue-title-button" :aria-label="`${clueSelectionMode ? '选择' : '查看'}线索 #${clue.number} ${clue.title}`" @click.stop="clueSelectionMode ? toggleClueSelection(clue.id) : openClue(clue)"><span v-html="highlight(clue.title)"></span></button></h2>
                    <p v-if="clue.ocrText" v-html="highlight(shortText(clue.ocrText, layout === 'list' ? 165 : 74))"></p><p v-else class="clue-ocr-state" :class="{ 'is-error': clue.ocrStatus === 'failed' }">{{ clue.ocrStatus === 'failed' ? '文字识别失败' : clue.ocrStatus === 'pending' ? '正在识别文字…' : '暂无识别文字' }}</p>
                    <div class="clue-card-bottom">
                    <div v-if="clue.tags.length" class="clue-tags" aria-label="线索标签"><button v-for="tag in clue.tags.slice(0, 3)" :key="tag" class="clue-tag-chip" :aria-label="`筛选标签${tag}`" :aria-pressed="filterTag === tag" @click.stop="filterTag = tag"><span>{{ tag }}</span></button><details v-if="clue.tags.length > 3" class="clue-tag-more" @click.stop><summary :aria-label="`其余 ${clue.tags.length - 3} 个标签`"><span class="tags-collapsed">+{{ clue.tags.length - 3 }}</span><span class="tags-expanded">收起标签</span></summary><div><button v-for="tag in clue.tags.slice(3)" :key="tag" class="clue-tag-chip" :aria-label="`筛选标签${tag}`" :aria-pressed="filterTag === tag" @click.stop="filterTag = tag"><span>{{ tag }}</span></button></div></details></div>
                    <div class="clue-card-foot"><span>{{ dateLabel(clue.createdAt) }}</span><button :class="['compare-pick', { active: compareIds.includes(clue.id) }]" :aria-pressed="compareIds.includes(clue.id)" @click.stop="toggleCompare(clue.id)"><UiIcon name="compare" :size="18" />{{ compareIds.includes(clue.id) ? '已对照' : '加入对照' }}</button></div>
                    </div>
                  </div>
                </article>
              </div>
              <button v-if="displayedClues.length < visibleClues.length" class="clue-load-more" @click="cluePageSize += 60">加载更多线索（还有 {{ visibleClues.length - displayedClues.length }} 条）</button>
            </div>
          </section>
          <template v-else-if="view === 'organize'">
            <div v-if="organizationActive || organizationPaused" class="organization-run-controls" role="status"><span>{{ organizationProgress }}</span><small>本次耗时 {{ elapsedLabel }}</small><button v-if="organizationActive" :disabled="organizationPauseRequested" @click="requestOrganizationPause">{{ organizationPauseRequested ? '等待当前请求保存…' : '暂停整理' }}</button><button v-else :disabled="busy" @click="runOrganization">继续整理</button></div>
          <SourceRevisionNotice v-if="sourceRevisionReviews.length" data-source-reviews :reviews="sourceRevisionReviews" :busy="busy" @open-clue="openTimelineClue" @focus-event="focusSourceReviewEvent" @reviewed="acknowledgeOneSource" @reviewed-all="acknowledgeSourceReviews" />
          <OrganizationOverview :clues="clues" :people="people" :relationships="relationships" :events="events" :organization="organization" :busy="busy" :auto-organize="autoOrganize" :api-configured="apiKeyConfigured" :api-provider="selectedProviderLabel" :can-undo="Boolean(reviewUndo && reviewUndo.scriptId === activeScriptId)" :progress="organizationProgress" :pending-ocr-count="pendingOcrClues.length" :unfinished-task-count="unfinishedTasks.length" :organization-active="organizationActive" @capture="capture" @retry-ocr="showPendingOcr" @resume="runOrganization" @discuss="openDiscussion" @open-workbench="reviewWorkbenchOpen = true" @bulk-accept="applyReviewSelection($event, 'accept')" @bulk-ignore="applyReviewSelection($event, 'ignore')" @undo="undoLastChange" @analyze="runOrganization" @retry-source="retryTimeExtraction" @navigate="switchView" @open-clue="openSourceClue" @accept-person="acceptPersonSuggestion" @accept-relationship="acceptRelationshipSuggestion" @accept-timeline="acceptTimelineSuggestion" @accept-clue-point="acceptCluePointSuggestion" @clear-suggestions="clearOrganizationSuggestions" />
          <TimelineExtractionIssues :issues="timeExtractionIssues" :busy="busy" :script-id="activeScriptId || ''" @retry="retryTimeExtraction" @add="addTimeIssue" @ignore="ignoreTimeIssues" @open-clue="openSourceClue" />
            <section v-if="unfinishedTasks.length || pendingOcrClues.length" class="task-resume" data-pending-processing aria-label="待继续处理"><header><div><strong>待继续处理</strong><p>已完成阶段已保存。点击继续后才会调用 API。</p></div><button v-if="unfinishedTasks.length" class="secondary-button" :disabled="busy" @click="runOrganization">继续整理</button></header><ul><li v-for="task in unfinishedTasks" :key="task.clueId"><button class="text-button" @click="openTimelineClue(task.clueId)">原线索 #{{ String(task.sourceNo).padStart(3, '0') }}</button><span>{{ task.message || (task.stage === 'checking' ? '时间核对待继续' : task.stage === 'local' ? '本地结果已保存，可继续 API 整理' : '整理待继续') }}</span></li><li v-for="clue in pendingOcrClues" :key="`ocr:${clue.id}`"><button class="text-button" @click="openClue(clue)">原线索 #{{ String(clue.number).padStart(3, '0') }}</button><span>{{ clue.ocrError || (clue.ocrStatus === 'pending' ? 'OCR 识别尚未完成' : '暂无 OCR 文字') }}</span><button v-if="!clue.ocrText.trim()" class="secondary-button" :disabled="busy" @click="retryOcr(clue)">重试识别</button></li></ul></section>
          </template>
          <section v-else-if="view === 'people'" class="page people-page" :class="{ 'relationship-page': relationGraph }"><div v-if="!relationGraph || !people.length" class="page-header"><div><h1>{{ relationGraph ? '人物关系' : '人物档案' }}</h1><p>{{ relationGraph ? '查看你手动建立的人物关系。' : '名字匹配来自已保存线索；人物之间的关系由你亲自建立。' }}</p></div><div class="header-actions"><button v-if="!relationGraph" class="secondary-button" :disabled="people.length < 2" @click="openRelationshipDialog()"><UiIcon name="plus" :size="18" />添加关系</button><button class="primary-button" @click="openPersonDialog()"><UiIcon name="plus" :size="18" />添加人物</button></div></div><div v-if="!relationGraph || !people.length" class="subtabs"><button :class="{ active: !relationGraph }" @click="relationGraph = false">人物列表</button><button :class="{ active: relationGraph }" @click="relationGraph = true">关系图</button></div><div v-if="!people.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="people" :size="31" /></div><h2>建立人物档案</h2><p>添加人物姓名后，可以自动找到提及姓名的线索。</p><button class="primary-button" @click="openPersonDialog()"><UiIcon name="plus" :size="18" />添加人物</button></div><RelationshipExplorer v-else-if="relationGraph" :key="activeScriptId" :people="people" :relationships="relationships" :image-urls="imageUrls" :clue-counts="personClueCounts" :script-id="activeScriptId" :relationship-dialog-open="relationshipDialog" @open-person="openGraphPerson" @view-person="openPersonWorkspace" @view-clues="viewPersonClues" @remove-relationship="removeRelationship" @add-relationship="openRelationshipDialog" @add-person="openPersonDialog()" @show-people-list="relationGraph = false" /><div v-else class="people-grid"><article v-for="person in people" :key="person.id" class="person-card"><div class="person-avatar"><img v-if="person.photoPath && imageUrls[person.photoPath]" :src="imageUrls[person.photoPath]" :alt="person.name" /><span v-else>{{ person.name.slice(0, 1) }}</span></div><div class="person-card-main"><h2><button class="person-name-link" @click="openPersonWorkspace(person.id)">{{ person.name }}</button></h2><p v-if="person.aliases.length">又名 {{ person.aliases.join('、') }}</p><p v-else class="muted">暂无别名</p></div><div class="person-card-meta">{{ personClueCount(person) }} 条相关线索</div><p v-if="person.notes" class="person-card-notes">{{ shortText(person.notes, 82) }}</p><div class="person-card-actions"><button @click="openPersonWorkspace(person.id)">查看详情 <UiIcon name="chevron" :size="15" /></button><button title="编辑人物" @click="openPersonDialog(person)"><UiIcon name="edit" :size="17" /></button><button title="删除人物" @click="removePerson(person)"><UiIcon name="trash" :size="17" /></button></div></article></div></section>
          <section v-else-if="view === 'timeline'" class="page timeline-page">
            <details v-if="organization?.timeline.length || candidateEvents.length" class="timeline-pending"><summary>待确认时间点 <span>{{ (organization?.timeline.length || 0) + candidateEvents.length }}</span><UiIcon name="chevron" :size="16" /></summary><div class="timeline-pending-content">
            <div v-if="organization?.timeline.length" class="candidate-list ai-timeline-list"><div class="section-label">待确认时间点</div><p>AI 和 OCR 原文扫描结果会显示在这里。无年份的时间也可以录入，保存后会标记；标记可单独忽略。</p><article v-for="suggestion in organization.timeline" :key="suggestion.id"><div class="ai-timeline-main"><strong>{{ suggestion.title }}</strong><span>{{ dateLabel(suggestion.startsAt) }}</span><em v-if="suggestion.startsAt.startsWith('--')" class="ai-timeline-yearless">无年份</em><small>“{{ suggestion.quote }}”</small></div><button @click="openSourceClue(suggestion.sourceNo)">原线索 #{{ String(suggestion.sourceNo).padStart(3, '0') }}</button><button class="primary-button" @click="acceptTimelineSuggestion(suggestion.id)">{{ suggestion.requiresTitle || suggestion.title === '待补充事件' ? '补充事件' : '直接录入' }}</button></article></div>
            <div v-if="candidateEvents.length" class="candidate-list"><div class="section-label">待确认的时间</div><p>以下日期来自照片文字识别。请核对原图并填写事件后再加入时间线。</p><article v-for="candidate in candidateEvents" :key="candidate.id"><span>{{ dateLabel(candidate.startsAt) }}</span><button v-if="candidate.clueId" @click="clues.find(clue => clue.id === candidate.clueId) && openClue(clues.find(clue => clue.id === candidate.clueId)!)">查看原图</button><button class="primary-button" @click="openEventDialog(candidate)">确认事件</button></article></div>
            </div></details>
            <div v-if="!confirmedEvents.length && !organization?.timeline.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="timeline" :size="31" /></div><h2>等待第一条确认的事件</h2><p>从线索里找到明确的时间，再由你录入事件。</p><button class="primary-button" @click="openEventDialog()"><UiIcon name="plus" :size="18" />添加时间节点</button></div>
            <template v-else-if="confirmedEvents.length">
              <button v-if="sourceReviewEventIds.length" class="source-review-banner" @click="openSourceReviews"><UiIcon name="file" :size="16" />{{ sourceReviewEventIds.length }} 个事件的来源已修改，前往核对<UiIcon name="chevron" :size="14" /></button>
              <TimelineExplorer ref="timelineExplorer" :key="activeScriptId" :display-mode="timelineDisplayMode" :events="confirmedEvents" :people="people" :clues="clues" :script-id="activeScriptId" :source-review-event-ids="sourceReviewEventIds" v-model:person-id="timelinePersonFilter" @edit-event="openEventDialog" @open-clue="openTimelineClue" @toggle-marker="toggleYearlessMarker" @fullscreen-change="timelineImmersive = $event">
                <template #page-actions>
                  <div class="timeline-page-actions">
                    <div class="timeline-display-toggle" role="group" aria-label="时间线展示方式">
                      <button type="button" :class="{ active: timelineDisplayMode === 'axis' }" aria-label="时间轴" title="时间轴" :aria-pressed="timelineDisplayMode === 'axis'" @click="setTimelineDisplayMode('axis')"><UiIcon name="timeline" :size="17" /></button>
                      <button type="button" :class="{ active: timelineDisplayMode === 'list' }" aria-label="事件列" title="事件列" :aria-pressed="timelineDisplayMode === 'list'" @click="setTimelineDisplayMode('list')"><UiIcon name="list" :size="17" /></button>
                    </div>
                    <button type="button" class="primary-button timeline-add-event" aria-label="添加事件" title="添加事件" @click="openEventDialog()"><UiIcon name="plus" :size="18" /></button>
                  </div>
                </template>
              </TimelineExplorer>
            </template>
          </section>
          <section v-else-if="view === 'board'" class="page board-page"><div class="page-header"><div><h1>自由整理板</h1><p>拖动卡片，手动连接思路。布局自动保存在本机。</p></div><div class="header-actions"><button class="secondary-button" @click="boardLinkForm.fromId = ''; boardLinkForm.toId = ''; boardLinkForm.label = ''; boardLinkDialog = true"><UiIcon name="plus" :size="18" />连接卡片</button><button class="primary-button" @click="openBoardDialog('note')"><UiIcon name="plus" :size="18" />添加卡片</button></div></div><div class="board-toolbar"><button @click="openBoardDialog('clue')"><UiIcon name="archive" :size="17" />线索</button><button @click="openBoardDialog('person')"><UiIcon name="person" :size="17" />人物</button><button @click="openBoardDialog('note')"><UiIcon name="note" :size="17" />便签</button><div class="board-toolbar-spacer"></div><button @click="boardZoom = Math.max(.5, boardZoom - .15)"><UiIcon name="zoomOut" :size="17" /></button><span>{{ Math.round(boardZoom * 100) }}%</span><button @click="boardZoom = Math.min(2, boardZoom + .15)"><UiIcon name="zoomIn" :size="17" /></button></div><div class="board-canvas"><div v-if="!boardItems.length" class="board-empty"><div class="board-empty-symbol"><UiIcon name="board" :size="37" /></div><strong>你的线索空间</strong><span>添加人物、线索或便签，开始整理。</span><button class="primary-button" @click="openBoardDialog('note')"><UiIcon name="plus" :size="17" />添加第一张卡片</button></div><VueFlow v-else :nodes="boardNodes" :edges="boardEdges" :default-zoom="boardZoom" :min-zoom=".5" :max-zoom="2" :fit-view-on-init="false" @node-click="selectedBoardId = $event.node.id" @node-drag-stop="onBoardDragStop" @connect="onBoardConnect"><Background :gap="24" :size="1" pattern-color="#e2ddd5" /><Controls /></VueFlow><div v-if="selectedBoardItem" class="board-inspector"><div><strong>卡片详情</strong><button title="关闭" @click="selectedBoardId = ''"><UiIcon name="close" :size="16" /></button></div><p>{{ selectedBoardItem.text || (selectedBoardItem.kind === 'clue' ? clues.find(clue => clue.id === selectedBoardItem.refId)?.title : people.find(person => person.id === selectedBoardItem.refId)?.name) }}</p><span v-if="selectedBoardItem.group">分组：{{ selectedBoardItem.group }}</span><div><button @click="openBoardDialog(selectedBoardItem.kind, selectedBoardItem)"><UiIcon name="edit" :size="16" />编辑</button><button @click="removeBoardItem(selectedBoardItem.id)"><UiIcon name="trash" :size="16" />移除</button></div></div></div><div v-if="boardLinks.length" class="board-links-list"><span>已建立的连接</span><div v-for="link in boardLinks" :key="link.id"><span>{{ link.label || '未命名连接' }}</span><button title="删除连接" @click="removeBoardLink(link.id)"><UiIcon name="close" :size="15" /></button></div></div></section>
          <section v-else-if="view === 'notes'" class="page"><div class="page-header"><div><h1>笔记</h1><p>记录你自己的观察与讨论，不生成答案或推理。</p></div><button class="primary-button" @click="openNoteDialog()"><UiIcon name="plus" :size="18" />新建笔记</button></div><div v-if="!notes.length" class="section-empty"><div class="section-empty-icon"><UiIcon name="note" :size="31" /></div><h2>先记下一个想法</h2><p>文字笔记可以关联具体线索或人物。</p><button class="primary-button" @click="openNoteDialog()"><UiIcon name="plus" :size="18" />新建笔记</button></div><div v-else class="notes-grid"><article v-for="note in [...notes].sort((a,b) => b.createdAt.localeCompare(a.createdAt))" :key="note.id" class="note-card"><div class="note-card-top"><UiIcon name="note" :size="19" /><span>{{ dateLabel(note.createdAt) }}</span></div><p>{{ note.text }}</p><div class="note-card-bottom"><span v-if="note.clueId">{{ clues.find(clue => clue.id === note.clueId)?.title || '线索' }}</span><span v-else-if="note.personId">{{ people.find(person => person.id === note.personId)?.name || '人物' }}</span><span v-else>独立笔记</span><button title="编辑" @click="openNoteDialog(note)"><UiIcon name="edit" :size="17" /></button><button title="删除" @click="removeNote(note.id)"><UiIcon name="trash" :size="17" /></button></div></article></div></section>
          <section v-else-if="view === 'compare'" class="page"><div class="page-header"><div><h1>记录对照</h1><p>并排核对人物、时间、描述和原始出处，差异由你确认。</p></div><button v-if="compareIds.length || comparisonEventIds.length" class="secondary-button" @click="compareIds = []; comparisonEventIds = []">清空对照</button></div><RecordComparison :script-id="activeScriptId" :clues="clues" :events="events" :people="people" :image-urls="imageUrls" :initial-clue-ids="compareIds" :initial-event-ids="comparisonEventIds" :busy="busy" @open-clue="openTimelineClue" @merge-events="mergeComparisonEvents" /></section>
          <section v-else-if="view === 'settings'" class="page"><div class="page-header"><div><h1>档案管理</h1><p>每个剧本独立存储；可以按剧本导出与恢复。</p></div><button class="primary-button" @click="openScriptDialog()"><UiIcon name="plus" :size="18" />新建剧本</button></div><div class="settings-layout"><div class="spatial-gallery-column"><div class="script-library-heading"><span class="section-label">我的剧本</span><span>{{ scripts.length }} 本</span></div><div class="script-library" aria-label="我的剧本"><button v-for="script in scripts" :key="script.id" class="script-library-item" :class="{ 'is-current': script.id === activeScriptId }" :aria-pressed="script.id === activeScriptId" @click="selectScript(script.id)"><span class="library-cover"><img v-if="script.coverPath && imageUrls[script.coverPath]" :src="imageUrls[script.coverPath]" :alt="script.name" /><UiIcon v-else name="file" :size="28" /></span><span class="library-copy"><strong>{{ script.name }}</strong><small>{{ dateLabel(script.playDate) }}</small></span><span v-if="script.id === activeScriptId" class="library-current">当前剧本</span><UiIcon v-else name="chevron" :size="18" /></button></div></div><div class="settings-side"><ArchiveStatus :key="activeScriptId" :script-id="activeScriptId" :revision-key="archiveRevision" :busy="busy" @export="exportArchive" /><div class="section-label">当前剧本</div><div class="settings-card"><h2>{{ activeScript.name }}</h2><p>照片、OCR 文字、人物和整理内容都保存在本机。导出的档案可在另一台设备上导入。</p><button class="settings-action" @click="openScriptDialog(activeScript)"><UiIcon name="edit" :size="18" />编辑剧本<UiIcon name="chevron" :size="16" /></button><button class="settings-action" @click="exportArchive"><UiIcon name="download" :size="18" />导出完整档案<UiIcon name="chevron" :size="16" /></button><button class="settings-action" @click="importArchive"><UiIcon name="upload" :size="18" />导入历史档案<UiIcon name="chevron" :size="16" /></button><button class="settings-action" @click="recoveryOpen = true"><UiIcon name="archive" :size="18" />回收站与恢复<UiIcon name="chevron" :size="16" /></button><button class="settings-action danger" @click="removeScript(activeScript)"><UiIcon name="trash" :size="18" />删除剧本<UiIcon name="chevron" :size="16" /></button></div><div class="settings-card ai-settings-card"><h2>AI 线索整理</h2><p>启动时按出口 IP 自动选择：中国 IP 使用 DeepSeek，其他地区使用 GPT。只发送当前剧本的 OCR 文字和线索编号，照片留在本机；密钥按设备分别保存在本机：iPad 使用 Keychain，网页版保存在当前浏览器本地，不进入导出档案；请勿在公用设备配置网页密钥。</p><div class="ai-selected-provider"><span class="ai-route-dot" :class="aiStatusTone"></span>{{ aiRoute.provider ? `当前选择：${selectedProviderLabel}` : aiStatusLabel }}<button class="text-button" :disabled="aiRoute.phase === 'checking'" @click="initializeAiRouting">重新检测</button></div><div class="ai-provider-settings"><div class="ai-provider-heading"><strong>DeepSeek</strong><small>{{ apiKeysConfigured.deepseek ? '已保存密钥' : '未配置' }}</small></div><label class="ai-key-label">DeepSeek API Key<input v-model="apiKeyDrafts.deepseek" type="password" autocomplete="off" placeholder="粘贴 DeepSeek API Key" /></label><div class="ai-key-actions"><button class="primary-button" :disabled="busy || !apiKeyDrafts.deepseek.trim()" @click="saveProviderKey('deepseek')">{{ Capacitor.isNativePlatform() ? '保存到 iPad' : '保存到此浏览器' }}</button><button v-if="apiKeysConfigured.deepseek" class="text-button" :disabled="busy" @click="removeProviderKey('deepseek')">移除密钥</button></div></div><div class="ai-provider-settings"><div class="ai-provider-heading"><strong>GPT · OpenAI</strong><small>{{ apiKeysConfigured.openai ? '已保存密钥' : '未配置' }}</small></div><p>经济优先自动选择：日常提取和时间核对使用 GPT-6 Luna；格式失败或多处时刻未覆盖时才升级 GPT-6.1 Sol。只发送 OCR 文字。</p><label class="ai-key-label">OpenAI API Key<input v-model="apiKeyDrafts.openai" type="password" autocomplete="off" placeholder="粘贴 OpenAI API Key" /></label><div class="ai-key-actions"><button class="primary-button" :disabled="busy || !apiKeyDrafts.openai.trim()" @click="saveProviderKey('openai')">{{ Capacitor.isNativePlatform() ? '保存到 iPad' : '保存到此浏览器' }}</button><button v-if="apiKeysConfigured.openai" class="text-button" :disabled="busy" @click="removeProviderKey('openai')">移除密钥</button></div></div><label class="auto-organize-toggle"><input v-model="autoOrganize" type="checkbox" :disabled="!apiKeyConfigured" @change="saveAutoOrganize" /><span><strong>自动整理新增线索</strong><small>拍照或导入后会发送 OCR 文字到当前选择的 {{ selectedProviderLabel }}；可能产生 API 用量。</small></span></label></div><div class="privacy-note"><UiIcon name="info" :size="18" /><span>本机 OCR 和照片管理可离线使用。选择 AI 整理时会联网发送文字；模型只生成待确认建议，不判断证词、不推断因果或答案。</span></div></div></div></section>
        </template>
      </main>
      <nav class="mobile-nav" aria-label="底部导航"><button v-for="item in nav" :key="item.id" :class="{ active: activeNavId === item.id }" @click="switchView(item.id)"><UiIcon :name="item.icon" :size="21" /><span>{{ item.label }}</span></button></nav>
      <PersonWorkspace v-if="personWorkspaceId" :person-id="personWorkspaceId" :script-id="activeScriptId" :people="people" :relationships="relationships" :events="events" :clues="clues" :image-urls="imageUrls" @close="personWorkspaceId = ''" @open-clue="openTimelineClue" @focus-event="focusWorkspaceEvent" @open-person="openPersonWorkspace" @edit-person="openGraphPerson" @merge-person="openPersonMerge" @compare-event="compareWorkspaceEvent" @correct-name="openNameCorrections" />
      <PersonMergeDialog v-if="personMergeSourceId" :script-id="activeScriptId" :source-id="personMergeSourceId" :people="people" :busy="busy" @close="personMergeSourceId = ''" @confirm="confirmPersonMerge" />
      <RecoveryPanel v-if="recoveryOpen" :script-id="activeScriptId" @close="recoveryOpen = false" @restored="loadWorkspace" />
    <Teleport to="body">
      <div v-if="toast" class="toast" role="status">{{ toast }}</div>
      <DiscussionWorkspace v-if="discussionOpen && activeScript" :key="activeScriptId" :script-id="activeScriptId" :script-name="activeScript.name" :clues="clues" :people="people" :relationships="relationships" :events="events" :notes="notes" @close="discussionOpen = false" />
      <DocumentCorrection v-if="documentCorrectionOpen && selectedClue && imageUrls[selectedClue.imagePath]" :src="imageUrls[selectedClue.imagePath]" :title="selectedClue.title" :busy="busy" @close="documentCorrectionOpen = false" @save="saveDocumentCorrection" />
      <OperationHistory v-if="operationHistoryOpen && activeScript" :key="activeScriptId" :script-id="activeScriptId" :revision-key="archiveRevision" :busy="busy" @close="operationHistoryOpen = false" @undo="undoLastChange" @redo="redoLastChange" />
      <PersonNameCorrections v-if="correctionPersonId && activeScript" :key="`${activeScriptId}:${correctionPersonId}`" :script-id="activeScriptId" :person-id="correctionPersonId" :people="people" :clues="clues" :busy="busy" @close="correctionPersonId = ''" @changed="nameCorrectionChanged" />
      <ArchiveImportDialog v-if="importDialogOpen && importPreview" :preview="importPreview" :busy="busy" @close="closeImportPreview" @confirm="confirmArchiveImport" />
      <ReviewWorkbench v-if="reviewWorkbenchOpen && activeScript" :key="activeScriptId" :script-id="activeScriptId" :clues="clues" :organization="organization" :image-urls="imageUrls" :busy="busy" @request-image="requestClueImage" @close="reviewWorkbenchOpen = false" @open-clue="openTimelineClue" @accept="acceptWorkbenchSuggestion" @reanalyze="retryTimeExtraction" @ignore="applyReviewSelection([$event], 'ignore')" @locate-clue="locateClueSource" />
      <ClueBatchEditor v-if="clueBatchOpen && activeScript" :key="activeScriptId" :script-id="activeScriptId" :clues="selectedBatchClues" :rounds="captureRoundOptions" :categories="categories" :busy="busy" @close="clueBatchOpen = false" @apply="applyClueBatch" />
      <WorkspaceSearch v-if="workspaceSearchOpen && activeScript" :key="activeScriptId" :script-id="activeScriptId" :script-name="activeScript.name" :clues="clues" :people="people" :events="events" :notes="notes" @close="workspaceSearchOpen = false" @open-clue="openSearchClue" @open-person="openSearchPerson" @open-event="openSearchEvent" @open-note="openSearchNote" />
      <WorkspaceGuide v-if="workspaceGuideOpen && activeScript" :key="activeScriptId" :script-name="activeScript.name" @close="workspaceGuideOpen = false" @navigate="navigateFromGuide" @open-search="openWorkspaceSearch" />
      <div v-if="scriptDialog" class="modal-backdrop" @click.self="scriptDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingScriptId ? '编辑剧本' : '新建剧本' }}</h2><button title="关闭" @click="scriptDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>剧本名称<input v-model="scriptForm.name" maxlength="80" placeholder="输入剧本名称" /></label><label>游玩日期<input v-model="scriptForm.playDate" type="date" /></label><div class="image-picker-row"><div class="image-picker-preview" :style="scriptForm.coverPath ? { backgroundImage: `url(${scriptForm.coverPath.startsWith('data:') ? scriptForm.coverPath : imageUrls[scriptForm.coverPath] || ''})` } : {}"><UiIcon v-if="!scriptForm.coverPath" name="image" :size="22" /></div><button class="secondary-button" @click="chooseCover">选择封面照片</button></div></div><div class="modal-actions"><button class="secondary-button" @click="scriptDialog = false">取消</button><button class="primary-button" :disabled="busy" @click="saveScript">保存剧本</button></div></div></div>
      <div v-if="clueDialog && selectedClue" class="modal-backdrop clue-backdrop" @click.self="clueDialog = false"><div class="modal clue-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><span class="modal-kicker">线索 #{{ String(selectedClue.number).padStart(3, '0') }}</span><h2>{{ selectedClue.title }}</h2></div><button title="关闭" @click="clueDialog = false"><UiIcon name="close" :size="20" /></button></div><div class="clue-detail-layout"><div class="clue-photo-panel"><CluePhotoViewer v-if="imageUrls[selectedPhotoPath]" v-model:zoom="photoZoom" :src="imageUrls[selectedPhotoPath]" :alt="selectedClue.title" :rotation="selectedClue.rotation" :regions="selectedPhotoPath === selectedClue.imagePath && selectedClue.ocrImagePath === selectedClue.imagePath ? selectedClue.ocrRegions || [] : []" :focus-text="selectedPhotoPath === selectedClue.imagePath ? sourceExcerpt : ''" @location="sourceLocationCount = $event" /><div v-else class="photo-stage"><UiIcon name="image" :size="40" /></div><div class="photo-tools"><span>{{ selectedPhotoLabel }}</span><button v-if="selectedClue.displayImagePath" @click="showCorrectedPhoto = !showCorrectedPhoto">{{ showCorrectedPhoto ? '查看原图' : '查看副本' }}</button><button @click="capture"><UiIcon name="camera" :size="18" />继续拍摄</button><button title="放大或缩小" @click="photoZoom = !photoZoom"><UiIcon name="zoomIn" :size="18" />{{ photoZoom ? '缩小' : '放大' }}</button><button @click="rotatePhoto(selectedClue)"><UiIcon name="rotate" :size="18" />旋转</button><button @click="openCrop"><UiIcon name="image" :size="18" />裁剪</button><button :disabled="busy" @click="documentCorrectionOpen = true"><UiIcon name="grid" :size="18" />校正</button><button @click="annotationOpen = true"><UiIcon name="edit" :size="18" />标注</button></div></div><div class="clue-editor" :inert="busy || undefined"><PhotoQualityPanel v-if="imageUrls[selectedPhotoPath]" :src="imageUrls[selectedPhotoPath]" :regions="selectedPhotoPath === selectedClue.ocrImagePath ? selectedClue.ocrRegions || [] : []" :busy="busy" @retake="retakeSelectedPhoto" @correct="documentCorrectionOpen = true" /><section v-if="sourceExcerpt" class="source-excerpt"><header><strong>对应原文</strong><button aria-label="收起出处摘录" @click="sourceExcerpt = ''"><UiIcon name="close" :size="16" /></button></header><p>{{ sourceExcerpt }}</p><div class="source-location-actions"><span role="status">{{ selectedPhotoPath !== selectedClue.imagePath ? '切回原图查看出处定位' : sourceLocationCount ? `原图已框出 ${sourceLocationCount} 行对应文字` : selectedClue.ocrRegions?.length ? '当前摘录未匹配到原图位置' : '这条线索尚无原图文字定位' }}</span><button v-if="selectedPhotoPath !== selectedClue.imagePath" class="text-button" @click="showCorrectedPhoto = false">查看原图</button><button v-else-if="!sourceLocationCount" class="text-button" :disabled="busy" @click="locateClueSource(selectedClue.id)">{{ selectedClue.ocrRegions?.length ? '重建定位' : '补充定位' }}</button></div></section><SourceRevisionNotice v-if="selectedClueSourceReviews.length" :reviews="selectedClueSourceReviews" :busy="busy" @open-clue="openTimelineClue" @focus-event="focusSourceReviewEvent" @reviewed="acknowledgeOneSource" @reviewed-all="acknowledgeSourceReviews" /><div class="editor-section"><span class="section-label">基础信息</span><label>标题<input v-model="clueForm.title" /></label><div class="two-fields"><label>搜证轮次<input v-model="clueForm.round" placeholder="如：第一轮" /></label><label>分类<input v-model="clueForm.category" placeholder="如：物证" /></label></div><label>标签<input v-model="clueForm.tags" placeholder="用逗号分隔" /></label></div><div class="editor-section"><span class="section-label">OCR 识别文字 <small>可直接修正错误</small></span><textarea v-model="clueForm.ocrText" rows="8" placeholder="照片中暂未识别出文字"></textarea></div><div class="editor-section"><span class="section-label">备注</span><textarea v-model="clueForm.notes" rows="3" placeholder="写下你的观察"></textarea></div><div class="clue-editor-bottom"><button class="danger-text" @click="removeClue(selectedClue)"><UiIcon name="trash" :size="17" />删除线索</button><div><button class="secondary-button" @click="toggleCompare(selectedClue.id)"><UiIcon name="compare" :size="17" />{{ compareIds.includes(selectedClue.id) ? '移出对照' : '加入对照' }}</button><button class="primary-button" :disabled="busy" @click="saveClue">保存修改</button></div></div></div></div></div></div>
      <div v-if="personDialog" class="modal-backdrop" @click.self="personDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingPersonId ? '编辑人物' : '添加人物' }}</h2><button title="关闭" @click="personDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>姓名<input v-model="personForm.name" placeholder="人物姓名" /></label><div class="image-picker-row"><div class="image-picker-preview round" :style="personForm.photoPath ? { backgroundImage: `url(${personForm.photoPath.startsWith('data:') ? personForm.photoPath : imageUrls[personForm.photoPath] || ''})` } : {}"><UiIcon v-if="!personForm.photoPath" name="person" :size="22" /></div><button class="secondary-button" @click="choosePersonPhoto">选择人物照片</button></div><label>别名<input v-model="personForm.aliases" placeholder="多个别名用逗号分隔" /></label><label>备注<textarea v-model="personForm.notes" rows="4" placeholder="人物档案备注"></textarea></label></div><div class="modal-actions"><button v-if="editingPersonId" class="secondary-button" :disabled="busy" @click="openNameCorrections(editingPersonId)">姓名识别纠错</button><button v-if="editingPersonId && people.length > 1" class="secondary-button" :disabled="busy" @click="openPersonMerge(editingPersonId)">合并人物</button><button class="secondary-button" @click="personDialog = false">取消</button><button class="primary-button" @click="savePerson">保存人物</button></div></div></div>
      <div v-if="relationshipDialog" class="modal-backdrop" @click.self="relationshipDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ relationFromGraph ? '请输入他们的关系' : '添加人物关系' }}</h2><button title="关闭" @click="relationshipDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><p v-if="relationFromGraph">{{ people.find(person => person.id === relationForm.fromId)?.name }} 与 {{ people.find(person => person.id === relationForm.toId)?.name }}</p><template v-else><label>人物 A<select v-model="relationForm.fromId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label>人物 B<select v-model="relationForm.toId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label></template><label>关系描述<input ref="relationLabelInput" v-model="relationForm.label" :placeholder="relationFromGraph ? '如：同事、兄妹、朋友' : '如：同事'" @keydown.enter.prevent="saveRelationship" /></label><p class="form-help">这条关系完全由你确认，系统不会推断。</p></div><div class="modal-actions"><button class="secondary-button" @click="relationshipDialog = false">取消</button><button class="primary-button" @click="saveRelationship">{{ relationFromGraph ? '确认连线' : '添加关系' }}</button></div></div></div>
      <div v-if="eventDialog" class="modal-backdrop" @click.self="eventDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ pendingTimelineSuggestionId ? '确认时间线建议' : editingEventId ? '编辑时间节点' : '添加时间节点' }}</h2><button title="关闭" @click="eventDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>事件<input data-event-title v-model="eventForm.title" placeholder="已确认的事件" /></label><div class="event-time-field"><label v-if="eventForm.yearless">时间（无年份）<input v-model="eventForm.startsAt" type="text" placeholder="--06-17T03:04" /></label><label v-else>时间<input v-model="eventForm.startsAt" :type="/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(eventForm.startsAt) ? 'text' : 'datetime-local'" /></label><button type="button" class="secondary-button time-mode-button" @click="toggleEventYearless">{{ eventForm.yearless ? '切换为有年份' : '录入无年份时间' }}</button></div><label>时段（可选）<select v-model="eventForm.timeOfDay"><option value="">无</option><option v-for="period in ['凌晨','清晨','早晨','早上','上午','中午','下午','午后','傍晚','晚上','晚间','夜里','夜间','深夜','半夜']" :key="period" :value="period">{{ period }}</option></select></label><label>原始线索<select v-model="eventForm.clueId"><option value="">暂不关联</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label>涉及人物<select v-model="eventForm.personIds" multiple size="4"><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><p v-if="pendingTimeIssue" class="form-help">{{ pendingTimeIssue.startsAt ? '时间和来源已填写，写下这一刻发生了什么，然后保存。' : '原文未能确定日期，请填入你确认的日期，并写下发生了什么。' }}</p><blockquote v-if="pendingTimeIssue?.quote" class="time-issue-editor-quote">{{ pendingTimeIssue.quote }}</blockquote><p v-else class="form-help">只添加线索中明确出现且由你确认的事件。无年份时间按 --月-日T时:分 填写，保存后可单独忽略“无年份”标记。</p></div><section v-if="mergeTargets.length" class="event-merge-section"><strong>合并重复事件</strong><p>仅列出同一时间的记录。选择后保留目标标题，并合并人物和全部出处。</p><select v-model="mergeTargetId" aria-label="选择要合并到的事件"><option value="">选择目标事件</option><option v-for="candidate in mergeTargets" :key="candidate.id" :value="candidate.id">{{ candidate.title }}</option></select><button class="secondary-button" :disabled="busy || !mergeTargetId" @click="mergeEvent">确认合并到此事件</button></section><div class="modal-actions"><button class="secondary-button" @click="eventDialog = false; pendingTimelineSuggestionId = ''">取消</button><button class="primary-button" @click="saveEvent">保存节点</button></div></div></div>
      <div v-if="noteDialog" class="modal-backdrop" @click.self="noteDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ noteId ? '编辑笔记' : '新建笔记' }}</h2><button title="关闭" @click="noteDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack" :inert="busy || undefined"><div class="editor-draft-status" role="status"><span>{{ noteDraftStatus }}</span><button class="text-button" :disabled="busy" @click="discardNoteDraft">丢弃草稿</button><p v-if="noteDraftConflict">正式笔记或关联资料已发生变化，请核对恢复的草稿再保存。</p></div><label>笔记内容<textarea v-model="noteForm.text" rows="8" placeholder="写下观察、疑问或讨论内容"></textarea></label><label>关联线索<select v-model="noteForm.clueId" @change="noteForm.personId = ''"><option value="">不关联线索</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label>关联人物<select v-model="noteForm.personId" @change="noteForm.clueId = ''"><option value="">不关联人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label></div><div class="modal-actions"><button class="secondary-button" @click="noteDialog = false">取消</button><button class="primary-button" @click="saveNote">保存笔记</button></div></div></div>
      <div v-if="boardDialog" class="modal-backdrop" @click.self="boardDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>{{ editingBoardId ? '编辑卡片' : '添加整理板卡片' }}</h2><button title="关闭" @click="boardDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>类型<select v-model="boardForm.kind" @change="boardForm.refId = ''"><option value="note">便签</option><option value="clue">线索</option><option value="person">人物</option></select></label><label v-if="boardForm.kind === 'clue'">线索<select v-model="boardForm.refId"><option value="">选择线索</option><option v-for="clue in clues" :key="clue.id" :value="clue.id">#{{ clue.number }} {{ clue.title }}</option></select></label><label v-if="boardForm.kind === 'person'">人物<select v-model="boardForm.refId"><option value="">选择人物</option><option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label v-if="boardForm.kind === 'note'">便签内容<textarea v-model="boardForm.text" rows="4" placeholder="写在卡片上的内容"></textarea></label><label>分组<input v-model="boardForm.group" placeholder="可选，如：第一轮" /></label><label>颜色<input v-model="boardForm.color" type="color" class="color-input" /></label></div><div class="modal-actions"><button class="secondary-button" @click="boardDialog = false">取消</button><button class="primary-button" @click="saveBoardItem">保存卡片</button></div></div></div>
      <div v-if="boardLinkDialog" class="modal-backdrop" @click.self="boardLinkDialog = false"><div class="modal compact-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>手动连接卡片</h2><button title="关闭" @click="boardLinkDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="form-stack"><label>起点<select v-model="boardLinkForm.fromId"><option value="">选择卡片</option><option v-for="item in boardItems" :key="item.id" :value="item.id">{{ item.text || (item.kind === 'clue' ? clues.find(clue => clue.id === item.refId)?.title : people.find(person => person.id === item.refId)?.name) }}</option></select></label><label>终点<select v-model="boardLinkForm.toId"><option value="">选择卡片</option><option v-for="item in boardItems" :key="item.id" :value="item.id">{{ item.text || (item.kind === 'clue' ? clues.find(clue => clue.id === item.refId)?.title : people.find(person => person.id === item.refId)?.name) }}</option></select></label><label>连接说明<input v-model="boardLinkForm.label" placeholder="可选" /></label></div><div class="modal-actions"><button class="secondary-button" @click="boardLinkDialog = false">取消</button><button class="primary-button" @click="saveBoardLink">连接卡片</button></div></div></div>
      <div v-if="cropDialog && selectedClue" class="modal-backdrop crop-backdrop" @click.self="cropDialog = false"><div class="crop-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>裁剪线索照片</h2><p>在原图上拖动，选择需要保留的范围。原图始终保留。</p></div><button title="关闭" @click="cropDialog = false"><UiIcon name="close" :size="19" /></button></div><div class="crop-stage"><div class="crop-image-frame" @pointerdown="beginCrop" @pointermove="moveCrop" @pointerup="endCrop" @pointercancel="endCrop"><img ref="cropImage" :src="imageUrls[selectedClue.imagePath]" :alt="selectedClue.title" draggable="false" /><div v-if="cropStart && cropEnd" class="crop-selection" :style="cropStyle"></div></div></div><div class="modal-actions"><button class="secondary-button" @click="cropDialog = false">取消</button><button class="primary-button" :disabled="busy || !cropStart || !cropEnd" @click="applyCrop">保存裁剪</button></div></div></div>
      <AnnotationEditor v-if="annotationOpen && selectedClue" :clue-id="selectedClue.id" :image-url="imageUrls[selectedClue.imagePath] || ''" :rotation="selectedClue.rotation" @close="annotationOpen = false" @saved="annotationOpen = false; notify('标注已保存')" />
      </Teleport>
    </div>
  </IonApp>
</template>


<style scoped src="./styles/clue-library.css"></style>

<style scoped>
.timeline-page { display: flex; flex: 1; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; overflow: hidden; padding-bottom: 20px; }
.timeline-page > .page-header { flex: none; align-items: center; margin-bottom: 0; }
.timeline-page > .timeline-explorer { flex: 1; min-height: 0; height: auto; }
.timeline-page > .section-empty { flex: 1; }
.timeline-page > .timeline-pending { flex: none; margin: 0; }
.timeline-page > .source-review-banner { flex: none; }
.timeline-page-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.timeline-display-toggle { display: inline-flex; gap: 3px; padding: 4px; border: 1px solid #dfe6ec; border-radius: 12px; background: #eef2f5; }
.timeline-display-toggle button { display: inline-flex; flex: 0 0 40px; align-items: center; justify-content: center; width: 40px; min-width: 40px; min-height: 40px; padding: 0; border-radius: 9px; background: transparent; color: #7a8a97; font: inherit; font-size: 13px; white-space: nowrap; touch-action: manipulation; transition: background .18s, color .18s; }
.timeline-add-event { display: inline-flex; flex: 0 0 40px; align-items: center; justify-content: center; width: 40px; min-width: 40px; min-height: 40px; padding: 0; }
.timeline-display-toggle button.active { background: #fff; color: #36576e; font-weight: 650; box-shadow: 0 1px 4px #253f5210; }
.timeline-display-toggle button:focus-visible { outline: 2px solid #7f9db4; outline-offset: 2px; }
.timeline-list-controls { flex: none; align-items: center; gap: 14px; margin: 0; padding: 12px 16px; }
.timeline-list-controls > label { flex-direction: row; align-items: center; gap: 12px; }
.timeline-list-controls select { width: 180px; min-width: 0; }
.timeline-list-controls .timeline-visible-count { margin-left: auto; padding-bottom: 0; font-variant-numeric: tabular-nums; }
.timeline-reading-list { position: relative; flex: 1; min-width: 0; min-height: 0; margin: 0; padding: 0 24px; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; touch-action: pan-y; scrollbar-gutter: stable; -webkit-overflow-scrolling: touch; outline: none; }
.timeline-reading-list::before { display: none; }
.timeline-reading-list .timeline-event { display: grid; grid-template-columns: 12px 150px minmax(0, 1fr) auto; align-items: start; gap: 16px; padding: 24px 0; border-bottom: 1px solid #eaf0f4; }
.timeline-reading-list .timeline-event:last-child { border-bottom: 0; }
.timeline-reading-list .timeline-event-marker { width: 10px; height: 10px; margin: 7px 0 0; border: 2px solid #9eb4c5; background: #f8fafc; box-sizing: border-box; }
.timeline-reading-list .timeline-event-date { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; color: #57758c; font-size: 13px; line-height: 1.7; font-weight: 600; font-variant-numeric: tabular-nums; }
.timeline-event-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.timeline-reading-list .timeline-marker-action { padding: 3px 5px; color: #8997a2; font-size: 11px; font-weight: 400; }
.timeline-reading-list .timeline-event-content { min-width: 0; }
.timeline-reading-list .timeline-event-content h2 { max-width: 75ch; margin: 0 0 9px; color: #2d4353; font-size: 16px; font-weight: 550; line-height: 1.75; overflow-wrap: anywhere; }
.timeline-reading-list .timeline-event-refs { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.timeline-reading-list .timeline-event-refs > span { padding: 4px 8px; border-radius: 6px; font-size: 11px; }
.timeline-reading-list .timeline-event-refs > button { padding: 3px 0; margin-left: 3px; font-size: 12px; }
.timeline-reading-list .row-actions { display: flex; flex-direction: row; align-items: center; gap: 2px; }
.timeline-reading-list .row-actions button { display: grid; place-items: center; min-width: 40px; min-height: 40px; padding: 0; border-radius: 10px; color: #8b9aa6; background: transparent; touch-action: manipulation; }
.timeline-reading-list .row-actions button:active { color: #486b86; background: #edf3f7; }
.timeline-list-fullscreen { position: fixed; inset: 0; z-index: 1100; width: 100%; height: 100dvh; box-sizing: border-box; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: #f5f7fa; }
@media (max-width: 900px) {
  .timeline-page-header { flex-wrap: wrap; gap: 14px; }
  .timeline-page-actions { margin-left: auto; }
  .timeline-reading-list { padding-inline: 18px; }
  .timeline-reading-list .timeline-event { grid-template-columns: 10px 132px minmax(0, 1fr) auto; gap: 12px; }
  .timeline-reading-list .row-actions { flex-direction: column; }
}
@media (max-width: 620px) {
  .timeline-page { gap: 12px; }
  .timeline-page-actions { width: 100%; flex-wrap: nowrap; gap: 10px; }
  .timeline-display-toggle { flex: 0 0 auto; }
  .timeline-display-toggle button { flex: 0 0 40px; padding: 0; }
  .timeline-page-actions > .primary-button { flex: 0 0 40px; padding: 0; }
  .timeline-list-controls { gap: 10px; padding: 12px; }
  .timeline-list-controls > label { width: auto; flex: 1; }
  .timeline-list-controls > label > span { display: none; }
  .timeline-list-controls select { width: 100%; }
  .timeline-list-controls .timeline-visible-count { margin: 0; font-size: 11px; }
  .timeline-list-controls > button { padding-inline: 10px; font-size: 12px; }
  .timeline-reading-list { padding-inline: 14px; }
  .timeline-reading-list .timeline-event { grid-template-columns: 10px minmax(0, 1fr) 38px; gap: 6px 10px; padding-block: 20px; }
  .timeline-reading-list .timeline-event-marker { grid-column: 1; grid-row: 1 / 3; }
  .timeline-reading-list .timeline-event-date { grid-column: 2; grid-row: 1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .timeline-reading-list .timeline-event-content { grid-column: 2; grid-row: 2; }
  .timeline-reading-list .timeline-event-content h2 { font-size: 15px; }
  .timeline-reading-list .row-actions { grid-column: 3; grid-row: 1 / 3; }
  .timeline-reading-list .row-actions button { min-width: 38px; }
}
@media (prefers-reduced-motion: reduce) { .timeline-display-toggle button { transition: none; } }
</style>
