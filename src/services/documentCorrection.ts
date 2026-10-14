export type DocumentPoint = { x: number; y: number }
export type DocumentQuad = [DocumentPoint, DocumentPoint, DocumentPoint, DocumentPoint]

export function defaultDocumentQuad(): DocumentQuad {
  return [{ x: .04, y: .04 }, { x: .96, y: .04 }, { x: .96, y: .96 }, { x: .04, y: .96 }]
}

export function validDocumentQuad(points: DocumentQuad): boolean {
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1)) return false
  let twiceArea = 0
  for (let index = 0; index < 4; index++) {
    const a = points[index]!, b = points[(index + 1) % 4]!, c = points[(index + 2) % 4]!
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < .0004) return false
    if (Math.hypot(b.x - a.x, b.y - a.y) < .025) return false
    twiceArea += a.x * b.y - b.x * a.y
  }
  return twiceArea >= .03
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消校正', 'AbortError')
}

/** Decode the original orientation, then bound its working canvas to avoid full-resolution pixel buffers. */
export async function loadDocumentImage(src: string, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  cancelled(signal)
  const image = new Image()
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); image.removeAttribute('src'); reject(new DOMException('已取消载入', 'AbortError')) }
    image.onload = () => { cleanup(); resolve() }
    image.onerror = () => { cleanup(); image.removeAttribute('src'); reject(new Error('无法读取原始照片，请关闭后重试。')) }
    signal?.addEventListener('abort', abort, { once: true })
    image.src = src
  })
  try {
    cancelled(signal)
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('原始照片尺寸无效。')
    const scale = Math.min(1, 3200 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('当前设备无法创建校正画布。')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    image.removeAttribute('src')
  }
}

/** Rectangle-to-quadrilateral projective transform, sampled backwards with bilinear interpolation. */
export async function correctDocumentPerspective(source: HTMLCanvasElement, quad: DocumentQuad, signal?: AbortSignal): Promise<string> {
  cancelled(signal)
  if (!validDocumentQuad(quad)) throw new Error('请保持四个角顺序正确，且选区不能交叉或过小。')
  const points = quad.map(point => ({ x: point.x * (source.width - 1), y: point.y * (source.height - 1) }))
  const [p0, p1, p2, p3] = points as DocumentQuad
  const distance = (a: DocumentPoint, b: DocumentPoint) => Math.hypot(a.x - b.x, a.y - b.y)
  const rawWidth = (distance(p0, p1) + distance(p3, p2)) / 2
  const rawHeight = (distance(p0, p3) + distance(p1, p2)) / 2
  const scale = Math.min(1, 2400 / Math.max(rawWidth, rawHeight))
  const width = Math.max(2, Math.round(rawWidth * scale)), height = Math.max(2, Math.round(rawHeight * scale))
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y
  const determinant = dx1 * dy2 - dx2 * dy1
  let g = 0, h = 0
  if (Math.abs(dx3) + Math.abs(dy3) > .000001) {
    if (Math.abs(determinant) < .000001) throw new Error('选区角度过小，请重新选择纸张四角。')
    g = (dx3 * dy2 - dx2 * dy3) / determinant
    h = (dx1 * dy3 - dx3 * dy1) / determinant
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y
  const sourceContext = source.getContext('2d', { willReadFrequently: true })
  const output = document.createElement('canvas')
  output.width = width; output.height = height
  try {
    const context = output.getContext('2d')
    if (!context || !sourceContext) throw new Error('当前设备无法创建校正画布。')
    const input = sourceContext.getImageData(0, 0, source.width, source.height).data
    const image = context.createImageData(width, height), pixels = image.data
    let lastYield = performance.now()
    for (let y = 0; y < height; y++) {
      const v = y / (height - 1)
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1), divisor = g * u + h * v + 1
        if (!Number.isFinite(divisor) || Math.abs(divisor) < .00000001) throw new Error('选区无法校正，请重新选择四角。')
        const sx = Math.max(0, Math.min(source.width - 1, (a * u + b * v + c) / divisor))
        const sy = Math.max(0, Math.min(source.height - 1, (d * u + e * v + f) / divisor))
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1)
        const tx = sx - x0, ty = sy - y0
        const i00 = (y0 * source.width + x0) * 4, i10 = (y0 * source.width + x1) * 4
        const i01 = (y1 * source.width + x0) * 4, i11 = (y1 * source.width + x1) * 4
        const out = (y * width + x) * 4
        for (let channel = 0; channel < 3; channel++) {
          pixels[out + channel] = (input[i00 + channel]! * (1 - tx) + input[i10 + channel]! * tx) * (1 - ty) + (input[i01 + channel]! * (1 - tx) + input[i11 + channel]! * tx) * ty
        }
        pixels[out + 3] = 255
      }
      if (y % 8 === 0 && performance.now() - lastYield >= 12) {
        cancelled(signal)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        cancelled(signal)
        lastYield = performance.now()
      }
    }
    cancelled(signal)
    context.putImageData(image, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('校正图片编码失败，请重试。')), 'image/jpeg', .9))
    cancelled(signal)
    const result = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      const abort = () => reader.abort()
      const cleanup = () => signal?.removeEventListener('abort', abort)
      reader.onload = () => { cleanup(); resolve(String(reader.result)) }
      reader.onerror = () => { cleanup(); reject(new Error('无法保存校正预览，请重试。')) }
      reader.onabort = () => { cleanup(); reject(new DOMException('已取消校正', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      reader.readAsDataURL(blob)
    })
    cancelled(signal)
    return result
  } finally {
    output.width = 0; output.height = 0
  }
}
