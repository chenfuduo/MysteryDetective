import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { reactive } from 'vue'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { ClueRecord, OrganizationSnapshot, TimelineRecord } from './vault'
import { resolveAiProvider, providerLabel, type AiProvider } from './aiProvider'
import { chooseOrganizationModel, type OrganizationModelInput } from './openaiModelRouting'

type RawPerson = { name?: unknown; aliases?: unknown; source?: unknown; quote?: unknown }
type RawRelationship = { from?: unknown; to?: unknown; label?: unknown; source?: unknown; quote?: unknown }
type RawTimeline = { title?: unknown; startsAt?: unknown; timeOfDay?: unknown; people?: unknown; source?: unknown; quote?: unknown; approximate?: unknown }
type RawCluePoint = { source?: unknown; title?: unknown; category?: unknown; tags?: unknown; quote?: unknown }
type RawResult = { people?: unknown; relationships?: unknown; timeline?: unknown; cluePoints?: unknown }

const keyNames: Record<AiProvider, string> = { deepseek: 'deepseek_api_key', openai: 'openai_api_key' }

export async function hasApiKey(provider: AiProvider = 'deepseek'): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    if (!import.meta.env.DEV || provider !== 'openai') return false
    try {
      const response = await fetch('/__local-ai/openai/key-status')
      return response.ok && (await response.json()).configured === true
    } catch { return false }
  }
  await SecureStorage.setSynchronize(false)
  return Boolean((await SecureStorage.getItem(keyNames[provider]))?.trim())
}

export async function saveApiKey(value: string, provider: AiProvider = 'deepseek'): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error('请在 iPad App 中配置 API Key')
  const key = value.trim()
  if (!key) throw new Error(`请粘贴 ${providerLabel(provider)} API Key`)
  await SecureStorage.setSynchronize(false)
  await SecureStorage.setItem(keyNames[provider], key)
}

export async function removeApiKey(provider: AiProvider = 'deepseek'): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  await SecureStorage.setSynchronize(false)
  await SecureStorage.removeItem(keyNames[provider])
}

async function readApiKey(provider: AiProvider): Promise<string> {
  if (!Capacitor.isNativePlatform() && import.meta.env.DEV && provider === 'openai') return ''
  if (!Capacitor.isNativePlatform()) throw new Error('请在 iPad App 中配置 API Key')
  await SecureStorage.setSynchronize(false)
  const key = await SecureStorage.getItem(keyNames[provider])
  if (!key?.trim()) throw new Error(`请先在「档案管理」中保存 ${providerLabel(provider)} API Key`)
  return key.trim()
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []
}
function text(value: unknown, max = 180): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) ? parsed : 0
}
function sourceQuote(sourceNo: number, quote: unknown, clues: ClueRecord[]): { clue: ClueRecord; quote: string } | null {
  const clue = clues.find(item => item.number === sourceNo)
  const excerpt = text(quote, 600)
  if (!clue || !excerpt || !clue.ocrText.includes(excerpt)) return null
  return { clue, quote: excerpt }
}
type RunPhase = 'idle' | 'extracting' | 'checking' | 'complete' | 'error' | 'local' | 'paused'
export const organizationRun = reactive({ phase: 'idle' as RunPhase, provider: null as AiProvider | 'local' | null, message: '', lastError: '', model: '', modelReason: '', models: [] as string[] })
type DateToken = { index: number; end: number; year: string; month: number; day: number; value: string }
type ClockToken = { index: number; end: number; hour: number; minute: number | null; approximate: boolean; value: string }
type CheckedTime = { startsAt: string; precision: 'date' | 'hour' | 'minute'; approximate: boolean }
type PeriodToken = { index: number; end: number; value: string }
type NormalizedResult = { snapshot: OrganizationSnapshot; rejected: Map<number, number> }
export type OrganizationStage = 'extracting' | 'checking' | 'complete' | 'failed' | 'paused'
export type OrganizationCheckpoint = {
  version: 1
  fingerprint: string
  clueIds: string[]
  provider: AiProvider
  stage: 'checking' | 'complete'
  snapshot: OrganizationSnapshot
  rejected: [number, number][]
  updatedAt: string
}
export type OrganizationContext = {
  fingerprint?: string
  checkpoint?: OrganizationCheckpoint | null
  shouldPause?: () => boolean
  onCheckpoint?: (checkpoint: OrganizationCheckpoint) => void | Promise<void>
  onStage?: (stage: OrganizationStage, message?: string) => void | Promise<void>
}


export class OrganizationPausedError extends Error {
  constructor(readonly snapshot?: OrganizationSnapshot) {
    super(snapshot ? '已暂停，首轮结果已保存；继续时仅补做时间核对' : '已暂停，继续时从当前线索开始')
    this.name = 'OrganizationPausedError'
  }
}

