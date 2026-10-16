<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'

type WorkspaceView = 'clues' | 'organize' | 'people' | 'timeline' | 'board' | 'notes' | 'compare' | 'settings'
type PeopleSection = 'profiles' | 'relationships'

defineProps<{ scriptName: string }>()
const emit = defineEmits<{
  close: []
  navigate: [view: WorkspaceView, section?: PeopleSection]
  'open-search': []
}>()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let previousFocus: HTMLElement | null = null

const tools: { icon: string; title: string; text: string; view: WorkspaceView; section?: PeopleSection }[] = [
  { icon: 'person', title: '人物档案', text: '查看人物的线索与事件；同一个人的重复档案可手动合并。', view: 'people', section: 'profiles' },
  { icon: 'relationship', title: '人物关系', text: '长按人物进入连线模式，再选择另一人，输入关系后确认。', view: 'people', section: 'relationships' },
  { icon: 'timeline', title: '时间线', text: '按人物筛选、调节间距；找不到事件时点“显示全部”。有年份与无年份事件在同一条轴上，以颜色区分。', view: 'timeline' },
  { icon: 'board', title: '自由整理板', text: '把人物、线索与便签放到画布上，手动摆放和连接。', view: 'board' },
  { icon: 'compare', title: '记录对照', text: '并排核对两条记录和原文，写下自己的核对备注。', view: 'compare' },
  { icon: 'archive', title: '备份与回收', text: '在剧本管理中导出档案，或从回收站恢复误删的线索。', view: 'settings' },
]

function navigate(view: WorkspaceView, section?: PeopleSection) {
  emit('close')
  emit('navigate', view, section)
}
function search() {
  emit('close')
  emit('open-search')
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const controls = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'))
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', keydown)
  await nextTick()
  closeButton.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydown)
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div class="guide-backdrop" @click.self="emit('close')">
      <section ref="dialog" class="workspace-guide" role="dialog" aria-modal="true" aria-labelledby="workspace-guide-title">
        <header class="guide-header">
          <div>
            <p class="guide-eyebrow">{{ scriptName || '迹册' }} · 使用帮助</p>
            <h2 id="workspace-guide-title">从一张照片开始</h2>
          </div>
          <button ref="closeButton" type="button" class="guide-close" aria-label="关闭使用帮助" @click="emit('close')"><UiIcon name="close" :size="22" /></button>
        </header>

        <div class="guide-content">
          <p class="guide-intro">先收集，再核对，最后按人物与时间查阅。</p>
          <nav class="guide-steps" aria-label="线索整理流程">
            <button type="button" @click="navigate('clues')">
              <span class="step-number">1</span>
              <span><strong>拍照录入</strong><small>选好轮次，拍照或批量导入</small></span>
              <UiIcon name="chevron" :size="17" />
            </button>
            <button type="button" @click="navigate('organize')">
              <span class="step-number">2</span>
              <span><strong>核对建议</strong><small>查看原文，再确认整理结果</small></span>
              <UiIcon name="chevron" :size="17" />
            </button>
            <button type="button" @click="navigate('people', 'profiles')">
              <span class="step-number">3</span>
              <span><strong>查阅整理</strong><small>用人物、关系和时间串起记录</small></span>
              <UiIcon name="chevron" :size="17" />
            </button>
          </nav>

          <div class="guide-section-heading">
            <h3>常用工具</h3>
            <button type="button" class="guide-search" @click="search"><UiIcon name="search" :size="17" />全局搜索</button>
          </div>
          <div class="guide-tools">
            <button v-for="tool in tools" :key="tool.title" type="button" class="guide-tool" @click="navigate(tool.view, tool.section)">
              <span class="tool-icon"><UiIcon :name="tool.icon" :size="21" /></span>
              <span class="tool-copy"><strong>{{ tool.title }}</strong><span>{{ tool.text }}</span></span>
              <UiIcon class="tool-chevron" name="chevron" :size="16" />
            </button>
          </div>
          <button type="button" class="guide-note" @click="navigate('notes')"><UiIcon name="note" :size="18" />随时记下自己的观察<UiIcon name="chevron" :size="16" /></button>
          <aside class="guide-footnote">
            <UiIcon name="info" :size="18" />
            <p>照片与 OCR 文字保存在本机；使用 AI 整理时只发送 OCR 文字。确认建议后，可撤销最近一次操作。整理结果都应回到原文核对。</p>
          </aside>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.guide-backdrop { position: fixed; inset: 0; z-index: 1250; display: flex; align-items: center; justify-content: center; padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--cv-ink) 34%, transparent); }
