# DSH-Tauri 跨平台差距与技术选型

> 目标：把 Tauri v2 壳（OpenHarness）从「仅 macOS 实测」推进到「可移植到 Windows / Linux」。本文档盘点当前代码的平台相关实现、标注差异与缺口，并给出技术选型与落地顺序。原则：**不臆测**，所有结论基于本仓库 `src-tauri/src/main.rs` 等源码逐一核对；未在对应平台实测的项均明确标注。

---

## 0. 结论速览（TL;DR）

- **Tauri v2 本身跨平台**（core 用 Rust，webview 各系统自带），**架构无需重写**，主工作量在 **“系统层差异适配”+“内置 Node 跨平台”+“进程回收”** 三处。
- **当前最大障碍不是壳代码，而是内置 Node 仅支持 macOS**（`node_os_arch()` 对非 macos 直接 `Err`），以及若干 `#[cfg(not(unix))]` 的空实现（Windows 上等于“不能回收子进程”）。
- **智能体启动器（L1）在 Windows 上有特有坑**：npm 全局装的是 `.cmd` shim，直接 spawn 二进制会失败，需经 `cmd.exe /C`。
- **必须用 GitHub Actions 矩阵（windows/macos/ubuntu）做“能编译+能跑基础流程”验证**；目前仓库没有 build CI（仅 registry 同步）。
- 建议**新增 3 个 Rust 依赖/机制**承担系统差异：进程树回收、跨平台 Node 下载、pty（已有 `portable-pty` 已跨平台）。

---

## 1. Tauri v2 跨平台架构（现状映射）

| 层 | macOS（已实测） | Windows | Linux |
|---|---|---|---|
| 壳二进制 | Rust (aarch64/x86_64) | Rust | Rust |
| WebView | WKWebView | **WebView2**（Edge Chromium 运行时，需随包/系统安装） | WebKitGTK |
| PTY | `/dev/ptmx`（portable-pty unix 后端） | **ConPTY**（portable-pty win 后端，portable-pty 已支持） | `/dev/ptmx` |
| 子进程 shell | `/bin/zsh`（`$SHELL`） | `cmd.exe`（`$COMSPEC`）—— 已按 `cfg!(windows)` 处理 | `$SHELL` |
| 内置 Node | 仅 darwin（arm64/x64） | ❌ 未实现（`node_os_arch()` 报错） | ❌ 未实现 |
| 进程回收 | `kill(-pgid)` / `kill(pid)`（libc） | ⚠️ `#[cfg(not(unix))]` 空实现 | `kill(-pgid)` |

> Tauri v2 会随平台自动选用对应 webview，开发者无需改壳去“选浏览器”；需要处理的是**系统特有的进程/文件/Shell 语义**。

---

## 2. 当前跨平台就绪度清单（源码核对的对照表）

| 关注点 | 文件/行 | 现状（macOS 实测） | Windows/Linux 影响 |
|---|---|---|---|
| PTY（`portable-pty`） | `Cargo.toml`；`term_spawn`/`agent_spawn` | ✅ 可用 | ⚠️ Windows 走 ConPTY，需平台实测；Linux 走 posix，理论可用 |
| Shell 选择 | `term_spawn`（~1225） | macOS `$SHELL` 或 `/bin/zsh` | Windows 走 `$COMSPEC`/`cmd.exe`，已有分支 ✅ |
| 智能体启动 | `agent_spawn`（1335） | 经 `$SHELL -l -i -c 'exec …'` | ⚠️ Windows 分支仅 `CommandBuilder::new(&path)`，**未处理 `.cmd` shim**（见 §4） |
| 智能体检测 | `detect_cmd`（1292） | `#[cfg(unix)]` 用 `mode & 0o111`；`#[cfg(not(unix))]` 用 `.exists()` | Windows 已用 `.exists()` 分支 ✅，但 `.cmd` shim 需补 |
| 内置 Node 下载 | `node_os_arch()`（560） | 仅 darwin，非 macos 返回 `Err` | ❌ **Windows/Linux 需新增 `.zip`/包与下载目标**（见 §5） |
| 进程组回收 DSH | `kill_3080`（861） | `kill(-pgid)` + `kill(pid)` | ⚠️ `#[cfg(not(unix))]` 空实现 → Windows 杀不掉 npx→node 进程树 |
| 终端回收 | `kill_shell`/`kill_all_shells`（~1300） | `kill(pid, SIGKILL)` | ⚠️ 同上，Windows 分支空实现，需 `taskkill /F /T /PID` |
| 3080 端口探测 | `port_listener_pid`（lsof，~846） | 用 `lsof -ti:3080` | ❌ **Windows/Linux 无 `lsof`**，需换 `netstat -ano`（Win）/`lsof`（Linux 可用） |
| 内置 Node 解压 | `download_tarball`（603，tar 解压） | `tar` crate + `flate2` | ⚠️ Windows 官方 Node 包是 `.zip`（非 tar.gz），需加 zip 解压分支 |
| PATH 合并 | `node_search_dirs()`/`node_path_env()` | nvm/volta/~/.local/bin/brew 等 | ⚠️ Windows 需改为用户目录 Node 安装路径、`nvm-windows`、`AppData\..` 等方式 |
| 硬编码 Unix 路径 | `/usr/local/bin`、`/usr/bin`（353–354） | macOS | ⚠️ Windows 无这些路径，需按平台注入 |

