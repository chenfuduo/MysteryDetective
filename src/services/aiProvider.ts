import { reactive } from 'vue'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

export type AiProvider = 'deepseek' | 'openai'
type RoutingPhase = 'checking' | 'ready' | 'offline' | 'unknown'

export const aiRoute = reactive({
  provider: null as AiProvider | null,
  phase: 'checking' as RoutingPhase,
  countryCode: '',
  message: '正在检测 IP 地区',
})

export function providerLabel(provider: AiProvider | null): string {
  return provider === 'openai' ? 'GPT' : provider === 'deepseek' ? 'DeepSeek' : '待检测'
}

let detection: Promise<void> | null = null

export function initializeAiRouting(): Promise<void> {
  if (detection) return detection
  detection = detectRegion().finally(() => { detection = null })
  return detection
}

async function detectRegion(): Promise<void> {
  aiRoute.provider = null
  aiRoute.countryCode = ''
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    aiRoute.phase = 'offline'
    aiRoute.message = '当前离线，使用本地整理'
    return
  }
  aiRoute.phase = 'checking'
  aiRoute.message = '正在检测 IP 地区'
  const url = 'https://ipwho.is/?fields=success,message,country_code'
  try {
    let body: { success?: boolean; country_code?: unknown }
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({ url, connectTimeout: 5000, readTimeout: 5000 })
      if (response.status !== 200) throw new Error('IP 地区服务暂不可用')
      body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store', credentials: 'omit' })
      if (!response.ok) throw new Error('IP 地区服务暂不可用')
      body = await response.json()
    }
    const country = typeof body?.country_code === 'string' ? body.country_code.toUpperCase() : ''
    if (body?.success !== true || !/^[A-Z]{2}$/.test(country)) throw new Error('IP 地区识别失败')
    aiRoute.countryCode = country
    aiRoute.provider = country === 'CN' ? 'deepseek' : 'openai'
    aiRoute.phase = 'ready'
    aiRoute.message = `${country === 'CN' ? '中国 IP' : `${country} IP`} · 已选 ${providerLabel(aiRoute.provider)}`
  } catch {
    aiRoute.phase = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unknown'
    aiRoute.message = aiRoute.phase === 'offline' ? '当前离线，使用本地整理' : 'IP 地区检测失败，点击重试'
  }
}

export async function resolveAiProvider(): Promise<AiProvider> {
  if (aiRoute.phase !== 'ready') await initializeAiRouting()
  if (aiRoute.phase === 'offline') throw new Error('offline: 当前离线')
  if (!aiRoute.provider) throw new Error('无法识别 IP 地区，请点击右上角状态灯重试')
  return aiRoute.provider
}
