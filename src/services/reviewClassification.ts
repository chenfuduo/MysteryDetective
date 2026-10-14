import type { ClueRecord, OrganizationSnapshot } from './vault'

export type ReviewGroup = 'ready' | 'needs-content' | 'needs-review'
export type ReviewSuggestion = { kind: 'people' | 'relationships' | 'timeline' | 'cluePoints'; item: OrganizationSnapshot['people'][number] | OrganizationSnapshot['relationships'][number] | OrganizationSnapshot['timeline'][number] | OrganizationSnapshot['cluePoints'][number] }
export type ReviewClassification = { group: ReviewGroup; reason: string; canConfirm: boolean; sourceExists: boolean; retry: boolean }

function validTimelineDate(value: string): boolean {
  const match = value.match(/^(?:(\d{4})-|--)(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return false
  const year = match[1] ? Number(match[1]) : 2000
  const month = Number(match[2]), day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && (!match[4] || Number(match[4]) < 24) && (!match[5] || Number(match[5]) < 60)
}

export function classifyReview(suggestion: ReviewSuggestion, clues: ClueRecord[], audits: OrganizationSnapshot['timelineAudit'], reviewed = false): ReviewClassification {
  const item = suggestion.item
  const clue = clues.find(clue => clue.number === item.sourceNo)
  const sourceValid = Boolean(clue && item.quote.trim() && clue.ocrText.includes(item.quote))
  const base = { sourceExists: Boolean(clue), canConfirm: false, retry: false }
  if (!sourceValid) return { ...base, group: 'needs-review', reason: clue ? '摘录与当前 OCR 原文不匹配，请查看原文后重新整理。' : '原线索不存在，请重新整理以更新出处。', retry: true }
  if (suggestion.kind === 'timeline' && 'startsAt' in item) {
    if (!validTimelineDate(item.startsAt)) return { ...base, group: 'needs-review', reason: '日期或时刻格式无效，请查看原文后重新整理。', retry: true }
    if (item.requiresTitle || !item.title.trim() || item.title === '待补充事件') return { ...base, group: 'needs-content', reason: '已提取时间，请补充这时发生的事件。' }
    const audit = audits?.find(audit => audit.sourceNo === item.sourceNo && audit.status === 'review')
    if (audit && !reviewed) return { ...base, group: 'needs-review', reason: audit.message || '这条线索的时间覆盖尚未通过核对，请先核对原文。', canConfirm: true, retry: true }
  }
  return { ...base, group: 'ready', reason: reviewed ? '已由你核对原文，可以录入。' : '字段和出处齐全，可以录入。' }
}
