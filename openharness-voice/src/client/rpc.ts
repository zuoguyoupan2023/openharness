/**
 * openharness-voice — client RPC wrapper over the generic Connection channel.
 *
 * The host half registers `/openharness-voice` with `ctx.connection.rpc.handle`
 * (authority: loopback); the browser calls it with `ctx.connection.rpc.call`.
 * Business payloads are discriminated by `status`; envelope (transport)
 * failures map to a `VoiceFailure` too, so callers handle one shape.
 */
import { EP_STT, RPC_CHANNEL, type SttRequest, type SttResult, type VoiceFailure, type VoiceResult } from '../shared/protocol'

interface ConnectionRpcLike {
  call(channel: string, endpoint: string, payload: unknown): Promise<{
    ok: boolean
    value?: unknown
    error?: { message?: string }
  }>
}

let rpc: ConnectionRpcLike | null = null

/** Bind the connection RPC caller from the plugin ctx (call once in apply). */
export function bindVoiceRpc(ctx: { connection?: { rpc?: unknown } }): void {
  const c = ctx.connection?.rpc as ConnectionRpcLike | undefined
  if (c && typeof (c as { call?: unknown }).call === 'function') {
    rpc = c
  } else {
    rpc = null
  }
}

function transportFailure(message: string): VoiceFailure {
  return { status: 'error', code: 'UNKNOWN', message }
}

async function call<T>(endpoint: string, payload: unknown): Promise<VoiceResult<T>> {
  if (!rpc) return transportFailure('host RPC channel unavailable (connection service missing)')
  try {
    const res = await rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!res.ok) {
      return transportFailure(res.error?.message ?? `RPC transport error on ${endpoint}`)
    }
    return (res.value as VoiceResult<T>) ?? transportFailure(`empty response from ${endpoint}`)
  } catch (error) {
    return transportFailure(error instanceof Error ? error.message : String(error))
  }
}

export function rpcStt(req: SttRequest): Promise<VoiceResult<SttResult>> {
  return call<SttResult>(EP_STT, req)
}
