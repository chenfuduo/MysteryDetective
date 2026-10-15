<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ScriptRecord } from '../services/vault'

type Props = {
  scripts: ScriptRecord[]
  activeScriptId: string
  imageUrls: Record<string, string>
  dateLabel: (date: string) => string
}

const props = defineProps<Props>()
const emit = defineEmits<{ select: [id: string] }>()
const viewport = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const webglAvailable = ref(true)
const dragging = ref(false)
const focusedIndex = ref(0)
const activeIndex = computed(() => Math.max(0, props.scripts.findIndex(script => script.id === props.activeScriptId)))
const focusedScript = computed(() => props.scripts[focusedIndex.value] ?? props.scripts[activeIndex.value])
const isFocusedActive = computed(() => focusedScript.value?.id === props.activeScriptId)

const palette = ['#263646', '#35413e', '#403a38', '#353b4a', '#3e3844', '#34434b']
const groups = new Map<string, THREE.Group>()
const textures: THREE.CanvasTexture[] = []
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let resizeObserver: ResizeObserver | null = null
let raf = 0
let previousFrame = 0
let dragStartX = 0
let dragStartY = 0
let dragOffset = 0
let currentBuild = 0
const selectedTarget = new THREE.Vector3()
const sharedGeometry = new RoundedBoxGeometry(2.55, 3.55, 0.2, 7, 0.11)
const spineGeometry = new RoundedBoxGeometry(0.16, 3.43, 0.13, 4, 0.05)
const bodyMaterial = new THREE.MeshPhysicalMaterial({ color: '#202731', metalness: 0.68, roughness: 0.31, clearcoat: 0.42, clearcoatRoughness: 0.28 })
const spineMaterial = new THREE.MeshStandardMaterial({ color: '#8794a1', metalness: 0.78, roughness: 0.28 })
const coverGeometry = new THREE.PlaneGeometry(2.39, 3.39)

function drawCover(script: ScriptRecord, index: number) {
  const build = currentBuild
  const surface = document.createElement('canvas')
  surface.width = 960
  surface.height = 1350
  const context = surface.getContext('2d')
  if (!context) return null

  const base = palette[index % palette.length]
  const gradient = context.createLinearGradient(0, 0, 960, 1350)
  gradient.addColorStop(0, '#1b222b')
  gradient.addColorStop(1, base)
  context.fillStyle = gradient
  context.fillRect(0, 0, surface.width, surface.height)

  const glow = context.createRadialGradient(755, 170, 12, 755, 170, 780)
  glow.addColorStop(0, 'rgba(159,184,216,.23)')
  glow.addColorStop(1, 'rgba(159,184,216,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, surface.width, surface.height)

  const imageUrl = script.coverPath ? props.imageUrls[script.coverPath] : ''
  if (imageUrl) {
    const image = new Image()
    if (/^https?:/i.test(imageUrl)) image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (build !== currentBuild) return
      const scale = Math.max(surface.width / image.width, surface.height / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, (surface.width - width) / 2, (surface.height - height) / 2, width, height)
      const scrim = context.createLinearGradient(0, 0, 0, surface.height)
      scrim.addColorStop(0, 'rgba(8,10,15,.22)')
      scrim.addColorStop(0.38, 'rgba(8,10,15,.42)')
      scrim.addColorStop(1, 'rgba(8,10,15,.86)')
      context.fillStyle = scrim
      context.fillRect(0, 0, surface.width, surface.height)
      paintTypography(context, script)
      texture.needsUpdate = true
      requestRender()
    }
    image.onerror = () => undefined
    image.src = imageUrl
  }

  const texture = new THREE.CanvasTexture(surface)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer?.capabilities.getMaxAnisotropy() ?? 4, 8)
  textures.push(texture)
  paintTypography(context, script)
  return texture
}

