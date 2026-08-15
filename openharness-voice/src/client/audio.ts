/**
 * openharness-voice — browser audio capture (PCM16 WAV).
 *
 * Uses getUserMedia + WebAudio to produce a standard PCM16 16kHz mono WAV
 * Blob — the exact container Azure Speech's short-audio endpoint accepts
 * natively, so the host never needs to remux/translate anything.
 *
 * All capture runs in user-gesture event callbacks (button clicks), never
 * during React render — render stays side-effect free (plugin rule).
 */

export interface VoiceCapture {
  blob: Blob
  mimeType: string
}

/**
 * Record until the user releases (promise-style). The caller wires this to a
 * pointer down/up (or click-stop-toggle) and resolves with the final WAV blob.
 *
 * Returns a controller:
 *   { start(), stop(): Promise<VoiceCapture> }
 * `start` must be called from a user gesture to satisfy the mic permission
 * prompt; `stop` yields the recorded audio.
 */
export function createWavRecorder(): {
  start: (opts?: { sampleRate?: number; maxSeconds?: number }) => Promise<void>
  stop: () => Promise<VoiceCapture>
  isActive: () => boolean
} {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: ScriptProcessorNode | null = null
  let chunks: Float32Array[] = []
  let totalSamples = 0
  let sampleRate = 16000
  let active = false

  async function start(opts: { sampleRate?: number; maxSeconds?: number } = {}): Promise<void> {
    if (active) return
    sampleRate = opts.sampleRate ?? 16000
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })
    } catch (error) {
      throw new Error(describeMicError(error))
    }
    ctx = new AudioContext({ sampleRate: 16000 })
    source = ctx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated but universally supported and simplest for
    // a short V1 capture; 4096-sample buffer keeps PCM16 conversion cheap.
    node = ctx.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0)
      chunks.push(buf.slice())
      totalSamples += buf.length
    }
    source.connect(node)
    node.connect(ctx.destination) // keep the graph alive
    active = true
  }

  function stop(): Promise<VoiceCapture> {
    if (!active) return Promise.resolve({ blob: new Blob([], { type: 'audio/wav' }), mimeType: 'audio/wav; codecs=audio/pcm; samplerate=16000' })
    active = false
    // Teardown
    try { node?.disconnect() } catch { /* ignore */ }
    try { if (source) source.disconnect() } catch { /* ignore */ }
    try { stream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    try { void ctx?.close() } catch { /* ignore */ }
    ctx = null; source = null; node = null; stream = null

    const merged = new Float32Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    chunks = []; totalSamples = 0

    const blob = encodeWav(merged, sampleRate)
    return Promise.resolve({ blob, mimeType: 'audio/wav; codecs=audio/pcm; samplerate=16000' })
  }

  function isActive(): boolean {
    return active
  }

  return { start, stop, isActive }
}

function describeMicError(error: unknown): string {
  const name = (error as { name?: string })?.name
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '麦克风权限被拒绝 / Permission denied。请在系统(⌘)与浏览器中允许麦克风后重试。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '未检测到麦克风设备 / No microphone device found。'
  }
  if (name === 'NotReadableError') return '麦克风被其它程序占用，无法读取 / Mic busy elsewhere.'
  return `无法访问麦克风：${message}`
}

/** Merge a mono float32 buffer into a PCM16 16kHz WAV Blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)          // fmt chunk size
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let idx = 44
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    s = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(idx, s | 0, true)
    idx += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}

/** ArrayBuffer → base64 (for the RPC payload). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('音频文件读取失败'))
    reader.readAsDataURL(blob)
  })
}
