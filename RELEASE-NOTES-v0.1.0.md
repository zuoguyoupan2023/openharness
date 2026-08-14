# OpenHarness v0.1.0 · 发布说明（Release Notes）

> **OpenHarness** —— DeepSeek Harness（DSH）macOS 桌面壳：把 DSH Web UI 包装成原生应用，双击即用、无需浏览器。
> 发布包：`openharness_0.1.0_aarch64.dmg`（Apple Silicon）｜ 应用标识：`app.openharness.work`

---

## 📦 安装方法（重要，请先读）

1. 下载 `openharness_0.1.0_aarch64.dmg`，双击挂载，把 **OpenHarness** 拖入「应用程序」。
2. **首次打开请右键 → 打开**（或按住 `Control` 点击 → 打开），并在弹出的对话框里点「打开」。
   - ⚠️ 本版本未做 Apple Developer 签名/公证，macOS 的 Gatekeeper 会拦截普通双击。
   - 备选：系统设置 → 隐私与安全性 → 找到 OpenHarness → 点「仍要打开」。
   - 已放行后，之后可正常双击打开。

## 🚀 首次启动（自动完成，无需任何命令行）

1. **检测 Node.js**：应用会自动检测系统 Node（≥ 22.15 + npx，支持 Homebrew / nvm / 官方安装包；nvm 多版本时自动选最新版）。
2. **没有 Node？不用装**：弹出安装向导，自动下载官方预编译 Node 并内置到应用数据目录（免 sudo、不污染系统）：
   - 默认「自动回退」：官方 nodejs.org → 淘宝 npmmirror → 清华 TUNA，哪个快用哪个；
   - 下载太慢/失败：在向导里手动切换「淘宝 npmmirror / 清华 TUNA」后重试；
   - 安装完成自动校验版本，并继续下面的启动流程。
3. **自动启动 DSH**：自动下载并运行 `@deepseek-ai/dsh web`，预装高亮插件 `adhdgofly-dsh-ext`，服务就绪后**自动打开对话标签页**。
4. 国内网络下载 DSH/插件慢？在「设置 → npm 镜像源」切换**淘宝 npmmirror**（推荐），保存后重启 DSH 生效。

## ✨ 功能一览

- 💬 **对话**：多标签页（DSH 标签 + 网页标签）；网页标签为原生 webview，Google/GitHub/npm 等网站可正常浏览；网址栏支持后退/前进/刷新/新建标签；重启自动重连。
- 🖥️ **日志**：DSH 实时日志 + 状态灯 + 一键重启。
- 🧩 **插件中心**：143+ 社区插件索引（awesome-dsh-plugin），支持分类筛选/搜索/安装/更新/卸载，装完自动重启生效；官方组合包独立分区。
- ⚙️ **设置**：
  - npm 镜像源（官方 / 淘宝 npmmirror / 自定义），对 npx + pnpm 全链路生效；
  - **3080 端口生命周期**：关闭 app 时同时关闭 3080 上的 DSH（**默认开启**）；如果你自己在终端里启动 DSH，可关闭此项让它继续运行；
  - Node.js 环境：重新检测 / 重新下载安装内置 Node。
- 🛡️ **稳定性**：退出自动回收 DSH 进程；端口被占用时自动接管（不再残留孤儿进程）；日志落盘防管道断裂。

## ⚠️ 已知限制

- 仅支持 **macOS**（本包为 Apple Silicon arm64；Intel 需另行构建 x64 包）。
- 未签名/未公证：首次打开需右键放行 Gatekeeper（见上文安装方法）。
- 首次启动需联网（下载 Node / DSH / 插件）；国内可切淘宝镜像。
- 关闭 app 会一并关闭**由 app 管理的** DSH（含被接管的实例）；若你在终端手动启动 DSH 且想保留它，请在「设置」关闭「关闭 app 时同时关闭 3080」。

## 🔄 反馈

遇到问题请提供「日志视图」的完整输出（或在 `~/Library/Logs` 与临时目录 `openharness-dsh-*.log` 中查找）。
