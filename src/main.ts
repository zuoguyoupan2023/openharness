// src/main.ts —— OpenHarness 应用入口
import {
  initDsh,
  onLog,
  onReady,
  onExit,
  startDsh,
  termSpawn,
  termWrite,
  termKill,
  onTermOutput,
  onTermExit,
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
import { initTheme, cycleTheme, effectiveTheme } from "./theme";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
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
    // shell 终端输入 → 转发到对应 shell 子进程 stdin
    onShellInput(id, data) {
      void termWrite(id, data).catch(() => {
        terms?.markExited(
          id,
          "\x1b[31m（写入 shell stdin 失败）\x1b[0m"
        );
      });
    },
    // 关闭按钮 → 杀掉子进程并移除 UI
    onCloseShell(id) {
      void termKill(id).catch(() => {});
      terms?.closeShell(id);
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

  // 「+」新增 shell 终端
  $("term-add").addEventListener("click", async () => {
    const id = terms?.nextShellId() ?? `shell-${Date.now()}`;
    terms?.newShell(id, t("term.shell.tab", { n: id.slice(id.indexOf("-") + 1) }));
    try {
      appendLog(await termSpawn(id));
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
}

// ===== 推荐链接（侧边栏底部角落，低调）=====
const REFERRAL_URL = "https://opencode.ai/go?ref=3Y4AMWZX88";
function initReferral(): void {
  const btn = document.getElementById("referral-toggle");
  btn?.addEventListener("click", () => {
    // 主窗口 webview 未拦截 window.open：_blank 将在系统默认浏览器打开，避免占用应用内标签
    window.open(REFERRAL_URL, "_blank", "noopener");
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
  window.addEventListener("theme-changed", updateThemeIcon);
  updateThemeIcon();

  const langBtn = document.getElementById("lang-toggle");
  langBtn?.addEventListener("click", () => {
    setLang(getLang() === "zh" ? "en" : "zh");
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