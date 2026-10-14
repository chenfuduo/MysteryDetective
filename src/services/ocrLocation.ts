/** Line-level bounds in the upright original image; top-left origin, normalized to 0…1. */
export type OcrRegion = { text: string; x: number; y: number; width: number; height: number; confidence?: number }

type NativeOcrLine = { text: string; confidence?: number; boundingBox?: { x: number; y: number; width: number; height: number } }

export function normalizedOcrRegions(lines: readonly NativeOcrLine[]): OcrRegion[] {
  return lines.flatMap(line => {
    const box = line.boundingBox
    if (!line.text?.trim() || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return []
    const x = Math.max(0, box.x), y = Math.max(0, box.y)
    const width = Math.min(1, box.x + box.width) - x, height = Math.min(1, box.y + box.height) - y
    if (width <= 0 || height <= 0) return []
    return [{ text: line.text, x, y, width, height, ...(typeof line.confidence === 'number' && Number.isFinite(line.confidence) ? { confidence: line.confidence } : {}) }]
  })
}

function locationText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
}

/** Never guess the location of corrected or unmatched text. A hit is an exact normalized quote across OCR lines. */
export function matchOcrRegions(regions: readonly OcrRegion[], quote: string): OcrRegion[] {
  const needle = locationText(quote)
  if (needle.length < 2) return []
  const lines = regions.filter(region => typeof region.text === 'string' && [region.x, region.y, region.width, region.height].every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001).map(region => ({ region, text: locationText(region.text) }))
  const source = lines.map(line => line.text).join('')
  const spans: { start: number; end: number }[] = []
  let from = 0
  while (from <= source.length - needle.length) {
    const start = source.indexOf(needle, from)
    if (start < 0) break
    spans.push({ start, end: start + needle.length })
    from = start + needle.length
  }
  if (!spans.length) return []
  let offset = 0
  return lines.filter(line => {
    const start = offset
    offset += line.text.length
    return line.text.length > 0 && spans.some(span => span.start < offset && span.end > start)
  }).map(line => line.region)
}
