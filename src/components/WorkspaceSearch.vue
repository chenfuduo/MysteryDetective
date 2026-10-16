<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getLocalState, saveLocalState, type ClueRecord, type NoteRecord, type PersonRecord, type TimelineRecord } from '../services/vault'

const props = defineProps<{ scriptId: string; scriptName: string; clues: ClueRecord[]; people: PersonRecord[]; events: TimelineRecord[]; notes: NoteRecord[] }>()
const emit = defineEmits<{ close: []; 'open-clue': [id: string, quote?: string]; 'open-person': [id: string]; 'open-event': [id: string]; 'open-note': [id: string] }>()
type Kind = 'clues' | 'people' | 'events' | 'notes'
type SearchEntry = { id: string; kind: Kind; title: string; detail: string; fields: string[]; quoteText?: string }
type SearchResult = SearchEntry & { excerpt: string; quote?: string; score: number }
const tabs = [{ id: 'all', label: '全部' }, { id: 'clues', label: '线索' }, { id: 'people', label: '人物' }, { id: 'events', label: '时间' }, { id: 'notes', label: '笔记' }] as const
const kindLabels: Record<Kind, string> = { clues: '线索', people: '人物', events: '时间', notes: '笔记' }
const query = ref(''), activeTab = ref<'all' | Kind>('all'), limit = ref(40), history = ref<string[]>([]), historyMessage = ref('')
const searchInput = ref<HTMLInputElement | null>(null), dialog = ref<HTMLElement | null>(null)
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
const terms = computed(() => [...new Set(normalize(query.value).split(/\s+/).filter(Boolean))])
const currentPeople = computed(() => props.people.filter(person => person.scriptId === props.scriptId))
const peopleById = computed(() => new Map(currentPeople.value.map(person => [person.id, person])))
const currentClues = computed(() => props.clues.filter(clue => clue.scriptId === props.scriptId))
const cluesById = computed(() => new Map(currentClues.value.map(clue => [clue.id, clue])))
function eventTime(event: TimelineRecord): string {
  const match = event.startsAt.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!match) return event.startsAt
  const [, year, month, day, hour, minute] = match
  let value = `${year ? `${year}年` : ''}${Number(month)}月${Number(day)}日`
  if (hour !== undefined && event.precision !== 'date') value += event.precision === 'hour' ? ` ${hour}时` : ` ${hour}:${minute}`
  return `${event.approximate ? '约 ' : ''}${value}${!year && !event.yearlessMarkerIgnored ? ' · 无年份' : ''}`
}
const entries = computed<SearchEntry[]>(() => {
  if (!props.scriptId) return []
  return [
    ...currentClues.value.map(clue => ({ id: clue.id, kind: 'clues' as const, title: clue.title || `线索 #${String(clue.number).padStart(3, '0')}`, detail: `线索 #${String(clue.number).padStart(3, '0')} · 第 ${clue.round} 轮${clue.category ? ` · ${clue.category}` : ''}`, fields: [clue.title, clue.ocrText, clue.notes, ...clue.tags, ...currentPeople.value.filter(person => (person.ocrNames || []).some(name => clue.ocrText.includes(name))).flatMap(person => [person.name, ...person.aliases]), `#${String(clue.number).padStart(3, '0')}`, String(clue.number)], quoteText: clue.ocrText })),
    ...currentPeople.value.map(person => ({ id: person.id, kind: 'people' as const, title: person.name, detail: person.aliases.length ? `别名：${person.aliases.join('、')}` : '人物档案', fields: [person.name, ...person.aliases, ...(person.ocrNames || []), person.notes] })),
    ...props.events.filter(event => event.scriptId === props.scriptId && event.confirmed).map(event => {
      const names = event.personIds.map(id => peopleById.value.get(id)).filter((person): person is PersonRecord => Boolean(person)).flatMap(person => [person.name, ...person.aliases, ...(person.ocrNames || [])])
      const time = eventTime(event)
      return { id: event.id, kind: 'events' as const, title: event.title || '未命名事件', detail: time, fields: [event.title, time, event.startsAt, ...names] }
    }),
    ...props.notes.filter(note => note.scriptId === props.scriptId).map(note => {
      const person = peopleById.value.get(note.personId), clue = cluesById.value.get(note.clueId)
      return { id: note.id, kind: 'notes' as const, title: note.text.split('\n').find(line => line.trim())?.slice(0, 52) || '未命名笔记', detail: [person?.name, clue ? `线索 #${String(clue.number).padStart(3, '0')}` : ''].filter(Boolean).join(' · ') || '文字笔记', fields: [note.text, person?.name || '', ...(person?.aliases || []), ...(person?.ocrNames || []), clue?.title || ''] }
    }),
  ]
})
// Keep the original excerpt for source navigation even when full-width characters match a keyword.
function excerpt(value: string): { text: string; quote: string } {
  if (!value) return { text: '', quote: '' }
  const offsets: number[] = [], chars: string[] = []
  let position = 0
  for (const character of value) {
    const folded = character.normalize('NFKC').toLocaleLowerCase()
    for (let index = 0; index < folded.length; index++) { offsets.push(position); chars.push(folded[index]!) }
    position += character.length
  }
  const folded = chars.join(''), matches = terms.value.map(term => folded.indexOf(term)).filter(index => index >= 0)
  const first = matches.length ? offsets[Math.min(...matches)] || 0 : 0
  const start = Math.max(0, first - 28), end = Math.min(value.length, Math.max(start + 145, first + 90))
  const quote = value.slice(start, end).trim()
  return { text: `${start ? '…' : ''}${quote}${end < value.length ? '…' : ''}`, quote }
}
const results = computed<SearchResult[]>(() => {
  if (!terms.value.length) return []
  return entries.value.flatMap(entry => {
    const foldedFields = entry.fields.map(normalize), searchable = foldedFields.join('\n')
    if (!terms.value.every(term => searchable.includes(term))) return []
    let bestIndex = 0, bestHits = -1
    foldedFields.forEach((field, index) => { const hits = terms.value.filter(term => field.includes(term)).length; if (hits > bestHits) { bestHits = hits; bestIndex = index } })
    const content = entry.fields[bestIndex] || entry.title
    const snippet = excerpt(content)
    const sourceSnippet = entry.kind === 'clues' && entry.quoteText && terms.value.some(term => normalize(entry.quoteText!).includes(term)) ? excerpt(entry.quoteText) : null
    const title = normalize(entry.title)
    return [{ ...entry, excerpt: snippet.text, quote: sourceSnippet?.quote, score: terms.value.reduce((score, term) => score + (title === term ? 6 : title.includes(term) ? 3 : 0), 0) }]
  }).sort((left, right) => right.score - left.score)
})
const counts = computed(() => ({ all: results.value.length, clues: results.value.filter(item => item.kind === 'clues').length, people: results.value.filter(item => item.kind === 'people').length, events: results.value.filter(item => item.kind === 'events').length, notes: results.value.filter(item => item.kind === 'notes').length }))
const filteredResults = computed(() => activeTab.value === 'all' ? results.value : results.value.filter(result => result.kind === activeTab.value))
const visibleResults = computed(() => filteredResults.value.slice(0, limit.value))
function highlighted(value: string): { text: string; marked: boolean }[] {
  const text = value.normalize('NFKC'), folded = text.toLocaleLowerCase(), ranges: { start: number; end: number }[] = []
  for (const term of terms.value) {
    let start = folded.indexOf(term)
    while (start >= 0) { ranges.push({ start, end: start + term.length }); start = folded.indexOf(term, start + term.length) }
  }
  ranges.sort((a, b) => a.start - b.start)
  const merged: typeof ranges = []
  for (const range of ranges) { const last = merged[merged.length - 1]; if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else merged.push({ ...range }) }
  const parts: { text: string; marked: boolean }[] = []
  let offset = 0
  for (const range of merged) { if (range.start > offset) parts.push({ text: text.slice(offset, range.start), marked: false }); parts.push({ text: text.slice(range.start, range.end), marked: true }); offset = range.end }
  if (offset < text.length) parts.push({ text: text.slice(offset), marked: false })
  return parts
}
let historyVersion = 0, historyQueue: Promise<void> = Promise.resolve(), previousFocus: HTMLElement | null = null
function persistHistory(values: string[]) {
  const scriptId = props.scriptId
  historyVersion++
  history.value = values
  historyMessage.value = ''
  historyQueue = historyQueue.catch(() => {}).then(() => saveLocalState(scriptId, 'workspace-search-history', values)).catch(() => { if (props.scriptId === scriptId) historyMessage.value = '本次搜索记录未保存，不影响查找资料。' })
}
function selectResult(result: SearchResult) {
  if (!entries.value.some(entry => entry.kind === result.kind && entry.id === result.id)) return
  const value = query.value.trim().slice(0, 160)
  if (value) persistHistory([value, ...history.value.filter(item => normalize(item) !== normalize(value))].slice(0, 5))
  if (result.kind === 'clues') emit('open-clue', result.id, result.quote)
  else if (result.kind === 'people') emit('open-person', result.id)
  else if (result.kind === 'events') emit('open-event', result.id)
  else emit('open-note', result.id)
}
function useHistory(value: string) { query.value = value; nextTick(() => searchInput.value?.focus()) }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')).filter(element => element.getClientRects().length > 0)
  const first = focusable[0], last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch([query, activeTab], () => { limit.value = 40 })
