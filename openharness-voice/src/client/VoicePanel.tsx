/**
 * openharness-voice — VoicePanel (conversation.input.right seat).
 *
 * A session-scoped list slot beside the composer's send button: a mic button.
 * Hold to record (getUserMedia → PCM16 WAV), release to send the audio to the
 * host half (`/openharness-voice` RPC) for cloud STT, then the recognized text
 * is written straight into the composer draft via the framework-injected
 * `inputActions.setDraft`. An optional speaker button reads the last result
 * with browser speechSynthesis (zero-cost TTS).
 *
 * All capture / RPC / setDraft run inside user-gesture event callbacks, never
 * during render. React hooks (`useInput`) are called unconditionally at the
 * top of the component; every async path is try/caught and degrades to an
 * inline status strip instead of throwing.
 */

import * as React from 'react'
import { createWavRecorder, blobToBase64 } from './audio'
import { rpcStt } from './rpc'

const NS = 'openharness-voice'

export const SECTION_ID = 'openharness-voice'
export const SECTION_LABEL = () => '语音'
export const INPUT_RIGHT_SLOT = 'conversation.input.right'

interface InputActionsLike {
  setDraft(text: string): void
  submit?(): void
}

export interface VoicePanelProps {
  /** Framework-injected standard props for a session-scoped list slot. */
  inputActions?: InputActionsLike
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useInput?: (selector: (state: any) => any) => any
  sessionId?: string | number
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 8, position: 'relative' },
  mic: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: 8, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 15, lineHeight: 1, userSelect: 'none', touchAction: 'none',
  },
  micRecording: {
    background: 'rgba(220,38,38,0.12)',
    borderColor: '#dc2626',
    color: '#dc2626',
  },
  micDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  status: {
    position: 'absolute', bottom: 34, right: 0, zIndex: 90, minWidth: 220, maxWidth: 320,
    padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
    background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base))',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-primary)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  },
  statusError: { borderColor: '#dc2626', color: '#dc2626' },
  statusOk: { borderColor: '#059669', color: '#059669' },
  speaker: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: 8, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 15, lineHeight: 1,
  },
}

type StatusKind = 'idle' | 'recording' | 'working' | 'ok' | 'error'

interface Status {
  kind: StatusKind
  text: string
}

/** Live recorder created lazily on first hold; kept across the session. */
let recorder: ReturnType<typeof createWavRecorder> | null = null

function getRecorder(): ReturnType<typeof createWavRecorder> {
  if (!recorder) recorder = createWavRecorder()
  return recorder
}

export function VoicePanel(props: VoicePanelProps): React.ReactElement {
  const { inputActions, useInput } = props
  // Hooks must be called unconditionally. Note: never call useInput during
  // render for side effects — only read for a disabled/hint heuristic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputState = useInput ? useInput((s: any) => s) : undefined
  const draft: string = (typeof inputState?.draft === 'string' ? inputState.draft : '') || ''

  const [status, setStatusState] = React.useState<Status>({ kind: 'idle', text: '' })
  const recordingRef = React.useRef(false)

  const setStatus = (s: Status) => {
    if (recordingRef.current && s.kind !== 'recording') return
    setStatusState(s)
  }

  const handlePress = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (recordingRef.current) return
    recordingRef.current = true
    const rec = getRecorder()
    setStatus({ kind: 'recording', text: '松开结束录音…' })
    // Capture + start must happen on a user gesture.
    try {
      void rec
        .start()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setStatus({ kind: 'error', text: message })
          recordingRef.current = false
        })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      recordingRef.current = false
    }
  }

  const handleRelease = async () => {
    if (!recordingRef.current) return
    recordingRef.current = false
    const rec = getRecorder()
    setStatus({ kind: 'working', text: '转写中…' })
    try {
      const capture = await rec.stop()
      const audioBase64 = await blobToBase64(capture.blob)
      const res = await rpcStt({ audioBase64, mimeType: capture.mimeType, language: 'zh-CN' })
      if (res.status === 'ok') {
        const text = res.value.text
        if (!text) {
          setStatus({ kind: 'error', text: '未能识别出语音（请对准麦克风再说一次）' })
          return
        }
        // Write into the composer draft.
        try {
          const next = draft ? `${draft}${draft.endsWith(' ') || draft.endsWith('\n') ? '' : ' '}${text}` : text
          ;(inputActions as InputActionsLike | undefined)?.setDraft(next)
        } catch {
          /* setDraft failed — still show the result text */
        }
        setStatus({ kind: 'ok', text: `已回填：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}` })
      } else {
        setStatus({ kind: 'error', text: res.message })
      }
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const speak = () => {
    try {
      if (!('speechSynthesis' in window)) {
        setStatus({ kind: 'error', text: '浏览器不支持 speechSynthesis' })
        return
      }
      const text = draft || status.text
      if (!text || !/[\u4e00-\u9fa5a-zA-Z0-9]{1,}/.test(text)) {
        setStatus({ kind: 'error', text: '没有可朗读的文本' })
        return
      }
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      window.speechSynthesis.speak(u)
      setStatus({ kind: 'ok', text: '正在朗读…' })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const recording = status.kind === 'recording'
  const disabled = !inputActions

  return React.createElement(
    'div',
    { style: styles.row },
    (status.kind !== 'idle'
      ? React.createElement(
          'div',
          {
            style: {
              ...styles.status,
              ...(status.kind === 'error' ? styles.statusError : {}),
              ...(status.kind === 'ok' ? styles.statusOk : {}),
            },
          },
          status.text,
        )
      : null),
    React.createElement(
      'button',
      {
        type: 'button' as const,
        title: '按住说话（语音转文字）',
        'aria-label': '按住说话',
        style: { ...styles.mic, ...(recording ? styles.micRecording : {}), ...(disabled ? styles.micDisabled : {}) },
        disabled,
        onPointerDown: handlePress,
        onPointerUp: () => void handleRelease(),
        onPointerLeave: () => {
          // Avoid a stuck recording when the pointer leaves the control.
          if (recordingRef.current) void handleRelease()
        },
        onPointerCancel: () => {
          if (recordingRef.current) void handleRelease()
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      },
      recording ? '●' : '🎤',
    ),
    React.createElement(
      'button',
      {
        type: 'button' as const,
        title: '朗读（speechSynthesis）',
        'aria-label': '朗读',
        style: styles.speaker,
        disabled,
        onClick: speak,
      },
      '🔊',
    ),
  )
}
