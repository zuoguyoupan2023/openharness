# 001 · 规划：OpenHarness（下一步做什么）

> 参考：`demo1/plan.html`（两阶段蓝图）、[`001-summary.md`](001-summary.md)（现状）、[`002-discussion.md`](002-discussion.md)（决策记录）
> 优先级：P0=下个迭代就做，P1=随后，P2=远期
> 更新日期：2026-08-14

---

## ▶ 接下来该做什么（一句话版）

**先补两个 P0 短板：① 多标签阶段 2（原生 webview，解决网页白屏）② 插件中心收尾（详情页 + 自动更新检查）；然后进 P1（终端面板 → 工作区/权限模式），最后 P2 打包发布。** 详细排期见文末。

---

## ✅ 已完成（2026-08-14 迭代）

- [x] 改名 openharness（B 标准：productName / identifier / crate / 品牌 / 日志前缀）
- [x] 多标签页阶段 1：iframe 池 + 标签栏 + 网址栏 + 历史栈 + 新标签页 + localStorage 持久化
- [x] 插件中心基础：awesome-dsh-plugin 索引（143 插件）+ 分类/搜索 + npm 版本（npmmirror 回退）+ 装/卸/更 + 自动重启生效 + 官方组合包区
- [x] 设置视图：npm 镜像源（官方/淘宝/自定义）持久化 + 注入 `npm_config_registry` 全链路生效
- [x] 预装插件机制：`AUTO_INSTALL_PLUGINS`（`adhdgofly-dsh-ext@0.1.1` 已发布 npm 并解开，启动自动预装）
- [x] 稳定性：日志走文件防 EPIPE、`window.onerror` 兜底、`dsh-exit` 后自动探测外部 3080 直连
- [x] Bug 修复：TabManager TDZ 崩溃（卡死 + 按钮无响应 + DSH 不自启）

---

## P0 · 多标签页阶段 2：原生 webview（解决网页白屏）

现状：阶段 1 用 iframe 池，Google / Bing / GitHub 等多数网站被 X-Frame-Options / CSP 拒嵌（白屏），只能浏览允许嵌入的站点。

目标：**DSH 标签保持 iframe（稳定、不丢会话）；用户自开的网页标签升级为 Tauri 原生子 webview**（`window.add_child(WebviewBuilder)`，官方 multiwebview 示例）。

| 子任务 | 说明 |
|--------|------|
| 多 webview 管理器 | 封装「每标签一个原生 webview」的创建/销毁/显隐/定位，替代 iframe 池 |
| 已知坑处理 | 多 webview 白屏 [#10011](https://github.com/tauri-apps/tauri/issues/10011)、resize 失效 [#10131](https://github.com/tauri-apps/tauri/issues/10131)、Windows 层级 [#9798](https://github.com/tauri-apps/tauri/issues/9798)、额外 webview 权限需单独配 [#10317](https://github.com/tauri-apps/tauri/issues/10317) |
| 导航拦截 | `window.open` / 新窗口请求 → 自动开新标签；`webview.navigate` 同步网址栏 |
| 回退 | webview 方案遇阻时，阶段 1 iframe 池继续可用（代码保留） |

验收：Google / Bing / GitHub 等网站可在标签内正常浏览与搜索，网址栏可编辑前往。

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

## P2 · 打包发布

- `npm run tauri build` 产出 .app / .dmg。
- 签名 + notarize（`tauri-apple-signing` / `@tauri-apps/cli`）。
- 自动更新（`tauri-plugin-updater` + 更新服务器）。
- 安装包内嵌 Node 运行时（可选）：摆脱对系统 Node/npx 的依赖，预装 `@deepseek-ai/dsh` 离线可用。

---

## 排期建议（下一个迭代）

1. **P0 · 多标签阶段 2（原生 webview）**——网页白屏是当前最大体验短板，优先
2. **P0 · 插件中心收尾**——详情页 + 自动更新检查 + 缓存落盘
3. **P1 · 嵌入式终端面板**——xterm.js + stdin 转发
4. **P1 · 工作区 / 权限模式 UI**——Codex/WorkBuddy 差异化参考点
5. **P2 · 打包发布**——签名 / 自动更新 / 内嵌 Node