function scanDates(value: string): DateToken[] {
  // Full-width OCR digits retain their original character offsets for source quotes.
  const numericText = value.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10))
  const pattern = /(?:(\d{4})\s*年\s*)?(\d(?:\s*\d)?)\s*月\s*(\d(?:\s*\d)?)\s*日|(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<![\d-])(\d{1,2})[/.](\d{1,2})(?!\d)/g
  const dates: DateToken[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(numericText)) !== null) {
    const year = match[1] || match[4] || ''
    const month = Number((match[2] || match[5] || match[7]).replace(/\s/g, ''))
    const day = Number((match[3] || match[6] || match[8]).replace(/\s/g, ''))
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year ? Number(year) : 2000, month, 0)).getUTCDate()) continue
    dates.push({ index: match.index, end: pattern.lastIndex, year, month, day, value: `${year ? `${year}-` : '--'}${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` })
  }
  return dates
}
function clockNumber(value: string): number {
  value = value.replace(/\s/g, '')
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value.includes('十')) {
    const [tens, units] = value.split('十')
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0)
  }
  return value.length > 1 ? Number([...value].map(char => digits[char]).join('')) : digits[value]
}
function scanClocks(value: string): ClockToken[] {
  const numericText = value.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).replace(/[﹕∶]/g, ':')
  const pattern = /(?:(凌晨|清晨|早晨|早上|上午|中午|下午|午后|傍晚|晚上|晚间|夜里|夜间|深夜|半夜|晚)\s*)?(?<!\d)(\d(?:\s*\d)?|[零〇一二两三四五六七八九十](?:\s*[零〇一二两三四五六七八九十]){0,2})\s*(点(?:钟)?|时|[:：])(?:\s*(半|一刻|三刻)|\s*(\d(?:\s*\d)?|[零〇一二两三四五六七八九十](?:\s*[零〇一二两三四五六七八九十]){0,2})\s*分?)?(?!\d)/g
  const clocks: ClockToken[] = []
  let previousPeriod = '', previousEnd = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(numericText)) !== null) {
    let hour = clockNumber(match[2])
    const minute = match[4] ? ({ 半: 30, 一刻: 15, 三刻: 45 }[match[4]] ?? null) : match[5] !== undefined ? clockNumber(match[5]) : null
    if (!Number.isFinite(hour) || hour > 23 || (minute !== null && (!Number.isFinite(minute) || minute > 59)) || (minute === null && /[:：]/.test(match[3]))) continue
    const between = value.slice(previousEnd, match.index)
    const inheritedPeriod = previousPeriod && !/[。；;!?！？]/.test(between) && !scanDates(between).length ? previousPeriod : ''
    const hint = between.match(/(凌晨|清晨|早晨|早上|上午|中午|下午|午后|傍晚|晚上|晚间|夜里|夜间|深夜|半夜|晚)[^。；;!?！？]{0,24}$/)?.[1] || ''
    const period = match[1] || hint || inheritedPeriod
    previousPeriod = period; previousEnd = pattern.lastIndex
    if (['下午', '午后', '傍晚', '晚上', '晚间', '夜里', '夜间', '深夜', '晚'].includes(period) && hour > 0 && hour < 12) hour += 12
    if (period === '中午' && hour > 0 && hour < 11) hour += 12
    if (['凌晨', '清晨', '早晨', '早上', '半夜'].includes(period) && hour === 12) hour = 0
    const surrounding = value.slice(Math.max(0, match.index - 3), Math.min(value.length, pattern.lastIndex + 5))
    clocks.push({ index: match.index, end: pattern.lastIndex, hour, minute, approximate: /约|左右|大概|大约|前后|许/.test(surrounding), value: `T${String(hour).padStart(2, '0')}${minute === null ? '' : `:${String(minute).padStart(2, '0')}`}` })
  }
  return clocks
}
function dateForClock(dates: DateToken[], clock: ClockToken): DateToken | undefined {
  const previous = [...dates].reverse().find(date => date.end <= clock.index)
  if (previous) return previous
  return dates.find(date => date.index >= clock.end && date.index - clock.end <= 120)
}
const timeOfDayTerms = ['凌晨', '清晨', '早晨', '早上', '上午', '中午', '下午', '午后', '傍晚', '晚上', '晚间', '夜里', '夜间', '深夜', '半夜']
function scanPeriods(value: string): PeriodToken[] {
  const pattern = new RegExp(timeOfDayTerms.slice(0, -1).join('|') + '|晚', 'g')
  const clocks = scanClocks(value)
  return [...value.matchAll(pattern)].flatMap(match => {
    const index = match.index ?? 0, end = index + match[0].length
    return clocks.some(clock => index < clock.end && end > clock.index) ? [] : [{ index, end, value: match[0] }]
  })
}
function dateForAnchor(dates: DateToken[], anchor: Pick<PeriodToken, 'index' | 'end'>): DateToken | undefined {
  const previous = [...dates].reverse().find(date => date.end <= anchor.index)
  if (previous) return previous
  return dates.find(date => date.index >= anchor.end && date.index - anchor.end <= 120)
}
function quoteOffsets(source: string, quote: string): number[] {
  const positions: number[] = []
  let offset = source.indexOf(quote)
  while (offset >= 0) { positions.push(offset); offset = source.indexOf(quote, offset + 1) }
  return positions
}
function validDate(value: unknown, quote: string, clueText: string, preservePeriodOnly = false): CheckedTime | null {
  const candidate = text(value, 40).replace(' ', 'T')
  const match = candidate.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (!quote || !match) return null
  const [, year, month, day, hour, minute] = match
  const dates = scanDates(clueText)
  const quotePositions = quoteOffsets(clueText, quote)
  const inQuote = (index: number, end: number) => quotePositions.some(position => index >= position && end <= position + quote.length)
  const matchingDate = (date: DateToken) => date.month === Number(month) && date.day === Number(day) && (!year || date.year === year)
  const clocks = scanClocks(clueText).filter(clock => inQuote(clock.index, clock.end)).map(clock => ({ clock, date: dateForClock(dates, clock) })).filter((item): item is { clock: ClockToken; date: DateToken } => Boolean(item.date && matchingDate(item.date)))
  if (hour !== undefined) {
    if (Number(hour) > 23 || (minute !== undefined && Number(minute) > 59)) return null
    const exact = clocks.filter(({ clock }) => clock.hour === Number(hour) && (minute === undefined || clock.minute === Number(minute)))
    if (!exact.length) return null
    const { clock, date } = exact[0]
    return { startsAt: `${date.value}${clock.value}`, precision: clock.minute === null ? 'hour' : 'minute', approximate: clock.approximate }
  }
  const dateOnly = dates.find(item => matchingDate(item) && inQuote(item.index, item.end))
    || quotePositions.map(position => [...dates].reverse().find(item => item.end <= position)).find((item): item is DateToken => Boolean(item && matchingDate(item)))
  if (preservePeriodOnly) return dateOnly ? { startsAt: dateOnly.value, precision: 'date', approximate: /(?:约|大约|前后|左右)/.test(quote) } : null
  // A date-only API candidate with one explicit clock in its own quote retains that clock.
  const clockValues = new Set(clocks.map(({ clock, date }) => `${date.value}${clock.value}`))
  if (clockValues.size === 1) {
    const { clock, date } = clocks[0]
    return { startsAt: `${date.value}${clock.value}`, precision: clock.minute === null ? 'hour' : 'minute', approximate: clock.approximate }
  }
  if (clockValues.size > 1) return null
  return dateOnly ? { startsAt: dateOnly.value, precision: 'date', approximate: /(?:约|大约|前后|左右)/.test(quote) } : null
}
function normalize(raw: RawResult, clues: ClueRecord[]): NormalizedResult {
  const people: OrganizationSnapshot['people'] = []
  const knownNames = new Set<string>()
  for (const item of asArray(raw.people) as RawPerson[]) {
    const source = sourceQuote(number(item.source), item.quote, clues)
    const name = text(item.name, 60)
    if (!source || !name || !source.clue.ocrText.includes(name) || knownNames.has(name)) continue
    knownNames.add(name)
    const aliases = Array.isArray(item.aliases) ? item.aliases.map(value => text(value, 60)).filter(value => value && source.clue.ocrText.includes(value)).slice(0, 5) : []
    people.push({ id: crypto.randomUUID(), name, aliases, sourceNo: source.clue.number, quote: source.quote })
  }
  const relationships: OrganizationSnapshot['relationships'] = []
  for (const item of asArray(raw.relationships) as RawRelationship[]) {
    const source = sourceQuote(number(item.source), item.quote, clues)
    const from = text(item.from, 60), to = text(item.to, 60), label = text(item.label, 80)
    if (!source || !from || !to || from === to || !label || !source.quote.includes(from) || !source.quote.includes(to) || !source.quote.includes(label)) continue
    relationships.push({ id: crypto.randomUUID(), from, to, label, sourceNo: source.clue.number, quote: source.quote })
  }
  const timeline: OrganizationSnapshot['timeline'] = []
  const rejected = new Map<number, number>()
  for (const item of asArray(raw.timeline) as RawTimeline[]) {
    const sourceNo = number(item.source)
    const source = sourceQuote(sourceNo, item.quote, clues)
    const title = text(item.title, 100)
    const periodText = text(item.timeOfDay, 12)
    const periodTokens = source ? scanPeriods(source.quote) : []
    const hasPeriodOnly = Boolean(periodText && periodTokens.some(period => period.value === periodText)) || Boolean(source && !/T\d{2}/.test(text(item.startsAt, 40)) && periodTokens.length)
    const checked = validDate(item.startsAt, source?.quote || '', source?.clue.ocrText || '', hasPeriodOnly)
    if (!source || !title || !checked) { rejected.set(sourceNo, (rejected.get(sourceNo) || 0) + 1); continue }
    const names = Array.isArray(item.people) ? item.people.map(value => text(value, 60)).filter(value => value && source.quote.includes(value)).slice(0, 8) : []
    const timeOfDay = checked.precision === 'date' ? (periodTokens.find(period => period.value === periodText)?.value || (periodTokens.length === 1 ? periodTokens[0]!.value : undefined)) : undefined
    timeline.push({ id: crypto.randomUUID(), title, ...checked, ...(timeOfDay ? { timeOfDay } : {}), approximate: checked.approximate || (item.approximate === true && /约|左右|大概|大约|前后|许/.test(source.quote)), people: names, sourceNo: source.clue.number, quote: source.quote, evidence: [{ clueId: source.clue.id, sourceNo: source.clue.number, quote: source.quote }] })
  }
  const cluePoints: OrganizationSnapshot['cluePoints'] = []
  for (const item of asArray(raw.cluePoints) as RawCluePoint[]) {
    const source = sourceQuote(number(item.source), item.quote, clues)
    const title = text(item.title, 100)
    if (!source || !title) continue
    const tags = Array.isArray(item.tags) ? item.tags.map(value => text(value, 24)).filter(Boolean).slice(0, 6) : []
    cluePoints.push({ id: crypto.randomUUID(), title, category: text(item.category, 32), tags, sourceNo: source.clue.number, quote: source.quote })
  }
  return { snapshot: { id: '', scriptId: '', updatedAt: new Date().toISOString(), people, relationships, timeline, cluePoints }, rejected }
}
function mergeTimeline(first: OrganizationSnapshot['timeline'], next: OrganizationSnapshot['timeline']): OrganizationSnapshot['timeline'] {
  const merged = [...first]
  for (const item of next) {
    const existingIndex = merged.findIndex(previous => previous.sourceNo === item.sourceNo && previous.timeOfDay === item.timeOfDay && previous.startsAt.slice(0, 7) === item.startsAt.slice(0, 7) && (previous.title === item.title || previous.quote.includes(item.quote) || item.quote.includes(previous.quote)) && (previous.startsAt === item.startsAt || (previous.startsAt.split('T')[0] === item.startsAt.split('T')[0] && (!previous.startsAt.includes('T') || !item.startsAt.includes('T')))))
    if (existingIndex < 0) { merged.push(item); continue }
    const previous = merged[existingIndex]
    const addsContinuousContext = item.quote.length > previous.quote.length && item.quote.includes(previous.quote)
    if (item.startsAt.length > previous.startsAt.length || (previous.requiresTitle && !item.requiresTitle) || addsContinuousContext) merged[existingIndex] = item
  }
  return merged
}
function auditTimeline(clues: ClueRecord[], timeline: OrganizationSnapshot['timeline'], rejected: Map<number, number>, reviewed: boolean, reviewError = ''): NonNullable<OrganizationSnapshot['timelineAudit']> {
  return clues.map(clue => {
    const dates = scanDates(clue.ocrText), clocks = scanClocks(clue.ocrText), periods = scanPeriods(clue.ocrText)
    const covered = clocks.filter(clock => {
      const date = dateForClock(dates, clock)
      if (!date) return false
      return timeline.some(item => item.sourceNo === clue.number && item.startsAt === `${date.value}${clock.value}` && quoteOffsets(clue.ocrText, item.quote).some(offset => clock.index >= offset && clock.end <= offset + item.quote.length))
    }).length
    const periodCovered = periods.filter(period => {
      const date = dateForAnchor(dates, period)
      if (!date) return false
      return timeline.some(item => item.sourceNo === clue.number && item.startsAt === date.value && item.timeOfDay === period.value && quoteOffsets(clue.ocrText, item.quote).some(offset => period.index >= offset && period.end <= offset + item.quote.length))
    }).length
    const invalid = rejected.get(clue.number) || 0
    const unknownSource = [...rejected.keys()].some(source => !clues.some(item => item.number === source))
    const messages: string[] = []
    if (covered < clocks.length) messages.push(`${clocks.length - covered} 处原文时刻尚未对应到有效事件`)
    if (periodCovered < periods.length) messages.push(`${periods.length - periodCovered} 处原文时段尚未对应到有效事件`)
    if (invalid) messages.push(`${invalid} 条时间建议的日期或原文出处未通过校验`)
    if (unknownSource) messages.push('存在无法对应原线索的时间建议')
    if (!reviewed) messages.push(reviewError || '尚未完成 API 完整性核对')
    return { sourceNo: clue.number, clocks: clocks.length, covered, periods: periods.length, periodCovered, status: messages.length ? 'review' as const : 'complete' as const, message: messages.join('；') || (clocks.length || periods.length ? `已核对 ${covered} 处原文时刻和 ${periodCovered} 处原文时段` : '已核对原文，未发现明确时间表达') }
  })
}
export type TimelineExtractionIssue = {
  id: string
  sourceNo: number
  kind: 'missing-time' | 'invalid-result' | 'incomplete'
  title: string
  detail: string
  quote: string
  startsAt?: string
  precision?: 'date' | 'hour' | 'minute'
  approximate?: boolean
  timeOfDay?: string
}

