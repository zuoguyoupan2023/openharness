// src/i18n.ts —— 界面国际化（中 / 英）
// 约定：壳 UI 全部文案走 t() / data-i18n；日志与进程输出（appendLog、node 进度日志）属技术性文本，保持原文。
export type Lang = "zh" | "en";

const STORAGE_KEY = "oh-lang";
export const LANGS: Lang[] = ["zh", "en"];

type Entry = { zh: string; en: string };

const DICT: Record<string, Entry> = {
  // ===== 侧边栏 =====
  "nav.chat": { zh: "对话", en: "Chat" },
  "nav.logs": { zh: "日志", en: "Logs" },
  "nav.plugins": { zh: "插件", en: "Plugins" },
  "nav.settings": { zh: "设置", en: "Settings" },
  "sidebar.toggle": { zh: "折叠/展开侧边栏 (⌘B)", en: "Collapse/expand sidebar (⌘B)" },
  "sidebar.status.starting": { zh: "DSH 启动中…", en: "DSH starting…" },
  "theme.toggle": { zh: "切换浅色/深色主题", en: "Toggle light/dark theme" },
  "lang.toggle": { zh: "切换语言（中/英）", en: "Switch language (EN/ZH)" },

  // ===== 状态（main.ts setStatus）=====
  "status.starting": { zh: "启动中，等待服务就绪…", en: "Starting, waiting for service…" },
  "status.running": { zh: "DSH 运行中", en: "DSH running" },
  "status.error": {
    zh: "启动失败，请检查 Node.js (≥22.15) 与网络；可在「设置」查看 Node 环境",
    en: "Startup failed. Check Node.js (≥22.15) and network; see Settings → Node environment",
  },
  "status.exit": { zh: "DSH 已退出，可在日志页点击重新启动", en: "DSH exited. Restart from the Logs page" },
  "status.external": { zh: "DSH 运行中", en: "DSH running" },

  // ===== 标签 / 网址栏 =====
  "tab.new": { zh: "新建标签页", en: "New tab" },
  "tab.close": { zh: "关闭标签", en: "Close tab" },
  "url.back": { zh: "后退", en: "Back" },
  "url.fwd": { zh: "前进", en: "Forward" },
  "url.reload": { zh: "刷新", en: "Reload" },
  "url.home": { zh: "新标签页主页", en: "Home / new tab" },
  "url.go": { zh: "前往", en: "Go" },
  "url.placeholder": {
    zh: "输入网址或搜索内容，回车前往…",
    en: "Type a URL or search, press Enter…",
  },

  // ===== 对话视图 =====
  "chat.waiting": { zh: "正在启动 DeepSeek Harness，请稍候…", en: "Starting DeepSeek Harness, please wait…" },
  "chat.waitingHint": { zh: "可在左侧「日志」查看启动进度", en: "See Logs on the left for startup progress" },
  "newtab.title": { zh: "新标签页", en: "New Tab" },
  "newtab.sub": { zh: "在网址栏输入网址，或直接搜索；常用入口：", en: "Type a URL or search in the address bar. Quick links:" },
  "link.dsh": { zh: "DeepSeek Harness 主界面", en: "DeepSeek Harness home" },
  "link.npm": { zh: "npm 官网", en: "npm" },
  "link.github": { zh: "GitHub", en: "GitHub" },
  "link.repo": { zh: "DeepSeek-Harness 仓库", en: "DeepSeek-Harness repo" },
  "link.awesome": { zh: "awesome-dsh-plugin", en: "awesome-dsh-plugin" },
  "link.docs": { zh: "DSH 插件开发文档", en: "DSH plugin dev docs" },
  "tab.untitled": { zh: "新标签页", en: "New tab" },

  // ===== 日志视图 =====
  "logs.initial1": { zh: "正在初始化 DSH 环境...", en: "Initializing DSH environment..." },
  "logs.initial2": {
    zh: "首次运行会自动下载依赖，请耐心等待；国内网络慢可在「设置」切换淘宝镜像源。",
    en: "First run downloads dependencies. If the network is slow, switch to the npmmirror registry in Settings.",
  },
  "logs.retry": { zh: "重新启动", en: "Restart" },
  "term.log.tab": { zh: "DSH 日志", en: "DSH Log" },
  "term.add": { zh: "新增终端", en: "New terminal" },
  "term.close": { zh: "关闭终端", en: "Close terminal" },
  "term.shell.tab": { zh: "终端 {n}", en: "Terminal {n}" },
  "term.clearLog": { zh: "清空", en: "Clear" },
  "term.spawnFail": {
    zh: "❌ 启动 shell 终端失败：{err}",
    en: "❌ Failed to start shell terminal: {err}",
  },
  "term.spawned": { zh: "shell 终端已启动", en: "Shell terminal started" },
  "term.exited": {
    zh: "（进程已退出，代码 {code}）",
    en: "(process exited, code {code})",
  },
  "agent.title": { zh: "启动智能体", en: "Launch agent" },
  "agent.menu.head": { zh: "智能体", en: "Agents" },
  "agent.installed": { zh: "已装", en: "OK" },
  "agent.notInstalled": { zh: "未装", en: "Not installed" },
  "agent.empty": { zh: "（正在检测…）", en: "(detecting…)" },
  "agent.foot": {
    zh: "点「已装」直接在新终端启动；未安装的暂不支持自动安装（规划中）",
    en: "Click an installed agent to launch it in a new terminal; installing missing ones is planned.",
  },
  "agent.launchFail": {
    zh: "❌ 启动智能体失败：{err}",
    en: "❌ Failed to launch agent: {err}",
  },

  // ===== 推荐链接（侧边栏底部角落，低调不打扰）=====
  "referral.title": {
    zh: "邀请好友：彼此各得 $5 使用额度",
    en: "Invite friends: you each get $5 credit",
  },

  // ===== 插件中心 =====
  "plugins.title": { zh: "插件中心", en: "Plugin Center" },
  "plugins.titleBadge": {
    zh: "安装 / 更新 / 卸载 / 重启生效 · 插件配置在 dsh web 内完成",
    en: "Install / Update / Remove / restart to apply · plugin config lives in dsh web",
  },
  "plugins.refresh": { zh: "刷新插件索引", en: "Refresh index" },
  "plugins.search": { zh: "搜索插件名称 / 描述…", en: "Search plugins by name / description…" },
  "plugins.installedTitle": { zh: "已安装（web profile）", en: "Installed (web profile)" },
  "plugins.officialTitle": { zh: "官方组合包", en: "Official bundles" },
  "plugins.officialBadge": { zh: "@deepseek-ai 核心包", en: "@deepseek-ai core packages" },
  "plugins.communityTitle": { zh: "插件市场（精选 + GitHub Topic）", en: "Plugin market (curated + GitHub topic)" },
  "plugins.loading": { zh: "正在获取插件索引…", en: "Fetching plugin index…" },
  "plugins.allCat": { zh: "全部", en: "All" },
  "plugins.fetching": { zh: "正在获取插件索引…", en: "Fetching plugin index…" },
  "plugins.fetchingShort": { zh: "获取中…", en: "Fetching…" },
  "plugins.fetchFail": {
    zh: "获取插件索引失败：{err}（请检查网络）",
    en: "Failed to fetch plugin index: {err} (check network)",
  },
  "plugins.actDone": { zh: "{label} 完成，正在重启 DSH 使插件生效…", en: "{label} done, restarting DSH to apply…" },
  "plugins.actRestarted": { zh: "DSH 已重启，插件已生效", en: "DSH restarted, plugins applied" },
  "plugins.actFail": { zh: "{label} 失败: ", en: "{label} failed: " },
  "plugins.noMatch": { zh: "没有匹配的插件", en: "No matching plugins" },
  "plugins.emptyInstalled": {
    zh: "暂无已安装插件（profile 未初始化）",
    en: "No plugins installed yet (profile not initialized)",
  },
  "plugins.installedTag": { zh: "已安装", en: "Installed" },
  "plugins.latestTag": { zh: "最新", en: "Latest" },
  "plugins.updateTag": { zh: "可更新", en: "Update available" },
  "plugins.badgeUpdates": { zh: "{n} 个插件可更新", en: "{n} plugin updates available" },
  "plugins.detail.hint": { zh: "点击查看详情", en: "Click for details" },
  "plugins.detail.loading": { zh: "正在获取详情…", en: "Fetching details…" },
  "plugins.detail.fail": { zh: "获取详情失败（网络不可用）", en: "Failed to fetch details (network unavailable)" },
  "plugins.detail.installSpec": { zh: "安装规格", en: "Install spec" },
  "plugins.detail.nonNpm": {
    zh: "该插件来自非 npm 源（{spec}），无 npm 元数据；可点击上方仓库链接查看。",
    en: "Non-npm source ({spec}); no npm metadata available. Open the repo link above.",
  },
  "plugins.detail.latest": { zh: "最新版本", en: "Latest" },
  "plugins.detail.author": { zh: "作者", en: "Author" },
  "plugins.detail.license": { zh: "许可证", en: "License" },
  "plugins.detail.updated": { zh: "最近发布", en: "Released" },
  "plugins.detail.stars": { zh: "Stars", en: "Stars" },
  "plugins.detail.category": { zh: "分类", en: "Category" },
  "plugins.detail.versionHistory": { zh: "版本历史", en: "Version history" },
  "plugins.detail.deps": { zh: "依赖", en: "Dependencies" },
  "plugins.detail.noDeps": { zh: "无依赖", en: "No dependencies" },
  "plugins.detail.noHistory": { zh: "无版本历史", en: "No version history" },
  "plugins.detail.readme": { zh: "README", en: "README" },
  "plugins.detail.noReadme": { zh: "该包未提供 README", en: "No README provided" },
  "plugins.install": { zh: "安装", en: "Install" },
  "plugins.update": { zh: "更新", en: "Update" },
  "plugins.remove": { zh: "卸载", en: "Remove" },
  "plugins.chipLocal": { zh: "本地", en: "local" },
  "plugins.updateTo": { zh: "更新到", en: "Update to" },
  "plugins.localInstall": { zh: "安装本地", en: "Install local" },
  "plugins.addFromLabel": { zh: "从其它来源添加", en: "Add from another source" },
  "plugins.localPickDir": { zh: "选择要安装的 dsh 插件目录", en: "Choose the dsh plugin directory to install" },
  "plugins.localPathPlaceholder": { zh: "本地插件：/abs/plugin.tgz 或 ./本地目录", en: "Local plugin: /abs/plugin.tgz or ./my-plugin" },
  "plugins.localEmpty": { zh: "请先填写本地插件路径", en: "Enter a local plugin path first" },
  "plugins.localInstallFail": { zh: "本地插件安装失败: {err}", en: "Local plugin install failed: {err}" },
  "plugins.npmSearchPlaceholder": { zh: "按 npm 包名搜索并一键安装，如 dsh-theme-center", en: "Search & install by npm package name, e.g. dsh-theme-center" },
  "plugins.npmSearching": { zh: "正在搜索 npm …", en: "Searching npm…" },
  "plugins.npmNoResult": { zh: "npm 上未找到匹配的包", en: "No matching npm package found" },
  "plugins.npmSearchFail": { zh: "npm 搜索失败: {err}", en: "npm search failed: {err}" },
  "plugins.retry": { zh: "重试", en: "Retry" },
  "plugins.versionRetry": { zh: "版本获取失败，点击重试", en: "Version fetch failed, click to retry" },
  "plugins.versionFetchFail": { zh: "版本获取失败，请检查网络", en: "Failed to fetch version, check network" },
  "plugins.versionFetched": { zh: "已获取 {pkg}@{v}", en: "Fetched {pkg}@{v}" },
  "plugins.col.name": { zh: "插件", en: "Plugin" },
  "plugins.col.version": { zh: "版本", en: "Version" },
  "plugins.col.status": { zh: "状态", en: "Status" },
  "plugins.col.desc": { zh: "描述", en: "Description" },
  "plugins.col.stars": { zh: "★ Stars", en: "★ Stars" },
  "plugins.col.source": { zh: "来源", en: "Source" },
  "plugins.official.base": { zh: "官方基础组合包（框架核心）", en: "Official base bundle (framework core)" },
  "plugins.official.web": { zh: "官方 Web 应用组合包", en: "Official web app bundle" },
  "plugins.official.headless": { zh: "官方 headless 组合包", en: "Official headless bundle" },
  "plugins.official.llm": { zh: "DeepSeek LLM 接入插件", en: "DeepSeek LLM adapter plugin" },

  // ===== 006 双数据源 / 来源 tabs / 秒开 =====
  "plugins.source.awesome": { zh: "社区精选", en: "Curated" },
  "plugins.source.topic": { zh: "GitHub Topic", en: "GitHub Topic" },
  "plugins.source.all": { zh: "全部（合并）", en: "All (merged)" },
  "plugins.src.awesome": { zh: "精选", en: "Curated" },
  "plugins.src.topic": { zh: "Topic", en: "Topic" },
  "plugins.src.awesomeTip": { zh: "由 awesome-dsh-plugin 人工精选", en: "Curated by awesome-dsh-plugin" },
  "plugins.src.topicTip": { zh: "来自 GitHub dsh-plugin 主题市场（自动过滤，人工未逐条审核）", en: "From the GitHub dsh-plugin topic market (auto-filtered, not manually reviewed)" },
  "plugins.topicCat.web-ui": { zh: "Web UI", en: "Web UI" },
  "plugins.topicCat.tool": { zh: "工具", en: "Tools" },
  "plugins.topicCat.agent": { zh: "Agent", en: "Agent" },
  "plugins.topicCat.coding": { zh: "编程", en: "Coding" },
  "plugins.topicCat.vision": { zh: "视觉", en: "Vision" },
  "plugins.topicCat.memory": { zh: "记忆", en: "Memory" },
  "plugins.topicCat.conversation": { zh: "对话", en: "Conversation" },
  "plugins.topicCat.notify": { zh: "通知", en: "Notify" },
  "plugins.topicCat.model": { zh: "模型", en: "Model" },
  "plugins.topicCat.document": { zh: "文档", en: "Document" },
  "plugins.topicCat.resource": { zh: "资源", en: "Resource" },
  "plugins.topicCat.other": { zh: "其它", en: "Other" },
  "plugins.snapshot.updated": { zh: "索引已刷新：{n} 条变化", en: "Index refreshed: {n} changed" },
  "plugins.snapshot.added": { zh: "新增 {n}", en: "+{n} new" },
  "plugins.snapshot.changed": { zh: "更新 {n}", en: "~{n} updated" },
  "plugins.snapshot.fail": { zh: "索引刷新失败，展示{src}快照（{at}）", en: "Index refresh failed; showing {src} snapshot ({at})" },
  "plugins.snapshot.dismiss": { zh: "关闭", en: "Dismiss" },
  "plugins.snapshot.src.bundle": { zh: "打包", en: "bundled" },
  "plugins.snapshot.src.cache": { zh: "上次缓存", en: "cached" },
  "plugins.snapshot.src.cdn": { zh: "最新", en: "live" },

  // ===== P0 交互（动作队列 / 状态条 / 卸载确认 / 更新语义） =====
  "plugins.status.busy": { zh: "{label}执行中…", en: "{label} running…" },
  "plugins.status.done": { zh: "{label}完成", en: "{label} done" },
  "plugins.confirmRemove": { zh: "确认卸载", en: "Confirm remove" },
  "plugins.confirmRemoveHint": { zh: "再次点击确认卸载；点击其它位置或按 Esc 取消", en: "Click again to remove; click elsewhere or press Esc to cancel" },
  "plugins.cancel": { zh: "取消", en: "Cancel" },
  "plugins.reinstall": { zh: "重新安装", en: "Reinstall" },
  "plugins.alreadyLatest": { zh: "已是最新", en: "Up to date" },
  "plugins.updateAll": { zh: "全部更新（{n}）", en: "Update all ({n})" },
  "plugins.updatingAll": { zh: "正在批量更新 {i}/{n}…", en: "Updating {i}/{n}…" },
  "plugins.updateAllDone": { zh: "全部更新完成，DSH 已重启", en: "All updated, DSH restarted" },
  "plugins.updateAllFail": { zh: "{n} 项更新失败，其余已完成并重启 DSH", en: "{n} failed; the rest updated and DSH restarted" },
  "plugins.loadMore": { zh: "滚动加载更多…", en: "Scroll to load more…" },
  "plugins.loadAll": { zh: "已全部加载（共 {n} 条）", en: "All loaded ({n} total)" },

  // ===== P1 信息架构（主 tabs / 二级视图 / 筛选 / 排序 / 推荐 / 本地 / npm 键盘） =====
  "plugins.tab.github": { zh: "GitHub", en: "GitHub" },
  "plugins.tab.npm": { zh: "npm", en: "npm" },
  "plugins.tab.local": { zh: "本地", en: "Local" },
  "plugins.githubView.awesome": { zh: "awesome", en: "awesome" },
  "plugins.githubView.topics": { zh: "topics", en: "topics" },
  "plugins.githubView.all": { zh: "全部", en: "All" },
  "plugins.githubView.recommended": { zh: "特别推荐", en: "Recommended" },
  "plugins.recommendedBadge": { zh: "特别推荐", en: "Recommended" },
  "plugins.recommended.reason.reader": { zh: "工作区文件浏览 / 编辑 / Markdown 预览，与高亮插件联动", en: "Workspace file browse / edit / Markdown preview, pairs with the highlight plugin" },
  "plugins.recommended.reason.replyInCn": { zh: "强制简体中文回复，中文用户开箱即用", en: "Forces Simplified Chinese replies, ready for Chinese users" },
  "plugins.recommended.reason.ruleForDsh": { zh: "给开发 dsh 插件的用户注入官方开发规范", en: "Injects official dsh plugin development rules" },
  "plugins.recommended.reason.coreRule": { zh: "注入核心工作铁律（分阶段 / 先问 / UI 优先）", en: "Injects core working rules (phased / ask first / UI first)" },
  "plugins.recommended.reason.adhd": { zh: "DSH Web 词性高亮，配色清晰", en: "Part-of-speech highlighting in DSH Web, crisp colors" },
  "plugins.filter.all": { zh: "全部", en: "All" },
  "plugins.filter.installed": { zh: "已安装", en: "Installed" },
  "plugins.filter.updatable": { zh: "可更新", en: "Updatable" },
  "plugins.filter.notInstalled": { zh: "未安装", en: "Not installed" },
  "plugins.sort.default": { zh: "默认", en: "Default" },
  "plugins.sort.stars": { zh: "Stars", en: "Stars" },
  "plugins.sort.updated": { zh: "最近更新", en: "Recently updated" },
  "plugins.sort.name": { zh: "名称", en: "Name" },
  "plugins.indexInfo": { zh: "索引：{src} · {at} · 共 {n} 条", en: "Index: {src} · {at} · {n} entries" },
  "plugins.searchGithub": { zh: "搜索 GitHub 插件…", en: "Search GitHub plugins…" },
  "plugins.searchNpm": { zh: "按 npm 包名搜索并一键安装，如 dsh-theme-center", en: "Search & install by npm package name, e.g. dsh-theme-center" },
  "plugins.searchLocal": { zh: "本地插件路径：/abs/plugin.tgz 或 ./本地目录，Enter 安装", en: "Local plugin path: /abs/plugin.tgz or ./my-plugin, Enter to install" },
  "plugins.officialQuick": { zh: "⚡ 官方组合包", en: "⚡ Official bundles" },
  "plugins.npmSearchGo": { zh: "搜索", en: "Search" },
  "plugins.localPickDirShort": { zh: "选择目录", en: "Pick folder" },
  "plugins.localPickTgz": { zh: "选择 .tgz", en: "Pick .tgz" },
  "plugins.localEmptyInline": { zh: "请先输入本地插件路径，或点击「选择目录 / 选择 .tgz」", en: "Enter a local plugin path, or pick a folder / .tgz first" },
  "plugins.localInvalidPath": { zh: "路径无效：{path}", en: "Invalid path: {path}" },
  "plugins.localInstalledTitle": { zh: "本地已安装（file:/link:）", en: "Installed locally (file:/link:)" },
  "plugins.localInstalledEmpty": { zh: "暂无本地安装的插件", en: "No locally installed plugins" },
  "plugins.npmInstalledLatest": { zh: "已安装 · 最新", en: "Installed · up to date" },
  "plugins.npmUpdateTo": { zh: "更新到 {v}", en: "Update to {v}" },
  "plugins.chipJumpHint": { zh: "点击定位到对应来源并展开详情", en: "Jump to its source & open details" },

  // ===== 设置 =====
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.registry.title": { zh: "npm 镜像源", en: "npm registry" },
  "settings.registry.desc": {
    zh: "影响首次下载 DSH 与安装插件（npx / pnpm 全链路生效）。已缓存的包不受影响；镜像对新发布包的同步可能有几分钟延迟，若安装报 404 可到 npmmirror.com/sync 手动触发同步。",
    en: "Affects first-time DSH download and plugin installs (npx / pnpm). Cached packages are unaffected; mirrors may lag a few minutes for new releases — if install 404s, trigger a sync at npmmirror.com/sync.",
  },
  "settings.registry.optOfficial": { zh: "官方默认（registry.npmjs.org）", en: "Official default (registry.npmjs.org)" },
  "settings.registry.optMirror": { zh: "淘宝 npmmirror（国内加速，推荐）", en: "npmmirror (faster in China, recommended)" },
  "settings.registry.optCustom": { zh: "自定义：", en: "Custom:" },
  "settings.registry.save": { zh: "保存", en: "Save" },
  "settings.registry.saved": {
    zh: "✓ 已保存（对之后的新下载生效；已运行的 DSH 重启后生效）",
    en: "Saved (applies to new downloads; running DSH needs a restart)",
  },
  "settings.registry.errUrl": { zh: "⚠️ 请输入以 http(s):// 开头的镜像地址", en: "Enter a mirror URL starting with http(s)://" },
  "settings.registry.errSave": { zh: "⚠️ 保存失败：", en: "Save failed: " },
  "settings.node.title": { zh: "Node.js 环境", en: "Node.js environment" },
  "settings.node.desc": {
    zh: "DSH 依赖 Node.js（≥22.15，node:zlib zstd）+ npx。未安装时可让应用自动下载官方 / 淘宝 npmmirror / 清华 TUNA 的预编译包并内置到应用数据目录（无需 sudo，不污染系统）。",
    en: "DSH requires Node.js (≥22.15, node:zlib zstd) + npx. If missing, the app can auto-download a prebuilt bundle from official / npmmirror / TUNA into the app data dir (no sudo, no system pollution).",
  },
  "settings.node.recheck": { zh: "重新检测 Node", en: "Re-check Node" },
  "settings.node.reinstall": { zh: "重新下载安装 Node", en: "Re-download & install Node" },
  "settings.dsh.title": { zh: "DSH 服务", en: "DSH service" },
  "settings.dsh.desc": {
    zh: "重启 DSH 使插件安装 / 卸载 / 更新及镜像配置生效（对话中的会话会中断）。",
    en: "Restart DSH to apply plugin installs / removals / updates and registry config (active sessions will be interrupted).",
  },
  "settings.dsh.closeLabel": {
    zh: "关闭 app 时同时关闭 3080 上的 DSH 服务（默认开启，即 3080 跟随 app 开关机）。",
    en: "Also shut down DSH on :3080 when the app quits (on by default — DSH follows the app).",
  },
  "settings.dsh.closeSub": {
    zh: "如果你习惯自己在终端里启动 DSH，可关闭此项：app 退出后 DSH 继续运行。",
    en: "If you run DSH yourself in a terminal, turn this off so DSH keeps running after the app quits.",
  },
  "settings.dsh.restart": { zh: "重启 DSH", en: "Restart DSH" },
  "settings.dsh.savedOn": { zh: "✓ 已保存：3080 将随 app 一起关闭", en: "Saved: DSH will quit with the app" },
  "settings.dsh.savedOff": { zh: "✓ 已保存：3080 将不随 app 关闭（退出后 DSH 继续运行）", en: "Saved: DSH keeps running after the app quits" },
  "settings.dsh.restarting": { zh: "正在重启 DSH…", en: "Restarting DSH…" },
  "settings.dsh.restarted": { zh: "✓ DSH 已重启", en: "DSH restarted" },
  "settings.appearance.title": { zh: "外观", en: "Appearance" },
  "settings.appearance.desc": {
    zh: "切换界面浅色 / 深色主题。对话标签内的网页内容由 DSH 自身控制，不随此切换。",
    en: "Switch the shell between light / dark themes. Web content inside tabs follows DSH itself, not this toggle.",
  },
  "settings.appearance.system": { zh: "跟随系统", en: "Follow system" },
  "settings.appearance.light": { zh: "亮色", en: "Light" },
  "settings.appearance.dark": { zh: "暗色", en: "Dark" },
  "settings.lang.title": { zh: "语言", en: "Language" },
  "settings.lang.desc": { zh: "界面语言切换（日志与进程输出保持原文）。", en: "UI language (logs and process output stay as-is)." },

  // ===== 插件索引源（006 双数据源后台刷新取源） =====
  "settings.pluginIndex.title": { zh: "插件索引源", en: "Plugin index source" },
  "settings.pluginIndex.desc": {
    zh: "插件中心后台刷新 registry 的取源。默认自动（gitee 镜像 → jsdelivr CDN → GitHub raw 并发取最新者，规避 jsdelivr 缓存滞后）；gitee 国内最快但需自建镜像仓库并同步，jsdelivr 国内较快、零维护，GitHub raw 更新最及时；自建镜像填完整 URL。",
    en: "Where the plugin center fetches the registry for background refresh. Auto = gitee mirror → jsdelivr CDN → GitHub raw, newest wins (avoids jsdelivr CDN lag); gitee is fastest in China but needs a self-hosted mirror with sync, jsdelivr is faster in China & zero-maintenance, raw is freshest; custom = your mirror URL.",
  },
  "settings.pluginIndex.auto": { zh: "自动（gitee → jsdelivr → GitHub raw，取最新）", en: "Auto (gitee → jsdelivr → GitHub raw, newest wins)" },
  "settings.pluginIndex.gitee": { zh: "gitee 镜像（国内最快，需自建镜像并同步）：", en: "gitee mirror (fastest in China, self-host & sync):" },
  "settings.pluginIndex.jsdelivr": { zh: "jsdelivr CDN（国内快，零维护）", en: "jsdelivr CDN (faster in China, zero-maintenance)" },
  "settings.pluginIndex.raw": { zh: "GitHub raw（最新，国内可能慢）", en: "GitHub raw (freshest, may be slow in China)" },
  "settings.pluginIndex.optCustom": { zh: "自定义镜像：", en: "Custom mirror:" },
  "settings.pluginIndex.note": {
    zh: "改动立即生效：下次刷新插件索引即按此取源；打包快照始终离线秒开、不受影响。",
    en: "Applies immediately: the next index refresh fetches per this setting; the bundled snapshot stays instant & offline regardless.",
  },

  // ===== Node 环境准备向导 =====
  "wizard.title": { zh: "Node.js 环境准备", en: "Node.js Setup" },
  "wizard.badge": { zh: "DSH 需要 Node.js ≥ 22.15 + npx", en: "DSH requires Node.js ≥ 22.15 + npx" },
  "wizard.status": { zh: "检测中…", en: "Checking…" },
  "wizard.sourceTitle": {
    zh: "选择下载源（下载太慢或失败可换源重试；自动模式会依次回退）：",
    en: "Choose a download source (switch if too slow / failing; auto mode falls back in order):",
  },
  "wizard.auto": { zh: "自动回退（官方 → 淘宝 npmmirror → 清华 TUNA）", en: "Auto fallback (official → npmmirror → TUNA)" },
  "wizard.official": { zh: "官方 nodejs.org", en: "Official nodejs.org" },
  "wizard.npmmirror": { zh: "淘宝 npmmirror（国内加速，推荐）", en: "npmmirror (faster in China, recommended)" },
  "wizard.tuna": { zh: "清华 TUNA（同步滞后，使用其已同步的 v22 版本）", en: "Tsinghua TUNA (lagged sync; uses its synced v22)" },
  "wizard.install": { zh: "下载并安装 Node.js", en: "Download & install Node.js" },
  "wizard.recheck": { zh: "重新检测", en: "Re-check" },

  // ===== 启动 / Node 流程（main.ts）=====
  "app.startLog": { zh: "正在启动 DeepSeek Harness...", en: "Starting DeepSeek Harness..." },
  "app.startErr": { zh: "启动出错: ", en: "Startup error: " },
  "node.checking": { zh: "检测中…", en: "Checking…" },
  "node.ready": { zh: "Node.js {v} 已就绪，正在启动 DSH...", en: "Node.js {v} ready, starting DSH…" },
  "node.installed": { zh: "Node.js {v} 安装成功（{path}）", en: "Node.js {v} installed ({path})" },
  "node.autoInstall": {
    zh: "正在启动 DSH（自动预装高亮插件 adhdgofly-dsh-ext，就绪后自动打开对话标签）...",
    en: "Starting DSH (auto-installing adhdgofly-dsh-ext; opens the chat tab when ready)…",
  },
  "node.downloading": { zh: "开始下载 Node.js...", en: "Downloading Node.js…" },
  "node.errDownload": { zh: "下载出错: ", en: "Download failed: " },
  "node.fail": { zh: "检测失败: ", en: "Check failed: " },
  "node.failHint": {
    zh: "可切换「淘宝 npmmirror / 清华 TUNA」源后重试，或先手动安装 Node.js。",
    en: "Switch to the npmmirror / TUNA source and retry, or install Node.js manually.",
  },
  "node.reinstallHint": {
    zh: "选择下载源后点击「下载并安装 Node.js」。若已内置旧版本，将被替换为新版本。",
    en: "Choose a source, then click \"Download & install Node.js\". If an older bundled version exists, it will be replaced.",
  },
  "node.checkFail": { zh: "无法检测 Node 环境: ", en: "Cannot check Node environment: " },
  "app.dshReadyLog": { zh: "DSH 就绪: ", en: "DSH ready: " },
  "app.dshExited": { zh: "DSH 进程已退出", en: "DSH process exited" },
  "app.externalDetected": { zh: "检测到外部 DSH 已在 3080 运行，直接连接", en: "External DSH detected on :3080, connecting directly" },
};

let lang: Lang = "zh";

export function getLang(): Lang {
  return lang;
}

/** 取当前语言文案；支持 {name} 占位符替换 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const e = DICT[key];
  let s = e ? e[lang] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

export function setLang(l: Lang): void {
  lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l === "zh" ? "zh" : "en";
  applyI18n();
  window.dispatchEvent(new Event("lang-changed"));
}

/** 把 data-i18n / data-i18n-title / data-i18n-placeholder 元素更新为当前语言 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n || "");
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle || "");
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const input = el as HTMLInputElement;
    input.placeholder = t(input.dataset.i18nPlaceholder || "");
  });
}

export function initLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved === "zh" || saved === "en") lang = saved;
  } catch {
    lang = "zh";
  }
  document.documentElement.lang = lang === "zh" ? "zh" : "en";
  applyI18n();
  return lang;
}