> 结论：**PTY 与 shell 基本可移植（已有分支）**；真正的缺口集中在 **①进程回收 ②内置 Node 下载/解压 ③`.cmd` shim ④端口探测 ⑤CI 验证**。

---

## 3. 智能体启动器（L1）在 Windows 的差异

### 3.1 你已预期的行为（macOS 那套环境坑的 Windows 对比）
- macOS：GUI 进程 PATH 短 → 缺 nvm 等 → 用 `$SHELL -l -i -c 'exec …'` 补全环境。
- **Windows 一般不会“PATH 空”**：Windows 桌面启动的 GUI 继承完整系统+用户 PATH，claude/codex 直接跑通常能找到命令。所以 `agent_spawn` 的 Windows 分支**不需要**套 shell 包装，现有 `#[cfg(windows)]` 直接跑二进制在环境层面是合理的。

### 3.2 但 Windows 有自身的坑：`.cmd` shim
npm 全局命令在 Windows 上实际是 **`<name>.cmd` / `<name>.ps1`** shim（一小段批处理/脚本，内部调 `node` + 真正的 JS 入口）。直接 `CommandBuilder::new("claude")` spawn：
- 若 `detect_cmd` 返回的是 `.../bin/claude`（无扩展名），Windows 找不到可执行 → 报 ENOENT。
- 即使返回 `claude.cmd`，Rust `std::process::Command` / portable-pty 直接用 `.cmd` 需要经 **`cmd.exe /C claude.cmd …`** 才能跑（不能直接把 .cmd 当可执行）。

**技术选型（Windows 启动智能体）**：
```rust
// 推荐：统一走 cmd.exe /C 执行，兼容 .cmd shim
let mut c = CommandBuilder::new("cmd.exe");
c.arg("/C").arg(&path_or_cmd); // path = detect_cmd 找到的 .cmd
```
> 另一方案是把 npm 全局命令换成直接调 `node <global>/node_modules/<pkg>/cli.js`，但那样要绕 path resolution，不如 `.cmd` shim 稳。**选 `cmd.exe /C`**。

### 3.3 L1 在 Windows 的验收标准
- 检测：`detect_cmd` 能找到 `claude.cmd` 等（需让 `.cmd` 分支返回带扩展名的可执行）。
- 启动：`cmd.exe /C <shim>` 在 ConPTY 里跑起来，TUI 正常、可 `term_resize`。
- 回收：`term_kill`/退出后 `taskkill /T /F /PID` 清进程树。

---

## 4. 需要补的系统差异实现（按依赖划定）

### 4.1 进程树回收（Windows）
现状：`kill_3080`/`kill_shell`/`kill_all_shells` 的 Windows 分支都是空实现（只 `let _ = pid;`）。
方案：新增一个 `fn kill_process_tree(pid: u32)`：
```rust
// Unix：kill(-pgid)+kill(pid)（现状已 OK）
// Windows：Command::new("taskkill").args(["/T","/F","/PID",&pid.to_string()])
```
并替换所有 `#[cfg(not(unix))]` 空分支为调用该函数。影响面：DSH 生命周期、多终端、智能体退出。

### 4.2 3080 端口 → pid 探测（Windows/Linux）
现状：`lsof -ti:3080`（Unix）。
方案：按平台换命令：
- Windows：`netstat -ano | findstr :3080`（取最后列 PID）。
- Linux：`lsof` 通常可用；或读 `/proc/net/tcp`。
> 或者统一改用一个 Rust 库（如 `sysinfo`）遍历进程的网络端口，避免依赖外部命令。**推荐 `sysinfo`**：跨平台、不用 shell 命令，且能顺带做进程树遍历。

### 4.3 内置 Node 下载 & 解压（最大缺口）
现状：`node_os_arch()` 只放行 darwin；`download_tarball` 用 tar.gz。
方案：
- 下载目标：darwin → `darwin-arm64/x64`（现状）；`win32` → `win-x64/arm64`（Node 官方包为 **`.zip`**）；`linux` → `linux-x64/arm64`（`.tar.gz`，与现状一致）。
- 解压：tar.gz 走现有 `tar`+`flate2`；**Windows `.zip` 需加 `zip` crate**。
- 落地形态：解压后 Node `bin/`（Unix）vs 直接 `node.exe`/`npm.cmd`（Windows），`resolve_npx`/`node_path_env` 要按平台返回 `npx`（Unix）或 `npx.cmd`（Windows）。

