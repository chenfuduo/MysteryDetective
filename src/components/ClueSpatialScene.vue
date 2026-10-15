<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ClueRecord } from '../services/vault'

type Props = { container: HTMLElement | null; clues: ClueRecord[]; selectedId: string }
const props = defineProps<Props>()
const emit = defineEmits<{ ready: [value: boolean] }>()
const canvasElement = ref<HTMLCanvasElement | null>(null)
const geometry = new RoundedBoxGeometry(2, 1, 0.16, 5, 0.035)
const material = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0.47, roughness: 0.38, clearcoat: 0.36, clearcoatRoughness: 0.32, vertexColors: true })
const dummy = new THREE.Object3D()
const instanceColors = new THREE.Color()
let canvas: HTMLCanvasElement | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let cards: THREE.InstancedMesh | null = null
let floor: THREE.Mesh | null = null
let observer: ResizeObserver | null = null
let mutations: MutationObserver | null = null
let frame = 0
let previousSize = ''
let actualCount = 0

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.02
  renderer.shadowMap.enabled = props.clues.length <= 28
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x000000, 0)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000)
  scene.add(new THREE.HemisphereLight('#dce7f3', '#11151c', 1.5))
  scene.add(new THREE.AmbientLight('#98a7b7', 0.38))
  const key = new THREE.DirectionalLight('#edf4fa', 2.65)
  key.position.set(-150, 260, 700)
  key.castShadow = renderer.shadowMap.enabled
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -1600
  key.shadow.camera.right = 1600
  key.shadow.camera.top = 1300
  key.shadow.camera.bottom = -1300
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
  const fill = new THREE.DirectionalLight('#8199b3', 1.1)
  fill.position.set(500, 70, 280)
  scene.add(fill)
  floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#0c1218', roughness: 0.88, metalness: 0.24 }))
  floor.position.z = -25
  floor.receiveShadow = renderer.shadowMap.enabled
  scene.add(floor)

  cards = new THREE.InstancedMesh(geometry, material, Math.max(1, props.clues.length))
  cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  cards.castShadow = renderer.shadowMap.enabled
  cards.receiveShadow = true
  scene.add(cards)
  observer = new ResizeObserver(resize)
  observer.observe(props.container)
  mutations = new MutationObserver(schedule)
  mutations.observe(props.container, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] })
  window.addEventListener('scroll', onScroll, true)
  resize()
  syncInstances()
  emit('ready', true)
}

function resize() {
  if (!props.container || !renderer || !camera) return
  const width = Math.max(1, props.container.clientWidth)
  const height = Math.max(1, props.container.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  const distance = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
  camera.position.set(width / 2, height / 2, distance)
  camera.lookAt(width / 2, height / 2, 0)
  camera.updateProjectionMatrix()
  floor?.position.set(width / 2, height / 2, -25)
  floor?.scale.set(width, height, 1)
  syncInstances()
  schedule()
}

function syncInstances() {
  if (!props.container || !cards || !camera || !renderer) return
  const parent = props.container.getBoundingClientRect()
  const visibleElements = [...props.container.querySelectorAll<HTMLElement>('.clue-card[data-clue-id]')]
  const visible = new Map(visibleElements.map(element => [element.dataset.clueId || '', element]))
  const width = Math.max(1, props.container.clientWidth)
  const height = Math.max(1, props.container.clientHeight)
  actualCount = 0

  props.clues.forEach((clue, index) => {
    const element = visible.get(clue.id)
    if (!element || actualCount >= cards!.instanceMatrix.count) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height || rect.right < parent.left || rect.left > parent.right || rect.bottom < parent.top || rect.top > parent.bottom) return
    const x = rect.left - parent.left + rect.width / 2
    const y = height - (rect.top - parent.top + rect.height / 2)
    const isSelected = clue.id === props.selectedId
    const depth = isSelected ? 34 : 10 + (index % 4) * 3
    const relativeX = x - width / 2
    dummy.position.set(x, y, depth)
    dummy.rotation.set(((index % 2) ? 1 : -1) * 0.026, Math.max(-0.06, Math.min(0.06, relativeX / 9000)), 0)
    const compactList = element.closest('.clue-collection')?.classList.contains('list')
    dummy.scale.set(Math.max(80, rect.width - 6) / 2, Math.max(70, rect.height - 6), (compactList ? 8 : 12) / 0.16)
    dummy.updateMatrix()
    cards.setMatrixAt(actualCount, dummy.matrix)
    if (isSelected) instanceColors.set('#738da8')
    else if (clue.favorite) instanceColors.set('#66503d')
    else instanceColors.set(index % 2 ? '#26313c' : '#222d37')
    cards.setColorAt(actualCount, instanceColors)
    actualCount += 1
  })
  cards.count = actualCount
  cards.instanceMatrix.needsUpdate = true
  if (cards.instanceColor) cards.instanceColor.needsUpdate = true
  cards.computeBoundingSphere()
  previousSize = `${width}x${height}`
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

function onScroll() {
  if (!props.container) return
  const size = `${props.container.clientWidth}x${props.container.clientHeight}`
  if (size !== previousSize) resize()
  else syncInstances()
}

watch(() => [props.clues.map(clue => `${clue.id}:${clue.favorite}:${clue.displayImagePath}:${clue.imagePath}`).join('|'), props.selectedId], async () => {
  await nextTick()
  syncInstances()
})
watch(() => props.container, () => { if (props.container && renderer) resize(); else if (props.container) init() })

onMounted(async () => { await nextTick(); init() })
onUnmounted(() => {
  observer?.disconnect()
  mutations?.disconnect()
  window.removeEventListener('scroll', onScroll, true)
  if (frame) cancelAnimationFrame(frame)
  if (scene) scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    if (object.geometry !== geometry) object.geometry.dispose()
    if (object.material !== material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(item => item.dispose())
  })
  cards?.dispose()
  floor?.geometry.dispose()
  ;(floor?.material as THREE.Material | undefined)?.dispose()
  geometry.dispose()
  material.dispose()
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
  canvas = null
  cards = null
  floor = null
})
</script>

<template>
  <canvas ref="canvasElement" class="clue-spatial-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.clue-spatial-canvas{position:absolute;z-index:0;inset:0;width:100%;height:100%;pointer-events:none}
</style>
