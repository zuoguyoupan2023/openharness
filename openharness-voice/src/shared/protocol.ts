/**
 * openharness-voice — host↔client RPC protocol (shared vocabulary).
 *
 * Transport: the generic Connection RPC channel `/openharness-voice`
 * (host registers it with `ctx.connection.rpc.handle`, the browser calls
 * `ctx.connection.rpc.call('/openharness-voice', endpoint, payload)`).
 * Business payloads are discriminated by `status`; transport / cloud
 * failures ride the `error` branch so the browser never throws out of its
 * React render path.
 *
 * V1 scope:
 *   stt — browser sends a PCM16 WAV Blob (base64) + mimeType; host forwards
 *         it to the configured cloud STT provider (Azure Speech V1) and
 *         returns the recognized Chinese text.
 *   tts — optional; host forwards text to the cloud TTS provider and returns
 *         playable audio (base64) or an error. Kept behind the same channel so
 *         a later provider can slot in without touching the client.
 */

/** Stable machine-routable failure code for V1. */
export type VoiceFailureCode =
  | 'NO_CONFIG'          /* provider keys missing in the host environment */
  | 'BAD_AUDIO'          /* audio payload unreadable / unsupported */
  | 'STT_FAILED'         /* cloud recognition returned no text or errored */
  | 'TTS_FAILED'
  | 'BAD_REQUEST'
  | 'UNKNOWN'

export interface VoiceFailure {
  status: 'error'
  code: VoiceFailureCode
  message: string
}

export type VoiceResult<T> = { status: 'ok'; value: T } | VoiceFailure

/** `stt` payload: PCM16 WAV audio (base64) + mimeType tag sent from the browser. */
export interface SttRequest {
  /** base64-encoded PCM16 16kHz mono WAV bytes. */
  audioBase64: string
  /** e.g. 'audio/wav; codecs=audio/pcm; samplerate=16000'. */
  mimeType?: string
  /** Optional provider override; V1 only supports 'azure'. Absent = 'azure'. */
  provider?: string
  /** Optional BCP-47 language hint; defaults to zh-CN. */
  language?: string
}

export interface SttResult {
  text: string
  /** Recognized status (Success / NoMatch / ...). */
  status?: string
}

/** `tts` payload: plain text to be spoken. */
export interface TtsRequest {
  text: string
  provider?: string
  language?: string
}

export interface TtsResult {
  /** base64-encoded playable audio bytes (mp3/wav). */
  audioBase64: string
  mimeType: string
}

/** Channel + endpoint names shared by both halves. */
export const RPC_CHANNEL = '/openharness-voice'
export const EP_STT = 'stt'
export const EP_TTS = 'tts'
