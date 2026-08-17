# 014 · 规划：链接打开行为 + 历史记录独立标签页（含此前规划未完成项盘点）

> 状态：**✅ 已实施（2026-08-18）**：① 历史记录独立标签页 ② 历史按钮移至「前往」最右 ③ 内部打开自动切对话视图；§1 盘点备查，其余遗留项（§2.2 交付 B、§6 未完成项）不入本轮。
> 范围：`src/main.ts`、`src/tabs.ts`、`src/history.ts`、`src/open-link.ts`、`index.html`、`src/i18n.ts` 为主的前端改动；零 Rust 改动。
> 来源：上轮交付 A（链接打开方式选择器 + 历史记录浮层）的用户反馈：① 历史记录改为**独立标签页**显示；② 历史按钮放在**网址栏「前往」按钮最右侧**；③ 链接在 App 内打开时**自动切到对话界面并激活新标签页**。

---

## 0. 结论速览（TL;DR）

| 需求 | 一句话方案 |
|---|---|
| ① 历史记录独立标签页 | 新增标签类型 `history`（像 Chrome `chrome://history`）：点击历史按钮 → 若已有历史标签则激活、否则新建一个显示按天分组历史列表的标签页；**删除**上一轮的浮层面板 `#history-panel` |
| ② 历史按钮位置 | 网址栏「前往」按钮 **右侧**（`url-go` 之后，本行最右） |
| ③ 内部打开自动切对话 | `openLink` 的 `openInApp` 在 `addTab` 后自动 `switchView("chat")` 并激活新标签 |
| 附带 | 盘点此前规划未完成项（§1），写入本文档备查 |

---

## 1. 此前规划未完成项盘点（2026-08-18 全仓库核对）

> 方法：逐份阅读根目录规划文档（000–013）的状态标记与待办，并结合代码现状核对。已完成项不列。

| # | 项 | 出处文档 | 状态 | 卡点 / 说明 |
|---|---|---|---|---|
| 1 | **P1 · 工作区/会话管理 + 权限/沙箱模式 UI**（工作区选择器、会话按目录分组、对话区上方 只读/写工作区/联网 切换） | `001-plan.md` L78–85 | 未实施 | 规划为 Codex/WorkBuddy 差异化点；DSH 自身有沙箱，壳只补 UI |
| 2 | **P1/P2 · 多模态（语音 + 视觉）**：系统 TTS + Vosk STT 先行；Qwen3-TTS / Kokoro / SenseVoice；云端 Edge TTS / Azure STT；视觉理解 / OCR | `001-plan.md` L102–123；`005` `006-stt-*` `007-voice-cloud` `008-voice-pure-config` | 未实施（调研已完成） | 「执行另等具体要求」；`openharness-voice` 插件已调研但 npm 未发布 404，待发布后评估接入 |
| 3 | **智能体启动器新增 maka / reasonix** | `011-agents-maka-reasonix-plan.md` | 规划未实施 | ⚠️ 开放项：两个工具的确切身份（命令名 / npm 包名）需用户确认，否则检测/启动/安装指向错误 |
| 4 | **gitee 镜像接入** | `007-gitee-repo.md` | 代码侧已就绪 | 等待用户创建 gitee repo 并配置一次性密钥 |
| 5 | **跨平台推进（Windows / Linux）**：进程回收、内置 Node 下载/解压、`.cmd` shim、端口探测、CI 验证 | `010-cross-platform.md` | 未实施 | 建议引入 `sysinfo` 依赖；未在目标平台实测 |
| 6 | **P2 · 打包发布**：签名 + notarize、Gatekeeper 引导、可选离线打包 dsh | `001-plan.md` L127–132 | 未实施 | 发布说明见 `RELEASE-NOTES-v0.1.0.md` |
| 7 | **终端智能体 L2「未装即装」**（`agent_install` 一键安装） | `001-term.md` | 明确本期不做 | 需先有 3.1 工具权威信息 |
| 8 | **011 遗留：maka/reasonix 确认后的落地** | 同 #3 | — | 与 #3 同源 |

> 注：`013-plugin-center-ui-ux-plan.md` 已按用户指示不再作为参考（其信息架构已实施并被新一轮调整覆盖）；插件中心相关功能（P0 队列 / 卸载确认 / 分页 / 防抖 / 竞态 / 批量更新 / 主 tabs 重构 / 推荐 / 筛选排序）均已实施。

### 1.1 上一轮交付的遗留项（重要）

| 遗留 | 说明 | 状态 |
|---|---|---|
| **交付 B：DSH 对话标签改原生 webview** | 对话（iframe）内的链接点击目前无法被前端拦截（跨源），跳系统浏览器/iframe 内导航无法拖动到「打开方式选择器」；唯一彻底方案是 DSH 标签改原生 webview（Rust `add_child` + `on_new_window`），有会话稳定性风险，需单独阶段实现并实测，不稳可回退 | ⚠️ 待单独实施 |

---

## 2. 链接打开方式（交付 A 回顾 + 遗留）

### 2.1 已实施（2026-08-18 交付 A）

- `src/open-link.ts`：统一入口 `openLink(url)` —— 按设置（每次询问 / App 内 / 系统浏览器）执行；「每次询问」弹统一风格选择框（App 内打开 / 浏览器打开 + 「不再提示」复选框）。
- 设置页新增「链接打开方式」组（localStorage 持久化，立即生效）。
- 覆盖入口：插件详情/表格链接（`target=_blank` 全局拦截，capture 阶段）、网页标签 `window.open`/`target=_blank`（Rust `webview-new-window` 事件）、终端 URL、侧边栏推荐链接、`window.open()` monkey-patch。

