<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TimelineExtractionIssue } from '../services/organizer'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ issues: TimelineExtractionIssue[]; busy: boolean; scriptId: string }>()
const emit = defineEmits<{
  retry: [sourceNo: number]
  add: [issue: TimelineExtractionIssue]
  ignore: [ids: string[]]
  openClue: [sourceNo: number, quote?: string]
}>()
const expanded = ref(false)
function drawerKey() { return `clue-vault:time-issues-drawer:${props.scriptId}` }
function savedDrawerState() {
  try { return localStorage.getItem(drawerKey()) !== 'collapsed' } catch { return true }
}
const drawerOpen = ref(savedDrawerState())
function setDrawerOpen(open: boolean) {
  drawerOpen.value = open
  try { localStorage.setItem(drawerKey(), open ? 'open' : 'collapsed') } catch { /* The drawer remains usable without storage. */ }
}
watch(() => props.scriptId, () => { drawerOpen.value = savedDrawerState() })
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
    <div v-if="drawerOpen" class="time-issues-backdrop" @click="setDrawerOpen(false)"></div>
    <section class="time-issues" :class="{ 'is-open': drawerOpen }" aria-label="时间提取待处理事项" :aria-hidden="!drawerOpen" :inert="!drawerOpen">
      <header class="time-issues-heading"><div><h3><UiIcon name="clock" :size="19" />可能遗漏的时间 <span>{{ issues.length }}</span></h3><p>重新查找只发送 OCR 文字；结果需确认后加入时间线。</p></div><div class="time-issues-heading-actions"><button class="time-ignore-all" :disabled="busy" @click="emit('ignore', issues.map(issue => issue.id))">忽略全部提示</button><button class="time-drawer-close" aria-label="收起时间提示" @click="drawerOpen = false">收起 <span aria-hidden="true">×</span></button></div></header>
      <div class="time-issues-body">
        <article v-for="group in shownGroups" :key="group.sourceNo" class="time-source-group"><header><strong>线索 #{{ String(group.sourceNo).padStart(3, '0') }} · {{ group.issues.length }} 项</strong><button class="time-retry" :disabled="busy" @click="emit('retry', group.sourceNo)"><UiIcon name="restore" :size="16" />{{ busy ? '正在重新查找…' : '重新查找时间' }}</button></header><p class="time-retry-note">只分析本条线索的 OCR 文字；已录入的事件会保留。会调用 AI 服务并产生 API 用量。</p><div v-for="issue in (expandedSources.includes(group.sourceNo) ? group.issues : group.issues.slice(0, 3))" :key="issue.id" class="time-issue"><h4>{{ issue.title }}</h4><p>{{ issue.detail }}</p><blockquote v-if="issue.quote">{{ issue.quote }}</blockquote><footer><button v-if="issue.kind === 'missing-time'" class="time-manual" :disabled="busy" @click="emit('add', issue)">{{ issue.startsAt ? '手动补一条事件' : '填写日期和事件' }}</button><button :disabled="busy" @click="emit('openClue', issue.sourceNo, issue.quote || undefined)">查看照片</button><button class="time-ignore" :disabled="busy" @click="emit('ignore', [issue.id])">忽略这条提示</button></footer></div><button v-if="group.issues.length > 3" class="time-more" @click="expandedSources = expandedSources.includes(group.sourceNo) ? expandedSources.filter(sourceNo => sourceNo !== group.sourceNo) : [...expandedSources, group.sourceNo]">{{ expandedSources.includes(group.sourceNo) ? '收起' : `展开其余 ${group.issues.length - 3} 项` }}</button></article>
        <button v-if="groups.length > 3" class="time-more" @click="expanded = !expanded">{{ expanded ? '收起其他线索' : `还有 ${groups.length - 3} 条线索，展开处理` }}</button>
      </div>
    </section>
    <button v-if="!drawerOpen" class="time-drawer-reopen" @click="setDrawerOpen(true)"><UiIcon name="clock" :size="16" />可能遗漏的时间 <span>{{ issues.length }}</span><span aria-hidden="true">↑</span></button>
  </template>
</template>