watch(() => props.scriptId, async scriptId => {
  const version = ++historyVersion
  query.value = ''; activeTab.value = 'all'; history.value = []; historyMessage.value = ''
  if (!scriptId) return
  try {
    const saved = await getLocalState<unknown>(scriptId, 'workspace-search-history')
    if (version !== historyVersion || props.scriptId !== scriptId) return
    history.value = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.slice(0, 160)).slice(0, 5) : []
  } catch { /* Search remains available if recent history cannot be read. */ }
}, { immediate: true })
onMounted(async () => { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; document.addEventListener('keydown', onKeydown, true); await nextTick(); searchInput.value?.focus() })
onBeforeUnmount(() => { historyVersion++; document.removeEventListener('keydown', onKeydown, true); if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="workspace-search-backdrop" @click.self="emit('close')">
      <section ref="dialog" class="workspace-search-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-search-title">
        <header class="workspace-search-header">
          <div><span class="workspace-search-eyebrow">{{ scriptName }}</span><h2 id="workspace-search-title">查找资料</h2></div>
          <button class="search-close" aria-label="关闭查找" @click="emit('close')">×</button>
        </header>
        <div class="workspace-search-input-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <input ref="searchInput" v-model="query" type="search" placeholder="搜索人物、时间、线索原文或笔记" aria-label="搜索当前剧本资料" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <button v-if="query" class="clear-query" @click="query = ''; searchInput?.focus()">清空</button>
        </div>
        <div v-if="terms.length" class="workspace-search-tabs" role="tablist" aria-label="资料类型">
          <button v-for="tab in tabs" :key="tab.id" role="tab" :aria-selected="activeTab === tab.id" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">{{ tab.label }}<span>{{ counts[tab.id] }}</span></button>
        </div>
        <div class="workspace-search-body">
          <template v-if="!terms.length">
            
            <section v-if="history.length" class="search-history"><div><h3>最近搜索</h3><button @click="persistHistory([])">清除记录</button></div><div class="search-history-chips"><button v-for="value in history" :key="value" @click="useHistory(value)">{{ value }}</button></div></section>
          </template>
          <template v-else-if="visibleResults.length">
            <p class="search-result-summary" role="status">找到 {{ filteredResults.length }} 条{{ activeTab === 'all' ? '资料' : kindLabels[activeTab] }}</p>
            <div class="search-results"><button v-for="result in visibleResults" :key="`${result.kind}:${result.id}`" class="search-result" @click="selectResult(result)"><span class="result-type" :class="`type-${result.kind}`">{{ kindLabels[result.kind] }}</span><span class="result-content"><strong><template v-for="(part, index) in highlighted(result.title)" :key="index"><mark v-if="part.marked">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></strong><span class="result-detail"><template v-for="(part, index) in highlighted(result.detail)" :key="index"><mark v-if="part.marked">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span><span v-if="result.excerpt && result.excerpt !== result.title" class="result-excerpt"><template v-for="(part, index) in highlighted(result.excerpt)" :key="index"><mark v-if="part.marked">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span></span><span class="result-chevron" aria-hidden="true">›</span></button></div>
            <button v-if="filteredResults.length > limit" class="search-show-more" @click="limit += 40">再显示 {{ Math.min(40, filteredResults.length - limit) }} 条 · 还有 {{ filteredResults.length - limit }} 条</button>
          </template>
          <div v-else class="search-empty" role="status"><strong>{{ results.length ? '这个分类里没有匹配资料' : '没有找到匹配资料' }}</strong><p>{{ results.length ? '其他分类中还有结果，可以切换查看。' : '试试姓名、物品或更短的原文关键词；多个词需要同时匹配。' }}</p><button v-if="activeTab !== 'all'" @click="activeTab = 'all'">查看全部分类</button><button v-else @click="query = ''; searchInput?.focus()">重新查找</button></div>
          <p v-if="historyMessage" class="search-history-message" role="status">{{ historyMessage }}</p>
        </div>
        <footer class="workspace-search-footer"><span>资料只在本机查找 · 不会发送给 AI</span></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.workspace-search-backdrop{position:fixed;inset:0;z-index:1250;background: color-mix(in srgb, var(--cv-ink) 34%, transparent);display:flex;align-items:flex-start;justify-content:center;padding:max(36px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));box-sizing:border-box}.workspace-search-dialog{display:flex;flex-direction:column;width:min(760px,100%);max-height:calc(100dvh - max(36px,env(safe-area-inset-top)) - max(20px,env(safe-area-inset-bottom)));min-height:0;background:var(--cv-surface);border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);box-shadow: var(--cv-shadow-raised);overflow:hidden;color:var(--cv-ink)}.workspace-search-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 25px 17px}.workspace-search-eyebrow{display:block;color:var(--cv-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.workspace-search-header h2{font-size:22px;margin:3px 0 0;font-weight:650;letter-spacing:.02em}.workspace-search-dialog button{font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}.search-close{flex-shrink:0;display:grid;place-items:center;width:44px;height:44px;background:var(--cv-surface-subtle);border:0;border-radius: var(--cv-radius-control);color:var(--cv-secondary);font-size:29px!important;line-height:1}.workspace-search-input-wrap{display:flex;gap:12px;align-items:center;margin:0 25px 18px;padding:0 15px;min-height:54px;border:1.5px solid var(--cv-border-strong);background:var(--cv-surface);border-radius: var(--cv-radius-control);box-shadow:0 0 0 3px var(--cv-accent-soft)}.workspace-search-input-wrap svg{width:21px;height:21px;fill:none;stroke:var(--cv-muted);stroke-width:1.7;flex-shrink:0}.workspace-search-input-wrap input{flex:1;width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--cv-ink);font:inherit;font-size:16px;min-height:52px;user-select:text;-webkit-user-select:text}.workspace-search-input-wrap input::placeholder{color:var(--cv-muted);font-size:14px}.workspace-search-input-wrap input::-webkit-search-cancel-button{display:none}.clear-query{flex-shrink:0;background:transparent;border:0;color:var(--cv-secondary);font-size:12px!important;min-height:44px;padding:0 2px}.workspace-search-tabs{display:flex;gap:4px;padding:0 25px 12px;border-bottom:1px solid var(--cv-border);overflow-x:auto;flex-shrink:0}.workspace-search-tabs button{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--cv-muted);border-radius: var(--cv-radius-control);padding:11px 13px;font-size:13px;white-space:nowrap}.workspace-search-tabs button span{font-size: var(--cv-type-meta);color:var(--cv-muted)}.workspace-search-tabs button.active{background:var(--cv-accent-soft);color:var(--cv-accent);font-weight:650}.workspace-search-tabs button.active span{color:var(--cv-accent)}.workspace-search-body{overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 25px;min-height:0;flex:1}.search-empty p{font-size:13px;line-height:1.9;color:var(--cv-muted);margin:0}.search-history{padding:0 0 24px}.search-history>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}.search-history h3{font-size:12px;color:var(--cv-muted);font-weight:500}.search-history>div>button{border:0;background:transparent;color:var(--cv-muted);font-size:12px;min-height:44px}.search-history-chips{display:flex;gap:8px;flex-wrap:wrap}.search-history-chips button{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--cv-border)!important;background:var(--cv-surface-subtle)!important;border-radius: var(--cv-radius-control);padding:10px 13px!important;min-height: var(--cv-control)!important;color:var(--cv-secondary)!important}.search-result-summary{display:flex;justify-content:space-between;gap:12px;margin:16px 0 8px;color:var(--cv-secondary);font-size:12px}.search-results{display:flex;flex-direction:column}.search-result{display:flex;align-items:flex-start;gap:12px;text-align:left;width:100%;border:0;border-bottom:1px solid var(--cv-border);background:transparent;padding:18px 0;min-height:80px}.search-result:active,.search-result:hover{background:var(--cv-accent-soft)}.result-type{flex-shrink:0;padding:5px 8px;border-radius:6px;background:var(--cv-accent-soft);color:var(--cv-muted);font-size: var(--cv-type-meta);line-height:1.5}.result-type.type-events{background:var(--cv-warning-soft);color:var(--cv-warning)}.result-type.type-people{background:var(--cv-accent-soft);color:var(--cv-secondary)}.result-type.type-notes{background:var(--cv-surface-subtle);color:var(--cv-secondary)}.result-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}.result-content strong{font-size:14px;line-height:1.7;color:var(--cv-ink);overflow-wrap:anywhere;font-weight:650}.result-detail{font-size: var(--cv-type-meta);color:var(--cv-muted);line-height:1.6;overflow-wrap:anywhere}.result-excerpt{font-size:12px;line-height:1.9;color:var(--cv-secondary);overflow-wrap:anywhere;white-space:pre-line}.result-content mark{background:var(--cv-warning-soft);color:var(--cv-warning);border-radius:3px;padding:0 1px}.result-chevron{align-self:center;color:var(--cv-muted);font-size:23px;padding:0 1px 0 5px}.search-show-more{display:block;min-height:44px;width:100%;background:var(--cv-accent-soft);border:1px solid var(--cv-border);border-radius: var(--cv-radius-control);color:var(--cv-accent);font-size:12px!important;margin:16px 0 20px}.search-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:48px 16px}.search-empty strong{color:var(--cv-secondary);font-size:15px}.search-empty button{padding:11px 17px;border-radius: var(--cv-radius-control);border:1px solid var(--cv-border);background:var(--cv-accent-soft);color:var(--cv-accent);font-size:12px}.workspace-search-footer{display:flex;justify-content:space-between;gap:10px;padding:14px 25px;font-size: var(--cv-type-meta);color:var(--cv-muted);background:var(--cv-surface-subtle);border-top:1px solid var(--cv-border);flex-shrink:0}.search-history-message{font-size: var(--cv-type-meta);color:var(--cv-warning);line-height:1.7;padding:10px 0}.workspace-search-dialog button:focus-visible{outline:2px solid var(--cv-accent);outline-offset:3px}@media(max-width:600px){.workspace-search-backdrop{padding:max(12px,env(safe-area-inset-top)) 10px max(12px,env(safe-area-inset-bottom))}.workspace-search-dialog{max-height:calc(100dvh - max(12px,env(safe-area-inset-top)) - max(12px,env(safe-area-inset-bottom)));border-radius: var(--cv-radius-panel)}.workspace-search-header{padding:20px 17px 16px}.workspace-search-input-wrap{margin:0 17px 17px;gap:9px;padding:0 11px}.workspace-search-input-wrap input::placeholder{font-size:12px}.workspace-search-tabs{padding-left:13px;padding-right:13px;gap:0}.workspace-search-tabs button{gap:6px;padding:10px 12px}.workspace-search-body{padding:0 17px}.workspace-search-footer{padding:12px 17px}.workspace-search-footer>span:last-child{display:none}.search-result{gap:9px}}