### 2.2 遗留：对话内链接

- 现状：DSH 标签为 iframe（`tabs.ts` 明确为「稳定、不丢会话」做的选择），跨源 iframe 内链接点击无法从前端 JS 拦截。
- 计划（交付 B，单独阶段）：DSH 标签改原生 webview → 其 `on_new_window` 事件接入统一 `openLink`；同时 `on_navigation` 可同步对话内导航到历史记录。
- 风险：可能影响 DSH 会话稳定性；实施后需真实对话场景实测，不稳定则回退 iframe。

---

## 3. 历史记录独立标签页（本次实施）

### 3.1 设计

- 新增标签类型：`type TabType = "dsh" | "web" | "blank" | "history"`（`src/tabs.ts`）。
- 历史标签页内容为本地渲染的列表页（类似新标签页 `newTabPageHtml` 的本地 overlay），展示按天分组（今天 / 昨天 / 更早 YYYY年M月D日）的记录：
  - 每条：图标 + 标题 + 网址 + 时间；
  - 点击条目 → `addTab("web", url)` 激活新标签打开该网址（历史标签保留在标签栏）；
  - 页面顶部：「历史记录」标题 +「清空」按钮 +（可选）关闭标签提示。
- 渲染逻辑在 `src/history.ts` 增加 `renderHistoryPage(container, onOpen, onClear)`；原 `renderHistoryList` 保留（浮层面板删除后可不再使用，若删除则清理导出）。
- 按钮：网址栏「前往」按钮右侧新增 `#url-history`（时钟图标，`title=历史记录`）。
- 点击行为（`src/main.ts`）：
  1. 若已存在 `type === "history"` 的标签 → `activate` 它；
  2. 否则 `addTab("history")`；
  3. 自动 `switchView("chat")`（保证用户看到新标签）。
- 持久化：`restore()` 与 `persist()` 兼容 `history` 类型；恢复后该标签重新渲染历史页（数据从 localStorage 现取，始终最新）。
- 删除：上一轮浮层的 `#history-panel` DOM 与相关 CSS、`#history-close` 绑定、外部点击关闭逻辑。

### 3.2 历史数据

- `src/history.ts`：`recordHistory`（同 URL 1 分钟合并）、`getHistory`、`clearHistory`、`groupHistory`（今天/昨天/更早）、`hostOf`、时间格式化；上限 800 条。
- 埋点不变：`tabs.ts` `loadUrl` / `onNav` / `onTitle` + `open-link.ts` `doOpen` / 自动模式。

---

## 4. 内部打开自动切到对话界面（本次实施）

- `src/main.ts` `registerLinkOpener({ openInApp })`：
  ```
  openInApp: (url) => {
    tabManager.addTab("web", url);   // 默认 activate 新标签
    switchView("chat");              // 自动切到对话界面并显示新标签
  }
  ```
- 效果：在插件中心 / 设置 / 日志等任何视图点击链接并选择「在 App 内打开」→ 立即切到对话界面，网页标签已在激活态显示。
- `switchView` 已有逻辑：切到对话会调用 `tabManager.restoreActiveWebview()`，原生 webview 按当前激活标签正确显示。

---

## 5. 本次实施改动清单

| 文件 | 改动 |
|---|---|
| `014-*.md`（本文件） | 规划 + 盘点 |
| `src/tabs.ts` | `TabType` 加 `"history"`；`addTab("history")` 类型处理；`ensurePane` / `loadUrl` 渲染历史页；`restore`/`persist` 兼容；`newTabPageHtml` 可复用样式的本地页渲染 |
| `src/history.ts` | 新增 `renderHistoryPage`（整页布局：标题 + 清空 + 分组列表） |
| `src/main.ts` | 历史按钮移到 url-go 右侧；点击 → 复用/新建 history 标签 + `switchView("chat")`；删除浮层面板逻辑；`openInApp` 加 `switchView("chat")` |
| `index.html` | 历史按钮移位（url-go 后）；删除 `#history-panel`（DOM+CSS） |
| `src/i18n.ts` | 历史页文案（标题/清空/分组/空态）、按钮 title 复用 |
| 验证 | `npx tsc --noEmit`、`npm run build`、手动矩阵 §7 |

---

## 6. 以后待办（不入本轮）

- 交付 B：DSH 标签改原生 webview（§2.2）。
- 未完成项 §1 中 1–6：工作区/权限 UI、多模态、maka/reasonix（先确认身份）、gitee 镜像（等用户）、跨平台、打包发布。

---

## 7. 手动验证矩阵（实施后）

| # | 场景 | 预期 |
|---|---|---|
| 1 | 点地址栏最右历史按钮（无 history 标签） | 新建历史标签并激活，对话视图显示按天分组列表 |
| 2 | 再点一次（已有 history 标签） | 激活已有历史标签，不新建 |
| 3 | 历史页点某条记录 | 新开网页标签打开该网址并激活；历史标签保留 |
| 4 | 历史页「清空」 | 列表清空并显示空态文案 |
| 5 | 在插件中心点链接 → 选「在 App 内打开」 | 自动切到对话界面，新网页标签激活显示 |
| 6 | 网页标签内 `target=_blank` | 按设置弹选择框 / 直接执行，App 内打开时切对话视图 |
| 7 | 重新启动 app | 历史标签恢复（重新渲染当前历史数据） |
| 8 | 中/英切换 | 历史页文案跟随语言 |

---

> 本规划随实施同步更新；如实施中与现状冲突（以实际编译/运行结果为准），先记录偏差再继续。