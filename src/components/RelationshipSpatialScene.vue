<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { PersonRecord, RelationshipRecord } from '../services/vault'

type Point = { x: number; y: number }
type Props = {
  people: PersonRecord[]
  relationships: RelationshipRecord[]
  positions: Record<string, Point>
  pan: Point
  zoom: number
  rotation: Point
  selectedId: string
  linkSourceId: string
  linkTargetId: string
  imageUrls: Record<string, string>
  clueCounts: Record<string, number>
  centerId: string
  hideUnrelated: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ ready: [value: boolean]; projected: [value: Record<string, Point & { width: number; height: number }>] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const CARD_WIDTH = 180
const CARD_HEIGHT = 90
const CARD_DEPTH = 5
const boxGeometry = new RoundedBoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH, 5, 8)
const faceGeometry = new THREE.PlaneGeometry(CARD_WIDTH - 8, CARD_HEIGHT - 8)
const labelGeometry = new RoundedBoxGeometry(1, 30, 9, 4, 4)
const cardMaterials = new Map<string, THREE.MeshPhysicalMaterial>()
const cardTextures = new Map<string, THREE.CanvasTexture>()
const cardGroups = new Map<string, THREE.Group>()
const edgeMeshes = new Map<string, THREE.Mesh>()
const edgeLabels = new Map<string, THREE.Mesh>()
const projected = new Map<string, THREE.Vector3>()
const fromPoint = new THREE.Vector3()
const toPoint = new THREE.Vector3()
const direction = new THREE.Vector3()
const centerPoint = new THREE.Vector3()
const screenPoint = new THREE.Vector3()
const desiredCameraPosition = new THREE.Vector3()
const desiredCameraTarget = new THREE.Vector3()
const currentCameraTarget = new THREE.Vector3()
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let renderer: THREE.WebGLRenderer | null = null
let observer: ResizeObserver | null = null
let stageGrid: THREE.GridHelper | null = null
let frame = 0
let previousFrame = 0
let cameraMotionActive = false
let cameraMotionInitialized = false
let renderEpoch = 0
let disposed = false
let projectedCache: Record<string, Point & { width: number; height: number }> = {}
let edgeGeometry: THREE.CylinderGeometry | null = null

function makePersonTexture(person: PersonRecord) {
  const surface = document.createElement('canvas')
  surface.width = 720
  surface.height = 360
  const context = surface.getContext('2d')
  if (!context) return null
  const gradient = context.createLinearGradient(0, 0, 720, 360)
  gradient.addColorStop(0, '#ffffff')
  gradient.addColorStop(0.52, '#fafcfd')
  gradient.addColorStop(1, '#f5f8fa')
  context.fillStyle = gradient
  context.fillRect(0, 0, 720, 360)
  context.strokeStyle = 'rgba(150,174,188,.22)'
  context.lineWidth = 2
  context.strokeRect(14, 14, 692, 332)
  const sheen = context.createLinearGradient(0, 0, 0, 112)
  sheen.addColorStop(0, 'rgba(255,255,255,.09)')
  sheen.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = sheen
  context.fillRect(16, 16, 688, 112)

  const avatarX = 112
  const avatarY = 180
  const avatarRadius = 76
  context.fillStyle = '#edf2f5'
  context.beginPath()
  context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = 'rgba(139,168,181,.5)'
  context.lineWidth = 4
  context.stroke()
  context.fillStyle = '#466879'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '600 112px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  context.fillText([...person.name][0] || '人', avatarX, avatarY)

  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#788491'
  context.font = '600 18px -apple-system, BlinkMacSystemFont, sans-serif'
  context.fillText('人物档案', 224, 96)
  context.fillStyle = '#24313d'
  context.font = '600 42px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  const name = person.name || '未命名人物'
  context.fillText(name.length > 8 ? `${name.slice(0, 8)}…` : name, 224, 158)
  context.fillStyle = '#788491'
  context.font = '400 21px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  const alias = person.aliases.slice(0, 2).join(' · ') || '人物档案'
  context.fillText(alias.length > 16 ? `${alias.slice(0, 16)}…` : alias, 224, 204)
  context.fillStyle = '#8ba8b5'
  context.font = '500 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  context.fillText(`${props.clueCounts[person.id] || 0} 条线索`, 224, 278)

  const url = props.imageUrls[person.photoPath] || props.imageUrls[person.id] || ''
  if (url) {
    const epoch = renderEpoch
    const image = new Image()
    if (/^https?:/i.test(url)) image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (disposed || epoch !== renderEpoch) return
      context.save()
      context.beginPath()
      context.arc(avatarX, avatarY, avatarRadius - 4, 0, Math.PI * 2)
      context.clip()
      const scale = Math.max((avatarRadius * 2) / image.width, (avatarRadius * 2) / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, avatarX - width / 2, avatarY - height / 2, width, height)
      context.restore()
      const texture = cardTextures.get(person.id)
      if (texture) { texture.needsUpdate = true; scheduleRender() }
    }
    image.src = url
  }

  const texture = new THREE.CanvasTexture(surface)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer?.capabilities.getMaxAnisotropy() ?? 4, 8)
  cardTextures.set(person.id, texture)
  return texture
}

