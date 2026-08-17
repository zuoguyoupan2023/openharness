// src/main.ts —— OpenHarness 应用入口
import {
  initDsh,
  onLog,
  onReady,
  onExit,
  startDsh,
  termSpawn,
  termWrite,
  termResize,
  termKill,
  agentList,
  agentSpawn,
  onTermOutput,
  onTermExit,
  onTermInputDebug,
} from "./dsh";
import { TabManager } from "./tabs";
import { initPlugins } from "./plugins";
import { initSettings } from "./settings";
import { TermManager } from "./terminal";
import {
  checkNode,
  downloadNode,
  initNodeEvents,
  onNodeFail,
  onNodeProgress,
  onNodeReady,
  progressPercent,
} from "./node";
import { mountIcons, iconSvg } from "./icons";
import { initLang, setLang, getLang, t } from "./i18n";
import { initTheme, cycleTheme, effectiveTheme, getThemePref } from "./theme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { startDshSettingsSync, pushPref } from "./dsh-settings";
import { registerLinkOpener, openLink } from "./open-link";
import { recordDownloadStart, markDownloadEnd } from "./downloads";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** 简单 HTML 转义（避免把用户/工具名拼进 innerHTML 时注入） */
function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 模块级引用：switchView 切换视图时联动原生 webview 显隐 */
let tabManager: TabManager;

/** 模块级引用：多终端管理器（DSH 日志只读终端 + 可交互 shell 终端） */
let terms: TermManager | null = null;

/** DSH 日志终端 id（固定只读终端） */
const LOG_TERM_ID = "dsh-log";

function appendLog(msg: string): void {
  // DSH 进程输出统一灌进「DSH 日志」只读终端（终端内渲染，支持 ANSI）
  terms?.feedLine(LOG_TERM_ID, msg);
}

function setStatus(state: string, text: string): void {
  $("side-dot").className = "dot " + state;
  $("indicator").className = "dot " + state;
  $("side-status").textContent = text;
  $("status-text").textContent = text;
}

