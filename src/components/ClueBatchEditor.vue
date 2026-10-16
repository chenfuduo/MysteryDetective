<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BatchCluePatch } from '../services/clueBatch'
import type { ClueRecord } from '../services/vault'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ scriptId: string; clues: ClueRecord[]; rounds: string[]; categories: string[]; busy: boolean }>()
const emit = defineEmits<{ close: []; apply: [patch: BatchCluePatch] }>()
const dialog = ref<HTMLElement | null>(null)
const roundEnabled = ref(false), categoryEnabled = ref(false), tagsEnabled = ref(false), favoriteEnabled = ref(false)
const round = ref('1'), category = ref(''), addTagsText = ref(''), removeTagsText = ref(''), favorite = ref('true')
const previousFocus = typeof document === 'undefined' ? null : document.activeElement
const scopedClues = computed(() => props.clues.filter(clue => clue.scriptId === props.scriptId))
const preview = computed(() => scopedClues.value.slice(0, 5))
const categoryOptions = computed(() => [...new Set(props.categories.filter(Boolean))])
const roundOptions = computed(() => [...new Set(props.rounds.filter(value => /^\d+$/.test(value) && Number(value) > 0))])
function parseTags(value: string) { return [...new Set(value.split(/[\s,，、;；]+/).map(tag => tag.trim()).filter(Boolean))] }
const addTags = computed(() => parseTags(addTagsText.value))
const removeTags = computed(() => parseTags(removeTagsText.value))
const overlappingTags = computed(() => addTags.value.filter(tag => removeTags.value.includes(tag)))
const enabledCount = computed(() => Number(roundEnabled.value) + Number(categoryEnabled.value) + Number(tagsEnabled.value) + Number(favoriteEnabled.value))
const validation = computed(() => {
  if (!props.scriptId || scopedClues.value.length !== props.clues.length) return '所选线索不属于同一剧本，请关闭后重新选择。'
  if (!scopedClues.value.length) return '请先选择要修改的线索。'
  if (roundEnabled.value && (!/^\d+$/.test(round.value) || !Number.isSafeInteger(Number(round.value)) || Number(round.value) < 1)) return '轮次需要填写大于 0 的整数。'
  if (tagsEnabled.value && overlappingTags.value.length) return `不能同时添加和移除同一标签：${overlappingTags.value.join('、')}`
  if (tagsEnabled.value && !addTags.value.length && !removeTags.value.length) return '请填写要添加或移除的标签，或取消勾选标签。'
  return ''
})
const changeSummary = computed(() => {
  const values: string[] = []
  if (roundEnabled.value) values.push(`轮次改为第 ${round.value || '…'} 轮`)
  if (categoryEnabled.value) values.push(category.value.trim() ? `分类改为「${category.value.trim()}」` : '清空分类')
  if (tagsEnabled.value && addTags.value.length) values.push(`添加标签：${addTags.value.join('、')}`)
  if (tagsEnabled.value && removeTags.value.length) values.push(`移除标签：${removeTags.value.join('、')}`)
  if (favoriteEnabled.value) values.push(favorite.value === 'true' ? '加入收藏' : '取消收藏')
  return values
})
function close() { if (!props.busy) emit('close') }
function apply() {
  if (props.busy || validation.value || !enabledCount.value) return
  const patch: BatchCluePatch = {}
  if (roundEnabled.value) patch.round = Number(round.value)
  if (categoryEnabled.value) patch.category = category.value.trim()
  if (tagsEnabled.value) { patch.addTags = addTags.value; patch.removeTags = removeTags.value }
  if (favoriteEnabled.value) patch.favorite = favorite.value === 'true'
  emit('apply', patch)
}
function handleKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !dialog.value) return
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length > 0)
  if (!controls.length) { event.preventDefault(); dialog.value.focus(); return }
  const first = controls[0]!, last = controls[controls.length - 1]!, active = document.activeElement
  if (event.shiftKey && (active === first || active === dialog.value || !dialog.value.contains(active))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || active === dialog.value || !dialog.value.contains(active))) { event.preventDefault(); first.focus() }
}
watch(() => [props.scriptId, props.clues.map(clue => clue.id).join('|')], () => {
  roundEnabled.value = categoryEnabled.value = tagsEnabled.value = favoriteEnabled.value = false
  round.value = String(scopedClues.value[0]?.round || 1)
  category.value = ''; addTagsText.value = ''; removeTagsText.value = ''; favorite.value = 'true'
}, { immediate: true })
onMounted(async () => { await nextTick(); dialog.value?.focus() })
onBeforeUnmount(() => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="batch-backdrop" @click.self="close">
      <section ref="dialog" class="batch-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="clue-batch-title" :aria-busy="busy" @keydown="handleKeys">
        <header class="batch-head">
          <div><h2 id="clue-batch-title">批量修改 · {{ scopedClues.length }} 条线索</h2></div>
          <button class="batch-close" type="button" :disabled="busy" aria-label="关闭批量修改" @click="close"><UiIcon name="close" :size="21" /></button>
        </header>
        <div class="batch-scroll">
          <div class="batch-selection" aria-label="已选线索预览"><span v-for="clue in preview" :key="clue.id" :title="clue.title">#{{ String(clue.number).padStart(3, '0') }} {{ clue.title || '未命名线索' }}</span><span v-if="scopedClues.length > 5" class="batch-more">另 {{ scopedClues.length - 5 }} 条</span></div>
          <div class="batch-fields">
            <section class="batch-field" :class="{ enabled: roundEnabled }">
              <label class="batch-toggle"><input v-model="roundEnabled" type="checkbox" :disabled="busy" /><span>搜证轮次</span></label>
              <div class="batch-field-content"><label for="clue-batch-round" class="batch-sr-only">修改为第几轮</label><input id="clue-batch-round" v-model="round" type="number" inputmode="numeric" min="1" step="1" list="clue-batch-round-options" :disabled="busy || !roundEnabled" /><datalist id="clue-batch-round-options"><option v-for="value in roundOptions" :key="value" :value="value">第 {{ value }} 轮</option></datalist></div>
            </section>
            <section class="batch-field" :class="{ enabled: categoryEnabled }">
              <label class="batch-toggle"><input v-model="categoryEnabled" type="checkbox" :disabled="busy" /><span>分类</span></label>
              <div class="batch-field-content"><label for="clue-batch-category" class="batch-sr-only">修改后的分类</label><input id="clue-batch-category" v-model="category" type="text" list="clue-batch-category-options" placeholder="选择已有分类，或输入新分类" :disabled="busy || !categoryEnabled" /><datalist id="clue-batch-category-options"><option v-for="value in categoryOptions" :key="value" :value="value" /></datalist><span class="batch-hint">勾选后留空，将清空所选线索的分类</span></div>
            </section>
            <section class="batch-field" :class="{ enabled: tagsEnabled }">
              <label class="batch-toggle"><input v-model="tagsEnabled" type="checkbox" :disabled="busy" /><span>标签</span></label>
              <div class="batch-field-content batch-tags"><label>添加标签<input v-model="addTagsText" type="text" placeholder="例如：医院、监控" :disabled="busy || !tagsEnabled" /></label><label>移除标签<input v-model="removeTagsText" type="text" placeholder="填写需要移除的标签" :disabled="busy || !tagsEnabled" /></label><span class="batch-hint">多个标签用空格、逗号或顿号分隔</span></div>
            </section>
            <section class="batch-field" :class="{ enabled: favoriteEnabled }">
              <label class="batch-toggle"><input v-model="favoriteEnabled" type="checkbox" :disabled="busy" /><span>收藏</span></label>
              <div class="batch-field-content"><label for="clue-batch-favorite" class="batch-sr-only">收藏操作</label><select id="clue-batch-favorite" v-model="favorite" :disabled="busy || !favoriteEnabled"><option value="true">加入收藏</option><option value="false">取消收藏</option></select></div>
            </section>
          </div>
          <section class="batch-preview" aria-live="polite"><h3>即将修改</h3><ul v-if="changeSummary.length"><li v-for="change in changeSummary" :key="change">{{ change }}</li></ul><p v-else>先勾选需要修改的项目</p></section>
          <p v-if="validation" class="batch-error" role="alert">{{ validation }}</p>
        </div>
        <footer class="batch-actions"><button class="secondary-button" type="button" :disabled="busy" @click="close">取消</button><button class="primary-button" type="button" :disabled="busy || !enabledCount || !!validation" @click="apply">{{ busy ? '正在保存…' : `应用到 ${scopedClues.length} 条线索` }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.batch-backdrop{position:fixed;inset:0;z-index:1300;background: color-mix(in srgb, var(--cv-ink) 34%, transparent);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}.batch-dialog{width:min(640px,100%);max-height:100%;display:flex;flex-direction:column;min-height:0;background:var(--cv-surface);border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);box-shadow: var(--cv-shadow-raised);outline:none;overflow:hidden;color:var(--cv-ink)}.batch-head{display:flex;justify-content:space-between;gap:16px;padding:24px 24px 18px}.batch-head h2{font-size:21px;margin:8px 0}.batch-close{flex:none;width:44px;height:44px;background:var(--cv-surface-subtle);border:0;border-radius: var(--cv-radius-control);display:grid;place-items:center;color:var(--cv-secondary)}.batch-scroll{min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 24px 20px}.batch-selection{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 18px}.batch-selection span{font-size:12px;color:var(--cv-secondary);background:var(--cv-surface-subtle);border:1px solid var(--cv-border);padding:6px 9px;border-radius:7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.batch-selection .batch-more{background:transparent;border-color:transparent}.batch-fields{border:1px solid var(--cv-border);border-radius: var(--cv-radius-panel);overflow:hidden}.batch-field{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;padding:14px 16px;border-bottom:1px solid var(--cv-border);background:var(--cv-canvas)}.batch-field:last-child{border-bottom:0}.batch-field.enabled{background:var(--cv-surface)}.batch-toggle{display:flex;align-items:center;gap:10px;min-height:44px;align-self:start;font-weight:650;font-size:14px;cursor:pointer}.batch-toggle input{width:20px;height:20px;margin:0;accent-color:var(--cv-accent);flex:none}.batch-field-content{display:flex;flex-direction:column;gap:7px;min-width:0}.batch-field-content input,.batch-field-content select{box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--cv-border-strong);border-radius: var(--cv-radius-control);padding:10px 12px;font:inherit;font-size:var(--cv-type-input);color:var(--cv-ink);background:var(--cv-surface)}.batch-field-content input:disabled,.batch-field-content select:disabled{opacity:.5;background:var(--cv-canvas)}.batch-field-content input:focus,.batch-field-content select:focus{outline:2px solid var(--cv-focus);outline-offset:1px}.batch-hint{font-size: var(--cv-type-meta);color:var(--cv-muted);line-height:1.6}.batch-tags>label{font-size:12px;color:var(--cv-secondary);display:flex;flex-direction:column;gap:5px}.batch-tags>label+label{margin-top:5px}.batch-preview{background:var(--cv-accent-soft);border-radius:12px;padding:13px 16px;margin-top:16px}.batch-preview h3{font-size:12px;margin:0 0 7px;color:var(--cv-accent)}.batch-preview p,.batch-preview li{font-size:12px;line-height:1.8;margin:0;overflow-wrap:anywhere}.batch-preview ul{padding-left:17px;margin:0}.batch-error{font-size:12px;color:var(--cv-warning);background:var(--cv-warning-soft);border-radius:8px;padding:9px 12px;line-height:1.7;margin:12px 0 0}.batch-actions{display:flex;justify-content:flex-end;gap:10px;padding:16px 24px;border-top:1px solid var(--cv-border);background:var(--cv-surface)}.batch-actions button{min-height:44px}.batch-dialog button:disabled{opacity:.45;cursor:default}.batch-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:560px){.batch-head{padding:20px 18px 15px}.batch-head h2{font-size:19px}.batch-scroll{padding:0 18px 16px}.batch-field{grid-template-columns:1fr;gap:4px;padding:11px 14px}.batch-toggle{min-height:44px}.batch-field-content{padding-left:30px}.batch-actions{padding:14px 18px}.batch-actions .primary-button{flex:1}.batch-dialog{border-radius: var(--cv-radius-panel)}}

.batch-backdrop, .batch-dialog, .batch-dialog * { box-sizing: border-box; }
.batch-dialog { font-family: var(--cv-font); }
.batch-head > div { min-width: 0; overflow-wrap: anywhere; }
.batch-selection span { white-space: normal; overflow-wrap: anywhere; }
.batch-dialog button { min-height: var(--cv-control); transition: background-color var(--cv-motion-press) var(--cv-ease); touch-action: manipulation; }
.batch-dialog button:not(:disabled):active { filter: brightness(.94); }
.batch-dialog button:focus-visible, .batch-toggle input:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
.batch-actions { flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) { .batch-dialog, .batch-dialog * { animation: none !important; transition: none !important; } }

.batch-preview p, .batch-preview li { font-size: var(--cv-type-summary); line-height: var(--cv-leading-reading); }
</style>