/** Explain review audits without creating events or treating accepted suggestions as missing. */
export function timelineExtractionIssues(clues: ClueRecord[], snapshot: OrganizationSnapshot | null, confirmedEvents: TimelineRecord[] = []): TimelineExtractionIssue[] {
  if (!snapshot) return []
  const issues: TimelineExtractionIssue[] = []
  const nearbyQuote = (source: string, index: number, end: number): string => {
    const before = source.slice(Math.max(0, index - 180), index)
    const separators = [...before.matchAll(/[。！？；;!?]/g)]
    const last = separators.at(-1)
    let start = last ? Math.max(0, index - 180) + last.index! + 1 : Math.max(0, index - 96)
    const tail = source.slice(end, Math.min(source.length, end + 220))
    const boundary = tail.search(/[。！？；;!?]/)
    let finish = boundary >= 0 ? end + boundary + 1 : Math.min(source.length, end + 96)
    let quote = source.slice(start, finish).trim()
    while (quote && quoteOffsets(source, quote).length > 1 && finish - start < 560 && (start > 0 || finish < source.length)) {
      start = Math.max(0, start - 24)
      finish = Math.min(source.length, finish + 24)
      quote = source.slice(start, finish).trim()
    }
    return quote
  }
  for (const audit of snapshot.timelineAudit || []) {
    if (audit.status !== 'review') continue
    const clue = clues.find(clue => clue.number === audit.sourceNo && (!snapshot.scriptId || clue.scriptId === snapshot.scriptId))
    if (!clue) continue
    const dates = scanDates(clue.ocrText)
    const clocks = scanClocks(clue.ocrText)
    const periods = scanPeriods(clue.ocrText)
    const suggestions = snapshot.timeline.filter(item => item.sourceNo === clue.number || item.evidence?.some(source => source.clueId === clue.id && source.sourceNo === clue.number))
    const sourcesFor = (item: OrganizationSnapshot['timeline'][number]): string[] => {
      const quotes = item.evidence?.length
        ? item.evidence.filter(source => source.clueId === clue.id && source.sourceNo === clue.number).map(source => source.quote)
        : item.sourceNo === clue.number ? [item.quote] : []
      return quotes.filter(quote => quote.trim() && quoteOffsets(clue.ocrText, quote).length)
    }
    const idFor = (kind: TimelineExtractionIssue['kind'], anchor: string): string => JSON.stringify([clue.number, kind, anchor])
    for (const clock of clocks) {
      const date = dateForClock(dates, clock)
      const startsAt = date ? `${date.value}${clock.value}` : undefined
      const containsClock = (quote: string): boolean => quoteOffsets(clue.ocrText, quote).some(offset => clock.index >= offset && clock.end <= offset + quote.length)
      const suggestionCovered = startsAt && suggestions.some(item => item.startsAt === startsAt && sourcesFor(item).some(containsClock))
      const eventCovered = startsAt && confirmedEvents.some(event => {
        if (!event.confirmed || event.scriptId !== clue.scriptId || event.startsAt !== startsAt) return false
        const evidence = (event.evidence || []).filter(source => source.clueId === clue.id && source.sourceNo === clue.number)
        const quotes = evidence.map(source => source.quote).filter(quote => quote.trim())
        if (quotes.length) return quotes.some(containsClock)
        return event.clueId === clue.id || evidence.length > 0
      })
      const covered = suggestionCovered || eventCovered
      if (covered) continue
      const clockLabel = clock.value.slice(1)
      const timeLabel = date ? `${date.year ? `${date.year}年` : ''}${date.month}月${date.day}日 ${clockLabel}` : clockLabel
      const dateOnly = date && suggestions.some(item => item.startsAt === date.value && sourcesFor(item).some(quote => quoteOffsets(clue.ocrText, quote).some(offset => clock.index >= offset && clock.end <= offset + quote.length)))
      issues.push({
        id: idFor('missing-time', `${clock.index}:${startsAt || clock.value}`), sourceNo: clue.number, kind: 'missing-time',
        title: `${timeLabel} 时间尚无对应事件`,
        detail: !date ? '原文有这个时刻，但无法定位所属日期。请核对原文后手动填写日期，或重试本条线索；不会代填日期。' : dateOnly ? '原文含具体时刻，当前建议只记录了日期。可按这段原文补充事件，或重试本条线索。' : '原文中这个时刻尚未对应到具有有效出处的时间建议。可查看原文、手动补充事件，或重试本条线索。',
        quote: nearbyQuote(clue.ocrText, clock.index, clock.end), ...(startsAt ? { startsAt } : {}), precision: clock.minute === null ? 'hour' : 'minute', approximate: clock.approximate,
      })
    }
    for (const period of periods) {
      const date = dateForAnchor(dates, period)
      const startsAt = date?.value
      const containsPeriod = (quote: string): boolean => quoteOffsets(clue.ocrText, quote).some(offset => period.index >= offset && period.end <= offset + quote.length)
      const suggestionCovered = Boolean(startsAt && suggestions.some(item => item.startsAt === startsAt && item.timeOfDay === period.value && sourcesFor(item).some(containsPeriod)))
      const eventCovered = Boolean(startsAt && confirmedEvents.some(event => {
        if (!event.confirmed || event.scriptId !== clue.scriptId || event.startsAt !== startsAt || event.timeOfDay !== period.value) return false
        const evidence = (event.evidence || []).filter(source => source.clueId === clue.id && source.sourceNo === clue.number)
        const quotes = evidence.map(source => source.quote).filter(quote => quote.trim())
        if (quotes.length) return quotes.some(containsPeriod)
        return event.clueId === clue.id || evidence.length > 0
      }))
      if (suggestionCovered || eventCovered) continue
      issues.push({
        id: idFor('missing-time', `${period.index}:${startsAt || period.value}`), sourceNo: clue.number, kind: 'missing-time',
        title: `原文时段“${period.value}”尚无对应事件`,
        detail: startsAt ? `原文写明“${period.value}”但没有具体钟点。可按原文时段录入事件，不会换算成具体时分。` : `原文写明“${period.value}”，但附近没有明确日期。请补入你确认的日期，时段会保留为“${period.value}”。`,
        quote: nearbyQuote(clue.ocrText, period.index, period.end), ...(startsAt ? { startsAt } : {}), precision: 'date', timeOfDay: period.value,
      })
    }
    const invalid = suggestions.find(item => !sourcesFor(item).length || !sourcesFor(item).some(quote => {
      const checked = validDate(item.startsAt, quote, clue.ocrText, Boolean(item.timeOfDay))
      const periodValid = !item.timeOfDay || scanPeriods(quote).some(period => period.value === item.timeOfDay)
      return checked && checked.startsAt === item.startsAt && periodValid
    }))
    const dateOnlyInvalid = invalid && !invalid.startsAt.includes('T') && sourcesFor(invalid).some(quote => scanClocks(quote).length > 0)
    if (invalid || /未通过校验|无法对应原线索|日期或原文出处|只有日期|仅有日期/.test(audit.message)) {
      const quote = invalid ? sourcesFor(invalid)[0] || '' : ''
      issues.push({
        id: idFor('invalid-result', invalid?.startsAt || 'validation'), sourceNo: clue.number, kind: 'invalid-result',
        title: dateOnlyInvalid ? '有时间结果只保留了日期，漏掉原文时刻' : invalid && !sourcesFor(invalid).length ? '有时间结果无法核对原文出处' : '有时间结果的日期或出处未通过核对',
        detail: dateOnlyInvalid ? '原文摘录包含具体钟表时刻，当前结果却只有日期。请查看原文补充事件时刻，或重试本条线索。' : '这条线索的部分时间结果未能同时对应有效日期和原文。请查看线索核对，或重试本条；未通过的结果不会自动录入。',
        quote: quote || (clocks[0] ? nearbyQuote(clue.ocrText, clocks[0].index, clocks[0].end) : clue.ocrText.slice(0, 280).trim()),
      })
    }
    if (/尚未完成 API|核对未完成|未完成.*核对|API.*(?:失败|超时)|请求.*失败|网络不可用|额度不足|余额不足|暂停/.test(audit.message)) {
      issues.push({
        id: idFor('incomplete', 'audit'), sourceNo: clue.number, kind: 'incomplete',
        title: /网络不可用|额度不足|余额不足/.test(audit.message) ? '当前只有本地扫描结果，尚需核对事件内容' : /暂停/.test(audit.message) ? '这条线索的时间核对已暂停' : '这条线索的 API 时间核对尚未完成',
        detail: /网络不可用|额度不足|余额不足/.test(audit.message) ? '已保留本地扫描的时间。可直接查看原文并补充事件，或在网络、API 额度恢复后重试本条。' : '已有整理结果仍然保留，可继续核对原文或重试本条线索，完成后再决定是否录入。',
        quote: clocks[0] ? nearbyQuote(clue.ocrText, clocks[0].index, clocks[0].end) : clue.ocrText.slice(0, 280).trim(),
      })
    }
  }
  return issues
}

