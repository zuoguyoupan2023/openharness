# 001 · 总结：OpenHarness（DeepSeek Harness 桌面壳 · 当前实现）

> 项目：`openharness`（原 `my-dsh-app`，Tauri v2 + Vite + vanilla TS） · 更新日期：2026-08-14
> 目标：把 DSH Web UI（`http://127.0.0.1:3080`）包装成 Mac 原生应用，无需浏览器、双击即用。
> 决策记录见 [`002-discussion.md`](002-discussion.md)，下一步规划见 [`001-plan.md`](001-plan.md)。

---

## 一、实现了什么

| # | 能力 | 状态 |
|---|------|------|
| 1 | 改名 **openharness**：productName / identifier(`com.openharness.app`) / crate / 品牌 | ✅ |
| 2 | 单窗口 + 左侧边栏四视图（💬 对话 / 🖥️ 日志 / 🧩 插件 / ⚙️ 设置） | ✅ |
| 3 | Rust 后端托管 DSH 子进程（启动 / 日志流 / 退出回收） | ✅ |
| 4 | 端口探测：3080 已在运行（含用户手动启动的外部实例）则直接连接，不重复启动 | ✅ |
| 5 | 就绪检测：匹配 DSH 输出后自动切到对话视图 | ✅ |
| 6 | **多标签页（阶段 1：iframe 池）**：标签栏 + 新建/关闭 + 网址栏（后退/前进/刷新/主页）+ 新标签页快捷入口 + localStorage 持久化 | ✅ |
| 7 | DSH 标签：未就绪显示等待动画；就绪自动加载；**重启后自动重连** | ✅ |
| 8 | **插件中心**：以 awesome-dsh-plugin.com/plugins.json 为主索引（143 个社区插件，CORS 开放）+ 分类筛选 + 搜索 + npm 版本拉取（npmjs → npmmirror 回退 + 本地缓存） | ✅ |
| 9 | 插件生命周期：安装 / 更新 / 卸载（`dsh plugin --profile web`）+ **完成后自动重启 DSH 生效** | ✅ |
| 10 | 官方组合包独立区块（dsh-base / web-app / headless / llm-deepseek） | ✅ |
| 11 | **设置视图**：npm 镜像源（官方默认 / 淘宝 npmmirror / 自定义）持久化到 app 配置目录 `config.json` | ✅ |
| 12 | 镜像注入：spawn 时设 `npm_config_registry` / `NPM_CONFIG_REGISTRY`，**级联 npx 与 pnpm 全链路** | ✅ |
| 13 | **预装插件机制**：`AUTO_INSTALL_PLUGINS` 常量数组（幂等跳过已装、先于 web 启动串行执行）；`adhdgofly-dsh-ext@0.1.1` 已发布 npm 并解开注释，启动即自动预装 | ✅ |
| 14 | 应用退出时整组回收自启的 DSH 进程（`kill(-pgid)`）；直连的外部实例不受影响 | ✅ |
| 15 | 稳定性：日志写文件而非管道（防 EPIPE）；前端 `window.onerror` / `unhandledrejection` 兜底，异常写入日志视图 | ✅ |
| 16 | `dsh-exit` 后自动探测外部 3080，发现外部实例即自动直连（避免卡死在等待页） | ✅ |
| 17 | Bug 修复：TabManager 构造期回调引用未初始化变量（TDZ）导致的「卡死 + 按钮无响应 + DSH 不自启」 | ✅ |

---

## 二、怎么实现的（架构）

```
┌────────────────────────────── Tauri 应用（单窗口） ──────────────────────────────┐
│  ┌─────────┐  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 侧边栏   │  │  内容区（四视图切换）                                        │  │
│  │ 对话/日志 │  │  💬 对话：标签栏 + 网址栏 + iframe 池（DSH 标签 + 网页标签）  │  │
│  │ /插件/设置│  │  🖥️ 日志：日志区 + 状态条 + 重新启动按钮                     │  │
│  │ DSH状态灯 │  │  🧩 插件：已安装 + 官方组合包 + 社区插件表（分类/搜索/装卸更） │  │
│  └─────────┘  │  ⚙️ 设置：npm 镜像源（官方/淘宝/自定义）+ 重启 DSH            │  │
│               └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │ tauri::invoke / 事件
        ┌──────────────────────▼──────────────────────┐
        │  Rust 后端（src-tauri/src/main.rs）           │
        │  · start_dsh：探测 3080 → 已运行则直连，否则    │
        │    spawn `npx --yes @deepseek-ai/dsh web`    │
        │    （先执行 AUTO_INSTALL_PLUGINS 预装）        │
        │  · restart_dsh：杀进程组 → 等端口释放 → 重 spawn│
        │  · run_dsh_cmd：执行任意 dsh CLI（插件装/卸/更）│
        │  · get_settings / set_registry：镜像配置落盘    │
        │    → spawn 时注入 npm_config_registry（级联）  │
        │  · list_installed_plugins：读 web profile     │
        │  · 日志文件尾随 → dsh-log；就绪 → dsh-ready     │
        │  · 退出时 kill(-pgid) 整组回收                 │
        └──────────────────────┬──────────────────────┘
                               │ spawn（独立进程组）
        ┌──────────────────────▼──────────────────────┐
        │  npx @deepseek-ai/dsh web → DSH 服务          │
        │  http://127.0.0.1:3080                       │
        └─────────────────────────────────────────────┘
```

