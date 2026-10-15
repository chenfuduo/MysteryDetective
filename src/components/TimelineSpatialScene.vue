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
const unitBox = new RoundedBoxGeometry(2, 1, 0.14, 5, 0.035)
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
let lastChartWidth = 0
let lastChartHeight = 0
let axisRail: THREE.Mesh | null = null
let floor: THREE.Mesh | null = null
let axisGeometry: THREE.CylinderGeometry | null = null
const typeMaterials: Record<string, THREE.MeshPhysicalMaterial> = {
  dated: new THREE.MeshPhysicalMaterial({ color: '#516477', metalness: 0.46, roughness: 0.36, clearcoat: 0.35, clearcoatRoughness: 0.3 }),
  yearless: new THREE.MeshPhysicalMaterial({ color: '#80624c', metalness: 0.38, roughness: 0.42, clearcoat: 0.26, clearcoatRoughness: 0.36 }),
  mixed: new THREE.MeshPhysicalMaterial({ color: '#5c6671', metalness: 0.34, roughness: 0.44, clearcoat: 0.22, clearcoatRoughness: 0.4 }),
  selected: new THREE.MeshPhysicalMaterial({ color: '#93abc2', metalness: 0.52, roughness: 0.29, clearcoat: 0.5, clearcoatRoughness: 0.24 }),
  yearlessSelected: new THREE.MeshPhysicalMaterial({ color: '#d6ab83', metalness: 0.48, roughness: 0.29, clearcoat: 0.46, clearcoatRoughness: 0.26 }),
  mixedSelected: new THREE.MeshPhysicalMaterial({ color: '#b5c4d1', metalness: 0.44, roughness: 0.31, clearcoat: 0.42, clearcoatRoughness: 0.28 }),
}
const dotMaterials = {
  dated: new THREE.MeshPhysicalMaterial({ color: '#b9cde1', metalness: 0.56, roughness: 0.26, clearcoat: 0.46 }),
  yearless: new THREE.MeshPhysicalMaterial({ color: '#d6ab83', metalness: 0.44, roughness: 0.32, clearcoat: 0.38 }),
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
  renderer.toneMappingExposure = 1.02
  renderer.shadowMap.enabled = props.events.length <= 36
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x000000, 0)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(43, 1, 0.1, 5000)
  scene.add(new THREE.HemisphereLight('#d9e4ef', '#10151b', 1.42))
  scene.add(new THREE.AmbientLight('#9eacbb', 0.38))
  const key = new THREE.DirectionalLight('#edf4fa', 2.5)
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
  const fill = new THREE.DirectionalLight('#91a9c0', 1.05)
  fill.position.set(420, 30, 250)
  scene.add(fill)

  axisGeometry = new THREE.CylinderGeometry(2.8, 2.8, 1, 14, 1, false)
  axisRail = new THREE.Mesh(axisGeometry, new THREE.MeshPhysicalMaterial({ color: '#9fb8d8', metalness: 0.66, roughness: 0.3, clearcoat: 0.44 }))
  axisRail.rotation.z = Math.PI / 2
  axisRail.castShadow = true
  scene.add(axisRail)

  floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#0d131a', roughness: 0.86, metalness: 0.22 }))
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
    card.material = selected ? typeMaterials[type === 'yearless' ? 'yearlessSelected' : type === 'mixed' ? 'mixedSelected' : 'selected']! : typeMaterials[type]!
    const centerX = rect.left - containerRect.left + rect.width / 2
    const centerY = rect.top - containerRect.top + rect.height / 2
    const depth = selected ? 36 : id.startsWith('timeline-cluster:') ? 18 : 12
    card.position.set(centerX, height - centerY, depth)
    card.rotation.set((element.classList.contains('half-upper') ? 1 : -1) * 0.028, (selected ? -1 : 1) * 0.045, 0)
    card.scale.set(Math.max(44, rect.width - 4) / 2, Math.max(30, rect.height - 5), 12 / 0.14)
    card.visible = true
  }
  for (const [id, card] of cards) if (!seen.has(id)) { scene.remove(card); card.geometry !== unitBox && card.geometry.dispose(); cards.delete(id) }

  const axisElement = props.container.querySelector<HTMLElement>('.shared-axis-line')
  if (axisElement && axisRail) {
    const rect = axisElement.getBoundingClientRect()
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
    marker.position.set((item.position / 100) * width, height / 2, id === props.selectedId ? 30 : 14)
    marker.scale.setScalar(id === props.selectedId ? 7.5 : 5.6)
    marker.visible = true
  }
  for (const [id, marker] of markers) if (!dotIds.has(id)) { scene.remove(marker); markers.delete(id) }
  schedule()
}

function schedule() {
  if (!renderer || frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (!renderer || !scene || !camera) return
    renderer.render(scene, camera)
  })
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
  cards.clear()
  markers.clear()
  if (scene) scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    if (object.geometry !== unitBox && object.geometry !== sphereGeometry) object.geometry.dispose()
  })
  unitBox.dispose()
  sphereGeometry.dispose()
  axisGeometry?.dispose()
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
