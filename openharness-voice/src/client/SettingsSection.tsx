/**
 * openharness-voice — SettingsSection (settings.section seat).
 *
 * A root-scope settings panel explaining the plugin and its cloud config.
 * The actual record-to-draft interaction lives in the session-scoped
 * VoicePanel (`conversation.input.right`); this panel is the documentation /
 * status surface the spec asked for. It only renders — no capture, no RPC.
 */

import * as React from 'react'

export const SECTION_ID = 'openharness-voice'
export const SETTINGS_LABEL = () => '语音'

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0', fontSize: 14, lineHeight: 1.7 },
  title: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-label-primary)' },
  desc: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
  list: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,0.08))',
    padding: '1px 6px', borderRadius: 4,
  },
  hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
}

export function SettingsSection(): React.ReactElement {
  return React.createElement(
    'div',
    { style: styles.root },
    React.createElement('div', { style: styles.title }, '语音输入（云 STT）'),
    React.createElement(
      'div',
      { style: styles.desc },
      '在输入框右侧的麦克风按钮「按住说话」即可把语音转成中文文本并回填到输入框。识别 / 朗读走云端 API（V1 为 Azure Speech），密钥只存在于 dsh 宿主进程，浏览器侧不可见。',
    ),
    React.createElement(
      'ul',
      { style: styles.list },
      React.createElement('li', null, '录音：Web API getUserMedia + WebAudio 采为 16kHz PCM WAV。'),
      React.createElement('li', null, '转写：音频经 /openharness-voice RPC 交给宿主转发 Azure，规避 CORS。'),
      React.createElement('li', null, '朗读：默认用浏览器 speechSynthesis（零成本）；也可选云端 TTS。'),
    ),
    React.createElement(
      'div',
      { style: styles.hint },
      React.createElement('span', null, '需要在宿主进程配置 Azure 密钥：设置环境变量 '),
      React.createElement('code', { style: styles.code }, 'AZURE_SPEECH_KEY'),
      React.createElement('span', null, ' 与 '),
      React.createElement('code', { style: styles.code }, 'AZURE_SPEECH_REGION'),
      React.createElement(
        'span',
        null,
        '（如 eastus）。未配置时按住说话会给出清晰提示，不会崩溃；配置后重新启动 DSH 生效。',
      ),
    ),
  )
}
