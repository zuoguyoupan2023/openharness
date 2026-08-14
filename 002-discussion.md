# 002 · 讨论纪要：OpenHarness 决策记录

> 日期：2026-08-14 · 前置文档：[001-summary.md](001-summary.md)、[001-plan.md](001-plan.md)
> 结论：本轮只做调研与决策，**001-plan 中未选中的项暂不执行**；以下 6 项已由用户拍板。

---

## 1. 改名 openharness（方案 B：标准）

| 项 | 旧值 | 新值 |
|----|------|------|
| `package.json` name | dsh-tauri-app | **openharness** |
| `tauri.conf.json` productName | my-dsh-app | **openharness** |
| `tauri.conf.json` identifier | com.deepseek.dsh.app | **com.openharness.app**（发布后不可改，趁早改） |
| 窗口标题 | DeepSeek Harness · 桌面版 | **OpenHarness** |
| Cargo crate | my-dsh-app | **openharness** |
| 日志文件名 | my-dsh-app-dsh-*.log | **openharness-dsh-*.log** |
| 侧边栏 brand | DeepSeek Harness | **OpenHarness** |

> 未做（后续可选）：磁盘目录 / git 仓库名（随时可在 GitHub 改）。

## 2. npm 镜像（方案 3：设置页可配）

调研事实：
- 默认 registry.npmjs.org 在国内首次下载慢；npx 有缓存，装过后不受影响。
- npmmirror（registry.npmmirror.com）是完整镜像，实测 `@deepseek-ai/dsh` 同步延迟约 1 分钟。
- 清华 TUNA npm 镜像实测 404（不可用），不作备选。
- ⚠️ 新发布包同步有延迟（如即将发布的 `adhdgofly-dsh-ext`），可去 npmmirror.com/sync 手动触发。

实现：
- 设置视图：官方默认 / 淘宝 npmmirror / 自定义，持久化到 app 配置目录 `config.json`。
- Rust spawn 时注入 `npm_config_registry` / `NPM_CONFIG_REGISTRY` 环境变量，级联 npx 与 pnpm 全链路。
- 已运行的 DSH 需重启才对新下载生效。

## 3. 首次预装 adhdgofly-dsh-ext（常量数组 + 注释元素）

```rust
const AUTO_INSTALL_PLUGINS: &[&str] = &["adhdgofly-dsh-ext"];
```
- 幂等：已安装则跳过；先于 `dsh web` 启动、串行执行，避免 npx/pnpm 并发锁。
- ✅ 2026-08-14：`adhdgofly-dsh-ext@0.1.1` 已发布 npm，注释已解开。

## 4. 插件视图定位（方案 C：生命周期分工）

- **app 管生命周期**：安装 / 更新 / 卸载 / 重启生效 / 版本检查（进程在壳手里）。
- **dsh web 管配置**：每个插件的设置项。
- 索引升级：从「仅搜 @deepseek-ai」改为 **awesome-dsh-plugin.com/plugins.json**（143+ 社区插件，机器可读、CORS 开放）+ npm registry 补版本。
- 新增 `restart_dsh` 命令，装/卸/更后自动重启生效。

## 5. 多标签页 + 网址栏（先方案 1，后升级方案 4）

- 阶段 1（本轮）：iframe 池 + 标签栏 + 网址栏 + 前进/后退/刷新 + 新标签页主页 + localStorage 持久化。
- 已知限制：X-Frame-Options / CSP 会阻止多数网站（Google/Bing/GitHub 等）被 iframe 内嵌 → 白屏；搜索默认走 Bing（国内可用）。
- 阶段 2（后续）：DSH 标签保持 iframe，用户网页标签升级为 Tauri 原生子 webview（`window.add_child`，需处理已知坑：白屏 #10011、resize #10131、Windows 层级 #9798、额外 webview 权限 #10317）。

## 6. 功能优先级（P0）

