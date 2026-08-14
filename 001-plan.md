# 001 · 规划：OpenHarness（下一步做什么）

> 参考：`demo1/plan.html`（两阶段蓝图）、`demo1/plan1.html`（双轨架构）、`demo1/task-plan.html`（视觉与语音规划）、[`001-summary.md`](001-summary.md)（现状）、[`002-discussion.md`](002-discussion.md)（决策记录）
> 优先级：P0=下个迭代就做，P1=随后，P2=远期
> 更新日期：2026-08-14（已并入 demo1/task-plan 多模态路线；本轮完成 UI 工程化：iconify 图标 / 浅色深色主题 / i18n 中英 / 插件中心紧凑化）

---

## ▶ 接下来该做什么（一句话版）

**P0 已全部完成（多标签阶段 2 原生 webview + 插件发布联动 + Node 环境准备）+ 本轮 UI 工程化（iconify 图标、浅色/深色主题、i18n 中英、插件中心紧凑化）；接下来建议：① P0 插件中心剩余（命令语义验证 → 缓存落盘 → 自动更新检查 → 详情页）② P1 嵌入式终端面板 ③ P1 工作区/权限模式 UI 与 P1/P2 多模态（系统 TTS + Vosk STT 先行）④ P2 打包发布。多模态路线已并入本文档（见「P1/P2 · 多模态能力」），执行另等具体要求。** 详细排期见文末。

---

## ✅ 已完成（2026-08-14 迭代）

- [x] 改名 openharness（B 标准：productName / identifier `app.openharness.work` / crate / 品牌 / 日志前缀）
- [x] **3080 生命周期可配置**：退出时强制回收（进程组 + lsof 兜底）、接管已有实例、`close_with_app` 设置（默认随 app 关闭，终端自管用户可关）
- [x] 多标签页阶段 1：iframe 池 + 标签栏 + 网址栏 + 历史栈 + 新标签页 + localStorage 持久化
- [x] **多标签页阶段 2：网页标签升级 Tauri 原生子 webview**（`tauri::Window::add_child`，`unstable` feature；DSH 标签保持 iframe）——Google / GitHub / npm 等不再白屏；`window.open`/`target=_blank` 自动开新标签；导航/标题事件同步网址栏与标签标题
- [x] 插件中心基础：awesome-dsh-plugin 索引（143 插件）+ 分类/搜索 + npm 版本（npmmirror 回退）+ 装/卸/更 + 自动重启生效 + 官方组合包区
- [x] 设置视图：npm 镜像源（官方/淘宝/自定义）持久化 + 注入 `npm_config_registry` 全链路生效
- [x] 预装插件机制：`AUTO_INSTALL_PLUGINS`（`adhdgofly-dsh-ext@0.1.1` 已发布 npm 并解开，启动自动预装）
- [x] **Node.js 环境准备**：启动检测（含 brew/nvm 目录搜索，解决 Finder PATH 缺失）+ 三源安装向导（官方/淘宝/清华，自动回退）+ 内置 Node 优先（免 sudo）+ 安装后自动继续启动 DSH 并打开对话标签
- [x] 稳定性：日志走文件防 EPIPE、`window.onerror` 兜底、`dsh-exit` 后自动探测外部 3080 直连
- [x] Bug 修复：TabManager TDZ 崩溃（卡死 + 按钮无响应 + DSH 不自启）
- [x] **UI 工程化（本轮）**：禁用 emoji 约定入档（见 `001-summary.md` 头部）；侧边栏/标签栏/网址栏/按钮图标换 Iconify lucide **内联 SVG**（`src/icons.ts` 的 `iconSvg()` + `scripts/extract-icons.mjs`，弃用 Web Component——WKWebView 下尺寸失控）；浅色/深色主题（CSS 变量 + 跟随系统 + 设置页「外观」组 + 侧边栏快捷按钮）；i18n 中/英（`src/i18n.ts` 的 `t()` / `data-i18n` + 设置页「语言」组 + 侧边栏快捷按钮，localStorage 持久化）
- [x] **插件中心布局紧凑化（P0 收尾）**：已安装区单行横向滚动、官方包网格压缩、社区表行距收紧，长索引一屏可达
- [x] **插件版本信息修复**：github 源（217 个）版本列显示来源弱标签；npm 源（35 个）显示最新版本；失败缓存不落盘、刷新自动重试、请求 8s 超时

---

## P0 · 多标签页阶段 2：原生 webview（✅ 已完成）

> 状态：✅ 2026-08-14 实现。诊断结论：白屏**不是 app 网络问题**（插件中心可正常拉取外部 API），而是主流站点以 `X-Frame-Options: SAMEORIGIN/deny` / CSP `frame-ancestors` 拒嵌 iframe（实测 npmjs `SAMEORIGIN`、GitHub `deny`、Google `SAMEORIGIN`；Bing 与 awesome-dsh-plugin 无限制可嵌）。

