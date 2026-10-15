<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TimelineExtractionIssue } from '../services/organizer'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ issues: TimelineExtractionIssue[]; busy: boolean }>()
const emit = defineEmits<{
  retry: [sourceNo: number]
  add: [issue: TimelineExtractionIssue]
  ignore: [ids: string[]]
  openClue: [sourceNo: number, quote?: string]
}>()
const expanded = ref(false)
const expandedSources = ref<number[]>([])
const groups = computed(() => {
  const sources = new Map<number, TimelineExtractionIssue[]>()
  for (const issue of props.issues) sources.set(issue.sourceNo, [...(sources.get(issue.sourceNo) || []), issue])
  return [...sources].map(([sourceNo, issues]) => ({ sourceNo, issues }))
})
const shownGroups = computed(() => expanded.value ? groups.value : groups.value.slice(0, 3))
</script>

<template>
  <section v-if="issues.length" class="time-issues" aria-label="时间提取待处理事项">
    <header class="time-issues-heading"><div><h3><UiIcon name="clock" :size="19" />可能遗漏的时间 <span>{{ issues.length }}</span></h3><p>不会阻止其他建议录入。先点“自动补提这条线索”；也可以手动补事件，或忽略不需要的提示。</p></div><button class="time-ignore-all" :disabled="busy" @click="emit('ignore', issues.map(issue => issue.id))">忽略全部提示</button></header>
    <article v-for="group in shownGroups" :key="group.sourceNo" class="time-source-group"><header><strong>线索 #{{ String(group.sourceNo).padStart(3, '0') }} · {{ group.issues.length }} 项</strong><button class="time-retry" :disabled="busy" @click="emit('retry', group.sourceNo)"><UiIcon name="restore" :size="16" />自动补提这条线索</button></header><p class="time-retry-note">仅重新整理这条线索，已有人工录入和关系保留；会产生 API 用量。</p><div v-for="issue in (expandedSources.includes(group.sourceNo) ? group.issues : group.issues.slice(0, 3))" :key="issue.id" class="time-issue"><h4>{{ issue.title }}</h4><p>{{ issue.detail }}</p><blockquote v-if="issue.quote">{{ issue.quote }}</blockquote><footer><button v-if="issue.kind === 'missing-time'" class="time-manual" :disabled="busy" @click="emit('add', issue)">{{ issue.startsAt ? '手动补一条事件' : '填写日期和事件' }}</button><button :disabled="busy" @click="emit('openClue', issue.sourceNo, issue.quote || undefined)">可选：查看照片</button><button class="time-ignore" :disabled="busy" @click="emit('ignore', [issue.id])">忽略这条提示</button></footer></div><button v-if="group.issues.length > 3" class="time-more" @click="expandedSources = expandedSources.includes(group.sourceNo) ? expandedSources.filter(sourceNo => sourceNo !== group.sourceNo) : [...expandedSources, group.sourceNo]">{{ expandedSources.includes(group.sourceNo) ? '收起' : `展开其余 ${group.issues.length - 3} 项` }}</button></article>
    <button v-if="groups.length > 3" class="time-more" @click="expanded = !expanded">{{ expanded ? '收起其他线索' : `还有 ${groups.length - 3} 条线索，展开处理` }}</button>
  </section>
</template>

<style scoped>
.time-issues{margin-top:18px;border:1px solid #eadcca;border-radius:14px;background:#fffcf7;overflow:hidden;color:#425244}.time-issues-heading{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:17px 19px}.time-issues h3{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;color:#735c3e}.time-issues h3 span{background:#f2e7d5;border-radius:10px;padding:2px 7px;font-size:11px}.time-issues-heading p{font-size:12px;line-height:1.8;margin:7px 0 0;color:#8b806e}.time-issues button{font:inherit;cursor:pointer;min-height:40px;padding:8px 11px;border:0;border-radius:8px;background:transparent;font-size:12px;line-height:1.4;color:#657c58;touch-action:manipulation}.time-issues button:disabled{opacity:.5;cursor:wait}.time-ignore-all{flex-shrink:0;color:#9c8e78!important}.time-source-group{border-top:1px solid #eee4d6;padding:14px 19px 0}.time-source-group>header{display:flex;gap:12px;align-items:center;justify-content:space-between}.time-source-group>header strong{font-size:12px;color:#7f765d}.time-retry{display:flex;gap:6px;align-items:center;background:#edf3e8!important;color:#4f7042!important;font-weight:600!important}.time-retry-note{font-size:11px;color:#a19682;margin:6px 0 12px;line-height:1.6}.time-issue{padding:12px 0;border-top:1px solid #f0e9de}.time-issue h4{font-size:13px;line-height:1.6;margin:0;color:#655c48}.time-issue>p{font-size:12px;line-height:1.7;color:#928573;margin:5px 0}.time-issue blockquote{font-size:12px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;color:#8d806b;background:#f8f3e9;border-left:2px solid #dbc9aa;border-radius:0 7px 7px 0;margin:9px 0 0;padding:8px 11px;max-height:150px;overflow:auto}.time-issue footer{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:8px}.time-manual{background:#fff!important;border:1px solid #dedfcc!important;color:#526d44!important;font-weight:600!important}.time-ignore{margin-left:auto;color:#a29480!important}.time-more{display:block;width:100%;border-radius:0!important;border-top:1px solid #eee4d6!important;min-height:44px!important}@media(max-width:650px){.time-issues-heading{gap:8px;padding:14px;flex-wrap:wrap}.time-ignore-all{margin-left:auto}.time-source-group{padding:12px 14px 0}.time-issue footer{gap:3px}.time-ignore{margin-left:0}.time-source-group>header{gap:8px}.time-retry{font-size:11px!important}}
</style>