function makeLabelTexture(label: string) {
  const surface = document.createElement('canvas')
  surface.width = 480
  surface.height = 96
  const context = surface.getContext('2d')
  if (!context) return null
  context.clearRect(0, 0, surface.width, surface.height)
  context.fillStyle = '#ffffff'
  context.beginPath()
  context.roundRect(2, 2, 476, 92, 42)
  context.fill()
  context.strokeStyle = 'rgba(139,168,181,.5)'
  context.lineWidth = 3
  context.stroke()
  context.fillStyle = '#466879'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '500 34px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  const text = label.trim() || '关联'
  context.fillText(text.length > 12 ? `${text.slice(0, 12)}…` : text, 240, 48)
  const texture = new THREE.CanvasTexture(surface)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function init() {
  if (!canvas.value) return
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: true, powerPreference: 'low-power' })
  } catch {
    emit('ready', false)
    return
  }
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = props.people.length <= 28
  renderer.shadowMap.type = THREE.PCFShadowMap

  scene = new THREE.Scene()
  scene.background = null
  scene.fog = new THREE.Fog('#f6f8fa', 1500, 3200)
  renderer.setClearColor(0x000000, 0)
  camera = new THREE.PerspectiveCamera(42, width / height, 1, 5000)
  scene.add(new THREE.HemisphereLight('#dce7f3', '#cdd8df', 1.55))
  scene.add(new THREE.AmbientLight('#9ba9b8', 0.38))
  const key = new THREE.DirectionalLight('#e2ebf5', 2.6)
  key.position.set(-220, 430, 620)
  key.castShadow = props.people.length <= 28
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -1400
  key.shadow.camera.right = 1400
  key.shadow.camera.top = 1000
  key.shadow.camera.bottom = -1000
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
  const rim = new THREE.DirectionalLight('#849bb5', 1.25)
  rim.position.set(420, 90, -250)
  scene.add(rim)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#f1f5f7', roughness: 0.78, metalness: 0.14 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -330
  floor.receiveShadow = renderer.shadowMap.enabled
  scene.add(floor)
  stageGrid = new THREE.GridHelper(3600, 48, 0x70869b, 0x43576a)
  stageGrid.position.y = -328
  const gridMaterials = Array.isArray(stageGrid.material) ? stageGrid.material : [stageGrid.material]
  gridMaterials.forEach(material => { material.transparent = true; material.opacity = 0.06; material.depthWrite = false })
  scene.add(stageGrid)
  observer = new ResizeObserver(resize)
  observer.observe(canvas.value)
  rebuild()
  emit('ready', true)
}

