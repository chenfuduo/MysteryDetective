export type OrganizationModelInput = {
  task: 'extract' | 'timeline-audit'
  sourceChars: number
  clockCount: number
  missingClocks?: number
  rejectedTimes?: number
  repairResult?: boolean
}

export type OrganizationModelPlan = {
  model: 'gpt-6-luna' | 'gpt-6.1-sol'
  reasoningEffort: 'none' | 'low'
  maxCompletionTokens: number
  reason: string
}

export function chooseOrganizationModel(input: OrganizationModelInput): OrganizationModelPlan {
  const missingClocks = input.missingClocks ?? 0
  const substantialTimelineOmissions = input.task === 'timeline-audit'
    && missingClocks >= 3
    && missingClocks >= input.clockCount * 0.5

  if (input.repairResult || substantialTimelineOmissions) {
    return {
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
      maxCompletionTokens: 16000,
      reason: input.repairResult
        ? '需要修复上一轮整理结果，升级模型处理'
        : '时间核对遗漏至少 3 处且达到时间点的一半，升级模型补全',
    }
  }

  const needsLowReasoning = input.task === 'timeline-audit'
    || input.sourceChars >= 3000
    || input.clockCount >= 6

  return {
    model: 'gpt-6-luna',
    reasoningEffort: needsLowReasoning ? 'low' : 'none',
    maxCompletionTokens: 12000,
    reason: input.task === 'timeline-audit'
      ? '使用经济模型核对时间点'
      : needsLowReasoning
        ? '文本较长或时间点较多，使用经济模型加强整理'
        : '常规线索抽取，优先使用经济模型',
  }
}
