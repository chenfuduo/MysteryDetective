import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { ClueRecord, OrganizationSnapshot } from './vault'

type RawPerson = { name?: unknown; aliases?: unknown; source?: unknown; quote?: unknown }
type RawRelationship = { from?: unknown; to?: unknown; label?: unknown; source?: unknown; quote?: unknown }
type RawTimeline = { title?: unknown; startsAt?: unknown; people?: unknown; source?: unknown; quote?: unknown }
type RawCluePoint = { source?: unknown; title?: unknown; category?: unknown; tags?: unknown; quote?: unknown }
type RawResult = { people?: unknown; relationships?: unknown; timeline?: unknown; cluePoints?: unknown }

const keyName = 'deepseek_api_key'

export async function hasApiKey(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  await SecureStorage.setSynchronize(false)
  return Boolean((await SecureStorage.getItem(keyName))?.trim())
}

export async function saveApiKey(value: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error('请在 iPad App 中配置 API Key')
  const key = value.trim()
  if (!key) throw new Error('请粘贴 DeepSeek API Key')
  await SecureStorage.setSynchronize(false)
  await SecureStorage.setItem(keyName, key)
}

export async function removeApiKey(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  await SecureStorage.setSynchronize(false)
  await SecureStorage.removeItem(keyName)
}

async function readApiKey(): Promise<string> {
  if (!Capacitor.isNativePlatform()) throw new Error('请在 iPad App 中配置 API Key')
  await SecureStorage.setSynchronize(false)
  const key = await SecureStorage.getItem(keyName)
  if (!key?.trim()) throw new Error('请先在「剧本管理」中保存 DeepSeek API Key')
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
function lastExplicitDateBefore(value: string, index: number): { year: string; month: number; day: number } | null {
  const pattern = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日|(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g
  const prefix = value.slice(0, index)
  let latest: { year: string; month: number; day: number } | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prefix)) !== null) {
    const year = match[1] || match[4] || ''
    const month = Number(match[2] || match[5])
    const day = Number(match[3] || match[6])
    const maxDay = new Date(Date.UTC(year ? Number(year) : 2000, month, 0)).getUTCDate()
    if (month >= 1 && month <= 12 && day >= 1 && day <= maxDay) latest = { year, month, day }
  }
  return latest
}

