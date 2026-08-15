/**
 * openharness-voice — client half (browser bundle).
 *
 * Registers two list slots:
 *   - `settings.section` 「语音」panel — config / status documentation.
 *   - `conversation.input.right` VoicePanel — a hold-to-talk mic button that
 *     records PCM16 WAV, calls the host half via the `/openharness-voice`
 *     Connection RPC, and writes the recognized text into the composer draft
 *     with the framework-injected `inputActions.setDraft`.
 *
 * Bundled to lib/client.js via window.__ModuleLoader__.load (see build.mjs).
 * No default export; hooks are called unconditionally; apply never throws.
 */

import * as React from 'react'
import { bindVoiceRpc } from './rpc'
import { SettingsSection, SECTION_ID as SETTINGS_ID, SETTINGS_LABEL } from './SettingsSection'
import { VoicePanel, SECTION_ID as VOICE_ID, SECTION_LABEL } from './VoicePanel'

export const inject = ['connection', 'slots']

interface SlotRegistrar {
  inject(name: string, fn: () => void): void
  register(options: { name: string; id: string; order: number; label: () => string }, comp: unknown): void
}

function registerListSlot(
  ctx: {
    get(name: string): unknown
    logger?: { info?: (...args: unknown[]) => void }
  },
  slotName: string,
  id: string,
  label: () => string,
  order: number,
  Component: React.ComponentType<Record<string, unknown>>,
): void {
  const slots = ctx.get('slots') as SlotRegistrar | undefined
  if (!slots) return
  slots.inject(slotName, () => slots.register({ name: slotName, id, order, label }, Component))
}

interface AppCtx {
  get(name: string): unknown
  logger?: { info?: (...args: unknown[]) => void }
  connection?: { rpc?: unknown }
  effect?(fn: () => void, label?: string): unknown
}

export function apply(ctx: AppCtx): void {
  // Wire the RPC caller once (safe even if connection is absent — rpc.ts no-ops).
  bindVoiceRpc(ctx as { connection?: { rpc?: unknown } })

  const register = (): void => {
    try {
      registerListSlot(ctx, 'settings.section', SETTINGS_ID, SETTINGS_LABEL, 30, SettingsSection as React.ComponentType<Record<string, unknown>>)
      registerListSlot(ctx, 'conversation.input.right', VOICE_ID, SECTION_LABEL, 100, VoicePanel as React.ComponentType<Record<string, unknown>>)
      ctx.logger?.info?.('[openharness-voice] slots 已注册：settings.section「语音」 + 输入框侧 mic')
    } catch (error) {
      // Never throw out of apply — fail-loud would crash the whole web boot.
      console.error('[openharness-voice] slot registration failed:', error)
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'openharness-voice: slots')
  } else {
    register()
  }
}