实现要点（`src-tauri/src/main.rs` + `src/tabs.ts`）：

| 子任务 | 实现 |
|--------|------|
| 多 webview 管理器 | Rust `WebviewRegistry`（label=标签 id）+ 9 个命令：`webview_create/show/hide/set_bounds/navigate/back/forward/reload/close`；前端 IPC 串行队列 + 激活时「隐藏其余、显示当前」 |
| 已知坑处理 | `add_child` 需 `tauri unstable` feature 且在 **async 命令**内调用（避免主线程死锁）；`webview_show` 末尾重设尺寸 kick，规避 macOS 白屏 [#10011](https://github.com/tauri-apps/tauri/issues/10011)；窗口 resize → 前端去抖重算 bounds；子 webview 不注入 IPC 权限（纯浏览）[#10317](https://github.com/tauri-apps/tauri/issues/10317) |
| 导航拦截 | `on_new_window` → `Deny` + 事件 → 前端自动开新标签；`on_navigation` 事件同步网址栏/历史栈；`on_document_title_changed` 更新标签标题 |
| 回退 | DSH 标签保持 iframe 不受影响；webview 创建失败时降级为空白页（控制台报错） |

验收：Google / Bing / GitHub / npm 等网站可在标签内正常浏览与搜索，网址栏可编辑前往，`window.open` 自动开新标签。

> ⚠️ 已知边界：原生 webview 定位使用逻辑坐标（macOS 1:1）；Windows 高分屏缩放下 CSS px 与逻辑坐标可能不一致（当前仅 macOS 目标）。

---

## P0 · 插件中心完善（收尾）

现状：索引/分类/搜索/版本/装/卸/更 + 重启生效已完成。

| 子任务 | 说明 | 状态 |
|--------|------|------|
| 插件详情页 | 点开插件行 → 描述 / 版本历史（npm `time` 字段）/ README / 依赖 / 作者 | ⏳ |
| 自动更新检查 | 启动时 + 每 N 小时后台静默拉最新版本，角标提示「可更新」 | ⏳ |
| 缓存落盘升级 | 版本/基线从 localStorage 升级为 Rust 侧 JSON（`$APP_DATA/plugin-cache.json`） | ⏳ |
| 命令语义验证 | `dsh plugin --profile web update/remove` 的 pnpm 语义实测确认 | ⏳ |
| 发布联动 | **`adhdgofly-dsh-ext@0.1.1` 已发布 npm（2026-08-14），`AUTO_INSTALL_PLUGINS` 注释已解开，启动自动预装** | ✅ |
| 布局紧凑化 | 已安装单行横向滚动 + 官方包/社区表压缩，长索引一屏可达（本轮完成） | ✅ |

---

## P1 · 嵌入式终端面板（demo1 蓝图第二阶段）

现状：日志是只读文本流。

- 分屏布局：对话(70%) + 底部终端面板(30%)，可拖拽分割。
- `xterm.js` 渲染 + ANSI 颜色转义解析（npm 引入 `@xterm/xterm`）。
- **双向交互**：Rust 侧把 DSH 子进程 stdin 改为 `piped`，新增 `write_stdin(line)` 命令，终端输入 → 子进程 stdin。
- 日志模式切换：纯日志 / 终端仿真两种渲染。

---

## P1 · 会话 / 工作区 + 权限模式 UI（Codex / WorkBuddy 参考）

调研参考：Codex 桌面（Chat/Project 双模式、权限控制、沙箱）与腾讯 WorkBuddy（任务列表/对话/**结果区**三栏、多任务并行）——详见 [`002-discussion.md`](002-discussion.md) 第 7 节。

| 功能 | 说明 |
|------|------|
| 工作区/会话管理 | 工作区选择器，会话历史按目录分组（DSH 会话本就绑定运行目录） |
| **权限/沙箱模式 UI** | 对话区上方切换：只读 / 写工作区 / 联网——DSH 本身是 agent harness（有沙箱），壳只补 UI，是差异化亮点 |
| 右侧结果区 | 产物 / 文件 / 变更 / 预览面板（从会话解析 artifacts） |

---

## P1 · 稳定与体验

| 项目 | 说明 | 状态 |
|------|------|------|
| DSH 掉线自动重连 | iframe 加载失败 / `dsh-exit` 后自动重连 | 🟡 部分完成（已做外部 3080 探测直连；补自动重试 spawn） |
| 菜单栏/托盘 | 重启 DSH、打开日志目录、关于；托盘：运行状态、退出 | ⏳ |
| 开机自启 | `tauri-plugin-autostart` | ⏳ |
| 快捷键 | Cmd+1/2/3/4 切视图、Cmd+R 刷新、Cmd+T 新标签 | ⏳ |
| 深色模式适配 | 跟随系统（前端已暗色） | ⏳ |

---

## P1/P2 · 多模态能力：视觉与语音（demo1/task-plan 建议 · 已评估采纳）

> 来源：`demo1/task-plan.html`（视觉与语音完整规划：TTS / STT / 识图 / 生图）+ `demo1/plan1.html`（「DSH Cordis 插件 × Tauri 原生」双轨架构）。
> 评估结论：**总体合理，采纳为能力路线图**；执行另排期，不抢占 P0/P1 主线。

**架构原则（两层，来自 plan1.html）**：
- 第 1 层 Tauri 原生能力：`system_tts` / `microphone_input` / `screen_capture` / `camera_access` / `image_process`，经 IPC 命令暴露。
- 第 2 层 DSH Cordis 插件：`@dsh/plugin-tts` / `@dsh/plugin-speech` / `@dsh/plugin-vision` / `@dsh/plugin-draw` / `@dsh/plugin-ocr`，封装为 Agent 工具。
- ⚠️ 前置依赖：当前插件生态里没有该桥接，先以「Tauri 命令 + 前端薄封装」落地，插件层后续补——否则「用户一句话 → Agent 工具」闭环不成立。

**分期任务（合并 task-plan 四阶段）**：

| 阶段 | 内容 | 要点 |
|------|------|------|
| P1 · 快速上线 | 系统 TTS + Vosk STT | 系统 TTS 零依赖快赢（macOS `NSSpeechSynthesizer` via `objc`）；⚠️ macOS WebKit 不支持 `SpeechRecognition` API，STT 必须走后端方案 |
| P1 · 开源模型 | Qwen3-TTS 本地版 / Kokoro（82M 超轻）；SenseVoice-Small（50+ 语言、首字 <100ms）/ FireRedASR（中文 SOTA）；Tesseract OCR | 权重复用现有 Node 下载缓存机制（进度条 + 断点续传） |
| P2 · 云端 API | Edge TTS（免费）/ Qwen3-TTS API / MiniMax；Azure / 阿里云 STT；视觉理解（GPT-4V / Qwen-VL）+ 通义万相 / DALL-E | 密钥存 Tauri 安全存储（keyring），不落明文 |
| P2 · 高级本地 | dots.tts / MOSS-TTS；SenseVoice-Large / FireRedASR-LLM；Stable Diffusion / ComfyUI 子进程管理 | 推理任务一律 `tokio::task::spawn_blocking` 防阻塞 UI |

**采纳/修正说明**：
- ✅ 合理：系统 TTS 先上（零依赖）；Vosk 做入门 STT；Edge TTS 免费高质量；SenseVoice / FireRedASR / Qwen3-TTS 选型与「中文为主 + 本地优先」匹配；「复用 Node 下载缓存、安全存储、spawn_blocking」三条实现原则直接适用。
- ⚠️ 修正：原清单把 TTS/STT 当独立功能，缺与 DSH Agent 的桥接层（见架构原则）；OCR 优先级低于多模态 LLM 视觉理解（后者可直接进 Agent 上下文）；6–8 周估时偏乐观，按能力路线图推进、不承诺排期。

---

## P2 · 打包发布

- `npm run tauri build` 产出 .app / .dmg。
- 签名 + notarize（`tauri-apple-signing` / `@tauri-apps/cli`）——未签名发布需引导用户右键「打开」放行 Gatekeeper（发布说明见 `RELEASE-NOTES-v0.1.0.md`）。
- 自动更新（`tauri-plugin-updater` + 更新服务器）。
- 安装包内嵌 Node 运行时（可选）：✅ 已实现「缺失时自动下载内置 Node（免 sudo）」；可选后续把 `@deepseek-ai/dsh` 一并打包离线可用（摆脱首次联网下载）。

---

## 排期建议（下一个迭代）

1. **P0 · 插件中心收尾**——布局紧凑化 ✅；剩余建议顺序：命令语义验证（最便宜、先排雷）→ 缓存落盘（版本基线 Rust 侧 JSON，自动更新检查的数据基础）→ 自动更新检查 → 插件详情页
2. **P1 · 嵌入式终端面板**——xterm.js + stdin 转发（终端是后续「命令输入/调试」的地基）
3. **P1 · 工作区 / 权限模式 UI**——Codex/WorkBuddy 差异化参考点
4. **P1/P2 · 多模态能力**——系统 TTS + Vosk STT 先行（路线已并入上文，执行另等具体要求）
5. **P2 · 打包发布**——签名 / 自动更新 / 内嵌 dsh 离线包（Node 安装器已就绪；发布工程与功能开发可并行）