function localTimelineFallback(clues: ClueRecord[], reason: 'offline' | 'quota', previous?: OrganizationSnapshot): OrganizationSnapshot {
  const timeline: OrganizationSnapshot['timeline'] = []
  for (const clue of clues) {
    const dates = scanDates(clue.ocrText), clocks = scanClocks(clue.ocrText), periods = scanPeriods(clue.ocrText)
    const usedDates = new Set<number>()
    for (const clock of clocks) {
      const date = dateForClock(dates, clock)
      if (!date) continue
      usedDates.add(date.index)
      const quote = clue.ocrText.slice(Math.max(0, clock.index - 36), Math.min(clue.ocrText.length, clock.end + 90)).trim()
      timeline.push({ id: `ocr-time-${crypto.randomUUID()}`, title: '待补充事件', startsAt: `${date.value}${clock.value}`, precision: clock.minute === null ? 'hour' : 'minute', approximate: clock.approximate, people: [], sourceNo: clue.number, quote, requiresTitle: true, evidence: [{ clueId: clue.id, sourceNo: clue.number, quote }] })
    }
    for (const date of dates.filter(item => !usedDates.has(item.index))) {
      const quote = clue.ocrText.slice(Math.max(0, date.index - 36), Math.min(clue.ocrText.length, date.end + 90)).trim()
      timeline.push({ id: `ocr-time-${crypto.randomUUID()}`, title: '待补充事件', startsAt: date.value, precision: 'date', approximate: /约|左右|前后/.test(quote), people: [], sourceNo: clue.number, quote, requiresTitle: true, evidence: [{ clueId: clue.id, sourceNo: clue.number, quote }] })
    }
    for (const period of periods) {
      const date = dateForAnchor(dates, period)
      if (!date) continue
      const quote = clue.ocrText.slice(Math.max(0, period.index - 36), Math.min(clue.ocrText.length, period.end + 110)).trim()
      timeline.push({ id: `ocr-time-${crypto.randomUUID()}`, title: '待补充事件', startsAt: date.value, timeOfDay: period.value, precision: 'date', people: [], sourceNo: clue.number, quote, requiresTitle: true, evidence: [{ clueId: clue.id, sourceNo: clue.number, quote }] })
    }
  }
  const snapshot: OrganizationSnapshot = { id: '', scriptId: '', updatedAt: new Date().toISOString(), people: [], relationships: [], cluePoints: [], ...previous, timeline: mergeTimeline(previous?.timeline || [], timeline), analysis: { provider: 'local', localReason: reason, reviewed: false } }
  snapshot.timelineAudit = auditTimeline(clues, snapshot.timeline, new Map(), false, `${reason === 'offline' ? '网络不可用' : 'API 额度不足'}，已使用本地时间扫描，请核对事件内容`)
  organizationRun.model = ''; organizationRun.modelReason = ''; organizationRun.phase = 'local'; organizationRun.provider = 'local'; organizationRun.message = reason === 'offline' ? '网络不可用，已保留 API 结果并使用本地扫描' : 'API 额度不足，已使用本地扫描'
  return snapshot
}
function isNetworkUnavailable(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const message = error instanceof Error ? error.message : String(error)
  return /(network|internet|offline|connection|load failed|failed to fetch|could not connect|not connected)/i.test(message)
}
class OrganizationApiError extends Error {
  constructor(message: string, readonly localReason?: 'offline' | 'quota', readonly invalidResult = false) { super(message) }
}
const organizationSystem = `你是剧本杀线索的文字整理工具。只整理用户提供的 OCR 原文，不搜索外部资料，不推理剧情。
时间信息优先保证完整、精确。时间抽取必须独立于事件标题、人物、地点、分类等文字字段：分别扫描日期标记、钟表数字结构和时段词。没有具体时分但原文明确写出凌晨、清晨、早晨、早上、上午、中午、下午、午后、傍晚、晚上、晚间、夜里、夜间、深夜、半夜或晚时，也必须输出时间线事件，在 JSON 的 timeOfDay 字段逐字保留该时段；startsAt 只填写明确或沿用的日期，precision 为 date，不得换算、猜测具体时分。若没有明确日期，不得猜日期；仍应报告该时段并留待人工补日期。分别扫描日期标记和钟表数字结构（例如 10:27、10点27分、10时27分、十点二十七分），再按原文位置关联。早晨、晚间等时段词只帮助换算 24 小时制，不是识别时刻的前提；日期与时刻之间即使夹着人物、地点、括号说明或其他描述，也要继续识别。每条线索必须从头扫描到最后一行，尤其检查后半部分和分项列表。
时间线规则：
1. 每个明确时刻单独对应事件：到达、离开、打电话等发生在不同时刻时必须分开。原文写了几点几分，startsAt 必须保留分钟；例如“6月16日晚10点27分进入，10点29分离开”必须输出 --06-16T22:27 和 --06-16T22:29。只写到小时就只保留小时，不能补 :00。
2. 无年份使用 --MM-DD、--MM-DDTHH 或 --MM-DDTHH:mm；明确有年份使用 YYYY-MM-DD、YYYY-MM-DDTHH 或 YYYY-MM-DDTHH:mm。不得猜年份、日期、时刻或分钟。
3. 同线索前文明确月日，后续分项未出现新日期时沿用最近月日，跨段落/医院监控/城市监控等标题也继续检查，不得跨不同线索沿用日期。“6月17日早晨7点09分……城市监控显示：凌晨3时10分……3时24分……”必须分别保留后续每一时刻。
4. 时段词和 OCR 错别字不应阻断时钟数字识别。全角数字、数字间的 OCR 空格/换行、中文数字和冒号均要识别，例如“１０点２７分”“1 0 点 2 7 分”“十点三刻”；quote 仍保留原文，不能改写成标准数字。“通话1分43秒”“停留约一分钟”“1524病房”“线索卡22”是时长、房号或编号，不能当作新的事件时刻。明确晚上/下午换算 24 小时制；没有时段依据不得擅自加 12 小时。约、左右、大概、前后等近似含义必须保留，approximate=true；不能把约十点写成精确 10:00。
5. precision 为 date/hour/minute，与原文精度一致；约时仍保留原文实际精度。没有钟表时间但有明确时段词时，timeOfDay 必须填写原文中的词语，startsAt 只保留日期；不要把“凌晨”换算成 03:00、“上午”换算成 09:00 等任何具体时刻。输出 JSON 的 timeline 对象可包含 timeOfDay 字段。每个事件 title 只简述原文动作，无法提取标题时写“待补充事件”。不要为同一事件再重复一个仅日期建议。
6. 没有具体钟表数字的相对时间也必须保留，不能因 startsAt 无法单独确定而漏掉。若“约两分钟后”“随后”“片刻后”等后续动作明确承接一个已有钟表时刻的事件，将后续动作合并进该锚点事件的 title 和 quote，startsAt 与 precision 沿用锚点；保留原文相对时间措辞，含“约/左右”等估计时 approximate=true。不要把时长换算成新钟表时刻，也不要另造一个没有独立钟表时刻的节点。例如“7点左右敲门，约两分钟后坠楼”合成一个约7点的事件，标题同时写出敲门与坠楼，quote 连续包含两段原文；若之后另有“7点12分报警”，仍单独保留该事件。
7. 每条 quote 必须逐字连续摘录对应 OCR 原文，保留原标点/空格，不要改错字、不要拼接多段，优先含时刻、相对时间和事件动作；日期在前段时 quote 可只取当前时刻所在句，source 标明所属线索。每条 quote 尽量少于 400 字。
输出纯 JSON：{"people":[{"name":"原文人名","aliases":[],"source":1,"quote":"原文连续摘录"}],"relationships":[{"from":"人物A","to":"人物B","label":"原文明说关系","source":1,"quote":"原文连续摘录"}],"timeline":[{"title":"原文明确动作","startsAt":"--06-16T22:27","timeOfDay":"","precision":"minute","approximate":false,"people":[],"source":1,"quote":"原文连续摘录"}],"cluePoints":[{"source":1,"title":"简短主题","category":"通讯/财务/文书/影像/其他","tags":[],"quote":"原文连续摘录"}]}
其他约束：人物姓名须逐字出现；关系须原文明说，不因共同出现推断。每项必须有 source 和逐字 quote。只归纳明确事实，不判断证词真假、不分析动机/因果、不预测凶手/身份、不揭示答案、不补全未知经过。`