### 关键设计决策

1. **日志走文件不走管道**：子进程 stdout/stderr 重定向到临时目录 `openharness-dsh-N.log`，前端尾部跟踪（250ms 轮询）——app 重启/被杀不影响 DSH 存活。
2. **端口探测防冲突**：`start_dsh` 先探测 3080，通了直接 `dsh-ready`（含用户手动启动的外部 DSH），不通才 spawn；`restart_dsh` 等端口释放后再启动。
3. **进程组回收**：`process_group(0)` + 退出时 `kill(-pgid, SIGKILL)`；仅回收自启的 DSH，外部实例不受影响。
4. **多标签 iframe 池（阶段 1）**：每个标签一个 iframe，切换 `display` 显隐保持会话；网址栏自动补全 `https://`、非 URL 走 Bing 搜索（国内可用）；**已知限制：多数网站被 X-Frame-Options/CSP 拒嵌（白屏）→ 阶段 2 计划升级原生 webview（见 001-plan P0）**。
5. **就绪检测**：匹配 `dsh web:` / `127.0.0.1:3080` / running on / listening 并从行内解析 URL。
6. **插件索引来自 awesome-dsh-plugin.com/plugins.json**（CORS 开放，143+ 社区插件）+ npm registry 拉版本（npmmirror 回退）；不再是仅搜 `@deepseek-ai`。
7. **插件安装走官方 CLI** + 完成后自动 `restart_dsh` 生效。
8. **镜像配置全链路生效**：设置持久化到 app 配置目录 `config.json`，spawn 时注入 `npm_config_registry`，npx（下载 dsh）与 pnpm（`dsh plugin` 内部）都生效。
9. **前端模块化**：`src/main.ts`（入口/视图切换/事件总线接线）+ `dsh.ts`（生命周期+事件订阅）+ `tabs.ts`（标签管理器）+ `plugins.ts`（插件中心）+ `settings.ts` + `config.ts`（常量与设置 API）。
10. **Bug 修复经验**：构造器内同步回调引用未初始化的 `const` 会触发 TDZ 崩溃且 tsc 发现不了——避免构造期调用外部回调；并全局兜底 `window.onerror`。

---

## 三、文件清单

| 文件 | 作用 |
|------|------|
| `src-tauri/src/main.rs` | 后端：进程托管、设置(registry)、restart_dsh、插件命令、退出回收 |
| `src-tauri/Cargo.toml` | crate `openharness`；tauri 2 / tokio(full) / serde / libc |
| `src-tauri/tauri.conf.json` | productName `openharness`、identifier `com.openharness.app`、主窗口、devUrl 1420 |
| `src-tauri/capabilities/default.json` | `core:default` |
| `index.html` | 壳 UI：四视图 + 标签栏/网址栏/插件中心/设置页（样式内联） |
| `src/main.ts` | 应用入口：boot 流程、视图切换、DSH 事件接线、错误兜底 |
| `src/dsh.ts` | DSH 生命周期 API + 事件总线（log/ready/exit 订阅） |
| `src/tabs.ts` | 多标签管理器：iframe 池、网址栏、历史栈、新标签页、持久化 |
| `src/plugins.ts` | 插件中心：awesome 索引、分类/搜索、版本、装/卸/更 + 重启 |
| `src/settings.ts` | 设置视图：镜像源选择、保存、重启 DSH |
| `src/config.ts` | 设置常量（官方/淘宝源）与设置 API |
| `001-plan.md` / `002-discussion.md` | 规划与决策记录 |

## 四、运行方式

```bash
npm run tauri dev     # 开发（热重启，秒级）
npm run tauri build   # 打包 .app（尚未执行）
```

> 已知边界：关闭 app 会连带关闭**自启**的 DSH（进程组回收）；若 3080 是外部手动启动的实例，关闭 app 不影响它。多标签阶段 1 用 iframe，多数第三方网站拒嵌（白屏），阶段 2 升级原生 webview 解决。
