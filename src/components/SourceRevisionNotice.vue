<script setup lang="ts">
import { computed } from 'vue'
import type { SourceRevisionReview } from '../services/sourceRevision'
import UiIcon from './UiIcon.vue'
const headingId = `source-revision-heading-${crypto.randomUUID()}`
const props = defineProps<{ reviews: SourceRevisionReview[]; busy?: boolean }>()
const emit = defineEmits<{
  openClue: [id: string, quote?: string];
  reviewed: [clueId: string, revision: number];
  reviewedAll: [items: { clueId: string; revision: number }[]];
  focusEvent: [id: string];
}>()
const eventCount = computed(() => new Set(props.reviews.flatMap(review => review.affectedEvents.map(event => event.id))).size)
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }
function timeLabel(value: string) { return value.replace(/^--/, '').replace('T', ' ') }
</script>

<template>
  <section v-if="reviews.length" class="source-revision-notice" :aria-labelledby="headingId">
    <header class="revision-head">
      <div class="revision-icon"><UiIcon name="file" :size="20" /></div>
      <div><h3 :id="headingId">原文有更新，关联记录待核对 <span>{{ reviews.length }}</span></h3><p>{{ reviews.length }} 条线索的 OCR 已修改<span v-if="eventCount">，涉及 {{ eventCount }} 个已确认事件</span>。已有事件的时间与标题保留。</p></div>
    </header>
    <div class="revision-sources">
      <details v-for="review in reviews" :key="`${review.clueId}:${review.revision}`" class="revision-source">
        <summary><span class="source-number">#{{ String(review.sourceNo).padStart(3, '0') }}</span><span class="source-title">{{ review.clueTitle || '未命名线索' }}</span><span class="source-count">{{ review.affectedEvents.length }} 个事件 · {{ review.pendingCount }} 条建议</span><UiIcon name="chevron" :size="16" /></summary>
        <div class="revision-content">
          <div class="revision-meta"><span>{{ dateLabel(review.updatedAt) }} · 原文第 {{ review.revision }} 次更新</span><button class="revision-link" :disabled="busy" @click="emit('openClue', review.clueId)"><UiIcon name="image" :size="15" />查看原图与当前 OCR</button></div>
          <div class="revision-diff"><section><h4>上次核对前的原文</h4><pre>{{ review.previousText }}</pre></section><section><h4>当前原文</h4><pre>{{ review.currentText || '（当前文字为空）' }}</pre></section></div>
          <div v-if="review.affectedEvents.length" class="revision-events"><h4>关联的已确认事件</h4><article v-for="event in review.affectedEvents" :key="event.id"><div><span class="event-time">{{ timeLabel(event.startsAt) }}</span><strong>{{ event.title }}</strong><blockquote v-if="event.quote">{{ event.quote }}</blockquote><p v-else class="quote-empty">此事件关联了该线索，尚未保存文字摘录。</p></div><button class="secondary-button" :disabled="busy" @click="emit('focusEvent', event.id)">查看事件</button></article></div>
          <details v-if="review.pendingQuotes.length" class="pending-quotes"><summary>查看 {{ review.pendingCount }} 条待确认建议中的摘录</summary><blockquote v-for="quote in review.pendingQuotes" :key="quote">{{ quote }}</blockquote></details>
          <footer><p>确认后记录本次核对状态；再次修改原文会重新提示。</p><button class="primary-button" :disabled="busy" @click="emit('reviewed', review.clueId, review.revision)"><UiIcon name="check" :size="16" />已核对，保留现有记录</button></footer>
        </div>
      </details>
    </div>
    <details v-if="reviews.length > 1" class="revision-bulk"><summary>批量核对</summary><div><p>完成全部原文与关联事件核对后，可一次关闭当前 {{ reviews.length }} 条提醒。</p><button class="secondary-button" :disabled="busy" @click="emit('reviewedAll', reviews.map(review => ({ clueId: review.clueId, revision: review.revision })))">全部已核对，保留现有记录</button></div></details>
  </section>
</template>