async function requestOrganization(provider: AiProvider, apiKey: string, user: string, input: OrganizationModelInput, shouldPause?: () => boolean): Promise<RawResult> {
  const label = providerLabel(provider)
  const endpoint = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.deepseek.com/chat/completions'
  // Only malformed/truncated Luna results can cause one extra paid request.
  // Authentication, quota, network, and rate-limit errors never escalate models.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (shouldPause?.()) throw new OrganizationPausedError()
    const plan = provider === 'openai' ? chooseOrganizationModel({ ...input, repairResult: attempt > 0 }) : null
    const model = plan?.model || 'deepseek-chat'
    organizationRun.model = model
    organizationRun.modelReason = plan?.reason || '按出口 IP 选择 DeepSeek'
    if (!organizationRun.models.includes(model)) organizationRun.models.push(model)
    organizationRun.message = `${label} · ${model} 正在${input.task === 'extract' ? '提取 OCR 文字' : '核对时间'}${attempt ? '（格式补救）' : ''}`
    const data = { model, stream: false, ...(plan ? { reasoning_effort: plan.reasoningEffort, max_completion_tokens: plan.maxCompletionTokens } : { temperature: 0.2, max_tokens: 6000 }), response_format: { type: 'json_object' }, messages: [{ role: 'system', content: organizationSystem }, { role: 'user', content: user }] }
    try {
      let status: number, responseData: unknown
      try {
        if (Capacitor.isNativePlatform()) {
          const response = await CapacitorHttp.post({ url: endpoint, connectTimeout: 15000, readTimeout: 90000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, data })
          status = response.status; responseData = response.data
        } else {
          const response = await fetch(import.meta.env.DEV && provider === 'openai' ? '/__local-ai/openai/chat/completions' : endpoint, { method: 'POST', headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify(data) })
          status = response.status; responseData = await response.json().catch(() => null)
        }
      } catch (error) {
        if (isNetworkUnavailable(error)) throw new OrganizationApiError('网络不可用', 'offline')
        throw error
      }
      const apiError = (responseData as { error?: { code?: string; message?: string } } | null)?.error
      if (status === 402 || (status === 429 && apiError?.code === 'insufficient_quota')) throw new OrganizationApiError(`${label} API 额度不足`, 'quota')
      if (status < 200 || status >= 300) throw new OrganizationApiError(status === 401 ? `${label} API Key 无效，请在档案管理中更新` : `${label} ${model} 整理失败（HTTP ${status}），请稍后重试`)
      const choice = (responseData as { choices?: { finish_reason?: string; message?: { content?: string | null } }[] } | null)?.choices?.[0]
      if (choice?.finish_reason === 'length') throw new OrganizationApiError('整理结果过长，未能完整返回，请减少线索后重试', undefined, true)
      const content = choice?.message?.content
      if (!content) throw new OrganizationApiError(`${label} 没有返回整理结果，请重试`)
      let result: RawResult
      try { result = JSON.parse(content) as RawResult } catch { throw new OrganizationApiError(`${label} 返回内容格式异常，请重试`, undefined, true) }
      if (provider === 'openai' && (!result || typeof result !== 'object' || !['people', 'relationships', 'timeline', 'cluePoints'].every(key => Array.isArray(result[key as keyof RawResult])))) throw new OrganizationApiError(`${model} 返回的整理字段不完整`, undefined, true)
      return result
    } catch (error) {
      if (attempt === 0 && plan?.model === 'gpt-6-luna' && error instanceof OrganizationApiError && error.invalidResult) continue
      throw error
    }
  }
  throw new OrganizationApiError('模型整理未完成，请重试')
}

