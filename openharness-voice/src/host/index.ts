/**
 * openharness-voice — host half (Node side).
 *
 * Registers the `/openharness-voice` generic Connection RPC channel
 * (`ctx.connection.rpc.handle`, authority `loopback` — the same browser-trust
 * fence as `/api`). The browser (client half) calls this channel to:
 *
 *   stt — upload a PCM16 WAV Blob (base64); the host forwards it to the
 *         configured cloud STT provider (Azure Speech, V1) so the spectrum
 *         key stays server-side and CORS never bites the browser.
 *   tts — optional; forward plain text to the cloud TTS provider.
 *
 * The host thus acts as a thin cloud-API proxy: no audio/AI model runs here.
 * Provider selection is abstracted behind `resolveStt`/`resolveTts` so a
 * second provider slot can be added later without touching the client.
 *
 * Rules honored (openharness-rule-for-dsh-plugin):
 *  - named exports only (`name` / `inject` / `apply`), no default export;
 *  - service deps declared via the patch entry's `inject` (`connection`);
 *  - no plain-object `Config` export;
 *  - `apply` never throws — every handler try/catches and maps failures to a
 *    `{ status: 'error', code, message }` result (degrade, never crash boot).
 */

import type { SttRequest, SttResult, TtsRequest, TtsResult, VoiceFailure, VoiceResult } from '../shared/protocol'
import { EP_STT, EP_TTS, RPC_CHANNEL } from '../shared/protocol'

export const name = 'openharness-voice'

/** Hard deps: `connection` provides the RPC channel host side. */
export const inject = ['connection']

type ConnectionRpcLike = {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown) => Promise<unknown>,
    options: { authority: 'loopback' | 'trusted-host' },
  ): (() => Promise<void>) | void
}

interface HostContext {
  get(name: string): unknown
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
  effect?(fn: () => unknown, label?: string): unknown
}

/** Row config (cordis.patch.yml) — V1 accepts optional overrides but never a Config object. */
export interface HostConfig {
  enabled?: boolean
  provider?: string
  language?: string
}

function failure(code: VoiceFailure['code'], message: string): VoiceFailure {
  return { status: 'error', code, message }
}

/** Business success result (voice code). */
function ok<T>(value: T): { status: 'ok'; value: T } {
  return { status: 'ok', value }
}

/** Read a required env var; returns undefined when absent/unset. */
function env(name: string): string | undefined {
  const v = procEnv()[name]
  return v?.trim() ? v.trim() : undefined
}

