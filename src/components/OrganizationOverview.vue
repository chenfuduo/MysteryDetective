<script setup lang="ts">
import { computed } from 'vue'
import type { ClueRecord, OrganizationSnapshot, PersonRecord, RelationshipRecord, TimelineRecord } from '../services/vault'

const props = defineProps<{
  clues: ClueRecord[]
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  events: TimelineRecord[]
  organization: OrganizationSnapshot | null
  busy: boolean
  autoOrganize: boolean
  apiConfigured: boolean
}>()
const emit = defineEmits<{
  analyze: []
  navigate: [view: 'clues' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings']
  openClue: [sourceNo: number]
  acceptPerson: [id: string]
  acceptRelationship: [id: string]
  acceptTimeline: [id: string]
  acceptCluePoint: [id: string]
}>()
const cluePointCount = computed(() => new Set((props.organization?.cluePoints || []).map(item => item.sourceNo)).size)
const pendingCount = computed(() => {
  const result = props.organization
  return result ? result.people.length + result.relationships.length + result.timeline.length + result.cluePoints.length : 0
})
const clueFor = (sourceNo: number) => props.clues.find(clue => clue.number === sourceNo)
const dateLabel = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
</script>

<template>
  <section class="page organization-page">
    <header class="page-header">
      <div><h1>整理总览</h1><p>人物、关系、时间和线索主题集中在这里，每项都能回到原始线索。</p></div>
      <button class="primary-button" :disabled="busy || !clues.some(item => item.ocrText.trim())" @click="emit('analyze')">{{ busy ? '正在整理…' : '整理全部线索' }}</button>
    </header>

    <div class="organize-hero">
      <div><span class="organize-eyebrow">当前剧本</span><h2>{{ clues.length }} 条线索，{{ pendingCount }} 条待确认建议</h2><p v-if="!apiConfigured">先在「剧本管理」保存 DeepSeek API Key，再开始整理。</p><p v-else-if="autoOrganize">新录入线索会自动整理；你也可以随时重新整理全部线索。</p><p v-else>点击“整理全部线索”，从 OCR 文字中提取人物、关系、时间和线索主题。</p></div>
      <button v-if="!apiConfigured" class="secondary-button" @click="emit('navigate', 'settings')">配置 API Key</button>
      <button v-else class="secondary-button" :disabled="busy || !clues.length" @click="emit('analyze')">{{ busy ? '整理中' : '立即整理' }}</button>
    </div>

    <div class="organize-stats">
      <button class="organize-stat" @click="emit('navigate', 'people')"><span>人物</span><strong>{{ people.length }}</strong><small>人物档案</small></button>
      <button class="organize-stat" @click="emit('navigate', 'people')"><span>人物关系</span><strong>{{ relationships.length }}</strong><small>已确认关系</small></button>
      <button class="organize-stat" @click="emit('navigate', 'timeline')"><span>时间线</span><strong>{{ events.filter(item => item.confirmed).length }}</strong><small>{{ events.filter(item => !item.confirmed).length }} 个时间待核对</small></button>
      <button class="organize-stat" @click="emit('navigate', 'clues')"><span>线索主题</span><strong>{{ cluePointCount }}</strong><small>来自 OCR 文字</small></button>
    </div>

    <div class="organize-tools">
      <button @click="emit('navigate', 'people')"><span>人物档案</span><small>人物名单与手动关系图</small></button>
      <button @click="emit('navigate', 'timeline')"><span>事件时间线</span><small>查看已确认事件和原始线索</small></button>
      <button @click="emit('navigate', 'board')"><span>自由整理板</span><small>手动连接线索与人物</small></button>
      <button @click="emit('navigate', 'notes')"><span>笔记</span><small>记录自己的观察</small></button>
      <button @click="emit('navigate', 'compare')"><span>线索对照</span><small>并排查看原图和 OCR</small></button>
    </div>

    <section class="organization-results">
      <header class="organization-results-head"><div><h2>待确认建议</h2><p>确认后才会加入人物档案、关系图或正式时间线。</p></div><span v-if="organization">更新于 {{ dateLabel(organization.updatedAt) }}</span></header>
      <div v-if="!organization" class="organization-empty"><strong>还没有整理结果</strong><span>整理结果只基于本剧本的 OCR 文字；照片不会发送。</span></div>
      <div v-else-if="!pendingCount" class="organization-empty"><strong>目前没有待确认建议</strong><span>如果新录入了线索，可以重新整理。</span></div>
      <div v-else class="suggestion-groups">
        <section v-if="organization.people.length" class="suggestion-group"><h3>人物 <small>{{ organization.people.length }}</small></h3><article v-for="item in organization.people" :key="item.id" class="suggestion-card"><div class="suggestion-copy"><strong>{{ item.name }}<small v-if="item.aliases.length">又名 {{ item.aliases.join('、') }}</small></strong><blockquote>{{ item.quote }}</blockquote><button class="source-link" @click="emit('openClue', item.sourceNo)">查看线索 #{{ String(item.sourceNo).padStart(3, '0') }}</button></div><button class="suggestion-accept" @click="emit('acceptPerson', item.id)">加入人物档案</button></article></section>
        <section v-if="organization.relationships.length" class="suggestion-group"><h3>人物关系 <small>{{ organization.relationships.length }}</small></h3><article v-for="item in organization.relationships" :key="item.id" class="suggestion-card"><div class="suggestion-copy"><strong>{{ item.from }} <span>{{ item.label }}</span> {{ item.to }}</strong><blockquote>{{ item.quote }}</blockquote><button class="source-link" @click="emit('openClue', item.sourceNo)">查看线索 #{{ String(item.sourceNo).padStart(3, '0') }}</button></div><button class="suggestion-accept" @click="emit('acceptRelationship', item.id)">确认关系</button></article></section>
        <section v-if="organization.timeline.length" class="suggestion-group"><h3>时间节点 <small>{{ organization.timeline.length }}</small></h3><article v-for="item in organization.timeline" :key="item.id" class="suggestion-card"><div class="suggestion-copy"><strong>{{ dateLabel(item.startsAt) }} · {{ item.title }}</strong><blockquote>{{ item.quote }}</blockquote><button class="source-link" @click="emit('openClue', item.sourceNo)">查看线索 #{{ String(item.sourceNo).padStart(3, '0') }}</button></div><button class="suggestion-accept" @click="emit('acceptTimeline', item.id)">确认时间节点</button></article></section>
        <section v-if="organization.cluePoints.length" class="suggestion-group"><h3>线索主题 <small>{{ organization.cluePoints.length }}</small></h3><article v-for="item in organization.cluePoints" :key="item.id" class="suggestion-card"><div class="suggestion-copy"><strong>{{ item.title }}<small>{{ [item.category, ...item.tags].filter(Boolean).join(' · ') }}</small></strong><blockquote>{{ item.quote }}</blockquote><button class="source-link" @click="emit('openClue', item.sourceNo)">查看线索 #{{ String(item.sourceNo).padStart(3, '0') }}</button></div><button class="suggestion-accept" @click="emit('acceptCluePoint', item.id)">应用到线索</button></article></section>
      </div>
    </section>
    <p class="organize-disclosure">AI 结果可能识别错误。人物关系和时间节点需你确认；系统不会推断因果、动机或案件答案。发送到 DeepSeek 的内容只有 OCR 文字与线索编号。</p>
  </section>
</template>

<style scoped>
.organization-page{gap:18px}.organization-page .page-header{margin-bottom:0}.organize-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;border:1px solid #e8e8df;border-radius:13px;padding:20px 23px;background:linear-gradient(110deg,#f8f7f1,#fcf8f3)}.organize-eyebrow{font-size:10px;color:#a45e42;font-weight:700;letter-spacing:.08em}.organize-hero h2{margin:6px 0;font-size:18px;color:#39443b}.organize-hero p{margin:0;color:#869086;font-size:11px;line-height:1.6}.organize-hero>.secondary-button{white-space:nowrap}.organize-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}.organize-stat{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;border:1px solid #e9ece7;border-radius:10px;background:#fff;padding:15px 17px;color:#89928a}.organize-stat span{font-size:10px}.organize-stat strong{font-size:24px;line-height:1.1;color:#3b483e}.organize-stat small{font-size:10px;color:#a1a9a0}.organize-stat:hover,.organize-tools button:hover{border-color:#d3b29c;background:#fdfaf7}.organize-tools{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.organize-tools button{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;border:1px solid #e9ece7;border-radius:9px;background:#fff;padding:13px 14px;color:#59655b}.organize-tools button span{font-size:11px;font-weight:700}.organize-tools button small{font-size:9px;line-height:1.5;color:#98a198}.organization-results{border:1px solid #e8ebe6;border-radius:12px;background:#fff;overflow:hidden}.organization-results-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;padding:17px 19px;border-bottom:1px solid #eff1ed}.organization-results-head h2{font-size:14px;margin:0 0 5px;color:#414b42}.organization-results-head p,.organization-results-head>span{font-size:10px;color:#9aa39a;margin:0}.suggestion-groups{padding:0 18px}.suggestion-group{padding:15px 0;border-bottom:1px solid #eff1ed}.suggestion-group:last-child{border-bottom:0}.suggestion-group h3{font-size:11px;color:#a45e42;margin:0 0 9px}.suggestion-group h3 small{font-size:9px;color:#a4aba4;margin-left:5px}.suggestion-card{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:10px 0;border-top:1px solid #f3f4f1}.suggestion-copy{min-width:0}.suggestion-copy>strong{display:block;color:#4c574e;font-size:11px;line-height:1.5}.suggestion-copy>strong small{display:block;font-weight:400;color:#8f998f;font-size:9px;margin-top:3px}.suggestion-copy blockquote{margin:5px 0;color:#7e897f;font-size:10px;line-height:1.6;white-space:pre-wrap}.suggestion-copy blockquote:before{content:'“';color:#c49a7d}.suggestion-copy blockquote:after{content:'”';color:#c49a7d}.source-link{background:none;color:#a25d41;padding:0;font-size:9px}.suggestion-accept{border:1px solid #ead8cb;background:#fffaf5;color:#99583e;border-radius:6px;padding:7px 10px;font-size:10px;white-space:nowrap}.suggestion-accept:hover{background:#f8ede4}.organization-empty{min-height:112px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:#566259}.organization-empty strong{font-size:12px}.organization-empty span,.organize-disclosure{font-size:10px;color:#9aa39a;line-height:1.65}.organize-disclosure{margin:0;padding:0 2px}@media(max-width:900px){.organize-tools{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:620px){.organization-page{gap:13px}.organize-hero{align-items:flex-start;flex-direction:column;padding:16px}.organize-hero h2{font-size:16px}.organize-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.organize-stat{padding:12px}.organize-tools{grid-template-columns:repeat(2,minmax(0,1fr))}.organization-results-head{align-items:flex-start;flex-direction:column;padding:15px}.suggestion-groups{padding:0 13px}.suggestion-card{align-items:flex-start;flex-direction:column;gap:8px}.suggestion-accept{align-self:flex-end}.suggestion-copy blockquote{font-size:10px}}
</style>