1. ✅ 改名 openharness
2. ✅ 多标签 + 网址栏（阶段 1 MVP）
3. ✅ 插件中心（awesome 索引 + 生命周期管理 + 预装插件机制）
4. ✅ npm 镜像配置（设置页）
5. ⏸ 会话/工作区 + 权限模式 UI（WorkBuddy/Codex 参考点）→ 留到 P1

## 7. Codex / WorkBuddy 调研摘要（供 P1 参考）

- **Codex 桌面**：Chat / Project 双模式、附加上下文、模型切换、权限控制、工作目录、插件与技能市场、自动化（MCP/hooks/定时）、沙箱（只读/工作区写入）、Git 偏好、浏览器/电脑操控插件。
- **WorkBuddy（腾讯）**：一句话任务→自主执行→交付；三栏布局（任务列表/对话/**结果区：产物/文件/变更/预览**）；多任务并行；连接器；多 Agent 协作；零代码发布本地应用；记忆；沙箱/权限。
- **对 openharness 的映射**：三栏结果区（P1）、工作区/项目概念（P1）、权限/沙箱/审批 UI（P1 差异化亮点）、会话管理（P1）、模型/用量（P2）、自动化定时任务（P2）、hooks/记忆（P2）。

## 8. .gitignore

- 根目录补充 `/src-tauri/target/`、`/src-tauri/gen/`（双保险；`src-tauri/.gitignore` 原本已覆盖）。
- 001/002 文档、demo1 蓝图为设计资产，保留跟踪。

## 9. Bug 修复记录

- **卡死问题（2026-08-14）**：`main.ts` 中 `new TabManager(...)` 的构造函数同步触发 `onActiveChange` 回调，而回调引用尚未赋值的 `const tabManager` → TDZ `ReferenceError`，boot() 在绑定导航按钮 / 调用 `start_dsh` 之前中断，导致：卡在 DSH 等待页、左侧按钮无响应、DSH 从未自启（3080 仅靠外部手动实例支撑）。
- 修复：TabManager 移除外部回调，内部直接同步网址栏；main.ts 增加 `window.onerror` / `unhandledrejection` 兜底（异常写入日志视图）；`dsh-exit` 后自动探测外部 3080 并直连。

## 10. 多标签阶段 2：原生 webview（2026-08-14 实现）

**决策**：网页标签升级为 Tauri 原生子 webview（`Window::add_child(WebviewBuilder)`），DSH 标签保持 iframe。背景：白屏经实测确认是目标站点 `X-Frame-Options`/CSP 拒嵌 iframe（npmjs `SAMEORIGIN`、GitHub `deny`、Google `SAMEORIGIN`；Bing / awesome-dsh-plugin 无限制），与 app 网络无关（插件中心 fetch 外部 API 正常）。

**关键踩坑**：

1. **`add_child` 需要 `tauri` 的 `unstable` feature**（Cargo.toml 增加 `"unstable"`）。
2. **必须在 async 命令里调用 `add_child`**：其内部 `run_on_main_thread` + 阻塞 recv，若同步命令在主线程调用会死锁（官方示例即为 `async fn`）。
3. **子 webview 显隐**用 `Webview::hide/show`（仅隐藏自身，不动父窗口）；定位用 `LogicalPosition/LogicalSize`（前端 `getBoundingClientRect` 1:1 传入；macOS 下 CSS px == 逻辑 px）。
4. **导航同步**：`on_navigation`（每次导航开始）→ `webview-nav` 事件 → 前端更新网址栏/历史栈（同 URL 去重）；`on_new_window` → `Deny` + `webview-new-window` 事件 → 自动开新标签；`on_document_title_changed` → 标签标题。
5. **前端 IPC 串行队列**：激活/导航/关闭全部入队，避免 async invoke 乱序（快速连续操作不串台）。
6. **视图切换**：离开对话视图必须隐藏所有原生 webview（否则浮在日志/插件/设置视图之上）。
7. **白屏规避**（tauri#10011）：`webview_show` 末尾重设一次尺寸 kick；窗口 resize 前端去抖（150ms）重算 bounds。
8. 子 webview 是纯浏览（不注入 IPC 权限），无需 capability（tauri#10317 仅影响运行时 webview 的 IPC）。
