import type { ClueRecord, OrganizationSnapshot } from './vault'

export type ReviewGroup = 'ready' | 'needs-content' | 'needs-review'
export type ReviewSuggestion = { kind: 'people' | 'relationships' | 'timeline' | 'cluePoints'; item: OrganizationSnapshot['people'][number] | OrganizationSnapshot['relationships'][number] | OrganizationSnapshot['timeline'][number] | OrganizationSnapshot['cluePoints'][number] }
export type ReviewClassification = { group: ReviewGroup; reason: string; sourceExists: boolean; retry: boolean }

function validTimelineDate(value: string): boolean {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return false
  const year = match[1] ? Number(match[1]) : 2000
  const month = Number(match[2]), day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && (!match[4] || Number(match[4]) < 24) && (!match[5] || Number(match[5]) < 60)
}

export function classifyReview(suggestion: ReviewSuggestion, clues: ClueRecord[], _audits?: OrganizationSnapshot['timelineAudit'], _reviewed = false): ReviewClassification {
  const item = suggestion.item
  const clue = clues.find(clue => clue.number === item.sourceNo)
  const sourceValid = Boolean(clue && item.quote.trim() && clue.ocrText.includes(item.quote))
  const base = { sourceExists: Boolean(clue), retry: false }
  if (!sourceValid) return { ...base, group: 'needs-review', reason: clue ? '摘录与当前 OCR 不匹配，请重新整理以更新内容。' : '原线索不存在，请重新整理以更新出处。', retry: true }
  if (suggestion.kind === 'timeline' && 'startsAt' in item) {
    if (!validTimelineDate(item.startsAt)) return { ...base, group: 'needs-review', reason: '日期或时刻格式无效，请重新整理以修正时间。', retry: true }
    if (item.requiresTitle || !item.title.trim() || item.title === '待补充事件') return { ...base, group: 'needs-content', reason: '已提取时间，请补充这时发生的事件。' }
  }
  return { ...base, group: 'ready', reason: '字段和出处齐全，可直接录入；原文可按需查看。' }
}
