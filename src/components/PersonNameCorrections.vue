<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClueRecord, PersonRecord } from '../services/vault'
import type { ReviewUndo } from '../services/reviewActions'
import { removePersonOcrName, savePersonOcrName } from '../services/personNameCorrections'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ scriptId: string; personId: string; people: PersonRecord[]; clues: ClueRecord[]; busy: boolean }>()
const emit = defineEmits<{ close: []; changed: [undo: ReviewUndo] }>()
const person = computed(() => props.people.find(item => item.id === props.personId && item.scriptId === props.scriptId))
const clues = computed(() => props.clues.filter(item => item.scriptId === props.scriptId))
const value = ref(''), error = ref(''), message = ref(''), submitting = ref(false), localNames = ref<string[]>([])
const input = ref<HTMLInputElement | null>(null), panel = ref<HTMLElement | null>(null)
const locked = computed(() => props.busy || submitting.value)
const matches = computed(() => value.value.trim() ? clues.value.filter(clue => clue.ocrText.includes(value.value.trim())) : [])
function matchingCount(name: string) { return clues.value.filter(clue => clue.ocrText.includes(name)).length }
function close() { if (!locked.value) emit('close') }
function previewText(clue: ClueRecord) {
  const start = Math.max(0, clue.ocrText.indexOf(value.value.trim()) - 24)
  return `${start ? '…' : ''}${clue.ocrText.slice(start, start + 110)}${clue.ocrText.length > start + 110 ? '…' : ''}`
}
async function save() {
  if (locked.value || !person.value || !value.value.trim()) return
  const scriptId = props.scriptId, personId = props.personId, wrongName = value.value.trim()
  submitting.value = true; error.value = ''; message.value = ''
  try {
    const undo = await savePersonOcrName(scriptId, personId, wrongName)
    if (props.scriptId !== scriptId || props.personId !== personId) return
    localNames.value = [...localNames.value, wrongName]
    value.value = ''; message.value = '已保存，当前剧本的姓名匹配会使用这条规则。'; emit('changed', undo)
    await nextTick(); input.value?.focus()
  } catch (cause) { if (props.scriptId === scriptId && props.personId === personId) error.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { submitting.value = false }
}
async function remove(wrongName: string) {
  if (locked.value || !person.value) return
  const scriptId = props.scriptId, personId = props.personId
  submitting.value = true; error.value = ''; message.value = ''
  try {
    const undo = await removePersonOcrName(scriptId, personId, wrongName)
    if (props.scriptId !== scriptId || props.personId !== personId) return
    localNames.value = localNames.value.filter(name => name !== wrongName)
    message.value = '已移除这条姓名匹配规则。'; emit('changed', undo)
  } catch (cause) { if (props.scriptId === scriptId && props.personId === personId) error.value = cause instanceof Error ? cause.message : '移除失败，请重试' }
  finally { submitting.value = false }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(item => item.getClientRects().length)
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
let previousFocus: HTMLElement | null = null
watch(() => person.value, current => { localNames.value = [...(current?.ocrNames || [])] }, { immediate: true })
watch(() => `${props.scriptId}:${props.personId}`, () => { value.value = ''; error.value = ''; message.value = '' })
onMounted(async () => { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); input.value?.focus() })
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="correction-backdrop" @click.self="close">
      <section ref="panel" class="correction-panel" role="dialog" aria-modal="true" aria-labelledby="correction-title" tabindex="-1" @keydown="keydown">
        <header><div><span class="eyebrow">当前剧本 · {{ person?.name || '人物' }}</span><h2 id="correction-title">姓名识别纠错</h2></div><button type="button" class="icon-button" :disabled="locked" aria-label="关闭姓名识别纠错" @click="close"><UiIcon name="close" /></button></header>
        <div class="correction-body">
          <template v-if="person">
            <p class="explanation">把 OCR 识别错的姓名明确对应到 <strong>{{ person.name }}</strong>。之后查找相关线索、匹配事件和整理新线索时，会使用这条规则。</p>
            <p class="source-note">仅对当前剧本生效，逐字匹配；原始照片、OCR 原文和出处摘录保持原样。</p>
            <form class="correction-form" @submit.prevent="save">
              <label for="ocr-wrong-name">OCR 中的识别错名</label>
              <div class="correction-input"><input id="ocr-wrong-name" ref="input" v-model="value" :disabled="locked" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="从 OCR 原文复制识别错的姓名" /><button type="submit" :disabled="locked || !value.trim()">{{ submitting ? '处理中…' : '添加规则' }}</button></div>
              <div v-if="value.trim()" class="correction-preview"><strong>当前 {{ matches.length }} 条线索包含“{{ value.trim() }}”</strong><p v-if="!matches.length">当前没有匹配的 OCR 原文；保存后也可用于后续录入。</p><ul v-else><li v-for="clue in matches.slice(0, 4)" :key="clue.id"><span>#{{ String(clue.number).padStart(3, '0') }} · {{ clue.title || '未命名线索' }}</span><p>{{ previewText(clue) }}</p></li></ul><small v-if="matches.length > 4">另有 {{ matches.length - 4 }} 条匹配线索</small></div>
            </form>
            <p v-if="error" class="correction-error" role="alert">{{ error }}</p><p v-if="message" class="correction-message" role="status">{{ message }}</p>
            <section class="correction-rules"><h3>已确认的识别错名 <span>{{ localNames.length }}</span></h3><ul v-if="localNames.length"><li v-for="name in localNames" :key="name"><div><strong>{{ name }} <span aria-hidden="true">→</span> {{ person.name }}</strong><small>当前 {{ matchingCount(name) }} 条线索匹配</small></div><button type="button" :disabled="locked" :aria-label="`移除识别错名${name}`" @click="remove(name)">移除</button></li></ul><p v-else class="rules-empty">暂未添加。这里只收录你确认的错名，不会自动猜测。</p></section>
          </template>
          <p v-else class="rules-empty">当前剧本中找不到该人物，请关闭后重新打开。</p>
        </div>
        <footer><span>添加与移除均可在操作历史中撤销</span><button type="button" :disabled="locked" @click="close">完成</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.correction-backdrop,.correction-backdrop *{box-sizing:border-box}.correction-backdrop{position:fixed;inset:0;z-index:1350;display:flex;align-items:center;justify-content:center;padding:max(22px,env(safe-area-inset-top)) 20px max(22px,env(safe-area-inset-bottom));background:#25382c66;backdrop-filter:blur(5px)}.correction-panel{display:flex;flex-direction:column;width:min(640px,100%);max-height:100%;min-height:0;border:1px solid #dde6d7;border-radius:22px;overflow:hidden;background:#fcfdf9;color:#354f3f;box-shadow:0 24px 80px #20372c33;outline:none}.correction-panel header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:23px 25px 18px}.eyebrow{font-size:12px;color:#899a80}.correction-panel h2{margin:5px 0 0;font-size:22px}.correction-panel button,.correction-panel input{font:inherit}.correction-panel button{cursor:pointer;min-height:44px;border:1px solid #dce6d5;border-radius:10px;background:#fff;color:#52754c;padding:9px 13px}.correction-panel button:disabled{opacity:.5;cursor:default}.correction-panel .icon-button{display:grid;place-items:center;width:44px;flex-shrink:0;padding:9px;background:#eef3e9;border:0}.correction-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 25px 24px}.explanation{margin:0;font-size:14px;line-height:1.85;color:#6b8062}.explanation strong{color:#42623f}.source-note{font-size:12px;line-height:1.8;color:#9a9e86;margin:9px 0 21px}.correction-form label{display:block;font-size:12px;color:#71866a;margin-bottom:9px}.correction-input{display:flex;gap:9px}.correction-input input{flex:1;min-width:0;min-height:46px;padding:10px 12px;border:1px solid #d5e0ce;border-radius:10px;outline:none;background:#fff;color:#35533b;user-select:text;-webkit-user-select:text;font-size:14px}.correction-input input:focus{border-color:#87a27e;box-shadow:0 0 0 3px #edf3e8}.correction-input input::placeholder{color:#a2ac97;font-size:12px}.correction-input button{flex-shrink:0;background:#3d674d;color:#fff;border-color:#3d674d;font-size:13px}.correction-preview{margin-top:12px;padding:13px 14px;background:#f1f5ec;border:1px solid #e1e9d9;border-radius:12px}.correction-preview>strong{font-size:12px;color:#637d56;overflow-wrap:anywhere}.correction-preview ul,.correction-rules ul{list-style:none;margin:0;padding:0}.correction-preview li{margin-top:11px;border-top:1px solid #e2e9da;padding-top:10px}.correction-preview li>span{font-size:11px;color:#809371}.correction-preview p{font-size:12px;color:#819276;line-height:1.8;margin:5px 0 0;overflow-wrap:anywhere}.correction-preview small{display:block;color:#98a28b;font-size:11px;margin-top:9px}.correction-error,.correction-message{margin:13px 0 0;padding:10px 12px;border-radius:9px;font-size:12px;line-height:1.7}.correction-error{background:#fcf0e8;color:#a66f4a}.correction-message{background:#edf4e8;color:#648555}.correction-rules{margin-top:25px;padding-top:17px;border-top:1px solid #e4eadd}.correction-rules h3{display:flex;align-items:center;gap:8px;margin:0 0 9px;font-size:13px;color:#627b59}.correction-rules h3 span{font-size:11px;padding:3px 6px;border-radius:5px;background:#eaf0e4}.correction-rules li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #e9eee2}.correction-rules li>div{display:flex;flex-direction:column;gap:7px;min-width:0}.correction-rules li strong{font-size:14px;line-height:1.7;font-weight:550;overflow-wrap:anywhere}.correction-rules li strong span{color:#a5b39a;padding:0 7px}.correction-rules li small{font-size:11px;color:#95a08b}.correction-rules li button{flex-shrink:0;font-size:12px}.rules-empty{margin:13px 0 0;color:#9aa58e;font-size:12px;line-height:1.8}.correction-panel footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 25px;border-top:1px solid #e4ebdc;background:#f5f8f0}.correction-panel footer span{font-size:11px;color:#96a087;line-height:1.7}.correction-panel footer button{font-size:13px;min-width:72px}.correction-panel button:focus-visible{outline:2px solid #709168;outline-offset:3px}@media(max-width:560px){.correction-backdrop{padding:max(12px,env(safe-area-inset-top)) 10px max(12px,env(safe-area-inset-bottom))}.correction-panel header{padding:20px 18px 16px}.correction-body{padding:0 18px 20px}.correction-panel footer{padding:13px 18px}.correction-input{flex-wrap:wrap}.correction-input input{flex-basis:100%}.correction-input button{width:100%}}
</style>
