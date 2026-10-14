import type { OcrRegion } from './ocrLocation'

export type PhotoQualityIssue = {
  kind: 'blur' | 'glare' | 'small-text' | 'resolution'
  label: string
  detail: string
}
export type PhotoQualityReport = {
  issues: PhotoQualityIssue[]
  width: number
  height: number
  summary: string
  textAssessed: boolean
}

const cache = new Map<string, Promise<PhotoQualityReport>>()
let queue: Promise<unknown> = Promise.resolve()
const yieldFrame = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const percentile = (values: number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] || 0
}
function cacheKey(src: string, regions: OcrRegion[]) {
  // Only geometry/confidence affects this assessment. No OCR text is retained here.
  return `${src}\n${regions.map(region => `${region.x},${region.y},${region.width},${region.height},${region.confidence ?? ''}`).join(';')}`
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const timeout = setTimeout(() => { image.src = ''; reject(new Error('读取照片超时，请重试')) }, 12000)
    image.onload = () => { clearTimeout(timeout); resolve(image) }
    image.onerror = () => { clearTimeout(timeout); reject(new Error('照片暂时无法读取，请重试')) }
    image.src = src
  })
}

export function clearPhotoQualityCache(src?: string) {
  if (!src) { cache.clear(); return }
  for (const key of cache.keys()) if (key.startsWith(`${src}\n`)) cache.delete(key)
}

/** Local, advisory heuristics only. Never uploads, rewrites or rejects a photo. */
export function analyzePhotoQuality(src: string, regions: OcrRegion[] = []): Promise<PhotoQualityReport> {
  if (!src) return Promise.reject(new Error('尚未载入照片'))
  const key = cacheKey(src, regions)
  const existing = cache.get(key)
  if (existing) { cache.delete(key); cache.set(key, existing); return existing }
  const pending = queue.then(() => assess(src, regions))
  queue = pending.catch(() => undefined)
  cache.set(key, pending)
  while (cache.size > 24) cache.delete(cache.keys().next().value!)
  void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key) })
  return pending
}

async function assess(src: string, regions: OcrRegion[]): Promise<PhotoQualityReport> {
  const image = await loadImage(src)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) throw new Error('照片尺寸无效，请重新打开')
  const ratio = Math.min(1, 900 / Math.max(width, height))
  const sampleWidth = Math.max(1, Math.round(width * ratio))
  const sampleHeight = Math.max(1, Math.round(height * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = sampleWidth
  canvas.height = sampleHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('当前设备无法检查照片')
  const issues: PhotoQualityIssue[] = []
  try {
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight)
    let pixels: Uint8ClampedArray
    try { pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data }
    catch { throw new Error('当前照片无法在本地检查，请重新打开') }
    const gray = new Float32Array(sampleWidth * sampleHeight)
    for (let y = 0; y < sampleHeight; y++) {
      for (let x = 0; x < sampleWidth; x++) {
        const position = y * sampleWidth + x
        const channel = position * 4
        gray[position] = pixels[channel] * 0.2126 + pixels[channel + 1] * 0.7152 + pixels[channel + 2] * 0.0722
      }
      if (y % 80 === 79) await yieldFrame()
    }
    const tileSize = 48
    const tiles: { column: number; row: number; mean: number; deviation: number; clipped: number; laplacian: number; count: number }[] = []
    const textured: number[] = []
    let texturedPixels = 0
    for (let y = 1; y < sampleHeight - 1; y += tileSize) {
      for (let x = 1; x < sampleWidth - 1; x += tileSize) {
        let sum = 0, squared = 0, clipped = 0, lapSum = 0, lapSquared = 0, count = 0
        for (let ty = y; ty < Math.min(y + tileSize, sampleHeight - 1); ty++) {
          for (let tx = x; tx < Math.min(x + tileSize, sampleWidth - 1); tx++) {
            const position = ty * sampleWidth + tx
            const light = gray[position]
            const lap = 4 * light - gray[position - 1] - gray[position + 1] - gray[position - sampleWidth] - gray[position + sampleWidth]
            sum += light; squared += light * light; lapSum += lap; lapSquared += lap * lap
            if (light >= 253) clipped++
            count++
          }
        }
        if (!count) continue
        const mean = sum / count
        const variance = Math.max(0, squared / count - mean * mean)
        const laplacian = Math.max(0, lapSquared / count - (lapSum / count) ** 2)
        const tile = { column: Math.floor((x - 1) / tileSize), row: Math.floor((y - 1) / tileSize), mean, deviation: Math.sqrt(variance), clipped: clipped / count, laplacian, count }
        tiles.push(tile)
        // Blank paper is excluded: only textured tiles contribute to blur evidence.
        if (variance >= 90 && mean > 30 && mean < 248) { textured.push(laplacian); texturedPixels += count }
        await yieldFrame()
      }
    }
    if (Math.min(width, height) < 650 || Math.max(width, height) < 1000) {
      issues.push({ kind: 'resolution', label: '照片尺寸偏小', detail: `原图为 ${width} × ${height} 像素。靠近纸张拍摄，或导入更清晰的原图，有助于保留细小文字。` })
    }
    if (textured.length >= 4 && texturedPixels / gray.length >= 0.03 && percentile(textured, 0.5) < 52 && percentile(textured, 0.75) < 90) {
      issues.push({ kind: 'blur', label: '可能有些模糊', detail: '有文字或纹理的区域边缘较弱。可以放大核对，必要时保持相机稳定后重拍。' })
    }
    let glarePixels = 0
    for (const tile of tiles) {
      if (tile.clipped < 0.9 || tile.deviation > 6) continue
      const neighbors = tiles.filter(other => Math.abs(other.column - tile.column) <= 1 && Math.abs(other.row - tile.row) <= 1 && other !== tile)
      // White paper alone is not glare: require a locally brighter, clipped patch.
      if (neighbors.filter(other => other.mean < 230 && tile.mean - other.mean >= 24).length >= 2) glarePixels += tile.count
    }
    if (glarePixels / gray.length >= 0.015) {
      issues.push({ kind: 'glare', label: '局部可能反光', detail: '检测到局部过亮且细节较少的区域，也可能是纸张留白。请查看该处是否遮住文字；调整灯光或拍摄角度可减少反光。' })
    }
    const reliableHeights = regions.filter(region => Number.isFinite(region.height) && region.height > 0 && region.height <= 1 && region.width > 0 && region.width <= 1 && (region.confidence === undefined || region.confidence >= 0.5) && region.text.trim().length >= 2).map(region => region.height * height)
    const textAssessed = reliableHeights.length >= 4
    if (textAssessed && (percentile(reliableHeights, 0.5) < 14 || percentile(reliableHeights, 0.25) < 10)) {
      issues.push({ kind: 'small-text', label: '部分文字偏小', detail: '已定位的文字行在原图中高度较小。建议靠近纸张或分段拍摄，减少小字漏识别。' })
    }
    return {
      width, height, issues, textAssessed,
      summary: issues.length ? `${issues.length} 项拍摄改善建议` : '未发现明显的拍摄问题',
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