function switchView(name: string): void {
  document.querySelectorAll<HTMLElement>(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  document.querySelectorAll<HTMLElement>(".view").forEach((v) => {
    v.classList.toggle("active", v.id === "view-" + name);
  });
  if (tabManager) {
    if (name === "chat") tabManager.restoreActiveWebview();
    else tabManager.hideAllWebviews();
  }
  // 切换到日志/终端视图时重算各 xterm 尺寸
  if (name === "logs") terms?.fit();
}

async function launch(): Promise<void> {
  appendLog(t("app.startLog"));
  setStatus("waiting", t("status.starting"));
  try {
    appendLog(await startDsh());
  } catch (e) {
    appendLog(t("app.startErr") + String(e));
    setStatus("error", t("status.error"));
  }
}

// ===== 多终端（DSH 日志只读终端 + 可交互 shell 终端）=====
function initTerminalPanel(): void {
  terms = new TermManager($("term-stack"), $("term-tabs"), {
    // shell 终端输入 → 转发到对应 shell 子进程 PTY 主设备
    onShellInput(id, data) {
      void termWrite(id, data).catch(() => {
        terms?.markExited(
          id,
          "\x1b[31m（写入 shell PTY 失败）\x1b[0m"
        );
      });
    },
    // shell 终端渲染尺寸变化（含 fit）→ 同步回发 PTY，让 vim/top 自适应
    onShellResize(id, rows, cols) {
      void termResize(id, rows, cols).catch(() => {});
    },
    // 关闭按钮 → 杀掉子进程并移除 UI
    onCloseShell(id) {
      void termKill(id).catch(() => {});
      terms?.closeShell(id);
    },
    // 点击终端输出中的 URL → 按用户设置的链接打开方式处理
    onWebLink(uri) {
      void openLink(uri);
    },
  });

  // 默认固定一个 DSH 日志只读终端
  terms.ensureLog(LOG_TERM_ID, t("term.log.tab"));
  // 兜底初始提示（若 DSH 尚未开始输出，让日志终端不至于空白）
  terms.feedLine(LOG_TERM_ID, t("logs.initial1"));
  terms.feedLine(LOG_TERM_ID, t("logs.initial2"));

  // shell 进程输出事件 → 灌回对应终端
  onTermOutput(({ id, data }) => {
    // 忽略 DSH 日志终端的 shell 事件（日志走 dsh-log），只处理 shell 终端 id
    if (id !== LOG_TERM_ID) terms?.feed(id, data);
  });
  // shell 进程退出事件 → 标记终端为已退出
  onTermExit(({ id, data }) => {
    if (id !== LOG_TERM_ID) {
      terms?.markExited(id, t("term.exited", { code: data }));
    }
  });

  // 【调试】把前端收到的每段输入以可见形式打到 DSH 日志终端，排查方向键/escape 是否到达后端
  onTermInputDebug(({ data }) => {
    terms?.feedLine(LOG_TERM_ID, "[key] " + data);
  });

  // 「+」新增 shell 终端
  $("term-add").addEventListener("click", async () => {
    const id = terms?.nextShellId() ?? `shell-${Date.now()}`;
    terms?.newShell(id, t("term.shell.tab", { n: id.slice(id.indexOf("-") + 1) }));
    // 用 xterm 实际尺寸作为 PTY 初始尺寸，保证 vim/top 首帧对齐
    const { rows, cols } = terms?.getSize(id) ?? { rows: 24, cols: 80 };
    try {
      appendLog(await termSpawn(id, rows, cols));
    } catch (e) {
      // spawn 失败：在终端里提示并关闭该标签
      terms?.feed(id, t("term.spawnFail", { err: String(e) }) + "\r\n");
      terms?.markExited(id, "");
      terms?.closeShell(id);
      appendLog(t("term.spawnFail", { err: String(e) }));
    }
  });

  // 清空：清空当前激活的终端（含 DSH 日志）
  $("logs-clear").addEventListener("click", () => {
    const act = terms?.getActive();
    if (act) terms?.clear(act);
  });

  initAgentLauncher();
}

// ===== 智能体启动器（L1：检测 + 一键启动）=====
function initAgentLauncher(): void {
  const btn = document.getElementById("agent-btn");
  const menu = document.getElementById("agent-menu");
  const list = document.getElementById("agent-menu-list");
  const foot = document.getElementById("agent-menu-foot");
  // DOM 缺任一元素（旧 bundle / 打包不一致）时不崩溃，静默跳过该功能
  if (!btn || !menu || !list || !foot) {
    console.warn("agent launcher DOM missing, skip init");
    return;
  }

  // 关闭其它区域的点击穿透
  const close = () => {
    menu.hidden = true;
    btn.classList.remove("is-open");
  };
  document.addEventListener("click", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node) && ev.target !== btn) close();
  });

  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const showing = !menu.hidden;
    close();
    if (showing) return;
    menu.hidden = false;
    btn.classList.add("is-open");
    foot.textContent = t("agent.foot");
    list.innerHTML = `<div class="agent-item" style="cursor:default">${t("agent.empty")}</div>`;
    try {
      const agents = await agentList();
      renderAgents(list, agents);
    } catch (e) {
      list.innerHTML = `<div class="agent-item" style="cursor:default;color:var(--text-faint)">${String(e)}</div>`;
    }
  });
}

function renderAgents(list: HTMLElement, agents: import("./dsh").AgentInfo[]): void {
  list.innerHTML = "";
  if (!agents.length) {
    list.innerHTML = `<div class="agent-item" style="cursor:default;color:var(--text-faint)">—</div>`;
    return;
  }
  for (const a of agents) {
    const item = document.createElement("button");
    item.className = "agent-item";
    item.disabled = !a.installed;
    item.setAttribute("title", a.path || a.name);
    const stateCls = a.installed ? "ok" : "no";
    const stateText = a.installed ? t("agent.installed") : t("agent.notInstalled");
    item.innerHTML =
      `<span class="ag-icon">${iconSvg("terminal")}</span>` +
      `<span class="ag-name">${escHtml(a.name)}</span>` +
      `<span class="ag-state ${stateCls}">${escHtml(stateText)}</span>`;
    if (a.installed) {
      item.addEventListener("click", () => void launchAgent(a));
    }
    list.appendChild(item);
  }
}