function disposeDynamicObjects() {
  if (!scene) return
  cardGroups.forEach((group, id) => {
    scene?.remove(group)
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      if (object.geometry !== boxGeometry && object.geometry !== faceGeometry) object.geometry.dispose()
      if (object.material !== cardMaterials.get(id)) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose())
    })
  })
  edgeMeshes.forEach(mesh => {
    scene?.remove(mesh)
    ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose())
  })
  edgeLabels.forEach(mesh => {
    scene?.remove(mesh)
    ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => {
      const map = (material as THREE.MeshBasicMaterial).map
      map?.dispose()
      material.dispose()
    })
  })
  edgeGeometry?.dispose()
  edgeGeometry = null
  cardGroups.clear()
  edgeMeshes.clear()
  edgeLabels.clear()
  cardMaterials.forEach(material => material.dispose())
  cardMaterials.clear()
  cardTextures.forEach(texture => texture.dispose())
  cardTextures.clear()
}

function rebuild() {
  if (!scene || !renderer) return
  renderEpoch += 1
  disposeDynamicObjects()
  for (const person of props.people) {
    const group = new THREE.Group()
    group.userData.personId = person.id
    const material = new THREE.MeshPhysicalMaterial({ color: '#c6d6df', metalness: 0.08, roughness: 0.72, clearcoat: 0.15, clearcoatRoughness: 0.55 })
    cardMaterials.set(person.id, material)
    const body = new THREE.Mesh(boxGeometry, material)
    body.castShadow = props.people.length <= 28
    body.receiveShadow = true
    group.add(body)
    const texture = makePersonTexture(person)
    if (texture) {
      const face = new THREE.Mesh(faceGeometry, new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }))
      face.position.z = CARD_DEPTH / 2 + 0.15
      group.add(face)
    }
    scene.add(group)
    cardGroups.set(person.id, group)
  }

  edgeGeometry = new THREE.CylinderGeometry(1.1, 1.1, 1, 8, 1, true)
  for (const relationship of props.relationships) {
    const material = new THREE.MeshStandardMaterial({ color: '#8ba8b5', roughness: 0.4, metalness: 0.56, emissive: '#000000', emissiveIntensity: 0.18 })
    const line = new THREE.Mesh(edgeGeometry, material)
    line.userData.relationshipId = relationship.id
    scene.add(line)
    edgeMeshes.set(relationship.id, line)

    const width = Math.min(180, Math.max(72, (relationship.label || '关联').length * 9 + 28))
    const labelTexture = makeLabelTexture(relationship.label || '关联')
    if (labelTexture) {
      const label = new THREE.Mesh(labelGeometry, new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, toneMapped: false, side: THREE.DoubleSide }))
      label.scale.x = width
      label.position.z = 18
      label.userData.relationshipId = relationship.id
      scene.add(label)
      edgeLabels.set(relationship.id, label)
    }
  }
  syncScene()
}

function depthFor(person: PersonRecord, index: number) {
  if (person.id === props.selectedId) return 14
  if (person.id === props.centerId) return 3
  if (person.id === props.linkSourceId || person.id === props.linkTargetId) return 10
  return 2 + index % 3
}

function updateCamera() {
  if (!camera || !canvas.value) return
  const height = Math.max(1, canvas.value.clientHeight)
  const width = Math.max(1, canvas.value.clientWidth)
  const baseDistance = height / (2 * Math.tan(THREE.MathUtils.degToRad(42 / 2)))
  const zoom = Math.max(0.06, Math.min(3, props.zoom))
  const target = new THREE.Vector3((width / 2 - props.pan.x) / zoom - 400, (props.pan.y - height / 2) / zoom + 240, 0)
  const distance = baseDistance / zoom
  const yaw = props.rotation.x
  const pitch = props.rotation.y
  desiredCameraPosition.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    target.y + Math.sin(pitch) * distance,
    target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  )
  desiredCameraTarget.copy(target)
  if (!cameraMotionInitialized) {
    camera.position.copy(desiredCameraPosition)
    currentCameraTarget.copy(desiredCameraTarget)
    camera.lookAt(currentCameraTarget)
    cameraMotionInitialized = true
  } else cameraMotionActive = true
  camera.updateProjectionMatrix()
}

