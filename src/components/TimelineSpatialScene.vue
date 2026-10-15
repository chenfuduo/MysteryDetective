<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { TimelineRecord } from '../services/vault'

type AxisEvent = { event: TimelineRecord; position: number }
type Props = { container: HTMLElement | null; events: TimelineRecord[]; axisEvents: AxisEvent[]; selectedId: string }
const props = defineProps<Props>()
const emit = defineEmits<{ ready: [value: boolean] }>()
const canvasElement = ref<HTMLCanvasElement | null>(null)
const unitBox = new RoundedBoxGeometry(2, 1, 0.14, 4, 0.025)
const sphereGeometry = new THREE.SphereGeometry(1, 16, 10)
const cards = new Map<string, THREE.Mesh>()
const markers = new Map<string, THREE.Mesh>()
let canvas: HTMLCanvasElement | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let frame = 0
let previousFrame = 0
let lastChartWidth = 0
let lastChartHeight = 0
let axisRail: THREE.Mesh | null = null
let floor: THREE.Mesh | null = null
let axisGeometry: THREE.CylinderGeometry | null = null
let stemGeometry: THREE.CylinderGeometry | null = null
const stems = new Map<string, THREE.Mesh>()
const stemMaterials = {
  dated: new THREE.MeshPhysicalMaterial({ color: '#bccdd9', metalness: 0.05, roughness: 0.74, clearcoat: 0.08 }),
  yearless: new THREE.MeshPhysicalMaterial({ color: '#d5c7b5', metalness: 0.04, roughness: 0.76, clearcoat: 0.06 }),
}
const typeMaterials: Record<string, THREE.MeshPhysicalMaterial> = {
  dated: new THREE.MeshPhysicalMaterial({ color: '#edf3f8', metalness: 0.03, roughness: 0.7, clearcoat: 0.08 }),
  yearless: new THREE.MeshPhysicalMaterial({ color: '#f4efe7', metalness: 0.02, roughness: 0.74, clearcoat: 0.06 }),
  mixed: new THREE.MeshPhysicalMaterial({ color: '#edf1f5', metalness: 0.03, roughness: 0.72, clearcoat: 0.06 }),
  selected: new THREE.MeshPhysicalMaterial({ color: '#dce8f0', metalness: 0.03, roughness: 0.72, clearcoat: 0.06 }),
  yearlessSelected: new THREE.MeshPhysicalMaterial({ color: '#dce8f0', metalness: 0.03, roughness: 0.72, clearcoat: 0.06 }),
  mixedSelected: new THREE.MeshPhysicalMaterial({ color: '#dce8f0', metalness: 0.03, roughness: 0.72, clearcoat: 0.06 }),
}
const dotMaterials = {
  dated: new THREE.MeshPhysicalMaterial({ color: '#7f9eb6', metalness: 0.1, roughness: 0.6 }),
  yearless: new THREE.MeshPhysicalMaterial({ color: '#bba68c', metalness: 0.08, roughness: 0.64 }),
}

function init() {
  if (!props.container || !canvasElement.value) return
  canvas = canvasElement.value
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
  } catch {
    canvas.style.display = 'none'
    emit('ready', false)
    return
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.4))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.shadowMap.enabled = false
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x000000, 0)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(43, 1, 0.1, 5000)
  scene.add(new THREE.HemisphereLight('#ffffff', '#d6e1ea', 1.45))
  scene.add(new THREE.AmbientLight('#ffffff', 0.55))
  const key = new THREE.DirectionalLight('#ffffff', 1.4)
  key.position.set(-120, 190, 620)
  key.castShadow = renderer.shadowMap.enabled
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -1800
  key.shadow.camera.right = 1800
  key.shadow.camera.top = 1100
  key.shadow.camera.bottom = -1100
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
  const fill = new THREE.DirectionalLight('#dce8f2', 0.6)
  fill.position.set(420, 30, 250)
  scene.add(fill)

  axisGeometry = new THREE.CylinderGeometry(0.8, 0.8, 1, 10, 1, false)
  stemGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false)
  axisRail = new THREE.Mesh(axisGeometry, new THREE.MeshPhysicalMaterial({ color: '#bdcbd7', metalness: 0.08, roughness: 0.72 }))
  axisRail.rotation.z = Math.PI / 2
  axisRail.castShadow = true
  scene.add(axisRail)

  floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#f6f8fa', roughness: 0.96, metalness: 0 }))
  floor.position.z = -28
  floor.receiveShadow = renderer.shadowMap.enabled
  scene.add(floor)

  resizeObserver = new ResizeObserver(schedule)
  resizeObserver.observe(props.container)
  mutationObserver = new MutationObserver(schedule)
  mutationObserver.observe(props.container, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] })
  resize()
  syncObjects()
  emit('ready', true)
}