function validDate(value: unknown, quote: string, clueText: string): string {
  const candidate = text(value, 40).replace(' ', 'T')
  if (!quote) return ''
  const dateMatch = candidate.match(/^(?:(\d{4})-)?--?(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (!dateMatch) return ''
  const [, candidateYear, month, day, hour, minute] = dateMatch
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const validMonthDay = monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= new Date(Date.UTC(2000, monthNumber, 0)).getUTCDate()
  if (!validMonthDay) return ''

  const source = quote.replace(/\s/g, '')
  const quotedDate = source.match(new RegExp(`(?:(\\d{4})年)?0?${monthNumber}月0?${dayNumber}日`))
    || source.match(new RegExp(`(?:(\\d{4})[-/.])?0?${monthNumber}[-/.]0?${dayNumber}(?:日)?`))
  let sourceYear = quotedDate?.[1] || ''
  if (!quotedDate) {
    const quoteIndex = clueText.indexOf(quote)
    const contextualDate = quoteIndex >= 0 ? lastExplicitDateBefore(clueText, quoteIndex) : null
    if (!contextualDate || contextualDate.month !== monthNumber || contextualDate.day !== dayNumber) return ''
    sourceYear = contextualDate.year
  }
  if (candidateYear && sourceYear && candidateYear !== sourceYear) return ''
  if (candidateYear && !sourceYear && !quotedDate) return ''

  let time = ''
  if (hour) {
    const clockPattern = minute
      ? `(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|晚)?0?${Number(hour)}(?:[:：]|点|时)0?${Number(minute)}分?`
      : `(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|晚)?0?${Number(hour)}(?:点|时)(?!\\d)`
    const clock = source.match(new RegExp(clockPattern))
    if (clock) {
      let normalizedHour = Number(hour)
      if (['下午', '傍晚', '晚上', '晚', '中午'].includes(clock[1]) && normalizedHour < 12) normalizedHour += 12
      if (['凌晨', '清晨'].includes(clock[1]) && normalizedHour === 12) normalizedHour = 0
      time = `T${String(normalizedHour).padStart(2, '0')}${minute ? `:${minute}` : ''}`
    }
  }
  return `${sourceYear || '--'}${sourceYear ? '-' : ''}${month}-${day}${time}`
}
function normalize(raw: RawResult, clues: ClueRecord[]): OrganizationSnapshot {
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
    const from = text(item.from, 60)
    const to = text(item.to, 60)
    const label = text(item.label, 80)
    if (!source || !from || !to || from === to || !label || !source.quote.includes(from) || !source.quote.includes(to) || !source.quote.includes(label)) continue
    relationships.push({ id: crypto.randomUUID(), from, to, label, sourceNo: source.clue.number, quote: source.quote })
  }

  const timeline: OrganizationSnapshot['timeline'] = []
  for (const item of asArray(raw.timeline) as RawTimeline[]) {
    const source = sourceQuote(number(item.source), item.quote, clues)
    const title = text(item.title, 100)
    let startsAt = validDate(item.startsAt, source?.quote || '', source?.clue.ocrText || '')
    if (!source || !title || !startsAt) continue
    const names = Array.isArray(item.people) ? item.people.map(value => text(value, 60)).filter(value => value && source.quote.includes(value)).slice(0, 8) : []
    timeline.push({ id: crypto.randomUUID(), title, startsAt, people: names, sourceNo: source.clue.number, quote: source.quote })
  }

  const cluePoints: OrganizationSnapshot['cluePoints'] = []
  for (const item of asArray(raw.cluePoints) as RawCluePoint[]) {
    const source = sourceQuote(number(item.source), item.quote, clues)
    const title = text(item.title, 100)
    if (!source || !title) continue
    const tags = Array.isArray(item.tags) ? item.tags.map(value => text(value, 24)).filter(Boolean).slice(0, 6) : []
    cluePoints.push({ id: crypto.randomUUID(), title, category: text(item.category, 32), tags, sourceNo: source.clue.number, quote: source.quote })
  }

  return { id: '', scriptId: '', updatedAt: new Date().toISOString(), people, relationships, timeline, cluePoints }
}

function extractExplicitTimeline(clues: ClueRecord[]): OrganizationSnapshot['timeline'] {
  const suggestions: OrganizationSnapshot['timeline'] = []
  const datePattern = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日|(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<!\d)(\d{1,2})[-/.](\d{1,2})(?!\d)/g
  const clockPattern = /(?:(凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜间|深夜|半夜|晚)\s*)?(?<!\d)(\d{1,2})\s*(点(?:钟)?|时|[:：])(?:\s*(\d{1,2})\s*分?|\s*(半))?(?!\d)/g

  for (const clue of clues) {
    const sourceText = clue.ocrText
    if (!sourceText.trim()) continue
    const dates: { index: number; end: number; startsAt: string }[] = []
    datePattern.lastIndex = 0
    let dateMatch: RegExpExecArray | null
    while ((dateMatch = datePattern.exec(sourceText)) !== null) {
      const [, chineseYear, chineseMonth, chineseDay, numericYear, numericMonth, numericDay, shortMonth, shortDay] = dateMatch
      const year = chineseYear || numericYear || ''
      const month = Number(chineseMonth || numericMonth || shortMonth)
      const day = Number(chineseDay || numericDay || shortDay)
      const maxDay = new Date(Date.UTC(year ? Number(year) : 2000, month, 0)).getUTCDate()
      if (month < 1 || month > 12 || day < 1 || day > maxDay) continue
      const monthDay = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      dates.push({ index: dateMatch.index, end: datePattern.lastIndex, startsAt: year ? `${year}-${monthDay}` : `--${monthDay}` })
    }

    const clocks: { index: number; end: number; value: string }[] = []
    clockPattern.lastIndex = 0
    let clockMatch: RegExpExecArray | null
    while ((clockMatch = clockPattern.exec(sourceText)) !== null) {
      const period = clockMatch[1] || ''
      let hour = Number(clockMatch[2])
      const minuteText = clockMatch[4] === undefined ? (clockMatch[5] ? '30' : '') : clockMatch[4]
      const minute = minuteText ? Number(minuteText) : null
      if (hour > 23 || (minute !== null && minute > 59)) continue
      if (['下午', '傍晚', '晚上', '夜里', '夜间', '深夜', '晚', '中午'].includes(period) && hour > 0 && hour < 12) hour += 12
      if (['凌晨', '清晨', '早晨'].includes(period) && hour === 12) hour = 0
      if (['半夜'].includes(period) && hour === 12) hour = 0
      clocks.push({ index: clockMatch.index, end: clockPattern.lastIndex, value: `T${String(hour).padStart(2, '0')}${minute === null ? '' : `:${String(minute).padStart(2, '0')}`}` })
    }

    const clocksByDate = new Map<number, typeof clocks>()
    for (const clock of clocks) {
      const previous = [...dates].reverse().find(date => date.end <= clock.index)
      const next = dates.find(date => date.index >= clock.end)
      const previousDistance = previous ? clock.index - previous.end : Infinity
      const nextDistance = next ? next.index - clock.end : Infinity
      const relatedDate = nextDistance < previousDistance && nextDistance <= 180 ? next : previous || (nextDistance <= 180 ? next : undefined)
      if (!relatedDate) continue
      const relatedClocks = clocksByDate.get(relatedDate.index) || []
      relatedClocks.push(clock)
      clocksByDate.set(relatedDate.index, relatedClocks)
    }

    for (const date of dates) {
      const matchedClocks = clocksByDate.get(date.index) || []
      const entries = matchedClocks.length ? matchedClocks.map(clock => ({ startsAt: `${date.startsAt}${clock.value}`, clock })) : [{ startsAt: date.startsAt, clock: undefined }]
      for (const entry of entries) {
        const anchorStart = entry.clock ? Math.min(date.index, entry.clock.index) : date.index
        const anchorEnd = entry.clock ? Math.max(date.end, entry.clock.end) : date.end
        const quote = sourceText.slice(Math.max(0, anchorStart - 36), Math.min(sourceText.length, anchorEnd + 90)).trim().slice(0, 600)
        suggestions.push({
          id: `ocr-time-${crypto.randomUUID()}`,
          title: '待补充事件',
          startsAt: entry.startsAt,
          people: [],
          sourceNo: clue.number,
          quote,
          requiresTitle: true,
        })
      }
    }
  }
  return suggestions
}
function localTimelineFallback(clues: ClueRecord[]): OrganizationSnapshot {
  return {
    id: '',
    scriptId: '',
    updatedAt: new Date().toISOString(),
    people: [],
    relationships: [],
    timeline: extractExplicitTimeline(clues),
    cluePoints: [],
  }
}

function isNetworkUnavailable(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const message = error instanceof Error ? error.message : String(error)
  return /(network|internet|offline|connection|load failed|failed to fetch|could not connect|not connected)/i.test(message)
}

export async function organizeClues(clues: ClueRecord[]): Promise<OrganizationSnapshot> {
  const sourceClues = clues.filter(clue => clue.ocrText.trim()).map(clue => ({ source: clue.number, text: clue.ocrText.trim() }))
  if (!sourceClues.length) throw new Error('当前剧本没有可整理的 OCR 文字')
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return localTimelineFallback(clues)
  const apiKey = await readApiKey()

  const system = `你是剧本杀线索的文字整理工具。只整理用户提供的 OCR 原文，不搜索外部资料，不推理剧情。
时间信息优先保证完整、精确。时间抽取必须独立于事件标题、人物、地点、分类等文字字段：分别扫描日期标记和钟表数字结构（例如 10:27、10点27分、10时27分），再按原文位置关联。早晨、晚间等时段词只帮助换算 24 小时制，不是识别时刻的前提；日期与时刻之间即使夹着人物、地点、括号说明或其他描述，也要继续识别。每条线索都要从头扫描到尾，不能找到第一处时间就停止。

时间线规则：
1. 原文中的每个明确日期都要检查同一事件或同一句中是否写有时刻。只要原文明确写了几点几分，startsAt 就必须保留到分钟，绝不能只输出日期。例如“6月17日凌晨3时04分”写成“--06-17T03:04”，“2025年6月17日 15:08”写成“2025-06-17T15:08”。
2. 原文未写年份时使用 --MM-DD；有明确时刻时使用 --MM-DDTHH:mm。原文有年份时使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。不得补年份、时刻或分钟；原文只写到小时就只保留小时。
3. 同一条线索可能包含多项日期和时刻。每个明确的日期时间都单独输出一项，按原文出现顺序逐项检查，不得漏项、合并或只保留一个代表时间。对同一事件同时识别出日期和时刻时，只输出包含时刻的完整时间，不要再为该事件重复输出一个仅有日期的项目。
4. 日期与时刻可以相隔一段描述文字。若同一条线索前文明确写出月日，后续分项没有出现新日期，则沿用最近出现的月日，直到线索中出现新的明确日期；不得跨不同线索沿用日期，也不得补年份。原文没有任何可沿用日期时，不要猜日期。
5. 事件标题只简述原文明确写出的动作或事实，不概括动机、因果或真相。原文有明确时间但事件标题无法简洁提取时，仍输出时间建议，标题可写“待补充事件”。
6. 每条时间建议的 quote 必须是对应 OCR 原文中的逐字连续摘录，并且尽可能同时包含该日期、时刻和事件描述，便于核对原图。source 必须是该摘录所属线索的编号。

输出格式为纯 JSON，不要 Markdown 或额外说明：{"people":[{"name":"原文明确出现的人名","aliases":[],"source":1,"quote":"原文连续摘录"}],"relationships":[{"from":"人物A","to":"人物B","label":"原文明说的关系","source":1,"quote":"原文连续摘录"}],"timeline":[{"title":"原文明确写出的事件短句","startsAt":"YYYY-MM-DD、YYYY-MM-DDTHH:mm、--MM-DD 或 --MM-DDTHH:mm","people":[],"source":1,"quote":"原文连续摘录"}],"cluePoints":[{"source":1,"title":"这条线索的简短主题","category":"通讯/财务/文书/影像/其他","tags":[],"quote":"原文连续摘录"}]}

其他约束：人名必须逐字出现在对应原文；人物关系必须由原文直接说明，不能因两人同框、共同出现或同一事件而推断；事件日期和时间必须能在对应原文中找到；原文明确写出上午、下午、晚上等时段时，按其明确含义换算为 24 小时制；没有时段标记时不得擅自改变小时。线索主题只能简要归纳原文写了什么。每项都必须有 source 编号和逐字连续 quote。证据不足就省略，不要补全、猜测、判断证词真假、分析动机、预测凶手或揭示答案。` 
  const data = {
    model: 'deepseek-chat',
    stream: false,
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `请按系统规则完整整理以下单个剧本的 OCR 线索。逐条扫描每份原文直至末尾，优先确保时间线里的日期和具体时分都被完整保留；每条建议都要能凭 source 和 quote 回到原始线索。只返回符合格式的 JSON。\n${JSON.stringify(sourceClues)}` },
    ],
  }

  let status: number
  let responseData: unknown
  try {
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.post({
        url: 'https://api.deepseek.com/chat/completions',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        data,
      })
      status = response.status
      responseData = response.data
    } else {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      status = response.status
      responseData = await response.json().catch(() => null)
    }
  } catch (error) {
    if (isNetworkUnavailable(error)) return localTimelineFallback(clues)
    throw error
  }
  if (status === 402) return localTimelineFallback(clues)
  if (status < 200 || status >= 300) {
    if (status === 401) throw new Error('DeepSeek API Key 无效，请在剧本管理中更新')
    throw new Error(`DeepSeek 整理失败（HTTP ${status}），请稍后重试`)
  }
  const body = responseData as { choices?: { finish_reason?: string; message?: { content?: string | null } }[] } | null
  const choice = body?.choices?.[0]
  if (choice?.finish_reason === 'length') throw new Error('整理结果过长，未能完整返回，请减少线索后重试')
  const content = choice?.message?.content
  if (!content) throw new Error('DeepSeek 没有返回整理结果，请重试')
  let parsed: RawResult
  try { parsed = JSON.parse(content) as RawResult } catch { throw new Error('DeepSeek 返回内容格式异常，请重试') }
  return normalize(parsed, clues)
}
