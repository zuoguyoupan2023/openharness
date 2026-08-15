# openharness-voice

DSH 语音插件（云 API STT/TTS）。浏览器 `getUserMedia` + WebAudio 采为 16kHz PCM WAV →
交给宿主（dsh 进程）侧代理云 API 转写 → 中文文本回填 DSH 输入框；可选「朗读」。

- **V1 只接 Azure Speech**（STT `.../speech/recognition/conversation/cognitiveservices/v1`，TTS 预留）。
- **密钥只存在于宿主进程环境变量**，浏览器侧不可见，天然规避 CORS。
- 符合 `openharness-rule-for-dsh-plugin`：只命名导出 `name`/`inject`/`apply`；依赖用 `inject` 声明；只用 `settings.section` 与 `conversation.input.right`（list 槽）；host/client 的 `apply` 全程 try/catch，失败只降级不抛；React 渲染期无副作用、hooks 无条件调用。

## 安装

```bash
# 在 DSH-Tauri-app 目录
dsh plugin --profile web add ./openharness-voice
# 改 client 后必须彻底退出 app（⌘Q）重开，webview 才会加载新 bundle
```

## 配置云端密钥

在宿主 dsh 进程的环境变量中设置：

```bash
export AZURE_SPEECH_KEY="你的Azure订阅密钥"
export AZURE_SPEECH_REGION="eastus"   # 你的区域
```

未配置时按住说话会给出清晰提示（`NO_CONFIG`），不会崩溃。

## 使用

- 输入框右侧 🎤：**按住说话**，松开自动转写并回填输入框。
- 输入框右侧 🔊：用浏览器 `speechSynthesis` 朗读当前草稿（零成本 TTS）。
- 设置 → 「语音」：查看配置说明与插件状态。

## provider 抽象

host 半的 `dispatchStt` / `dispatchTts` 按 `provider` 分发；V1 仅实现 `azure`。
新增 provider 只需在 host 半再加一个 case（如 `openai`/`iflytek`），client 不用改。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run build       # esbuild → lib/index.js + lib/client.js
```