export async function organizeClues(clues: ClueRecord[], context: OrganizationContext = {}): Promise<OrganizationSnapshot> {
  organizationRun.lastError = ''; organizationRun.message = '正在准备 OCR 文字'; organizationRun.phase = 'extracting'; organizationRun.provider = null
  organizationRun.model = ''; organizationRun.modelReason = ''; organizationRun.models = []
  let first: NormalizedResult | undefined
  const saved = context.checkpoint
  const fingerprint = context.fingerprint || JSON.stringify(clues.map(clue => [clue.id, clue.ocrText]))
  const resumed = saved && saved.version === 1 && saved.fingerprint === fingerprint && saved.clueIds.length === clues.length && clues.every(clue => saved.clueIds.includes(clue.id)) ? saved : null
  if (resumed) { first = { snapshot: structuredClone(resumed.snapshot), rejected: new Map(resumed.rejected) }; organizationRun.phase = 'checking'; organizationRun.models = [...(resumed.snapshot.analysis?.models || [])]; organizationRun.model = organizationRun.models.at(-1) || '' }
  const saveStage = async (provider: AiProvider, stage: 'checking' | 'complete'): Promise<void> => {
    if (!first) return
    await context.onCheckpoint?.({ version: 1, fingerprint, clueIds: clues.map(clue => clue.id), provider, stage, snapshot: structuredClone(first.snapshot), rejected: [...first.rejected], updatedAt: new Date().toISOString() })
  }
  const stopIfRequested = (): void => {
    if (context.shouldPause?.()) throw new OrganizationPausedError(first?.snapshot)
  }
  try {
    const sourceClues = clues.filter(clue => clue.ocrText.trim()).map(clue => ({ source: clue.number, text: clue.ocrText }))
    if (!sourceClues.length) throw new Error('当前剧本没有可整理的 OCR 文字')
    if (resumed?.stage === 'complete' && first) {
      organizationRun.phase = 'complete'; organizationRun.provider = resumed.provider; organizationRun.message = '已恢复完成的整理结果'
      await context.onStage?.('complete', organizationRun.message)
      return first.snapshot
    }
    stopIfRequested()
    await context.onStage?.(first ? 'checking' : 'extracting', first ? '已恢复首轮结果，准备时间核对' : '准备提取 OCR 文字')
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { await context.onStage?.('failed', organizationRun.lastError || organizationRun.message); return localTimelineFallback(clues, 'offline', first?.snapshot) }
    let provider: AiProvider
    try { provider = await resolveAiProvider() } catch (error) {
      if (isNetworkUnavailable(error)) { await context.onStage?.('failed', organizationRun.lastError || organizationRun.message); return localTimelineFallback(clues, 'offline', first?.snapshot) }
      throw error
    }
    organizationRun.provider = provider; organizationRun.message = first ? `${providerLabel(provider)} 正在恢复时间核对` : `${providerLabel(provider)} 正在整理 OCR 文字`
    const apiKey = await readApiKey(provider)
    const sources = JSON.stringify(sourceClues)
    const modelInput: OrganizationModelInput = { task: 'extract', sourceChars: sourceClues.reduce((total, clue) => total + clue.text.length, 0), clockCount: clues.reduce((total, clue) => total + scanClocks(clue.ocrText).length, 0) }
    stopIfRequested()
    if (!first) {
      try { first = normalize(await requestOrganization(provider, apiKey, `完整整理以下单个剧本的 OCR 线索。逐条从头到尾扫描，不能省略后半段时间。只返回规定 JSON。\n${sources}`, modelInput, context.shouldPause), clues) }
      catch (error) {
        if (context.shouldPause?.()) { organizationRun.lastError = error instanceof Error ? error.message : String(error); stopIfRequested() }
        if (error instanceof OrganizationApiError && error.localReason) { await context.onStage?.('failed', organizationRun.lastError || organizationRun.message); return localTimelineFallback(clues, error.localReason) }
        throw error
      }
      first.snapshot.analysis = { provider, reviewed: false, models: [...organizationRun.models] }
      first.snapshot.timelineAudit = auditTimeline(clues, first.snapshot.timeline, first.rejected, false)
      // Persist extraction before starting another request; a restart only repeats the audit.
      await saveStage(provider, 'checking')
    }
    stopIfRequested()
    organizationRun.phase = 'checking'; organizationRun.message = `${providerLabel(provider)} 正在逐段核对时间是否遗漏`
    await context.onStage?.('checking', organizationRun.message)
    let reviewed = false, reviewError = ''
    // This inventory only directs the API to literal OCR spans; it never creates events online.
    const clockAnchors = clues.map(clue => ({ source: clue.number, occurrences: scanClocks(clue.ocrText).map(clock => ({ offset: clock.index, text: clue.ocrText.slice(clock.index, clock.end), context: clue.ocrText.slice(Math.max(0, clock.index - 48), Math.min(clue.ocrText.length, clock.end + 96)) })) }))
    const periodAnchors = clues.map(clue => ({ source: clue.number, occurrences: scanPeriods(clue.ocrText).map(period => ({ offset: period.index, text: period.value, context: clue.ocrText.slice(Math.max(0, period.index - 48), Math.min(clue.ocrText.length, period.end + 96)) })) }))
    // Count literal, dated clock anchors only. Unclear dates do not trigger a paid upgrade.
    const clockCoverage = clues.flatMap(clue => {
      const dates = scanDates(clue.ocrText)
      return scanClocks(clue.ocrText).flatMap(clock => {
        const date = dateForClock(dates, clock)
        if (!date) return []
        const covered = first!.snapshot.timeline.some(item => item.sourceNo === clue.number && item.startsAt === `${date.value}${clock.value}` && quoteOffsets(clue.ocrText, item.quote).some(offset => clock.index >= offset && clock.end <= offset + item.quote.length))
        return [covered]
      })
    })
    const auditModelInput: OrganizationModelInput = { ...modelInput, task: 'timeline-audit', clockCount: clockCoverage.length, missingClocks: clockCoverage.filter(covered => !covered).length }
    stopIfRequested()
    try {
      const second = normalize(await requestOrganization(provider, apiKey, `这是独立的第二轮时间完整性核对。重新扫描下面每份 OCR 原文，从第一行到最后一行；先列出每一处日期及钟表时刻，再逐一对应事件。重点检查后半部分、仅写时刻的分项、同句多个时刻、跨段沿用最近日期、时段换算和约时；另检查没有钟表数字的时段词（凌晨、清晨、早晨、早上、上午、中午、下午、午后、傍晚、晚上、晚间、夜里、夜间、深夜、半夜），把它们作为日期级事件输出，并在 timeOfDay 字段逐字保留，不得补造钟点。再检查没有钟表数字的相对时间表达，例如“约两分钟后”“随后”“片刻后”：若它明确承接最近的钟表时刻事件，必须把后续动作和原文相对时间合并写进该锚点事件的标题与连续 quote，沿用锚点时间，不要遗漏、不要换算成新时刻、不要另建无时刻节点。不要根据其他分析的数量提前结束。仅返回完整 timeline 数组，people、relationships、cluePoints 均为空数组，每条仍必须包含 source 和逐字 quote。附录的时刻锚点只是本地扫描找到的原文位置，用于逐项核对遗漏；它可能不完整，不代表正确日期、事件或最终答案，必须继续独立扫描全文。时刻锚点不能替代原文，不要把时长、房号和编号当成时刻。\nOCR 原文：${sources}\n待核对原文时刻锚点：${JSON.stringify(clockAnchors)}\n待核对原文时段锚点：${JSON.stringify(periodAnchors)}`, auditModelInput, context.shouldPause), clues)
      first.snapshot.timeline = mergeTimeline(first.snapshot.timeline, second.snapshot.timeline)
      for (const [sourceNo, count] of second.rejected) first.rejected.set(sourceNo, Math.max(first.rejected.get(sourceNo) || 0, count))
      reviewed = true
    } catch (error) {
      organizationRun.lastError = error instanceof Error ? error.message : String(error)
      await context.onStage?.('failed', organizationRun.lastError || organizationRun.message)
      stopIfRequested()
      if (error instanceof OrganizationApiError && error.localReason) return localTimelineFallback(clues, error.localReason, first.snapshot)
      reviewError = `第二轮核对未完成：${organizationRun.lastError}；已保留首轮整理结果，再次整理将仅重试核对`
    }
    // Keep the original extraction provider on resume, even if region routing changed.
    first.snapshot.analysis = { provider: resumed ? resumed.provider : provider, reviewed, models: [...organizationRun.models] }
    first.snapshot.timelineAudit = auditTimeline(clues, first.snapshot.timeline, first.rejected, reviewed, reviewError)
    // A complete checkpoint closes the crash window between API success and workflow persistence.
    await saveStage(resumed ? resumed.provider : provider, reviewed ? 'complete' : 'checking')
    const reviewCount = first.snapshot.timelineAudit.filter(item => item.status === 'review').length
    organizationRun.phase = 'complete'; organizationRun.message = reviewed ? (reviewCount ? `整理已保存，${reviewCount} 份线索的时间待复核` : '整理及时间完整性核对已完成') : '首轮整理已保存，等待重试时间核对'
    await context.onStage?.(reviewed ? 'complete' : 'failed', organizationRun.message)
    return first.snapshot
  } catch (error) {
    if (error instanceof OrganizationPausedError) {
      organizationRun.phase = 'paused'; organizationRun.message = error.message
      await context.onStage?.('paused', error.message)
      throw error
    }
    organizationRun.phase = 'error'; organizationRun.lastError = error instanceof Error ? error.message : String(error); organizationRun.message = organizationRun.lastError
    await context.onStage?.('failed', organizationRun.lastError || organizationRun.message)
    throw error
  }
}