<style scoped>
.source-revision-notice{border:1px solid var(--cv-warning-soft);background:var(--cv-warning-soft);border-radius: var(--cv-radius-panel);overflow:hidden;margin:0 0 18px;color:var(--cv-ink)}.revision-head{display:flex;gap:12px;padding:18px 20px}.revision-icon{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;background:var(--cv-warning-soft);color:var(--cv-warning)}.revision-head h3{font-size:15px;line-height:1.5;margin:0;display:flex;align-items:center;gap:8px}.revision-head h3 span{font-size: var(--cv-type-meta);font-weight:600;background:var(--cv-warning-soft);color:var(--cv-warning);padding:2px 7px;border-radius: var(--cv-radius-panel)}.revision-head p{font-size:12px;color:var(--cv-muted);line-height:1.8;margin:5px 0 0}.revision-source{border-top:1px solid var(--cv-border)}.revision-source>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;padding:14px 20px;min-height:48px}.revision-source>summary::-webkit-details-marker{display:none}.revision-source>summary>svg{transition:transform .15s}.revision-source[open]>summary>svg{transform:rotate(90deg)}.source-number{font-size:12px;color:var(--cv-warning);flex-shrink:0}.source-title{font-size:13px;font-weight:650;overflow-wrap:anywhere;min-width:0;flex:1}.source-count{font-size: var(--cv-type-meta);color:var(--cv-muted);flex-shrink:0}.revision-content{padding:0 20px 16px}.revision-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 13px;font-size: var(--cv-type-meta);color:var(--cv-muted)}.revision-link{display:inline-flex;align-items:center;gap:5px;padding:7px 0;color:var(--cv-accent);font:inherit;background:transparent;border:0;cursor:pointer}.revision-diff{display:grid;grid-template-columns:1fr 1fr;gap:12px}.revision-diff>section{min-width:0;border:1px solid var(--cv-border);border-radius: var(--cv-radius-control);background:var(--cv-surface);overflow:hidden}.revision-content h4{font-size:12px;line-height:1.5;margin:0;color:var(--cv-secondary);font-weight:650}.revision-diff h4{padding:10px 12px;background:var(--cv-surface-subtle);border-bottom:1px solid var(--cv-border)}.revision-diff>section:last-child h4{background:var(--cv-accent-soft)}.revision-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow-y:auto;margin:0;padding:12px;font:12px/1.9 inherit;color:var(--cv-secondary);-webkit-user-select:text;user-select:text}.revision-events{margin-top:16px}.revision-events article{display:flex;align-items:flex-start;gap:15px;padding:12px 0;border-bottom:1px solid var(--cv-border)}.revision-events article>div{min-width:0;flex:1}.revision-events strong{display:block;font-size:13px;line-height:1.7;margin-top:3px}.event-time{font-size: var(--cv-type-meta);color:var(--cv-warning)}.revision-events .secondary-button{font-size: var(--cv-type-meta);padding:8px 11px;min-height: var(--cv-control);flex-shrink:0}.revision-content blockquote{margin:7px 0 0;border-left:2px solid var(--cv-border);padding:2px 0 2px 10px;color:var(--cv-muted);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}.quote-empty{font-size: var(--cv-type-meta);color:var(--cv-muted);margin:5px 0 0}.pending-quotes{padding-top:14px;color:var(--cv-muted);font-size:12px}.pending-quotes summary{cursor:pointer;min-height: var(--cv-control)}.revision-content footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:15px}.revision-content footer p,.revision-bulk p{font-size: var(--cv-type-meta);line-height:1.8;color:var(--cv-muted);margin:0}.revision-content footer .primary-button{font-size:12px;padding:10px 13px;display:inline-flex;align-items:center;gap:6px;flex-shrink:0}.revision-bulk{padding:12px 20px;border-top:1px solid var(--cv-border);font-size:12px;color:var(--cv-muted)}.revision-bulk summary{cursor:pointer;min-height: var(--cv-control)}.revision-bulk>div{display:flex;gap:15px;align-items:center;justify-content:space-between;padding:5px 0 2px}.revision-bulk button{font-size: var(--cv-type-meta);flex-shrink:0;padding:9px 12px}.source-revision-notice button:disabled{opacity:.5;cursor:wait}@media(max-width:650px){.revision-head{padding:15px}.revision-source>summary{padding:13px 15px;flex-wrap:wrap}.source-count{margin-left:auto}.revision-content{padding:0 15px 15px}.revision-diff{grid-template-columns:1fr}.revision-diff pre{max-height:190px}.revision-meta,.revision-content footer,.revision-bulk>div{align-items:flex-start;flex-direction:column;gap:7px}.revision-content footer button,.revision-bulk button{align-self:flex-end}.revision-bulk{padding:12px 15px}.revision-events article{gap:8px}.revision-head h3{font-size:14px}}

.source-revision-notice { font-family: var(--cv-font); background: var(--cv-surface); border-color: var(--cv-border); }
.revision-head > div:last-child { min-width: 0; }
.revision-head h3 { flex-wrap: wrap; overflow-wrap: anywhere; }
.revision-head p, .revision-content footer p, .revision-bulk p { color: var(--cv-secondary); }
.revision-diff pre { font-family: var(--cv-font); font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); }
.revision-content button, .source-revision-notice summary, .revision-events .secondary-button { min-height: var(--cv-control); }
.revision-link { padding: 8px 10px; text-align: left; }
.revision-meta { flex-wrap: wrap; }
.source-revision-notice button, .source-revision-notice summary { transition: background-color var(--cv-motion-press) var(--cv-ease); touch-action: manipulation; }
.source-revision-notice button:not(:disabled):active, .source-revision-notice summary:active { filter: brightness(.94); }
.source-revision-notice button:focus-visible, .source-revision-notice summary:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: -3px; }
.revision-events strong { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .source-revision-notice, .source-revision-notice * { animation: none !important; transition: none !important; } }

.revision-content blockquote, .revision-events strong { font-size: var(--cv-type-summary); }
</style>