function updateCards() {
  if (!scene || !camera || !canvas.value) return
  projected.clear()
  props.people.forEach((person, index) => {
    const group = cardGroups.get(person.id)
    const point = props.positions[person.id]
    if (!group || !point) return
    const z = depthFor(person, index)
    group.visible = !props.hideUnrelated || !props.selectedId || person.id === props.selectedId || props.relationships.some(relationship => relationship.fromId === props.selectedId && relationship.toId === person.id || relationship.toId === props.selectedId && relationship.fromId === person.id)
    group.position.set(point.x - 400, 240 - point.y, z)
    group.rotation.set(0, 0, 0)
    group.userData.depth = z
    group.userData.cardPosition = group.position.clone()
    const dimmed = Boolean(props.linkSourceId && person.id !== props.linkSourceId && person.id !== props.linkTargetId)
    const selectedDimmed = Boolean(!props.linkSourceId && props.selectedId && person.id !== props.selectedId)
    const opacity = dimmed || selectedDimmed ? 0.25 : 1
    const material = cardMaterials.get(person.id)
    if (material) {
      material.transparent = opacity < 1
      material.opacity = opacity
      material.emissive.set(person.id === props.linkTargetId ? '#c5d9e5' : person.id === props.selectedId ? '#dbe8ef' : '#000000')
      material.emissiveIntensity = person.id === props.selectedId || person.id === props.linkTargetId ? 0.56 : 0.05
    }
    const face = group.children[1] as THREE.Mesh | undefined
    if (face?.material instanceof THREE.Material) {
      const faceMaterial = face.material as THREE.MeshBasicMaterial
      faceMaterial.transparent = opacity < 1
      faceMaterial.opacity = opacity
    }
    screenPoint.copy(group.position).project(camera)
    const projectedPoint = new THREE.Vector3((screenPoint.x + 1) * 0.5 * canvas.value.clientWidth, (1 - screenPoint.y) * 0.5 * canvas.value.clientHeight, screenPoint.z)
    projected.set(person.id, projectedPoint)
  })
}

function updateEdges() {
  if (!scene || !camera) return
  for (const relationship of props.relationships) {
    const line = edgeMeshes.get(relationship.id)
    const label = edgeLabels.get(relationship.id)
    const fromGroup = cardGroups.get(relationship.fromId)
    const toGroup = cardGroups.get(relationship.toId)
    if (!line || !fromGroup || !toGroup) continue
    fromPoint.copy(fromGroup.position)
    toPoint.copy(toGroup.position)
    direction.subVectors(toPoint, fromPoint)
    const length = direction.length()
    if (length < 1) continue
    const fromVisible = fromGroup.visible
    const toVisible = toGroup.visible
    line.visible = fromVisible && toVisible
    if (label) label.visible = line.visible
    if (!line.visible) continue
    direction.normalize()
    fromPoint.addScaledVector(direction, 88)
    toPoint.addScaledVector(direction, -88)
    direction.subVectors(toPoint, fromPoint)
    const segmentLength = Math.max(1, direction.length())
    line.position.copy(fromPoint).add(toPoint).multiplyScalar(0.5)
    line.scale.set(1, segmentLength, 1)
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    const connected = !props.linkSourceId && Boolean(props.selectedId) && (relationship.fromId === props.selectedId || relationship.toId === props.selectedId)
    const material = line.material as THREE.MeshStandardMaterial
    material.color.set(connected ? '#638596' : '#8ba8b5')
    material.transparent = Boolean(props.selectedId || props.linkSourceId)
    material.opacity = material.transparent && !connected && !props.linkSourceId ? 0.2 : 0.88
    if (props.linkSourceId) material.opacity = relationship.fromId === props.linkSourceId || relationship.toId === props.linkSourceId ? 0.92 : 0.12
    if (label) {
      label.position.copy(fromPoint).add(toPoint).multiplyScalar(0.5)
      label.position.z += 20
      label.quaternion.copy(camera.quaternion)
      const labelMaterial = label.material as THREE.MeshBasicMaterial
      labelMaterial.transparent = Boolean(props.selectedId || props.linkSourceId)
      labelMaterial.opacity = props.linkSourceId && relationship.fromId !== props.linkSourceId && relationship.toId !== props.linkSourceId ? 0.25 : props.selectedId && !connected ? 0.58 : 1
    }
  }
}