### 4.4 PATH 合并 / Node 定位（Windows）
现状：`node_search_dirs()` 收集 nvm/volta/~/.local/bin/brew。
方案：Windows 增补——
- `%USERPROFILE%\AppData\Roaming\nvm`（**nvm-windows 常用**）
- 系统/用户 `PATH` 里的 Node 目录
- `%ProgramFiles%\nodejs`（官方安装默认）
- volta：`%LOCALAPPDATA%\Volta\bin`
> `node_path_env` 无依赖即可跨平台（用 `std::env::split_paths` 已是平台正确）。

---

## 5. 技术选型建议（汇总）

| 能力 | 现状 | 建议选型 | 新增依赖 |
|---|---|---|---|
| PTY | `portable-pty` | ✅ 保留（已跨平台） | 无 |
| 进程树回收 | Unix 原生 / Win 空 | `sysinfo`（跨平台遍历）或 `taskkill`/`kill(-pgid)` | `sysinfo`（可选） |
| 3080 端口→pid | `lsof`（Unix） | **`sysinfo`** 统一（避免 lsof 缺失）+ Windows netstat 兜底 | `sysinfo` |
| Node 下载 | 仅 darwin tar.gz | 多平台：darwin tar.gz / win zip / linux tar.gz | `zip`（Windows） |
| 智能体 .cmd | 未处理 | Windows 走 `cmd.exe /C <shim>` | 无 |
| WebView | 系统自带 | Tauri v2 自动 → 但 Windows 需保证 **WebView2 运行时** | `tauri-plugin-webview`?（通常系统预装） |
| 打包 | `tauri-bundle` | 跨平台 bundle（.dmg/.msi/.appimage） | 无（Tauri 自带） |
| CI 验证 | ❌ 无 | **GitHub Actions 矩阵**（windows/macos/ubuntu）+ `tauri build` + 基础 smoke | 工作流配置 |

> **`sysinfo` 是性价比最高的新增依赖**：一个 cratet 同时解决 4.2 端口探测、进程树遍历、可顺带进程状态，减少手写平台分支。

---

## 6. 建议落地顺序（按“能编能跑 → 补能力 → 自动化”推进）

1. **建立 CI 矩阵**（最快确认现状）：GitHub Actions 对 windows-latest / macos-latest / ubuntu-latest 各跑一次 `npm run tauri build`（或 `cargo build`）。这一步立刻暴露所有“只在 macOS 通过”的编译/链接问题。
2. **修 Windows 进程回收**：`kill_3080`/`kill_shell` 的 Windows 空分支 → `taskkill /T /F /PID`（或 `sysinfo`）。
3. **修 Windows 智能体启动**：`agent_spawn` Windows 分支 → `cmd.exe /C`，`detect_cmd` 支持 `.cmd`。
4. **内置 Node 跨平台**：`node_os_arch()` 放开 win/linux + `.zip` 解压 + `npx.cmd` 定位。
5. **（可选）引入 `sysinfo`**：统一端口探测与进程树，替代 `lsof`/手写。
6. **平台测试**：Windows 上实测 DSH 生命周期 + 多终端 + 智能体；Linux 上实测 PTY/TUI。
7. **打包与分发**：Tauri 跨平台 bundle + **WebView2 运行时引导**（Windows 首次运行若缺需提示安装/静默装）。

---

## 7. 已知但暂缓 / 不确定项

- **WebView2 部署方式**：Windows 上 WebView2 需 Evergreen 运行时（Win10/11 通常已带，但 Win10 LTSB 或精简版可能缺）——建议用 Tauri 官方推荐的引导（`tauri-plugin` 或引导安装器）做首次检测/提示。此为发布期事项，暂缓。
- **Linux 打包目标**：AppImage / deb / rpm 取决于分发渠道；目前无需求，先保证 `cargo build` 通过即可。
- **arm Windows**：Node 官方提供 win-arm64，但 CI 用 windows-latest 跑在 x64，arm64 需单独构建或交叉，暂不承诺。
- **未实测声明的正确性**：本文档所有“Windows/Linux 将如何”均基于代码分支与文档推断，**未在目标平台跑过**；以第 6 节 CI 结果为唯一准绳。

---

## 8. 附：改动涉及的代码位置索引

| 功能 | 函数 | 位置 |
|---|---|---|
| PTY 拉起 | `spawn_pty_internal` | `src/main.rs` ~1398 |
| 智能体启动 | `agent_spawn` | ~1337 |
| 智能体检测 | `detect_cmd` | ~1292 |
| 终端杀进程 | `kill_shell` / `kill_all_shells` | ~1300 / ~1540 |
| DSH 进程组回收 | `kill_3080` | ~861 |
| 端口→pid | `port_listener_pid` | ~846（lsof） |
| Node 目标平台 | `node_os_arch` | ~560 |
| Node 下载/解压 | `download_tarball` | ~603 |
| PATH 合并 | `node_search_dirs` / `node_path_env` | ~330 / ~376 |
