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
const drawerOpen = ref(true)
const expandedSources = ref<number[]>([])
const groups = computed(() => {
  const sources = new Map<number, TimelineExtractionIssue[]>()
  for (const issue of props.issues) sources.set(issue.sourceNo, [...(sources.get(issue.sourceNo) || []), issue])
  return [...sources].map(([sourceNo, issues]) => ({ sourceNo, issues }))
})
const shownGroups = computed(() => expanded.value ? groups.value : groups.value.slice(0, 3))
</script>

<template>
  <template v-if="issues.length">
    <div v-if="drawerOpen" class="time-issues-backdrop" @click="drawerOpen = false"></div>
    <section class="time-issues" :class="{ 'is-open': drawerOpen }" aria-label="时间提取待处理事项" :aria-hidden="!drawerOpen" :inert="!drawerOpen">
      <header class="time-issues-heading"><div><h3><UiIcon name="clock" :size="19" />可能遗漏的时间 <span>{{ issues.length }}</span></h3><p>如果原文有时间却没出现在建议里，点对应线索的“重新查找时间”。系统会重新分析这条线索已识别的文字，不发送照片。分析后，到“整理建议”里点“直接录入”，时间才会加入时间线。</p></div><div class="time-issues-heading-actions"><button class="time-ignore-all" :disabled="busy" @click="emit('ignore', issues.map(issue => issue.id))">忽略全部提示</button><button class="time-drawer-close" aria-label="收起时间提示" @click="drawerOpen = false">收起 <span aria-hidden="true">×</span></button></div></header>
      <div class="time-issues-body">
        <article v-for="group in shownGroups" :key="group.sourceNo" class="time-source-group"><header><strong>线索 #{{ String(group.sourceNo).padStart(3, '0') }} · {{ group.issues.length }} 项</strong><button class="time-retry" :disabled="busy" @click="emit('retry', group.sourceNo)"><UiIcon name="restore" :size="16" />{{ busy ? '正在重新查找…' : '重新查找本条线索的时间' }}</button></header><p class="time-retry-note">只分析本条线索的 OCR 文字；已录入的事件会保留。会调用 AI 服务并产生 API 用量。</p><div v-for="issue in (expandedSources.includes(group.sourceNo) ? group.issues : group.issues.slice(0, 3))" :key="issue.id" class="time-issue"><h4>{{ issue.title }}</h4><p>{{ issue.detail }}</p><blockquote v-if="issue.quote">{{ issue.quote }}</blockquote><footer><button v-if="issue.kind === 'missing-time'" class="time-manual" :disabled="busy" @click="emit('add', issue)">{{ issue.startsAt ? '手动补一条事件' : '填写日期和事件' }}</button><button :disabled="busy" @click="emit('openClue', issue.sourceNo, issue.quote || undefined)">可选：查看照片</button><button class="time-ignore" :disabled="busy" @click="emit('ignore', [issue.id])">忽略这条提示</button></footer></div><button v-if="group.issues.length > 3" class="time-more" @click="expandedSources = expandedSources.includes(group.sourceNo) ? expandedSources.filter(sourceNo => sourceNo !== group.sourceNo) : [...expandedSources, group.sourceNo]">{{ expandedSources.includes(group.sourceNo) ? '收起' : `展开其余 ${group.issues.length - 3} 项` }}</button></article>
        <button v-if="groups.length > 3" class="time-more" @click="expanded = !expanded">{{ expanded ? '收起其他线索' : `还有 ${groups.length - 3} 条线索，展开处理` }}</button>
      </div>
    </section>
    <button v-if="!drawerOpen" class="time-drawer-reopen" @click="drawerOpen = true"><UiIcon name="clock" :size="16" />可能遗漏的时间 <span>{{ issues.length }}</span><span aria-hidden="true">↑</span></button>
  </template>
</template>