function emitProjected() {
  if (!canvas.value) return
  const next: Record<string, Point & { width: number; height: number }> = {}
  const height = Math.max(1, canvas.value.clientHeight)
  const baseDistance = height / (2 * Math.tan(THREE.MathUtils.degToRad(42 / 2)))
  const zoom = Math.max(0.06, Math.min(3, props.zoom))
  projected.forEach((point, id) => {
    const group = cardGroups.get(id)
    const depth = Number(group?.userData.depth) || 0
    const scale = baseDistance / Math.max(1, baseDistance / zoom - depth)
    const yaw = props.rotation.x - (group?.rotation.y || 0)
    const widthScale = Math.max(0.28, Math.abs(Math.cos(yaw)))
    const heightScale = Math.max(0.55, Math.abs(Math.cos(props.rotation.y)))
    next[id] = { x: point.x, y: point.y, width: CARD_WIDTH * scale * widthScale, height: CARD_HEIGHT * scale * heightScale }
  })
  const changed = Object.keys(next).length !== Object.keys(projectedCache).length || Object.entries(next).some(([id, point]) => {
    const old = projectedCache[id]
    return !old || Math.abs(point.x - old.x) > 0.35 || Math.abs(point.y - old.y) > 0.35 || Math.abs(point.width - old.width) > 0.35 || Math.abs(point.height - old.height) > 0.35
  })
  if (changed) {
    projectedCache = next
    emit('projected', next)
  }
}

function syncScene() {
  if (!renderer || !scene || !camera) return
  updateCamera()
  updateCards()
  updateEdges()
  scheduleRender()
}

function scheduleRender() {
  if (!renderer || frame) return
  frame = requestAnimationFrame(renderFrame)
}

function renderFrame(now: number) {
  frame = 0
  if (!renderer || !scene || !camera) return
  const delta = previousFrame ? Math.min((now - previousFrame) / 1000, 0.05) : 1 / 60
  previousFrame = now
  if (cameraMotionActive) {
    const alpha = 1 - Math.exp(-12 * delta)
    camera.position.lerp(desiredCameraPosition, alpha)
    currentCameraTarget.lerp(desiredCameraTarget, alpha)
    camera.lookAt(currentCameraTarget)
    updateEdges()
    if (camera.position.distanceToSquared(desiredCameraPosition) < 0.04 && currentCameraTarget.distanceToSquared(desiredCameraTarget) < 0.04) {
      camera.position.copy(desiredCameraPosition)
      currentCameraTarget.copy(desiredCameraTarget)
      camera.lookAt(currentCameraTarget)
      cameraMotionActive = false
      previousFrame = 0
    }
  }
  renderer.render(scene, camera)
  emitProjected()
  if (cameraMotionActive) frame = requestAnimationFrame(renderFrame)
  else previousFrame = 0
}

function resize() {
  if (!canvas.value || !renderer || !camera) return
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  syncScene()
}

watch(() => props.people.map(person => `${person.id}:${person.name}:${person.aliases.join(',')}:${person.photoPath}:${props.clueCounts[person.id] || 0}:${props.imageUrls[person.photoPath] || ''}`).join('|'), () => rebuild())
watch(() => props.relationships.map(relationship => `${relationship.id}:${relationship.fromId}:${relationship.toId}:${relationship.label}`).join('|'), () => rebuild())
watch(() => [props.positions, props.pan, props.zoom, props.rotation, props.selectedId, props.linkSourceId, props.linkTargetId, props.hideUnrelated], () => syncScene(), { deep: true })

onMounted(init)
onUnmounted(() => {
  disposed = true
  renderEpoch += 1
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  disposeDynamicObjects()
  boxGeometry.dispose()
  faceGeometry.dispose()
  labelGeometry.dispose()
  if (scene) scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    if (object.geometry !== boxGeometry && object.geometry !== faceGeometry && object.geometry !== labelGeometry) object.geometry.dispose()
    ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose())
  })
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
})
</script>

<template>
  <canvas ref="canvas" class="relationship-spatial-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.relationship-spatial-canvas{position:absolute;z-index:0;inset:0;width:100%;height:100%;pointer-events:none}
</style>
