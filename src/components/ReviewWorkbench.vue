<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import CluePhotoViewer from './CluePhotoViewer.vue'
import { classifyReview } from '../services/reviewClassification'
import type { ReviewSelection } from '../services/reviewActions'
import type { ClueRecord, OrganizationCluePointSuggestion, OrganizationPersonSuggestion, OrganizationRelationshipSuggestion, OrganizationSnapshot, OrganizationTimelineSuggestion } from '../services/vault'

type Suggestion =
  | { kind: 'people'; item: OrganizationPersonSuggestion }
  | { kind: 'relationships'; item: OrganizationRelationshipSuggestion }
  | { kind: 'timeline'; item: OrganizationTimelineSuggestion }
  | { kind: 'cluePoints'; item: OrganizationCluePointSuggestion }
const props = defineProps<{ scriptId: string; clues: ClueRecord[]; organization: OrganizationSnapshot | null; busy: boolean; imageUrls: Record<string, string> }>()
const emit = defineEmits<{ close: []; 'open-clue': [id: string, quote?: string]; accept: [selection: ReviewSelection]; ignore: [selection: ReviewSelection]; 'locate-clue': [id: string]; 'request-image': [path: string] }>()
const currentKey = ref('')
const sourceIndex = ref(0)
const zoom = ref(false)
const reviewed = ref<string[]>([])
const actionKey = ref('')
const completedCount = ref(0)
const workbench = ref<HTMLElement | null>(null)
const locatedCount = ref(0)
const ocr = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const previousFocus = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
const keyOf = (entry: Suggestion) => `${entry.kind}:${entry.item.id}`
const clues = computed(() => props.clues.filter(clue => clue.scriptId === props.scriptId))
const suggestions = computed<Suggestion[]>(() => {
  const result = props.organization
  if (!result || result.scriptId !== props.scriptId) return []
  return [
    ...result.people.map(item => ({ kind: 'people' as const, item })),
    ...result.relationships.map(item => ({ kind: 'relationships' as const, item })),
    ...result.timeline.map(item => ({ kind: 'timeline' as const, item })),
    ...result.cluePoints.map(item => ({ kind: 'cluePoints' as const, item })),
  ].sort((a, b) => a.item.sourceNo - b.item.sourceNo)
})
const currentIndex = computed(() => suggestions.value.findIndex(item => keyOf(item) === currentKey.value))
const suggestion = computed(() => suggestions.value[currentIndex.value] || null)
const groups = computed(() => [...new Set(suggestions.value.map(entry => entry.item.sourceNo))].map(number => ({ number, count: suggestions.value.filter(entry => entry.item.sourceNo === number).length, title: clues.value.find(clue => clue.number === number)?.title || '原线索已不存在' })))
const classification = computed(() => suggestion.value ? classifyReview(suggestion.value, clues.value, props.organization?.timelineAudit, reviewed.value.includes(currentKey.value)) : null)
const sources = computed(() => {
  const entry = suggestion.value
  if (!entry) return []
  const primary = clues.value.find(clue => clue.number === entry.item.sourceNo)
  const result: { clue: ClueRecord; quote: string }[] = primary ? [{ clue: primary, quote: entry.item.quote }] : []
  if (entry.kind === 'timeline') for (const evidence of entry.item.evidence || []) {
    const clue = clues.value.find(clue => clue.number === evidence.sourceNo && clue.id === evidence.clueId)
    if (clue && evidence.quote && clue.ocrText.includes(evidence.quote) && !result.some(source => source.clue.id === clue.id && source.quote === evidence.quote)) result.push({ clue, quote: evidence.quote })
  }
  return result
})
const source = computed(() => sources.value[sourceIndex.value] || sources.value[0] || null)
const photo = computed(() => source.value ? props.imageUrls[source.value.clue.imagePath] || '' : '')
watch(() => source.value?.clue.imagePath, path => { if (path && !props.imageUrls[path]) emit('request-image', path) }, { immediate: true })
const regions = computed(() => source.value?.clue.ocrImagePath === source.value?.clue.imagePath ? source.value?.clue.ocrRegions || [] : [])
const ocrParts = computed(() => {
  const text = source.value?.clue.ocrText || ''
  const quote = source.value?.quote || ''
  const index = quote ? text.indexOf(quote) : -1
  return index < 0 ? { before: text, match: '', after: '' } : { before: text.slice(0, index), match: quote, after: text.slice(index + quote.length) }
})
const disabled = computed(() => props.busy || Boolean(actionKey.value))
const kindLabel = (kind: Suggestion['kind']) => ({ people: '人物', relationships: '关系', timeline: '时间事件', cluePoints: '线索点' })[kind]
function dateLabel(value: string) {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return value
  return `${match[1] ? `${match[1]}年` : ''}${Number(match[2])}月${Number(match[3])}日${match[4] ? ` ${match[4]}${match[5] ? `:${match[5]}` : '时'}` : ''}`
}
const heading = computed(() => {
  const entry = suggestion.value
  if (!entry) return ''
  if (entry.kind === 'people') return entry.item.name
  if (entry.kind === 'relationships') return `${entry.item.from} · ${entry.item.label} · ${entry.item.to}`
  return entry.item.title || '待补充事件'
})
const details = computed(() => {
  const entry = suggestion.value
  if (!entry) return []
  if (entry.kind === 'people') return entry.item.aliases.length ? [{ label: '别名', value: entry.item.aliases.join('、') }] : []
  if (entry.kind === 'relationships') return [{ label: '关系', value: entry.item.label }]
  if (entry.kind === 'timeline') return [
    { label: '时间', value: dateLabel(entry.item.startsAt) },
    { label: '精度', value: `${entry.item.startsAt.startsWith('--') ? '无年份 · ' : ''}${entry.item.approximate ? '约时 · ' : ''}${(entry.item.precision || (/T\d{2}:\d{2}$/.test(entry.item.startsAt) ? 'minute' : /T\d{2}$/.test(entry.item.startsAt) ? 'hour' : 'date')) === 'minute' ? '到分钟' : (entry.item.precision || (/T\d{2}$/.test(entry.item.startsAt) ? 'hour' : 'date')) === 'hour' ? '到小时' : '仅日期'}` },
    ...(entry.item.people.length ? [{ label: '人物', value: entry.item.people.join('、') }] : []),
  ]
  return [{ label: '分类', value: entry.item.category || '未分类' }, ...(entry.item.tags.length ? [{ label: '标签', value: entry.item.tags.join('、') }] : [])]
})
const acceptLabel = computed(() => classification.value?.group === 'needs-content' ? '补充并录入' : '录入，下一条')
function navigate(offset: number) {
  if (disabled.value) return
  const target = suggestions.value[currentIndex.value + offset]
  if (target) currentKey.value = keyOf(target)
}
function chooseSource(event: Event) {
  if (disabled.value) return
  const number = Number((event.target as HTMLSelectElement).value)
  const target = suggestions.value.find(entry => entry.item.sourceNo === number)
  if (target) currentKey.value = keyOf(target)
}
function setReviewed(event: Event) {
  if (disabled.value || !classification.value?.canConfirm || !ocrParts.value.match) return
  if ((event.target as HTMLInputElement).checked) reviewed.value = [...new Set([...reviewed.value, currentKey.value])]
}
async function apply(action: 'accept' | 'ignore') {
  const entry = suggestion.value
  if (!entry || disabled.value || (action === 'accept' && classification.value?.group === 'needs-review')) return
  if (classification.value?.group !== 'needs-content' || action === 'ignore') actionKey.value = keyOf(entry)
  if (action === 'accept') emit('accept', { kind: entry.kind, id: entry.item.id })
  else emit('ignore', { kind: entry.kind, id: entry.item.id })
  await nextTick()
  if (!props.busy) actionKey.value = ''
}
watch(() => suggestions.value.map(keyOf), (keys, previous = []) => {
  const removed = previous.filter(key => !keys.includes(key))
  completedCount.value += removed.length
  if (!keys.includes(currentKey.value)) {
    const previousIndex = previous.indexOf(currentKey.value)
    currentKey.value = keys[Math.min(Math.max(previousIndex, 0), keys.length - 1)] || ''
  }
  if (actionKey.value && !keys.includes(actionKey.value)) actionKey.value = ''
  reviewed.value = reviewed.value.filter(key => keys.includes(key))
}, { immediate: true })
watch(() => props.scriptId, () => { reviewed.value = []; completedCount.value = 0; sourceIndex.value = 0; actionKey.value = '' })
watch(() => props.busy, value => { if (!value) actionKey.value = '' })
watch(currentKey, () => { sourceIndex.value = 0; zoom.value = false })
watch(() => source.value?.quote, async () => { locatedCount.value = 0; await nextTick(); ocr.value?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' }) })
function keydown(event: KeyboardEvent) {
  const element = workbench.value
  if (event.defaultPrevented || !element || !(event.target instanceof Node) || !element.contains(event.target) || document.querySelector('.modal-backdrop')) return
  if (event.key === 'Escape' && !disabled.value) { event.preventDefault(); emit('close'); return }
  if (event.key !== 'Tab') return
  const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(control => control.getClientRects().length)
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(() => { closeButton.value?.focus(); window.addEventListener('keydown', keydown) })
onUnmounted(() => { window.removeEventListener('keydown', keydown); previousFocus?.focus() })
</script>

<template>
  <Teleport to="body">
    <section ref="workbench" class="review-workbench" role="dialog" aria-modal="true" aria-labelledby="workbench-title" :aria-busy="busy" @contextmenu.prevent>
      <header class="workbench-header">
        <div><span class="workbench-eyebrow">当前剧本 · 逐条核对</span><h1 id="workbench-title">原文与整理结果</h1></div>
        <div class="workbench-progress" role="status" aria-live="polite"><strong>{{ suggestions.length }}</strong> 项待处理<span v-if="completedCount"> · 本次已处理 {{ completedCount }} 项</span></div>
        <button ref="closeButton" class="workbench-close" :disabled="disabled" aria-label="关闭逐条核对" @click="emit('close')">完成 <span aria-hidden="true">×</span></button>
      </header>
      <nav v-if="suggestion" class="workbench-navigation" aria-label="选择核对建议">
        <label>按原线索<select :value="suggestion.item.sourceNo" :disabled="disabled" @change="chooseSource"><option v-for="group in groups" :key="group.number" :value="group.number">#{{ String(group.number).padStart(3, '0') }} {{ group.title }} · {{ group.count }} 项</option></select></label>
        <div class="workbench-paging"><button :disabled="disabled || currentIndex <= 0" @click="navigate(-1)">‹ 上一条</button><span>{{ currentIndex + 1 }} / {{ suggestions.length }}</span><button :disabled="disabled || currentIndex >= suggestions.length - 1" @click="navigate(1)">下一条 ›</button></div>
      </nav>
      <div v-if="!suggestion" class="workbench-empty"><span aria-hidden="true">✓</span><h2>当前建议已处理完</h2><p>录入的内容可在人物档案和时间线查看。</p><button @click="emit('close')">返回整理总览</button></div>
      <div v-else class="workbench-columns">
        <section class="workbench-photo-pane" aria-label="建议对应的原始照片">
          <div class="workbench-pane-heading"><strong>原始照片 <span v-if="source">#{{ String(source.clue.number).padStart(3, '0') }}</span></strong><div><button :disabled="!photo" @click="zoom = !zoom">{{ zoom ? '适应窗口' : '放大' }}</button><button :disabled="!source || disabled" @click="source && emit('open-clue', source.clue.id, source.quote)">查看线索 ↗</button></div></div>
          <div v-if="sources.length > 1" class="workbench-source-tabs"><button v-for="(entry, index) in sources" :key="`${entry.clue.id}:${index}`" :class="{ active: sourceIndex === index }" @click="sourceIndex = index; zoom = false">出处 #{{ String(entry.clue.number).padStart(3, '0') }}</button></div>
          <CluePhotoViewer v-if="photo && source" :key="source.clue.id" :src="photo" :alt="source.clue.title" :rotation="source.clue.rotation" v-model:zoom="zoom" :regions="regions" :focus-text="source.quote" @location="locatedCount = $event" />
          <div v-else class="workbench-missing-photo">{{ source ? '原图暂时无法显示，请查看原线索。' : '原线索已不存在。' }}</div>
          <div v-if="source && !regions.length" class="workbench-photo-hint"><span>这张旧照片尚未记录文字坐标。</span><button :disabled="disabled" @click="emit('locate-clue', source.clue.id)">定位原图文字</button></div>
          <div v-else-if="source" class="workbench-photo-hint">{{ locatedCount ? `已定位 ${locatedCount} 处文字，放大后可上下左右拖动。` : '未找到匹配文字框，请对照右侧摘录查看原图。' }}</div>
        </section>
        <section class="workbench-review-pane" aria-label="整理建议与 OCR 原文">
          <div class="workbench-proposal"><div class="workbench-proposal-kind"><span>{{ kindLabel(suggestion.kind) }}</span><span :class="classification?.group">{{ classification?.group === 'ready' ? '可以录入' : classification?.group === 'needs-content' ? '需要补充' : '需要核对' }}</span></div><h2>{{ heading }}</h2><dl v-if="details.length"><div v-for="detail in details" :key="detail.label"><dt>{{ detail.label }}</dt><dd>{{ detail.value }}</dd></div></dl><blockquote>{{ suggestion.item.quote }}</blockquote><p class="workbench-review-reason" :class="classification?.group">{{ classification?.reason }}</p><label v-if="classification?.canConfirm" class="workbench-reviewed"><input type="checkbox" :disabled="disabled || !ocrParts.match" @change="setReviewed" /><span>我已核对原图及高亮原文，允许录入</span></label></div>
          <div class="workbench-ocr-heading"><strong>OCR 全文</strong><span>{{ ocrParts.match ? '当前摘录已高亮' : '未找到完全一致的摘录' }}</span></div>
          <div ref="ocr" class="workbench-ocr" tabindex="0" aria-label="OCR 全文，当前摘录高亮"><template v-if="source"><span>{{ ocrParts.before }}</span><mark v-if="ocrParts.match">{{ ocrParts.match }}</mark><span>{{ ocrParts.after }}</span><p v-if="!source.clue.ocrText" class="workbench-muted">暂无 OCR 文字，请在原线索中重试识别或补充文字。</p></template><p v-else class="workbench-muted">无法查看原文，请返回整理总览重新整理以更新出处。</p></div>
          <footer class="workbench-actions"><button class="workbench-ignore" :disabled="disabled" @click="apply('ignore')">忽略，下一条</button><button class="workbench-accept" :disabled="disabled || classification?.group === 'needs-review'" @click="apply('accept')">{{ busy ? '正在保存…' : acceptLabel }} <span aria-hidden="true">→</span></button><small>仅在保存成功后切换；需要补充的内容会打开编辑窗口。</small></footer>
        </section>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.review-workbench { position: fixed; inset: 0; z-index: 1200; display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: max(16px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(14px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: #f5f7f2; color: #2e4337; box-sizing: border-box; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.review-workbench *, .review-workbench *::before, .review-workbench *::after { box-sizing: border-box; }
.review-workbench button, .review-workbench select { font: inherit; }
.review-workbench button { min-height: 42px; padding: 0 14px; border: 1px solid #dfe6dc; border-radius: 11px; background: #fff; color: #365944; cursor: pointer; }
.review-workbench button:disabled { opacity: .42; cursor: default; }
.review-workbench button:focus-visible, .review-workbench select:focus-visible, .workbench-ocr:focus-visible { outline: 3px solid #7aa48b; outline-offset: 2px; }
.workbench-header { display: flex; align-items: center; gap: 22px; flex-shrink: 0; padding-bottom: 16px; }
.workbench-eyebrow { font-size: 11px; color: #7d8c80; letter-spacing: .08em; }
.workbench-header h1 { margin: 4px 0 0; font-size: 23px; letter-spacing: -.035em; }
.workbench-progress { margin-left: auto; color: #7a887d; font-size: 13px; }
.workbench-progress strong { font-size: 20px; color: #365944; }
.workbench-close { display: flex; align-items: center; gap: 18px; }
.workbench-close span { font-size: 24px; font-weight: 300; }
.workbench-navigation { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 18px; padding-bottom: 14px; }
.workbench-navigation label { display: flex; align-items: center; gap: 12px; font-size: 12px; color: #7c8a7e; min-width: 0; }
.workbench-navigation select { min-height: 42px; max-width: 430px; min-width: 0; padding: 0 30px 0 12px; border: 1px solid #dfe6dc; border-radius: 10px; background: #fff; color: #365944; text-overflow: ellipsis; }
.workbench-paging { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.workbench-paging span { min-width: 55px; text-align: center; font-size: 12px; color: #819084; font-variant-numeric: tabular-nums; }
.workbench-columns { flex: 1; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); min-height: 0; gap: 16px; }
.workbench-photo-pane, .workbench-review-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; border: 1px solid #e1e7dc; border-radius: 17px; background: #fff; }
.workbench-photo-pane { background: #edf0e8; }
.workbench-pane-heading { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: #fdfefa; font-size: 12px; }
.workbench-pane-heading strong span { color: #9b7456; font-variant-numeric: tabular-nums; }
.workbench-pane-heading > div { display: flex; gap: 7px; }
.workbench-pane-heading button { min-height: 36px; padding: 0 10px; font-size: 11px; background: transparent; }
.workbench-source-tabs { display: flex; gap: 6px; flex-shrink: 0; overflow-x: auto; padding: 8px 12px; background: #f6f8f1; }
.workbench-source-tabs button { min-height: 32px; padding: 0 10px; font-size: 11px; white-space: nowrap; }
.workbench-source-tabs button.active { color: #fff; border-color: #365f49; background: #365f49; }
.workbench-photo-hint { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 8px; min-height: 43px; padding: 8px 14px; background: #f8faf4; font-size: 11px; color: #8c988a; }
.workbench-photo-hint button { min-height: 32px; padding: 0 9px; font-size: 11px; white-space: nowrap; }
.workbench-missing-photo { flex: 1; display: grid; place-items: center; min-height: 120px; padding: 20px; text-align: center; color: #8a9688; font-size: 13px; }
.workbench-proposal { flex: 0 1 auto; max-height: 53%; overflow-y: auto; padding: 20px 22px 16px; }
.workbench-proposal-kind { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: #688370; }
.workbench-proposal-kind > span { padding: 4px 7px; border-radius: 6px; background: #eff5ed; }
.workbench-proposal-kind .needs-review { color: #ad704b; background: #fcf1e5; }
.workbench-proposal-kind .needs-content { color: #8e7946; background: #f8f5e8; }
.workbench-proposal h2 { margin: 15px 0 12px; font-size: 22px; line-height: 1.5; letter-spacing: -.025em; }
.workbench-proposal dl { display: grid; gap: 7px; margin: 0 0 13px; }
.workbench-proposal dl > div { display: flex; gap: 16px; font-size: 13px; line-height: 1.6; }
.workbench-proposal dt { flex: 0 0 30px; color: #8a958a; }
.workbench-proposal dd { margin: 0; overflow-wrap: anywhere; }
.workbench-proposal blockquote { margin: 0; padding: 11px 13px; border-left: 3px solid #cfdbc8; border-radius: 0 8px 8px 0; color: #697761; background: #f5f7f0; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.workbench-review-reason { margin: 12px 0 0; font-size: 11px; color: #7f9079; line-height: 1.7; }
.workbench-review-reason.needs-review { color: #b07550; }
.workbench-reviewed { display: flex; align-items: center; gap: 9px; margin-top: 12px; font-size: 12px; line-height: 1.6; color: #536a4c; }
.workbench-reviewed input { width: 18px; height: 18px; accent-color: #375f45; }
.workbench-ocr-heading { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 22px; border-top: 1px solid #edf0e8; border-bottom: 1px solid #edf0e8; font-size: 12px; }
.workbench-ocr-heading span { font-size: 10px; color: #98a18f; }
.workbench-ocr { flex: 1; min-height: 80px; overflow-y: auto; padding: 16px 22px; font-size: 13px; line-height: 1.95; white-space: pre-wrap; overflow-wrap: anywhere; color: #65705e; overscroll-behavior: contain; }
.workbench-ocr mark { border-radius: 3px; background: #f6dd9c; color: #5e4c22; padding: 2px 0; }
.workbench-muted { margin: 0; color: #939e8c; }
.workbench-actions { display: grid; grid-template-columns: .8fr 1.3fr; gap: 9px; flex-shrink: 0; padding: 13px 18px 12px; border-top: 1px solid #e9eee3; background: #fbfcf8; }
.workbench-actions .workbench-accept { display: flex; align-items: center; justify-content: center; gap: 14px; border-color: #365e46; background: #365e46; color: #fff; }
.workbench-actions small { grid-column: 1 / -1; font-size: 10px; line-height: 1.6; color: #9aA38f; }
.workbench-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 25px; text-align: center; }
.workbench-empty > span { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; background: #e8f0e1; color: #577343; font-size: 27px; }
.workbench-empty h2 { margin: 18px 0 8px; font-size: 23px; }
.workbench-empty p { margin: 0 0 22px; color: #8b9780; font-size: 13px; }
@media (orientation: portrait), (max-width: 760px) {
  .review-workbench { padding-right: max(12px, env(safe-area-inset-right)); padding-left: max(12px, env(safe-area-inset-left)); }
  .workbench-header { gap: 10px; padding-bottom: 12px; }
  .workbench-header h1 { font-size: 19px; }
  .workbench-progress { font-size: 11px; }
  .workbench-progress span { display: none; }
  .workbench-navigation { gap: 9px; padding-bottom: 10px; }
  .workbench-navigation label { flex: 1; gap: 7px; font-size: 0; }
  .workbench-navigation select { width: 100%; font-size: 12px; }
  .workbench-paging { gap: 5px; }
  .workbench-paging button { min-height: 40px; padding: 0 8px; font-size: 11px; }
  .workbench-paging span { min-width: 42px; font-size: 10px; }
  .workbench-columns { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(160px, .7fr) minmax(0, 1.3fr); gap: 10px; }
  .workbench-pane-heading { padding: 8px 12px; }
  .workbench-proposal { padding: 14px 16px 11px; max-height: 55%; }
  .workbench-proposal h2 { font-size: 19px; margin: 10px 0 8px; }
  .workbench-proposal blockquote { font-size: 11px; }
  .workbench-photo-hint { min-height: 35px; padding: 5px 12px; }
  .workbench-ocr-heading { padding: 9px 16px; }
  .workbench-ocr { padding: 12px 16px; }
  .workbench-actions { padding: 10px 12px 9px; }
}
@media (prefers-reduced-motion: reduce) { .review-workbench * { scroll-behavior: auto !important; } }
</style>