<style scoped>
.time-issues{margin-top:18px;border:1px solid #eadcca;border-radius:14px;background:#fffcf7;overflow:hidden;color:#425244;box-sizing:border-box}
.time-issues-heading{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:17px 19px}
.time-issues-heading h3{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;color:#735c3e}
.time-issues-heading h3 span,.time-drawer-reopen span{background:#f2e7d5;border-radius:10px;padding:2px 7px;font-size:11px}
.time-issues-heading p{font-size:12px;line-height:1.8;margin:7px 0 0;color:#8b806e}
.time-issues-heading-actions{display:flex;flex-shrink:0;align-items:center;gap:5px}
.time-issues button{font:inherit;cursor:pointer;min-height:40px;padding:8px 11px;border:0;border-radius:8px;background:transparent;font-size:12px;line-height:1.4;color:#657c58;touch-action:manipulation}
.time-issues button:disabled{opacity:.5;cursor:wait}
.time-ignore-all{color:#9c8e78!important}
.time-drawer-close,.time-drawer-reopen,.time-issues-backdrop{display:none}
.time-source-group{border-top:1px solid #eee4d6;padding:14px 19px 0}
.time-source-group>header{display:flex;gap:12px;align-items:center;justify-content:space-between}
.time-source-group>header strong{font-size:12px;color:#7f765d}
.time-retry{display:flex;gap:6px;align-items:center;background:#edf3e8!important;color:#4f7042!important;font-weight:600!important}
.time-retry-note{font-size:11px;color:#a19682;margin:6px 0 12px;line-height:1.6}
.time-issue{padding:12px 0;border-top:1px solid #f0e9de}
.time-issue h4{font-size:13px;line-height:1.6;margin:0;color:#655c48}
.time-issue>p{font-size:12px;line-height:1.7;color:#928573;margin:5px 0}
.time-issue blockquote{font-size:12px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;color:#8d806b;background:#f8f3e9;border-left:2px solid #dbc9aa;border-radius:0 7px 7px 0;margin:9px 0 0;padding:8px 11px;max-height:150px;overflow:auto}
.time-issue footer{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:8px}
.time-manual{background:#fff!important;border:1px solid #dedfcc!important;color:#526d44!important;font-weight:600!important}
.time-ignore{margin-left:auto;color:#a29480!important}
.time-more{display:block;width:100%;border-radius:0!important;border-top:1px solid #eee4d6!important;min-height:44px!important}
@media(max-width:650px){.time-issues-heading{gap:8px;padding:14px;flex-wrap:wrap}.time-ignore-all{margin-left:auto}.time-source-group{padding:12px 14px 0}.time-issue footer{gap:3px}.time-ignore{margin-left:0}.time-source-group>header{gap:8px}.time-retry{font-size:11px!important}}
@media (orientation:portrait){
  .time-issues-backdrop{display:block;position:fixed;inset:0;z-index:1299;background:rgba(26,34,28,.24)}
  .time-issues{position:fixed;z-index:1300;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));bottom:0;height:50vh;height:50dvh;max-height:50vh;max-height:50dvh;margin:0;padding-bottom:max(8px,env(safe-area-inset-bottom));display:flex;flex-direction:column;border-radius:18px 18px 0 0;box-shadow:0 -10px 34px rgba(47,58,48,.18);transform:translateY(calc(100% + 12px));transition:transform .22s ease-out;overscroll-behavior:contain}
  .time-issues.is-open{transform:translateY(0)}
  .time-issues-heading{flex:0 0 auto;gap:8px;padding:12px 14px 10px;border-bottom:1px solid #eee4d6}
  .time-issues-heading>div:first-child{min-width:0}
  .time-issues-heading h3{font-size:14px}
  .time-issues-heading p{font-size:11px;line-height:1.55;margin-top:5px}
  .time-issues-heading-actions{align-self:flex-start;gap:0}
  .time-ignore-all{font-size:10px!important;padding:6px!important;min-height:34px!important;white-space:nowrap}
  .time-drawer-close{display:inline-flex!important;align-items:center;gap:4px;padding:6px 8px!important;min-height:34px!important;border:1px solid #e6ddce!important;background:#fff!important;color:#75664f!important;white-space:nowrap}
  .time-drawer-close span{font-size:17px}
  .time-issues-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}
  .time-source-group{padding:10px 14px 0}
  .time-source-group>header{align-items:flex-start}
  .time-retry{max-width:58%;min-height:36px!important;padding:6px 8px!important;font-size:10px!important}
  .time-retry-note{margin:5px 0 9px;font-size:10px}
  .time-issue{padding:10px 0}
  .time-issue h4{font-size:12px}
  .time-issue>p,.time-issue blockquote{font-size:11px}
  .time-issue footer button{min-height:36px;padding:6px 8px;font-size:10px}
  .time-drawer-reopen{position:fixed;z-index:1300;right:max(14px,env(safe-area-inset-right));bottom:calc(env(safe-area-inset-bottom) + 76px);display:flex;align-items:center;gap:7px;min-height:42px;padding:0 13px;border:1px solid #e5d6bd;border-radius:22px;background:#fffcf7;color:#735c3e;box-shadow:0 4px 16px rgba(47,58,48,.16);font-family:inherit;font-size:12px;font-weight:600;line-height:1.3;touch-action:manipulation}
}
@media(prefers-reduced-motion:reduce){.time-issues{transition:none!important}}
</style>