async function launchAgent(a: import("./dsh").AgentInfo): Promise<void> {
  const id = terms?.nextShellId() ?? `agent-${Date.now()}`;
  // 智能体终端：带关闭按钮，标签名直接用命令名
  terms?.newShell(id, a.name);
  const m = document.getElementById("agent-menu");
  if (m) m.hidden = true;
  const { rows, cols } = terms?.getSize(id) ?? { rows: 24, cols: 80 };
  try {
    appendLog(await agentSpawn(id, rows, cols, a.key));
  } catch (e) {
    terms?.feed(id, t("agent.launchFail", { err: String(e) }) + "\r\n");
    terms?.markExited(id, "");
    terms?.closeShell(id);
    appendLog(t("agent.launchFail", { err: String(e) }));
  }
}

// ===== 推荐链接（侧边栏底部角落，低调）=====
const REFERRAL_URL = "https://opencode.ai/go?ref=3Y4AMWZX88";
function initReferral(): void {
  const btn = document.getElementById("referral-toggle");
  btn?.addEventListener("click", () => {
    // 统一走链接打开方式；侧边栏可能在网页内容视图下点击，直接执行避免弹框被遮挡
    void openLink(REFERRAL_URL, { source: "webview" });
  });
}

// ===== Node.js 环境准备向导 =====
let nodeWizardBound = false;

function showNodeWizard(initialMsg: string): void {
  const wizard = $("node-wizard");
  const status = $("node-status");
  const log = $("node-log");
  const bar = $("node-progress-bar") as HTMLElement;
  const installBtn = $("node-install") as HTMLButtonElement;
  const recheckBtn = $("node-recheck") as HTMLButtonElement;

  wizard.classList.add("show");
  status.textContent = initialMsg;
  log.textContent = initialMsg + "\n";

  const setBusy = (busy: boolean): void => {
    installBtn.disabled = busy;
    recheckBtn.disabled = busy;
  };
  const source = (): string => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="node-source"]:checked'
    );
    return el ? el.value : "auto";
  };

  if (!nodeWizardBound) {
    nodeWizardBound = true;
    onNodeProgress((p) => {
      log.textContent += p.message + "\n";
      log.scrollTop = log.scrollHeight;
      bar.style.width = progressPercent(p) + "%";
      if (p.phase === "done") status.textContent = p.message;
    });
    onNodeReady((r) => {
      status.textContent = t("node.ready", { v: r.version });
      bar.style.width = "100%";
      log.textContent +=
        t("node.installed", { v: r.version, path: r.path }) + "\n" +
        t("node.autoInstall") + "\n";
      wizard.classList.remove("show");
      void launch();
    });
    onNodeFail((msg) => {
      status.textContent = t("node.fail") + msg;
      log.textContent += t("node.fail") + msg + "\n";
      log.textContent += t("node.failHint") + "\n";
      setBusy(false);
    });

    installBtn.addEventListener("click", async () => {
      setBusy(true);
      log.textContent += t("node.downloading") + "\n";
      try {
        await downloadNode(source());
      } catch (e) {
        log.textContent += t("node.errDownload") + String(e) + "\n";
        setBusy(false);
      }
    });
    recheckBtn.addEventListener("click", async () => {
      setBusy(true);
      const n = await checkNode();
      if (n.ok) {
        log.textContent += n.message + "\n";
        wizard.classList.remove("show");
        void launch();
      } else {
        status.textContent = n.message;
        log.textContent += n.message + "\n";
      }
      setBusy(false);
    });
  }
}

