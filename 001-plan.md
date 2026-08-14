# 001 · 规划：DeepSeek Harness 桌面壳（下一步做什么）

> 参考：`demo1/plan.html`（两阶段蓝图）、`001-summary.md`（现状）
> 优先级：P0=下个迭代就做，P1=随后，P2=远期

---

## P0 · 网页多标签页（对话视图升级为浏览器式 Tab）

现状：对话视图只有一个 iframe 固定加载 3080。

目标：标签栏 + 多标签，像浏览器一样切换多个页面：

| 子任务 | 说明 |
|--------|------|
| Tab 栏 UI | 对话视图顶部加标签栏：`＋` 新建标签、`×` 关闭、拖动排序（可选） |
| 多 iframe 池 | 每个 Tab 一个 `<iframe>`，切换时 `display` 显隐（保持会话不重载）；默认 Tab 仍是 3080 |
| 预置 Tab 类型 | ① DSH 主界面 ② 新标签页（书签/常用：npm、GitHub、文档）③ 空白页 |
| 状态提示 | Tab 标题取 iframe `document.title`（跨域拿不到时用 URL 兜底） |
| 持久化 | 标签列表写入 localStorage，重启 app 后恢复 |
| 能力取舍 | 若 iframe 遇兼容问题（如第三方站点 X-Frame-Options 拒绝），改为 Tauri 原生子 webview（`window.add_child`，需处理定位与窗口 resize） |

验收：对话视图内可同时开着 3080 + npm 插件页 + GitHub，一键切换不丢状态。

---

## P0 · 插件中心完善（收集 → 检查更新 → 安装/卸载/更新）

现状：手动点「获取最新插件信息」；基线存 localStorage；安装走 `dsh plugin --profile web add`。

### 1. 插件信息收集渠道（前期人工收集 + 后续自动化）
| 渠道 | 做法 | 阶段 |
|------|------|------|
| npm registry 搜索 | `registry.npmjs.org/-/v1/search?text=@deepseek-ai dsh`（现有） | ✅ 已实现 |
| npm 官方组织页 | 爬取 `npmjs.com/org/deepseek-ai` 下所有 dsh 相关包 | P0 |
| GitHub 仓库/Releases | 监控 `deepseek-ai/*` 及社区仓库的 release 与 README 提到的插件 | P1 |
| 社区插件索引 | 手动登记已知插件（如本地 `adhdgofly-dsh-ext`）到内置 `KNOWN_PLUGINS` | P0 |
| 插件内自述 | 解析插件包 `package.json` / README 的 `dsh.bundle` 元数据 | P1 |

### 2. 更新检查
- 自动检查：启动时 + 每 N 小时后台静默拉取最新版本（不打扰用户，角标提示）。
- 基线持久化：从 localStorage 升级为本地 JSON 缓存文件（Rust 侧读写，`$APP_DATA/plugin-cache.json`），跨重启保留。
- 已安装版本 vs 最新版本 diff：读 `~/.dsh/profiles/web/package.json`（已有 `list_installed_plugins`），逐插件标「可更新」。

### 3. 安装/更新/卸载（按钮齐全）
- 安装：现有 `run_dsh_cmd` ✅，需补：安装完成后**自动重启 DSH** 使其生效（新增 `restart_dsh` 命令：kill 当前 DSH 进程组 → 重新 spawn）。
- 更新：`dsh plugin --profile web update <pkg>`（待验证 pnpm 语义）→ 同样重启生效。
- 卸载：`dsh plugin --profile web remove <pkg>` → 重启生效。
- 校验：安装前后对比 `list_installed_plugins` 差异并提示。

### 4. 插件详情页
点开插件行 → 弹层显示：描述 / 版本历史（`registry.npmjs.org/<pkg>` 的 `time` 字段）/ README 摘要 / 依赖 / 作者。

---

## P1 · 嵌入式终端面板（demo1 蓝图第二阶段）

现状：日志是只读文本流。

目标：壳内真正的终端体验：
- 分屏布局：对话(70%) + 底部终端面板(30%)，可拖拽分割（demo1 建议）。
- `xterm.js` 渲染 + ANSI 颜色转义解析（npm 引入 `@xterm/xterm`）。
- **双向交互**：Rust 侧把 DSH 子进程 stdin 从 `inherit` 改为 `piped`，新增 `write_stdin(line)` 命令，终端输入框→子进程 stdin（如重启、调试指令）。
- 日志模式切换：纯日志 / 终端仿真两种渲染。

---

## P1 · 稳定与体验

| 项目 | 说明 |
|------|------|
| DSH 掉线自动重连 | iframe 加载失败 / `dsh-exit` 后，自动探测并刷新或提示一键重连 |
| 菜单栏/托盘 | 菜单：重启 DSH、打开日志目录、关于；托盘图标：显示运行状态、退出 |
| 开机自启 | `tauri-plugin-autostart` |
| 快捷键 | Cmd+1/2/3 切换视图、Cmd+R 刷新对话 |
| 深色模式适配 | 跟随系统（前端已暗色，补 light 主题可选） |

---

## P2 · 打包发布

- `npm run tauri build` 产出 .app / .dmg。
- 签名 + notarize（`tauri-apple-signing` / `@tauri-apps/cli` 配置）。
- 自动更新（`tauri-plugin-updater` + 更新服务器）。
- 安装包内嵌 Node 运行时（可选）：摆脱对系统 Node/npx 的依赖，改为内置 `node` + 预装 `@deepseek-ai/dsh`，彻底离线可用。

---

## 排期建议（下一个迭代）

1. **多标签页**（P0，改动集中在前端，收益大）
2. **插件中心**：重启生效命令 + 自动更新检查 + 缓存落盘（P0）
3. **终端面板**（P1，需引入 xterm.js + stdin 转发）
4. 打包发布（P2）