.workspace-guide { width: min(640px, 100%); max-height: 100%; max-height: min(880px, calc(100dvh - 40px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); color: var(--cv-ink); box-shadow: var(--cv-shadow-raised); }
.guide-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-shrink: 0; padding: 24px 26px 19px; border-bottom: 1px solid var(--cv-border); }
.guide-eyebrow { margin: 0 0 8px; color: var(--cv-warning); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
h2 { margin: 0; font-size: 24px; line-height: 1.5; letter-spacing: 0; }
button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
button:focus-visible { outline: 3px solid var(--cv-focus); outline-offset: 3px; }
.guide-close { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: var(--cv-radius-control); background: var(--cv-surface-subtle); color: var(--cv-secondary); }
.guide-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 26px 24px; -webkit-overflow-scrolling: touch; }
.guide-intro { margin: 0 0 17px; color: var(--cv-secondary); font-size: 14px; line-height: 1.65; }
.guide-steps { display: grid; gap: 2px; padding: 7px 12px; background: var(--cv-accent-soft); border-radius: var(--cv-radius-panel); }
.guide-steps button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 68px; padding: 9px 4px; border: 0; border-bottom: 1px solid var(--cv-border); text-align: left; background: transparent; }
.guide-steps button:last-child { border-bottom: 0; }
.step-number { width: 29px; height: 29px; display: grid; place-items: center; flex-shrink: 0; border-radius: 50%; color: var(--cv-on-accent); background: var(--cv-accent); font-size: 13px; font-weight: 700; }
.guide-steps button > span:nth-child(2) { flex: 1; }
.guide-steps strong { display: block; margin-bottom: 3px; font-size: 14px; }
.guide-steps small { display: block; color: var(--cv-secondary); font-size: 12px; line-height: 1.45; }
.guide-section-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; gap: 12px; }
h3 { margin: 0; color: var(--cv-secondary); font-size: 12px; letter-spacing: .08em; }
.guide-search { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 8px 0 8px 10px; border: 0; color: var(--cv-accent); background: transparent; font-size: 12px; }
.guide-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.guide-tool { display: flex; gap: 9px; align-items: flex-start; padding: 14px 11px; min-height: 105px; text-align: left; border: 1px solid var(--cv-border); border-radius: var(--cv-radius-panel); background: var(--cv-surface); }
.tool-icon { width: 32px; height: 32px; display: grid; place-items: center; flex-shrink: 0; background: var(--cv-surface-subtle); color: var(--cv-accent); border-radius: var(--cv-radius-control); }
.tool-copy { flex: 1; min-width: 0; }
.tool-copy strong { display: block; font-size: 13px; line-height: 1.5; margin: 4px 0 5px; }
.tool-copy > span { display: block; color: var(--cv-secondary); font-size: 12px; line-height: 1.65; }
.tool-chevron { margin-top: 8px; flex-shrink: 0; color: var(--cv-muted); }
.guide-note { display: flex; align-items: center; gap: 9px; min-height: 46px; margin: 8px 0 4px; padding: 7px 1px; border: 0; color: var(--cv-accent); background: transparent; font-size: 12px; }
.guide-note svg:last-child { margin-left: auto; }
.guide-footnote { display: flex; align-items: flex-start; gap: 9px; padding: 13px 14px; background: var(--cv-warning-soft); border-radius: 12px; color: var(--cv-warning); }
.guide-footnote svg { flex-shrink: 0; margin-top: 1px; }
.guide-footnote p { margin: 0; font-size: var(--cv-type-meta); line-height: 1.75; }
@media (hover: hover) { .guide-tool:hover { border-color: var(--cv-border); background: var(--cv-surface); } .guide-steps button:hover { color: var(--cv-accent-strong); } .guide-close:hover { background: var(--cv-border); } }
@media (max-width: 480px) { .guide-backdrop { padding-left: 12px; padding-right: 12px; } .workspace-guide { border-radius: var(--cv-radius-panel); } .guide-header { padding: 21px 19px 17px; } .guide-content { padding: 16px 18px 20px; } h2 { font-size: 23px; } .guide-tools { grid-template-columns: 1fr; } .guide-tool { min-height: 0; padding: 12px; } .tool-copy strong { margin-top: 2px; } }
@media (prefers-reduced-motion: no-preference) { .workspace-guide { animation: guide-arrive .18s ease-out; } @keyframes guide-arrive { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } } }

.workspace-guide { font-family: var(--cv-font); }
.guide-backdrop, .workspace-guide, .workspace-guide * { box-sizing: border-box; }
.guide-header > div, .guide-steps button > span:nth-child(2), .guide-footnote p { min-width: 0; overflow-wrap: anywhere; }
.guide-steps strong, .tool-copy strong { font-size: var(--cv-type-summary); }
.workspace-guide button { transition: background-color var(--cv-motion-press) var(--cv-ease); }
.workspace-guide button:not(:disabled):active { background: var(--cv-accent-soft); }
.workspace-guide button:focus-visible { outline: 2px solid var(--cv-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .workspace-guide, .workspace-guide * { animation: none !important; transition: none !important; } }

</style>