function resize() {
  if (!props.container || !renderer || !camera) return
  const width = Math.max(1, props.container.clientWidth)
  const height = Math.max(1, props.container.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.fov = 43
  const distance = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
  camera.position.set(width / 2, height / 2, distance)
  camera.lookAt(width / 2, height / 2, 0)
  camera.updateProjectionMatrix()
  if (floor) { floor.position.set(width / 2, height / 2, -28); floor.scale.set(width, height, 1) }
  if (axisRail) { axisRail.position.set(width / 2, height / 2, 8); axisRail.scale.y = width }
  lastChartWidth = width
  lastChartHeight = height
  schedule()
}

function cardType(element: HTMLElement, event: TimelineRecord | undefined) {
  if (element.classList.contains('timeline-node-mixed')) return 'mixed'
  if (event?.startsAt.startsWith('--') || element.classList.contains('timeline-node-yearless')) return 'yearless'
  return 'dated'
}

function visibleItemElements() {
  if (!props.container) return []
  return [...props.container.querySelectorAll<HTMLElement>('.vis-item')].filter(element => {
    if (element.classList.contains('vis-background') || element.classList.contains('vis-line') || element.classList.contains('vis-dot')) return false
    return Boolean(element.querySelector('.timeline-event-content'))
  })
}

function syncObjects() {
  if (!scene || !props.container || !renderer) return
  const containerRect = props.container.getBoundingClientRect()
  const width = Math.max(1, props.container.clientWidth)
  const height = Math.max(1, props.container.clientHeight)
  if (width !== lastChartWidth || height !== lastChartHeight) resize()

  const eventById = new Map(props.events.map(event => [event.id, event]))
  const axisElement = props.container.querySelector<HTMLElement>('.shared-axis-line')
  const axisRect = axisElement?.getBoundingClientRect()
  const axisY = axisRect ? height - (axisRect.top - containerRect.top + axisRect.height / 2) : height / 2
  const seen = new Set<string>()
  for (const element of visibleItemElements()) {
    const content = element.querySelector<HTMLElement>('.timeline-event-content')
    if (!content) continue
    const id = content.dataset.eventId || content.dataset.clusterId
    if (!id) continue
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height || rect.right < containerRect.left || rect.left > containerRect.right || rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue
    seen.add(id)
    let card = cards.get(id)
    if (!card) {
      card = new THREE.Mesh(unitBox, typeMaterials.dated)
      card.castShadow = true
      card.receiveShadow = true
      card.userData.id = id
      scene.add(card)
      cards.set(id, card)
    }
    const event = eventById.get(id)
    const type = cardType(element, event)
    const selected = id === props.selectedId
    card.castShadow = !selected
    card.material = selected ? typeMaterials[type === 'yearless' ? 'yearlessSelected' : type === 'mixed' ? 'mixedSelected' : 'selected']! : typeMaterials[type]!
    const centerX = rect.left - containerRect.left + rect.width / 2
    const centerY = rect.top - containerRect.top + rect.height / 2
    const depth = selected ? 2.5 : 1
    card.position.x = centerX
    card.position.y = height - centerY
    card.userData.targetDepth = depth
    card.rotation.set(0, 0, 0)
    card.scale.set(Math.max(44, rect.width - 4) / 2, Math.max(30, rect.height - 5), 2 / 0.14)
    card.visible = true

    let stem = stems.get(id)
    if (!stem) {
      stem = new THREE.Mesh(stemGeometry!, stemMaterials[type as 'dated' | 'yearless'] || stemMaterials.dated)
      stem.castShadow = true
      stem.receiveShadow = true
      stem.userData.id = id
      scene.add(stem)
      stems.set(id, stem)
    }
    stem.material = stemMaterials[type === 'mixed' ? 'dated' : type as 'dated' | 'yearless']
    const stemLength = Math.max(0, Math.abs(axisY - card.position.y) - 10)
    stem.position.set(centerX, (axisY + card.position.y) / 2, 12)
    stem.scale.set(0.55, stemLength, 0.55)
    stem.userData.targetDepth = 0
    stem.visible = stemLength > 4
  }
  for (const [id, card] of cards) if (!seen.has(id)) { scene.remove(card); card.geometry !== unitBox && card.geometry.dispose(); cards.delete(id) }
  for (const [id, stem] of stems) if (!seen.has(id)) { scene.remove(stem); stems.delete(id) }

  if (axisElement && axisRect && axisRail) {
    const rect = axisRect
    const axisWidth = Math.max(1, rect.width)
    axisRail.position.set(rect.left - containerRect.left + axisWidth / 2, height - (rect.top - containerRect.top + rect.height / 2), 8)
    axisRail.scale.y = axisWidth
    axisRail.visible = true
  } else if (axisRail) axisRail.visible = false

  const dotIds = new Set<string>()
  for (const item of props.axisEvents) {
    const id = item.event.id
    dotIds.add(id)
    let marker = markers.get(id)
    if (!marker) {
      marker = new THREE.Mesh(sphereGeometry, dotMaterials.dated)
      marker.userData.id = id
      marker.castShadow = true
      scene.add(marker)
      markers.set(id, marker)
    }
    marker.material = item.event.startsAt.startsWith('--') ? dotMaterials.yearless : dotMaterials.dated
    marker.position.x = (item.position / 100) * width
    marker.position.y = height / 2
    marker.userData.targetDepth = id === props.selectedId ? 3 : 2
    marker.scale.setScalar(id === props.selectedId ? 4.5 : 3.4)
    marker.visible = true
  }
  for (const [id, marker] of markers) if (!dotIds.has(id)) { scene.remove(marker); markers.delete(id) }
  schedule()
}

function schedule() {
  if (!renderer || frame) return
  frame = requestAnimationFrame(renderFrame)
}

function renderFrame(now: number) {
  frame = 0
  if (!renderer || !scene || !camera) return
  const delta = previousFrame ? Math.min((now - previousFrame) / 1000, 0.05) : 1 / 60
  previousFrame = now
  let moving = false
  const animateDepth = (mesh: THREE.Mesh) => {
    const target = Number(mesh.userData.targetDepth)
    if (!Number.isFinite(target) || Math.abs(target - mesh.position.z) < 0.04) return
    mesh.position.z = THREE.MathUtils.damp(mesh.position.z, target, 13, delta)
    moving = true
  }
  cards.forEach(animateDepth)
  markers.forEach(animateDepth)
  stems.forEach(animateDepth)
  renderer.render(scene, camera)
  if (moving) frame = requestAnimationFrame(renderFrame)
  else previousFrame = 0
}

watch(() => [props.events, props.axisEvents, props.selectedId], () => syncObjects(), { deep: true })
watch(() => props.container, () => { if (props.container && renderer) resize(); else if (props.container) init() })

onMounted(async () => { await nextTick(); init() })
onUnmounted(() => {
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  cards.forEach(card => scene?.remove(card))
  markers.forEach(marker => scene?.remove(marker))
  stems.forEach(stem => scene?.remove(stem))
  cards.clear()
  markers.clear()
  stems.clear()
  if (scene) scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    if (object.geometry !== unitBox && object.geometry !== sphereGeometry) object.geometry.dispose()
  })
  unitBox.dispose()
  sphereGeometry.dispose()
  axisGeometry?.dispose()
  stemGeometry?.dispose()
  Object.values(stemMaterials).forEach(material => material.dispose())
  Object.values(typeMaterials).forEach(material => material.dispose())
  Object.values(dotMaterials).forEach(material => material.dispose())
  if (scene) scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose())
  })
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
  canvas = null
})
</script>

<template>
  <canvas ref="canvasElement" class="timeline-spatial-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.timeline-spatial-canvas{position:absolute;z-index:0;inset:0;width:100%;height:100%;pointer-events:none}
</style>