async function boot(): Promise<void> {
  // ===== 初始化：图标（lucide 内联 SVG）/ 语言 / 主题 =====
  mountIcons();
  initLang();
  initTheme();

  // ===== 与 DSH web 的主题 / 语言双向同步（壳 ↔ 3080） =====
  void startDshSettingsSync();

  window.addEventListener("error", (e) => {
    appendLog("❌ 前端错误: " + (e.message || String(e.error || e.type)));
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendLog("❌ 前端未处理异常: " + String(e.reason));
  });

  await initDsh();
  onLog(appendLog);

  // ===== 多标签页 =====
  tabManager = new TabManager($("tab-list"), $("iframe-stack"), $("url-input") as HTMLInputElement);
  void tabManager.initEvents();
  // 启动标签策略：恢复上次会话（开关可关）+ 默认标签页（如 chat.deepseek.com，静默创建）
  void tabManager.applyStartupPolicy();

  // ===== 统一链接打开方式 =====
  registerLinkOpener({
    openInApp: (url) => {
      tabManager.addTab("web", url); // 新标签并激活
      switchView("chat"); // 自动切到对话界面，显示刚打开的标签页
    },
    openExternal: (url) => {
      void openUrl(url).catch(() => {});
    },
  });

  // 全局链接点击拦截（capture 阶段，先于页面内联处理）：
  // target=_blank 与站外 http(s) 链接统一走「打开方式」；站内/锚点/非网页协议放行。
  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const abs = a.href; // 浏览器已解析的绝对地址
      if (!abs || abs.startsWith("#")) return;
      if (!/^https?:\/\//i.test(abs)) return; // mailto:/tel:/file: 等交给系统默认
      const isBlank = a.target === "_blank" || /\bnoopener\b|\bexternal\b/.test(a.rel || "");
      const isForeign = (() => {
        try {
          return new URL(abs).origin !== location.origin;
        } catch {
          return true;
        }
      })();
      if (isBlank || isForeign) {
        ev.preventDefault();
        ev.stopPropagation();
        void openLink(abs);
      }
    },
    true
  );

  // 拦截 JS 中的 window.open → 统一打开方式
  window.open = ((_url?: string | URL, _target?: string, _features?: string) => {
    const u = typeof _url === "string" ? _url : _url instanceof URL ? _url.href : "";
    if (u) void openLink(u);
    return null;
  }) as typeof window.open;

  // ===== 历史记录：独立标签页（Chrome 风格） =====
  // 点击地址栏最右的历史按钮：打开/激活历史标签页，并保证停留在对话视图
  $("url-history").addEventListener("click", () => {
    tabManager.openHistoryTab();
    switchView("chat");
  });

  // ===== 下载记录：独立标签页（Chrome 风格，按钮位于历史按钮右侧） =====
  $("url-downloads").addEventListener("click", () => {
    tabManager.openDownloadsTab();
    switchView("chat");
  });

  // Rust 端下载事件 → 写入下载记录，并刷新下载记录标签页（若正被激活）
  void listen<Record<string, unknown>>("download-start", (e) => {
    const p = (e.payload ?? {}) as { url?: string; filename?: string; path?: string };
    if (p.url) recordDownloadStart(p.url, p.filename || "", p.path || "");
    tabManager.refreshDownloads();
  });
  void listen<Record<string, unknown>>("download-complete", (e) => {
    const p = (e.payload ?? {}) as { url?: string; success?: boolean };
    if (p.url) markDownloadEnd(p.url, p.success !== false);
    tabManager.refreshDownloads();
  });

  $("tab-new").addEventListener("click", () => tabManager.addTab("blank"));
  $("url-home").addEventListener("click", () => tabManager.addTab("blank"));
  $("url-go").addEventListener("click", () =>
    tabManager.navigate(($("url-input") as HTMLInputElement).value)
  );
  $("url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") tabManager.navigate(($("url-input") as HTMLInputElement).value);
  });
  $("url-back").addEventListener("click", () => tabManager.goBack());
  $("url-fwd").addEventListener("click", () => tabManager.goForward());
  $("url-reload").addEventListener("click", () => tabManager.reload());

  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      tabManager.refreshActiveWebviewBounds();
      terms?.fit();
    }, 150);
  });

  // ===== 视图切换 =====
  document.querySelectorAll<HTMLElement>(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view || ""));
  });

  // ===== 日志视图 =====
  $("retry-btn").addEventListener("click", launch);
  initTerminalPanel();
  initReferral();

  // ===== 插件中心 =====
  initPlugins({
    onAction: (msg) => {
      switchView("logs");
      appendLog(msg);
    },
  });

  // ===== 设置 =====
  initSettings();

  // ===== Node.js 环境入口（设置页） =====
  $("settings-node-recheck").addEventListener("click", async () => {
    const n = await checkNode();
    $("settings-node-result").textContent = n.message;
    if (!n.ok) showNodeWizard(n.message);
  });
  $("settings-node-reinstall").addEventListener("click", () => {
    showNodeWizard(t("node.reinstallHint"));
  });

  // ===== DSH 状态事件 =====
  onReady((url) => {
    setStatus("running", t("status.running"));
    appendLog(t("app.dshReadyLog") + url);
    tabManager.markDshReady();
    switchView("chat");
  });
  onExit(() => {
    appendLog(t("app.dshExited"));
    setTimeout(async () => {
      try {
        await fetch("http://127.0.0.1:3080/", { mode: "no-cors" });
        appendLog(t("app.externalDetected"));
        setStatus("running", t("status.external"));
        tabManager.markDshReady();
        switchView("chat");
      } catch {
        setStatus("error", t("status.exit"));
      }
    }, 1500);
  });

  // ===== 侧边栏折叠/展开（窄条模式）：点击品牌 OpenHarness / OH 切换 =====
  const sidebar = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("brand-toggle");
  if (sidebar && toggleBtn) {
    const toggleSidebar = () => {
      sidebar.classList.toggle("collapsed");
      // 通知 tabManager 刷新 iframe 尺寸（延迟等待过渡完成）
      setTimeout(() => {
        if (tabManager) {
          tabManager.refreshActiveWebviewBounds();
        }
        terms?.fit();
      }, 50);
    };

    toggleBtn.addEventListener("click", toggleSidebar);

    // 键盘快捷键：Cmd+B (Mac) / Ctrl+B (Win/Linux)
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    });
  }

  // ===== 主题 / 语言快捷开关（侧边栏底部） =====
  const themeBtn = document.getElementById("theme-toggle");
  const updateThemeIcon = (): void => {
    const holder = themeBtn?.querySelector<HTMLElement>("i[data-icon]");
    if (!holder) return;
    // 显示「另一个」主题的图标：当前暗色 → 显示太阳（点一下变亮）
    const name = effectiveTheme() === "dark" ? "sun" : "moon";
    holder.dataset.icon = name;
    holder.innerHTML = iconSvg(name);
  };
  themeBtn?.addEventListener("click", () => cycleTheme());
  window.addEventListener("theme-changed", () => {
    updateThemeIcon();
    // 壳 → DSH：把当前主题偏好同步到 DSH web 的 ui-theme.preference
    void pushPref("ui-theme", getThemePref());
  });
  updateThemeIcon();

  const langBtn = document.getElementById("lang-toggle");
  langBtn?.addEventListener("click", () => {
    setLang(getLang() === "zh" ? "en" : "zh");
  });
  window.addEventListener("lang-changed", () => {
    // 壳 → DSH：把当前语言同步到 DSH web 的 locale.preference
    void pushPref("locale", getLang());
  });

  // ===== 启动：检查 Node 环境 =====
  await initNodeEvents();
  const node = await checkNode();
  if (!node.ok) {
    showNodeWizard(node.message);
    return;
  }
  appendLog(node.message);
  await launch();
}

void boot();