<style scoped>
.time-issues{margin-top:18px;border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);background:var(--cv-warning-soft);overflow:hidden;color:var(--cv-ink);box-sizing:border-box}
.time-issues-heading{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:17px 19px}
.time-issues-heading h3{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;color:var(--cv-warning)}
.time-issues-heading h3 span,.time-drawer-reopen span{background:var(--cv-warning-soft);border-radius: var(--cv-radius-control);padding:2px 7px;font-size: var(--cv-type-meta)}
.time-issues-heading p{font-size:12px;line-height:1.8;margin:7px 0 0;color:var(--cv-muted)}
.time-issues-heading-actions{display:flex;flex-shrink:0;align-items:center;gap:5px}
.time-issues button{font:inherit;cursor:pointer;min-height: var(--cv-control);padding:8px 11px;border:0;border-radius:8px;background:transparent;font-size:12px;line-height:1.4;color:var(--cv-secondary);touch-action:manipulation}
.time-issues button:disabled{opacity:.5;cursor:wait}
.time-ignore-all{color:var(--cv-muted)!important}
.time-drawer-close,.time-drawer-reopen,.time-issues-backdrop{display:none}
.time-source-group{border-top:1px solid var(--cv-border);padding:14px 19px 0}
.time-source-group>header{display:flex;gap:12px;align-items:center;justify-content:space-between}
.time-source-group>header strong{font-size:12px;color:var(--cv-secondary)}
.time-retry{display:flex;gap:6px;align-items:center;background:var(--cv-accent-soft)!important;color:var(--cv-accent)!important;font-weight:600!important}
.time-retry-note{font-size: var(--cv-type-meta);color:var(--cv-muted);margin:6px 0 12px;line-height:1.6}
.time-issue{padding:12px 0;border-top:1px solid var(--cv-border)}
.time-issue h4{font-size:13px;line-height:1.6;margin:0;color:var(--cv-ink)}
.time-issue>p{font-size:12px;line-height:1.7;color:var(--cv-muted);margin:5px 0}
.time-issue blockquote{font-size:12px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--cv-muted);background:var(--cv-warning-soft);border-left:2px solid var(--cv-border);border-radius:0 7px 7px 0;margin:9px 0 0;padding:8px 11px;max-height:150px;overflow:auto}
.time-issue footer{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:8px}
.time-manual{background:var(--cv-surface)!important;border:1px solid var(--cv-border)!important;color:var(--cv-secondary)!important;font-weight:600!important}
.time-ignore{margin-left:auto;color:var(--cv-muted)!important}
.time-more{display:block;width:100%;border-radius:0!important;border-top:1px solid var(--cv-border)!important;min-height:44px!important}
@media(max-width:650px){.time-issues-heading{gap:8px;padding:14px;flex-wrap:wrap}.time-ignore-all{margin-left:auto}.time-source-group{padding:12px 14px 0}.time-issue footer{gap:3px}.time-ignore{margin-left:0}.time-source-group>header{gap:8px}.time-retry{font-size: var(--cv-type-meta)!important}}
@media (orientation:portrait){
  .time-issues-backdrop{display:block;position:fixed;inset:0;z-index:1299;background: color-mix(in srgb, var(--cv-ink) 34%, transparent)}
  .time-issues{position:fixed;z-index:1300;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));bottom:0;height:50vh;height:50dvh;max-height:50vh;max-height:50dvh;margin:0;padding-bottom:max(8px,env(safe-area-inset-bottom));display:flex;flex-direction:column;border-radius: var(--cv-radius-panel) 18px 0 0;box-shadow: var(--cv-shadow-raised);transform:translateY(calc(100% + 12px));transition:transform .22s ease-out;overscroll-behavior:contain}
  .time-issues.is-open{transform:translateY(0)}
  .time-issues-heading{flex:0 0 auto;gap:8px;padding:12px 14px 10px;border-bottom:1px solid var(--cv-border)}
  .time-issues-heading>div:first-child{min-width:0}
  .time-issues-heading h3{font-size:14px}
  .time-issues-heading p{font-size: var(--cv-type-meta);line-height:1.55;margin-top:5px}
  .time-issues-heading-actions{align-self:flex-start;gap:0}
  .time-ignore-all{font-size: var(--cv-type-meta)!important;padding:6px!important;min-height: var(--cv-control)!important;white-space:nowrap}
  .time-drawer-close{display:inline-flex!important;align-items:center;gap:4px;padding:6px 8px!important;min-height: var(--cv-control)!important;border:1px solid var(--cv-border)!important;background:var(--cv-surface)!important;color:var(--cv-muted)!important;white-space:nowrap}
  .time-drawer-close span{font-size:17px}
  .time-issues-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}
  .time-source-group{padding:10px 14px 0}
  .time-source-group>header{align-items:flex-start}
  .time-retry{max-width:58%;min-height: var(--cv-control)!important;padding:6px 8px!important;font-size: var(--cv-type-meta)!important}
  .time-retry-note{margin:5px 0 9px;font-size: var(--cv-type-meta)}
  .time-issue{padding:10px 0}
  .time-issue h4{font-size:12px}
  .time-issue>p,.time-issue blockquote{font-size: var(--cv-type-meta)}
  .time-issue footer button{min-height: var(--cv-control);padding:6px 8px;font-size: var(--cv-type-meta)}
  .time-drawer-reopen{position:fixed;z-index:1300;right:max(14px,env(safe-area-inset-right));bottom:calc(env(safe-area-inset-bottom) + 76px);display:flex;align-items:center;gap:7px;min-height: var(--cv-control);padding:0 13px;border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);background:var(--cv-warning-soft);color:var(--cv-warning);box-shadow: var(--cv-shadow-raised);font-family:inherit;font-size:12px;font-weight:600;line-height:1.3;touch-action:manipulation}
}
@media(prefers-reduced-motion:reduce){.time-issues{transition:none!important}}

.time-issues, .time-drawer-reopen { font-family: var(--cv-font); }
.time-issues { background: var(--cv-surface); border-color: var(--cv-border); }
.time-issues-heading h3 { flex-wrap: wrap; line-height: var(--cv-leading-ui); }
.time-issues-heading > div:first-child, .time-source-group > header strong { min-width: 0; overflow-wrap: anywhere; }
.time-issues-heading p, .time-issue > p, .time-issue blockquote, .time-retry-note { font-size: var(--cv-type-meta); }
.time-issues button, .time-drawer-reopen { min-height: var(--cv-control); font-size: var(--cv-type-meta); }
.time-ignore-all, .time-drawer-close, .time-retry { min-height: var(--cv-control) !important; font-size: var(--cv-type-meta) !important; }
.time-issue footer { gap: 8px; }
.time-issue footer button { min-height: var(--cv-control); font-size: var(--cv-type-meta); }
.time-issues button, .time-drawer-reopen { transition: background-color var(--cv-motion-press) var(--cv-ease); }
.time-issues button:not(:disabled):active, .time-drawer-reopen:active { filter: brightness(.94); }
.time-issues button:focus-visible, .time-drawer-reopen:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: -3px; }
.time-issue blockquote { -webkit-user-select: text; user-select: text; }
@media (prefers-reduced-motion: reduce) { .time-issues, .time-issues *, .time-drawer-reopen { animation: none !important; transition: none !important; } }

.time-issue > p, .time-issue blockquote, .time-issue h4 { font-size: var(--cv-type-summary); }
</style>
