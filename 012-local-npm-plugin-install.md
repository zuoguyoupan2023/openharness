# 012 · 插件中心：npm / GitHub / 本地插件 一体化 安装·更新·卸载

> 状态：✅ 已实施（本会话）。目标：让插件中心不止支持仓库索引里的 npm / github 插件，还能**安装本地 dsh 插件**（.tgz 或本地目录），并让**所有来源**都有「更新」按钮。
> 关键：Tauri 只是壳；所有「插件」都是 dsh 插件（Cordis 插件包），安装/更新/卸载全部走 `dsh plugin ...` CLI。本次**完全没有改 tauri 壳**（遵循 000 §0「纯插件定制不进壳，壳只管生命周期」）。

---

## 1. 现状盘点（动手前）

| 来源 | 安装 | 更新 | 卸载 | 现状 |
|------|------|------|------|------|
| **npm** | ✅ `dsh plugin add <pkg>` | ✅ `update <pkg>` | ✅ `remove <pkg>` | 开发已完成：registry 2467 条里 1807 条是 npm（占大多数），已有 npm registry 镜像设置（官方/npmmirror，`src/config.ts` + `main.rs` 注入 `npm_config_registry`） |
| **GitHub** | ✅ `add github:owner/repo` | ❌ **无更新按钮** | ✅ | 发布源仅显示「github」徽标；详情/列表里只对 npm 插件给更新按钮 |
| **本地** | ❌ **无入口** | ❌ | ✅（chips 有卸载） | `dsh plugin add file:./x.tgz / file:/abs` 底层一直支持，但 UI 完全没暴露 |

**唯一真实缺口**：① 本地插件没有安装入口；② github + 本地插件没有「更新」。

## 2. 方案取舍（关键决策）

初始尝试给 Tauri 加官方 `tauri-plugin-dialog`（原生文件/目录选择框），但：

- 它（经 `tauri-plugin-fs` / `rfd`）拉入 `time@0.3.55`、`plist@1.10`、`serde_with@3.22` 等**要求 rustc ≥ 1.88** 的传递依赖，而本机 toolchain 是 **rustc 1.86** → 无法编译；`cargo update --precise` 回垫多个 crate 脆弱且影响真实构建。
- 且加原生 dialog 属于「伸手改壳」，违反 000 §0。

**定稿**：**纯前端本地路径输入**，零新增 Rust 依赖、不动壳。`dsh plugin add file:<路径>` 本就支持相对/绝对路径、.tgz 或目录。用户粘贴/输入本地路径即可装。

## 3. 改动清单

| 文件 | 改动 |
|------|------|
| `src/plugins.ts` | `updateCommandFor()` 统一「更新」命令决策：npm→`update <pkg>`；github/file/link→重装同一 spec；`installLocalPlugin()` 读 `plugins-local-path` 输入 → `add file:<path>`；列表与详情「更新」按钮对**所有已装插件**显示（npm 升级、github/本地重装同一 spec）；已安装 chips 增「**更新**」↻ 按钮 |
| `index.html` | 操作行新增 `plugins-local-path` 输入框 + `plugins-install-local` 按钮；新增 `.local-path-input` 虚线下划线样式 |
| `src/i18n.ts` | 新增 `plugins.localInstall / localPathPlaceholder / localEmpty / localInstallFail / updateTo` |
| `scripts/extract-icons.mjs` + `src/icons.generated.ts` | 图标集补 `folder-open` |
| `package.json` + `package-lock.json` | 不新增 dialog；顺带修复既有 `terminal.ts` 引用的 4 个 xterm addon 缺失（原 node_modules 手动装、未进 package.json，会被 npm 清掉） |

未改：Rust 侧（Cargo.toml / main.rs / capabilities）**零改动**，保持原样。

## 4. 本地更新语义（用户确认）

本地目录/tgz 的「更新」= **重新执行 `dsh plugin add <同一 file: spec>`**（pnpm 重拉软链/重打包），再重启 DSH 生效。github 同理走重装同一 `github:owner/repo`。

## 5. 复用与边界

- 勾连复用：全部走既有 `runDshCmd(["plugin","--profile","web",...])` → `restartDsh()` → `loadInstalled()` 链路（`plugin-dangles` 悬软链修复、pnpm workspace-root 兼容等既有 Rust 逻辑照常生效）。
- 限界/未做（避免自我加码）：未做原生文件选择对话框（受 rustc 1.86 限制）；未做本地插件的 npm 版本比较显示（本地无 registry 语义）。

## 6. 验证

- `npx tsc --noEmit` ✅
- `npx vite build` ✅
- `grep plugin-dialog` Rust/npm/代码 零残留 ✅
- 运行时可见性验证（000 §9.4）：需在 app 里填本地路径 → 安装 → 观察日志「…add…✅ 完成，重启 DSH」→ 已安装 chips 出现该包。