/** Connection RPC success envelope (what the browser's rpc.call expects). */
function jsonResult<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** host runs in Node — read process.env without importing @types/node types. */
function procEnv(): Record<string, string | undefined> {
  return ((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {}
}

/**
 * Azure Speech — short-audio synchronous REST STT.
 * POST https://<region>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
 * Body: raw PCM16 16kHz mono WAV bytes. Key rides the header (no token exchange).
 */
async function azureStt(req: SttRequest): Promise<VoiceResult<SttResult>> {
  const key = env('AZURE_SPEECH_KEY')
  const region = env('AZURE_SPEECH_REGION')
  if (!key || !region) {
    return failure('NO_CONFIG', 'Azure Speech 未配置：请设置环境变量 AZURE_SPEECH_KEY 与 AZURE_SPEECH_REGION')
  }
  if (!req.audioBase64) return failure('BAD_AUDIO', '没有收到音频字节')

  let audio: Uint8Array
  try {
    // host runs in Node — use Buffer (atob/btoa are browser globals, absent here)
    const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number } } }
    const buf = g.Buffer?.from(req.audioBase64, 'base64')
    if (!buf) return failure('BAD_AUDIO', '宿主环境缺少 Buffer，无法解码音频')
    audio = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch {
    return failure('BAD_AUDIO', '音频 base64 解码失败')
  }
  if (audio.length === 0) return failure('BAD_AUDIO', '音频字节为空')

  const language = req.language ?? 'zh-CN'
  const endpoint =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/` +
    `conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`

  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': req.mimeType ?? 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: audio as unknown as BodyInit,
    })
  } catch (error) {
    return failure('STT_FAILED', `Azure STT 网络错误：${error instanceof Error ? error.message : String(error)}`)
  }

  const raw = await resp.text()
  if (!resp.ok) {
    return failure('STT_FAILED', `Azure STT HTTP ${resp.status}: ${raw.slice(0, 300)}`)
  }
  let data: { RecognitionStatus?: string; DisplayText?: string; NBest?: Array<{ Display?: string }> }
  try {
    data = JSON.parse(raw)
  } catch {
    return failure('STT_FAILED', `Azure 返回非 JSON：${raw.slice(0, 300)}`)
  }
  if (data.RecognitionStatus !== 'Success' || (!data.DisplayText && !(data.NBest?.length))) {
    return ok<SttResult>({ text: '', status: data.RecognitionStatus ?? 'Unknown' })
  }
  const text = (data.NBest?.[0]?.Display ?? data.DisplayText ?? '').trim()
  return ok<SttResult>({ text, status: data.RecognitionStatus })
}

/**
 * Azure Speech — TTS REST (V1 scaffold). Returns base64 playable audio.
 * POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1 (SSML).
 * Kept intentionally thin; V1 client already prefers browser speechSynthesis,
 * so this is the documented fallback for hosts where the browser cannot speak.
 */
async function azureTts(req: TtsRequest): Promise<VoiceResult<TtsResult>> {
  const key = env('AZURE_SPEECH_KEY')
  const region = env('AZURE_SPEECH_REGION')
  if (!key || !region) return failure('NO_CONFIG', 'Azure TTS 未配置')
  if (!req.text) return failure('BAD_REQUEST', '没有要朗读的文本')
  const language = req.language ?? 'zh-CN'
  const ssml =
    `<speak version='1.0' xml:lang='${language}'><voice xml:lang='${language}' xml:gender='Female' name='zh-CN-XiaoxiaoNeural'>` +
    `${req.text}</voice></speak>`
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`

  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'openharness-voice',
      },
      body: ssml,
    })
  } catch (error) {
    return failure('TTS_FAILED', `Azure TTS 网络错误：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!resp.ok) return failure('TTS_FAILED', `Azure TTS HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const buf = await resp.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.length === 0) return failure('TTS_FAILED', 'Azure TTS 返回空音频')
  const audioBase64 = ((globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
    ?.from(bytes)
    .toString('base64')) ?? ''
  return ok<TtsResult>({ audioBase64, mimeType: resp.headers.get('content-type') ?? 'audio/mpeg' })
}

/** Provider dispatch — extend here when a 2nd provider lands. client stays unchanged. */
function dispatchStt(req: SttRequest): Promise<VoiceResult<SttResult>> {
  const provider = req.provider ?? 'azure'
  switch (provider) {
    case 'azure':
      return azureStt(req)
    default:
      return Promise.resolve(failure('BAD_REQUEST', `未知 STT provider: ${provider}（V1 仅支持 azure）`))
  }
}

function dispatchTts(req: TtsRequest): Promise<VoiceResult<TtsResult>> {
  const provider = req.provider ?? 'azure'
  switch (provider) {
    case 'azure':
      return azureTts(req)
    default:
      return Promise.resolve(failure('BAD_REQUEST', `未知 TTS provider: ${provider}`))
  }
}

export function apply(ctx: HostContext, config?: HostConfig): void {
  const enabled = config && typeof config.enabled === 'boolean' ? config.enabled : true
  if (enabled === false) {
    ctx.logger?.info?.('[openharness-voice] disabled by config — no RPC registered')
    return
  }

  const connection = (ctx as unknown as { connection?: { rpc?: ConnectionRpcLike } }).connection ??
    (ctx.get('connection') as { rpc?: ConnectionRpcLike } | undefined)
  if (!connection?.rpc) {
    ctx.logger?.warn?.('[openharness-voice] host half skipped: ctx.connection.rpc unavailable in this profile')
    return
  }

  const handler = async (endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown }> => {
    try {
      switch (endpoint) {
        case EP_STT:
          return jsonResult(await dispatchStt((payload ?? {}) as SttRequest))
        case EP_TTS:
          return jsonResult(await dispatchTts((payload ?? {}) as TtsRequest))
        default:
          return jsonResult(failure('BAD_REQUEST', `unknown openharness-voice endpoint: ${endpoint}`))
      }
    } catch (error) {
      // Never throw out of the RPC handler — degrade to a stable failure result.
      return jsonResult(failure('UNKNOWN', error instanceof Error ? error.message : String(error)))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = connection.rpc!.handle(RPC_CHANNEL, handler as never, { authority: 'loopback' })
      ctx.logger?.info?.(`[openharness-voice] RPC channel ${RPC_CHANNEL} registered (azure STT/TTS)`)
      return () => {
        try {
          const d = dispose as (() => Promise<void>) | undefined
          if (typeof d === 'function') void d()
        } catch {
          /* ignore */
        }
      }
    }, 'openharness-voice: rpc channel')
  } else {
    connection.rpc.handle(RPC_CHANNEL, handler as never, { authority: 'loopback' })
    ctx.logger?.info?.(`[openharness-voice] RPC channel ${RPC_CHANNEL} registered`)
  }
}
