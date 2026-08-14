# 001 · 总结：DeepSeek Harness 桌面壳（当前实现）

> 项目：`my-dsh-app`（Tauri v2 + Vite + vanilla TS） · 更新日期：2026-08-14
> 目标：把 DSH Web UI（`http://127.0.0.1:3080`）包装成 Mac 原生应用，无需浏览器、双击即用。

---

## 一、实现了什么

| # | 能力 | 状态 |
|---|------|------|
| 1 | 单窗口 + 左侧边栏（💬 对话 / 🖥️ 日志 / 🧩 插件 三视图切换） | ✅ |
| 2 | Rust 后端托管 DSH 子进程（启动 / 日志流 / 退出回收） | ✅ |
| 3 | 端口探测：3080 已在运行则直接连接，不重复启动 | ✅ |
| 4 | 就绪检测：匹配 DSH 实际输出 `dsh web: http://127.0.0.1:3080` 后自动切换到对话 | ✅ |
| 5 | 对话视图：iframe 内嵌 DSH Web UI（已验证 DSH 无 X-Frame-Options / WS Origin 校验，可安全嵌入） | ✅ |
| 6 | 日志视图：实时流式日志（文件尾随方式，非管道——app 重启/被杀不影响 DSH 存活） | ✅ |
| 7 | 插件视图：已安装插件读取（web profile 的 dependencies + bundles） | ✅ |
| 8 | 插件视图：从 npm registry 拉取 `@deepseek-ai` 生态插件信息（版本/日期/描述） | ✅ |
| 9 | 插件视图：版本基线对比，自动标记「🆕 新版本」 | ✅ |
| 10 | 插件视图：一键安装（`dsh plugin --profile web add <pkg>`，输出实时进日志视图） | ✅ |
| 11 | 应用退出时整组回收 DSH 进程（`process_group(0)` + `kill(-pgid)`） | ✅ |
| 12 | 稳定性：日志写文件而非管道，避免 EPIPE 崩溃；npx 加 `--yes` 避免安装确认卡住 | ✅ |

---

## 二、怎么实现的（架构）

```
┌────────────────────────────── Tauri 应用（单窗口） ──────────────────────────────┐
│  ┌─────────┐  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 侧边栏   │  │  内容区（三个视图切换）                                       │  │
│  │ 对话/日志 │  │  💬 对话：<iframe src="http://127.0.0.1:3080">               │  │
│  │ /插件    │  │  🖥️ 日志：日志区 + 状态条 + 重新启动按钮                       │  │
│  │ DSH状态灯 │  │  🧩 插件：已安装列表 + npm 插件表 + 安装按钮                  │  │
│  └─────────┘  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │ tauri::invoke / 事件
        ┌──────────────────────▼──────────────────────┐
        │  Rust 后端（src-tauri/src/main.rs）           │
        │  · start_dsh：探测 3080 → 已运行则直连，否则    │
        │    spawn `npx --yes @deepseek-ai/dsh web`    │
        │  · 子进程 stdout/stderr → 日志文件（/tmp）      │
        │  · 尾随日志文件 → 逐行 emit "dsh-log"          │
        │  · 检测到 "dsh web:" → emit "dsh-ready"       │
        │  · 子进程退出 → emit "dsh-exit"                │
        │  · run_dsh_cmd：执行任意 dsh CLI（插件安装）     │
        │  · list_installed_plugins：读 profile 清单     │
        │  · 退出时 kill(-pgid) 整组回收                 │
        └──────────────────────┬──────────────────────┘
                               │ spawn（独立进程组）
        ┌──────────────────────▼──────────────────────┐
        │  npx @deepseek-ai/dsh web → DSH 服务          │
        │  http://127.0.0.1:3080                       │
        └─────────────────────────────────────────────┘
```

### 关键设计决策

1. **日志走文件不走管道**：Tauri dev 热重启是强杀 app 进程，管道读端一断，子进程写日志会 EPIPE 崩溃（DSH 会被打死）。改为子进程 stdout/stderr 重定向到 `/tmp/my-dsh-app-dsh-N.log`，前端用「尾部跟踪」（`read_until` + EOF 轮询 250ms）实时推送——**app 怎么重启都不影响 DSH 存活**。
2. **端口探测防冲突**：`start_dsh` 先 `TcpStream::connect(127.0.0.1:3080)`，通了就直接 `dsh-ready`，不通才 spawn。热重启后新实例会直接连上旧实例留下的 DSH。
3. **进程组回收**：`process_group(0)`（setsid）把 npx→node 两级进程放进独立进程组；应用优雅退出时 `kill(-pid, SIGKILL)` 整组回收，不留僵尸占端口。
4. **iframe 合并单窗口**：DSH 未设置 `X-Frame-Options`/CSP `frame-ancestors`，且 WebSocket 不校验 Origin，因此对话视图用 `<iframe>` 内嵌 3080 是安全的；iframe 常驻（display 切换），切视图不重载、不丢会话。
5. **就绪检测修正**：DSH 实际输出 `dsh web: http://127.0.0.1:3080`，旧代码只认 `Running on`/`listening` 导致永不跳转；现匹配 `dsh web:` / `127.0.0.1:3080` / running on / listening 并从行内解析 URL。
6. **插件信息来自 npm registry**：`https://registry.npmjs.org/-/v1/search?text=@deepseek-ai dsh`（CORS 开放，前端可直接 fetch）；每次刷新把最新版本写入 `localStorage` 基线，下次对比出「🆕 新版本」。
7. **插件安装走官方 CLI**：`npx --yes @deepseek-ai/dsh plugin --profile web add <pkg>`（`dsh plugin` 会转发给 profile 目录里的 pnpm），输出经 `run_dsh_cmd` 实时流到日志视图。

---

## 三、文件清单

| 文件 | 作用 |
|------|------|
| `src-tauri/src/main.rs` | 后端：进程托管、日志流、端口探测、插件命令、退出回收 |
| `src-tauri/Cargo.toml` | tauri 2 / tauri-plugin-shell / serde / tokio(full) / libc |
| `src-tauri/tauri.conf.json` | 1200×800 主窗口、security（assetProtocol）、devUrl 1420 |
| `index.html` | 单窗口壳：侧边栏 + 对话(iframe) / 日志 / 插件 三视图 |
| `src-tauri/capabilities/default.json` | `core:default`（事件监听/自定义命令） |
| `vite.config.ts` | Vite 固定 1420 端口（Tauri dev 依赖） |

## 四、运行方式

```bash
npm run tauri dev     # 开发（热重启，秒级）
npm run tauri build   # 打包 .app（尚未执行）
```

> 已知边界：关闭 app 会连带关闭 DSH（进程组回收，符合"壳"语义）；若想"关 app 不杀 DSH"需改退出逻辑为仅断开连接。
