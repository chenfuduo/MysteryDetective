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
function validDate(value: unknown, quote: string): string {
  const candidate = text(value, 40).replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(candidate)) return ''
  if (Number.isNaN(Date.parse(candidate))) return ''
  return quote ? `${candidate.length === 10 ? `${candidate}T00:00` : candidate}` : ''
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
    const startsAt = validDate(item.startsAt, source?.quote || '')
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

export async function organizeClues(clues: ClueRecord[]): Promise<OrganizationSnapshot> {
  const apiKey = await readApiKey()
  const sourceClues = clues.filter(clue => clue.ocrText.trim()).map(clue => ({ source: clue.number, text: clue.ocrText.trim() }))
  if (!sourceClues.length) throw new Error('当前剧本没有可整理的 OCR 文字')

  const system = `你是剧本杀线索的文字整理工具。只整理用户给出的 OCR 原文，不搜索外部资料，不推理剧情。
只输出 JSON，格式为：{"people":[{"name":"原文明确出现的人名","aliases":[],"source":1,"quote":"原文连续摘录"}],"relationships":[{"from":"人物A","to":"人物B","label":"原文明说的关系","source":1,"quote":"原文连续摘录"}],"timeline":[{"title":"原文明确写出的事件短句","startsAt":"YYYY-MM-DDTHH:mm","people":[],"source":1,"quote":"原文连续摘录"}],"cluePoints":[{"source":1,"title":"这条线索的简短主题","category":"通讯/财务/文书/影像/其他","tags":[],"quote":"原文连续摘录"}]}
约束：人名必须逐字出现在对应原文；人物关系必须由原文直接说明，不能因两人同框、共同出现或同一事件而推断；日期时间和事件必须在对应原文中明确出现；线索主题只能简要归纳该原文写了什么。每项都必须有 source 编号和逐字连续 quote。证据不足就省略，不要补全、猜测、判断证词真假、分析动机、预测凶手或揭示答案。` 
  const data = {
    model: 'deepseek-chat',
    stream: false,
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `请整理以下一个剧本的 OCR 线索。返回 JSON。\n${JSON.stringify(sourceClues)}` },
    ],
  }

  let status: number
  let responseData: unknown
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
  if (status < 200 || status >= 300) {
    if (status === 401) throw new Error('DeepSeek API Key 无效，请在剧本管理中更新')
    if (status === 402) throw new Error('DeepSeek 账户余额不足或额度不可用')
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