.workspace-search-dialog { font-family: var(--cv-font); }
.workspace-search-dialog *, .workspace-search-dialog *::before, .workspace-search-dialog *::after { box-sizing: border-box; }
.workspace-search-header > div, .search-history > div:first-child h3 { min-width: 0; overflow-wrap: anywhere; }
.workspace-search-tabs button { min-height: var(--cv-control); }
.workspace-search-tabs button span, .result-type, .result-detail, .workspace-search-footer { font-size: var(--cv-type-meta); }
.result-content strong { font-size: var(--cv-type-title); }
.result-excerpt { font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); }
.search-history-chips button { white-space: normal; overflow-wrap: anywhere; }
.search-history-message, .search-history h3 { color: var(--cv-muted); }
.workspace-search-footer { flex-wrap: wrap; line-height: var(--cv-leading-ui); }
.workspace-search-dialog button { min-height: var(--cv-control); transition: background-color var(--cv-motion-press) var(--cv-ease); touch-action: manipulation; }
.workspace-search-dialog button:not(:disabled):active { background: var(--cv-accent-soft); color: var(--cv-accent-strong); }
.workspace-search-dialog button:focus-visible, .workspace-search-input-wrap:focus-within { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .workspace-search-dialog, .workspace-search-dialog * { animation: none !important; transition: none !important; } }

</style>
