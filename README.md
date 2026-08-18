# OpenHarness: AgentBox for DSH, claudecode, codex and zcode.
OpenHarness是一个智能体盒子,用来容纳 Deepseek Harness, Claude code, Codex 还有Zcode这些智能体工具. OH不修改这些智能体的内部逻辑,而是做一个便捷的可视化工作空间.

把 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）Web UI 包装成 Mac 原生应用的桌面壳 —— 双击即用、内置多标签浏览、插件中心与国内镜像支持。

## 功能

- **多标签页 + 网址栏**：DSH 主界面 + 任意网页/搜索（阶段 1 iframe 池，阶段 2 计划升级原生 webview）
- **插件中心**：143+ 社区插件（[awesome-dsh-plugin](https://awesome-dsh-plugin.com) 索引）+ 官方组合包；安装 / 更新 / 卸载 / 重启生效
- **npm 镜像配置**：官方默认 / 淘宝 npmmirror / 自定义，npx + pnpm 全链路生效（国内加速）
- **日志视图**：DSH 启动日志实时流式展示，可重新启动
- **进程托管**：Rust 后端 spawn `npx --yes @deepseek-ai/dsh web`，端口探测防冲突，退出整组回收

## 开发

```bash
npm run tauri dev      # 开发（热重启）
npm run tauri build    # 打包 .app
```

## 文档

- [`001-summary.md`](001-summary.md) — 当前实现总结
- [`001-plan.md`](001-plan.md) — 迭代规划
- [`002-discussion.md`](002-discussion.md) — 讨论纪要 / 决策记录

## 环境要求

- macOS（Tauri v2 + wry）
- Node.js >= 22（DSH 依赖；首次启动自动 `npx` 下载 `@deepseek-ai/dsh`，国内可先在「设置」切镜像源）
