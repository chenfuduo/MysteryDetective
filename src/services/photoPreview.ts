import { imageUrl } from './vault'

type Preview = { url: string; width: number; height: number; owned: boolean }
type Entry = { refs: number; usedAt: number; settled: boolean; result: Preview | null; promise: Promise<Preview> }
const previews = new Map<string, Entry>()
const queue: Array<() => void> = []
const maxCachedPreviews = 60
let active = 0

function scheduled<T>(work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push(() => {
      active += 1
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; drain() })
    })
    drain()
  })
}
function drain() { while (active < 4 && queue.length) queue.shift()!() }
function trim() {
  if (previews.size <= maxCachedPreviews) return
  const unused = [...previews.entries()].filter(([, entry]) => entry.refs === 0 && entry.settled).sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [key, entry] of unused) {
    if (previews.size <= maxCachedPreviews) break
    if (entry.result?.owned) URL.revokeObjectURL(entry.result.url)
    previews.delete(key)
  }
}
async function renderPreview(path: string, rotation: number): Promise<Preview> {
  const source = await imageUrl(path)
  if (!source) throw new Error('照片暂时无法读取')
  const photo = new Image()
  photo.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      photo.onload = () => resolve()
      photo.onerror = () => reject(new Error('照片暂时无法读取'))
      photo.src = source
    })
    const radians = rotation * Math.PI / 180
    const rotatedWidth = Math.abs(Math.cos(radians)) * photo.naturalWidth + Math.abs(Math.sin(radians)) * photo.naturalHeight
    const rotatedHeight = Math.abs(Math.sin(radians)) * photo.naturalWidth + Math.abs(Math.cos(radians)) * photo.naturalHeight
    const factor = Math.min(1, 360 / Math.max(rotatedWidth, rotatedHeight))
    const width = Math.max(1, Math.round(rotatedWidth * factor)), height = Math.max(1, Math.round(rotatedHeight * factor))
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('预览暂不可用')
      context.translate(width / 2, height / 2)
      context.rotate(radians)
      context.drawImage(photo, -photo.naturalWidth * factor / 2, -photo.naturalHeight * factor / 2, photo.naturalWidth * factor, photo.naturalHeight * factor)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .82))
      canvas.width = 0; canvas.height = 0
      if (!blob) throw new Error('预览暂不可用')
      return { url: URL.createObjectURL(blob), width, height, owned: true }
    } catch {
      return { url: source, width: photo.naturalWidth, height: photo.naturalHeight, owned: false }
    }
  } finally {
    photo.onload = null; photo.onerror = null; photo.removeAttribute('src')
  }
}

export function acquirePhotoPreview(path: string, rotation = 0): { result: Promise<Preview>; release: () => void } {
  const angle = ((rotation % 360) + 360) % 360
  const key = JSON.stringify([path, angle])
  let entry = previews.get(key)
  if (!entry) {
    const created: Entry = { refs: 0, usedAt: Date.now(), settled: false, result: null, promise: scheduled(async () => {
      if (!created.refs) throw new Error('预览已离开视野')
      return renderPreview(path, angle)
    }) }
    created.promise = created.promise.then(result => { created.result = result; created.settled = true; trim(); return result }).catch(error => { if (previews.get(key) === created) previews.delete(key); throw error })
    entry = created
    previews.set(key, entry)
  }
  entry.refs += 1
  entry.usedAt = Date.now()
  const acquired = entry
  let released = false
  return { result: acquired.promise, release: () => { if (released) return; released = true; acquired.refs = Math.max(0, acquired.refs - 1); acquired.usedAt = Date.now(); trim() } }
}

export function discardPhotoPreview(path: string, rotation = 0): void {
  const key = JSON.stringify([path, ((rotation % 360) + 360) % 360])
  const entry = previews.get(key)
  if (!entry || entry.refs) return
  if (entry.result?.owned) URL.revokeObjectURL(entry.result.url)
  previews.delete(key)
}