function paintTypography(context: CanvasRenderingContext2D, script: ScriptRecord) {
  context.save()
  context.strokeStyle = 'rgba(221,230,239,.45)'
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(76, 114)
  context.lineTo(884, 114)
  context.stroke()

  context.fillStyle = '#c6d4e4'
  context.font = '600 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  context.textAlign = 'left'
  context.fillText('迹 册   /   CASE FILE', 76, 82)

  context.strokeStyle = 'rgba(198,212,228,.24)'
  context.lineWidth = 2
  context.beginPath()
  context.arc(480, 590, 240, 0, Math.PI * 2)
  context.arc(480, 590, 190, 0, Math.PI * 2)
  context.stroke()
  context.fillStyle = 'rgba(198,212,228,.75)'
  context.beginPath()
  context.arc(480, 590, 6, 0, Math.PI * 2)
  context.fill()

  const title = script.name.trim() || '未命名剧本'
  const lines = wrapTitle(context, title, 740)
  context.textAlign = 'center'
  context.fillStyle = '#f5f7fa'
  context.shadowColor = 'rgba(0,0,0,.25)'
  context.shadowBlur = 20
  context.font = `${lines.length > 2 ? 50 : 62}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
  const firstY = 590 - (lines.length - 1) * 42
  lines.slice(0, 3).forEach((line, lineIndex) => context.fillText(line, 480, firstY + lineIndex * 84))
  context.shadowBlur = 0

  context.fillStyle = 'rgba(230,237,244,.78)'
  context.font = '500 23px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  context.fillText('线索整理档案', 480, 1040)
  context.strokeStyle = 'rgba(221,230,239,.35)'
  context.beginPath()
  context.moveTo(300, 1085)
  context.lineTo(660, 1085)
  context.stroke()
  context.restore()
}

function wrapTitle(context: CanvasRenderingContext2D, title: string, maxWidth: number) {
  const chars = [...title]
  const lines: string[] = []
  let line = ''
  for (const char of chars) {
    const next = line + char
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line)
      line = char
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

function initScene() {
  if (!canvas.value || !viewport.value) return
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: false, powerPreference: 'low-power' })
  } catch {
    webglAvailable.value = false
    return
  }

  const width = Math.max(1, viewport.value.clientWidth)
  const height = Math.max(1, viewport.value.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  scene = new THREE.Scene()
  scene.background = new THREE.Color('#080a0f')
  scene.fog = new THREE.Fog('#080a0f', 17, 32)
  camera = new THREE.PerspectiveCamera(37, width / height, 0.1, 80)
  camera.position.set(0, 0.18, 9.4)
  camera.lookAt(0, 0, 0)

  scene.add(new THREE.HemisphereLight('#dce7f3', '#11151c', 1.45))
  scene.add(new THREE.AmbientLight('#9ba9b8', 0.42))
  const key = new THREE.DirectionalLight('#e2ebf5', 3.2)
  key.position.set(-3.4, 5.8, 6)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -9
  key.shadow.camera.right = 9
  key.shadow.camera.top = 7
  key.shadow.camera.bottom = -5
  key.shadow.bias = -0.00025
  key.shadow.radius = 5
  scene.add(key)
  const fill = new THREE.DirectionalLight('#819bb8', 1.05)
  fill.position.set(5, 1.2, 3)
  scene.add(fill)
  const rim = new THREE.PointLight('#a8bdd5', 20, 18, 2)
  rim.position.set(0, 3.6, -4)
  scene.add(rim)

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#10151b', metalness: 0.32, roughness: 0.88 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -2.08
  floor.receiveShadow = true
  scene.add(floor)

  resizeObserver = new ResizeObserver(resizeScene)
  resizeObserver.observe(viewport.value)
  buildCards()
}

function buildCards() {
  if (!scene) return
  currentBuild += 1
  for (const group of groups.values()) scene.remove(group)
  groups.clear()
  textures.forEach(texture => texture.dispose())
  textures.length = 0
  const scripts = props.scripts
  scripts.forEach((script, index) => {
    const group = new THREE.Group()
    group.userData.scriptId = script.id
    const body = new THREE.Mesh(sharedGeometry, bodyMaterial)
    body.castShadow = true
    body.receiveShadow = true
    group.add(body)

    const spine = new THREE.Mesh(spineGeometry, spineMaterial)
    spine.position.set(-1.18, 0, 0.115)
    spine.castShadow = true
    group.add(spine)

    const texture = drawCover(script, index)
    if (texture) {
      const cover = new THREE.Mesh(coverGeometry, new THREE.MeshPhysicalMaterial({ map: texture, metalness: 0.12, roughness: 0.62, clearcoat: 0.16, clearcoatRoughness: 0.52 }))
      cover.position.set(0.01, 0, 0.106)
      cover.castShadow = true
      group.add(cover)
    }
    scene?.add(group)
    groups.set(script.id, group)
  })
  focusedIndex.value = activeIndex.value
  updateTargets(true)
}

function updateTargets(immediate = false) {
  if (!renderer || !camera) return
  const selected = props.scripts.findIndex(script => script.id === (props.scripts[focusedIndex.value]?.id ?? props.activeScriptId))
  const center = Math.max(0, selected)
  focusedIndex.value = center
  groups.forEach((group, id) => {
    const index = props.scripts.findIndex(script => script.id === id)
    const delta = index - center
    const sideDistance = Math.abs(delta)
    const target = group.userData.target ?? (group.userData.target = new THREE.Vector3()) as THREE.Vector3
    target.set(delta * 3.12 + dragOffset, -Math.min(sideDistance * 0.035, 0.12), -sideDistance * 0.74)
    group.userData.targetRotationY = THREE.MathUtils.clamp(-delta * 0.16, -0.48, 0.48)
    group.userData.targetScale = sideDistance === 0 ? 1 : Math.max(0.76, 0.9 - sideDistance * 0.025)
    if (immediate) {
      group.position.copy(target)
      group.rotation.y = group.userData.targetRotationY
      group.scale.setScalar(group.userData.targetScale)
    } else group.userData.needsMotion = true
  })
  const cameraTarget = selectedTarget.set(0, 0.08, 9.4)
  if (immediate) camera.position.copy(cameraTarget)
  else camera.userData.needsMotion = true
  requestRender()
}

function resizeScene() {
  if (!viewport.value || !renderer || !camera) return
  const width = Math.max(1, viewport.value.clientWidth)
  const height = Math.max(1, viewport.value.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  requestRender()
}

function requestRender() {
  if (!renderer || raf) return
  raf = requestAnimationFrame(renderFrame)
}

function renderFrame(now: number) {
  raf = 0
  if (!renderer || !scene || !camera) return
  const delta = previousFrame ? Math.min((now - previousFrame) / 1000, 0.05) : 1 / 60
  previousFrame = now
  const alpha = 1 - Math.exp(-9.5 * delta)
  let moving = false

  groups.forEach(group => {
    const target = group.userData.target as THREE.Vector3 | undefined
    if (!target) return
    const before = group.position.distanceToSquared(target)
    group.position.lerp(target, alpha)
    group.rotation.y = THREE.MathUtils.damp(group.rotation.y, group.userData.targetRotationY ?? 0, 9.5, delta)
    const scale = THREE.MathUtils.damp(group.scale.x, group.userData.targetScale ?? 1, 9.5, delta)
    group.scale.setScalar(scale)
    if (before > 0.0004 || Math.abs(group.rotation.y - (group.userData.targetRotationY ?? 0)) > 0.002 || Math.abs(scale - (group.userData.targetScale ?? 1)) > 0.002) moving = true
    else group.position.copy(target)
  })
  const cameraBefore = camera.position.distanceToSquared(selectedTarget)
  camera.position.lerp(selectedTarget, alpha)
  camera.lookAt(0, 0.08, 0)
  if (cameraBefore > 0.0004) moving = true

  renderer.render(scene, camera)
  if (moving) raf = requestAnimationFrame(renderFrame)
  else previousFrame = 0
}

function pointerDown(event: PointerEvent) {
  if (!canvas.value || event.button !== 0) return
  dragStartX = event.clientX
  dragStartY = event.clientY
  dragging.value = false
  canvas.value.setPointerCapture(event.pointerId)
}

function pointerMove(event: PointerEvent) {
  if (!canvas.value?.hasPointerCapture(event.pointerId)) return
  const dx = event.clientX - dragStartX
  const dy = event.clientY - dragStartY
  if (!dragging.value && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy) * 1.12) dragging.value = true
  if (!dragging.value) return
  const width = Math.max(1, viewport.value?.clientWidth ?? 1)
  dragOffset = THREE.MathUtils.clamp((dx / width) * 6.24, -3.12, 3.12)
  groups.forEach(group => {
    const target = group.userData.target as THREE.Vector3 | undefined
    const index = props.scripts.findIndex(script => script.id === group.userData.scriptId)
    const delta = index - focusedIndex.value
    if (target) target.x = delta * 3.12 + dragOffset
  })
  requestRender()
}

function pointerUp(event: PointerEvent) {
  if (!canvas.value?.hasPointerCapture(event.pointerId)) return
  const dx = event.clientX - dragStartX
  const dy = event.clientY - dragStartY
  canvas.value.releasePointerCapture(event.pointerId)
  if (dragging.value) {
    const threshold = Math.max(46, (viewport.value?.clientWidth ?? 500) * 0.09)
    if (Math.abs(dx) > threshold) {
      const nextIndex = THREE.MathUtils.clamp(focusedIndex.value + (dx < 0 ? 1 : -1), 0, props.scripts.length - 1)
      const next = props.scripts[nextIndex]
      if (next) emit('select', next.id)
    }
    dragging.value = false
    dragOffset = 0
    updateTargets()
    return
  }
  if (Math.abs(dx) + Math.abs(dy) > 12 || !canvas.value || !camera || !scene) return
  const bounds = canvas.value.getBoundingClientRect()
  pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects([...groups.values()], true)[0]
  let candidate: THREE.Object3D | null = hit?.object ?? null
  while (candidate && !candidate.userData.scriptId) candidate = candidate.parent
  const id = candidate?.userData.scriptId as string | undefined
  if (id) emit('select', id)
}

function chooseIndex(index: number) {
  const script = props.scripts[index]
  if (script) emit('select', script.id)
}

watch(() => props.scripts.map(script => `${script.id}:${script.name}:${script.playDate}:${script.coverPath}:${script.coverPath ? props.imageUrls[script.coverPath] ?? '' : ''}`).join('|'), () => {
  if (renderer) buildCards()
})
watch(() => props.activeScriptId, () => {
  focusedIndex.value = activeIndex.value
  dragOffset = 0
  updateTargets()
})

onMounted(initScene)
onUnmounted(() => {
  currentBuild += 1
  resizeObserver?.disconnect()
  if (raf) cancelAnimationFrame(raf)
  groups.clear()
  textures.forEach(texture => texture.dispose())
  textures.length = 0
  sharedGeometry.dispose()
  spineGeometry.dispose()
  coverGeometry.dispose()
  bodyMaterial.dispose()
  spineMaterial.dispose()
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
})
</script>

<template>
  <section class="spatial-gallery" aria-label="剧本空间档案">
    <header class="gallery-heading">
      <div>
        <span class="gallery-kicker">SPATIAL ARCHIVE</span>
        <h2>剧本档案</h2>
      </div>
      <span class="gallery-count">{{ String(focusedIndex + 1).padStart(2, '0') }} <i></i> {{ String(scripts.length).padStart(2, '0') }}</span>
    </header>

    <div ref="viewport" class="gallery-viewport" :class="{ 'is-dragging': dragging }">
      <canvas
        v-if="webglAvailable"
        ref="canvas"
        class="gallery-canvas"
        aria-label="拖动浏览剧本，点击选择剧本"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointercancel="pointerUp"
      ></canvas>
      <div v-else-if="!scripts.length" class="gallery-empty">还没有剧本档案</div>
      <div v-else class="gallery-fallback">
        <button v-for="script in scripts" :key="script.id" :class="{ active: script.id === activeScriptId }" @click="chooseIndex(scripts.indexOf(script))">
          <span>{{ script.name }}</span><small>{{ dateLabel(script.playDate) }}</small>
        </button>
      </div>
      <span v-if="scripts.length && webglAvailable" class="gallery-hint">左右拖动浏览 <b>·</b> 点击剧本切换</span>
      <button v-if="focusedIndex > 0 && scripts.length > 1" class="gallery-arrow previous" aria-label="上一个剧本" @click="chooseIndex(focusedIndex - 1)">‹</button>
      <button v-if="focusedIndex < scripts.length - 1" class="gallery-arrow next" aria-label="下一个剧本" @click="chooseIndex(focusedIndex + 1)">›</button>
    </div>

    <footer v-if="focusedScript" class="gallery-footer">
      <div class="selected-script-copy">
        <span class="selected-state"><i></i>{{ isFocusedActive ? '当前使用' : '已选档案' }}</span>
        <h3>{{ focusedScript.name }}</h3>
        <p>{{ dateLabel(focusedScript.playDate) }}</p>
      </div>
      <button class="gallery-select-button" :disabled="isFocusedActive" @click="emit('select', focusedScript.id)">
        {{ isFocusedActive ? '当前剧本' : '切换到此剧本' }}<span>↗</span>
      </button>
    </footer>
    <nav v-if="scripts.length > 1" class="gallery-pagination" aria-label="选择剧本">
      <button v-for="(script, index) in scripts" :key="script.id" :class="{ active: index === focusedIndex }" :aria-label="`选择${script.name}`" @click="chooseIndex(index)"></button>
    </nav>
  </section>
</template>

<style scoped>
.spatial-gallery{--spatial-ink:#f5f7fa;--spatial-muted:#929ba8;--spatial-accent:#9fb8d8;overflow:hidden;border:1px solid rgba(177,194,214,.16);border-radius:22px;background:#080a0f;color:var(--spatial-ink);box-shadow:0 22px 64px rgba(24,34,47,.12)}
.gallery-heading{height:70px;padding:0 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(214,225,237,.08)}
.gallery-kicker{display:block;margin-bottom:3px;color:#8a9aab;font:600 9px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.18em}
.gallery-heading h2{margin:0;color:#eef2f6;font-size:16px;font-weight:650;letter-spacing:.02em}
.gallery-count{display:flex;align-items:center;gap:9px;color:#aab4c0;font:500 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;font-variant-numeric:tabular-nums}
.gallery-count i{width:18px;height:1px;background:#627387}
.gallery-viewport{position:relative;height:clamp(360px,48vh,540px);min-height:360px;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,#18202a 0%,#0d1117 49%,#080a0f 100%);touch-action:pan-y;cursor:grab}
.gallery-viewport.is-dragging{cursor:grabbing}
.gallery-canvas{display:block;width:100%;height:100%;outline:none;touch-action:pan-y}
.gallery-hint{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);white-space:nowrap;color:rgba(190,202,216,.68);font-size:11px;letter-spacing:.04em;pointer-events:none}
.gallery-hint b{padding:0 6px;color:#687b91;font-weight:400}
.gallery-arrow{position:absolute;top:50%;width:38px;height:48px;transform:translateY(-50%);border:1px solid rgba(207,221,235,.16);border-radius:12px;background:rgba(11,15,21,.6);color:#d7e0e9;font-size:28px;line-height:1;backdrop-filter:blur(12px)}
.gallery-arrow.previous{left:14px}.gallery-arrow.next{right:14px}
.gallery-footer{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:108px;padding:17px 22px;border-top:1px solid rgba(214,225,237,.08);background:linear-gradient(105deg,#11161e,#0b0e13)}
.selected-state{display:flex;align-items:center;gap:8px;color:#9ba8b6;font-size:10px;letter-spacing:.04em}
.selected-state i{width:6px;height:6px;border-radius:50%;background:var(--spatial-accent);box-shadow:0 0 12px rgba(159,184,216,.48)}
.selected-script-copy h3{max-width:440px;margin:7px 0 3px;overflow:hidden;color:#f5f7fa;font-size:18px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.selected-script-copy p{margin:0;color:var(--spatial-muted);font-size:11px;font-variant-numeric:tabular-nums}
.gallery-select-button{flex:0 0 auto;display:flex;align-items:center;gap:16px;min-height:42px;padding:0 15px;border:1px solid rgba(159,184,216,.3);border-radius:11px;background:rgba(159,184,216,.1);color:#d7e4f1;font-size:12px;font-weight:600;transition:background .2s,border-color .2s,transform .2s}
.gallery-select-button:not(:disabled):active{transform:scale(.97);background:rgba(159,184,216,.19)}
.gallery-select-button:disabled{border-color:rgba(214,225,237,.12);background:rgba(214,225,237,.045);color:#9ba6b1}
.gallery-select-button span{font-size:15px}
.gallery-pagination{display:flex;justify-content:center;gap:7px;padding:0 0 15px;background:#0b0e13}
.gallery-pagination button{width:6px;height:6px;padding:0;border:0;border-radius:6px;background:#4c5663;transition:width .24s ease,background .24s ease}
.gallery-pagination button.active{width:22px;background:var(--spatial-accent)}
.gallery-empty,.gallery-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--spatial-muted)}
.gallery-fallback{flex-direction:column;gap:8px;overflow:auto;padding:24px}
.gallery-fallback button{display:flex;justify-content:space-between;align-items:center;width:min(100%,460px);min-height:54px;padding:0 16px;border:1px solid #35404b;border-radius:12px;background:#121821;color:#eef2f6;text-align:left}
.gallery-fallback button.active{border-color:#9fb8d8}.gallery-fallback small{color:#929ba8}
@media(max-width:760px){.gallery-viewport{height:clamp(330px,44vh,430px);min-height:330px}.gallery-heading{padding:0 16px}.gallery-footer{padding:15px 16px;min-height:96px}.selected-script-copy h3{max-width:52vw;font-size:16px}.gallery-select-button{gap:8px;padding:0 11px;font-size:11px}}
@media(prefers-reduced-motion:reduce){.gallery-select-button,.gallery-pagination button{transition:none}}
</style>
