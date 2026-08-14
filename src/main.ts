// src/main.ts —— OpenHarness 应用入口
import { initDsh, onLog, onReady, onExit, startDsh } from "./dsh";
import { TabManager } from "./tabs";
import { initPlugins } from "./plugins";
import { initSettings } from "./settings";
import {
  checkNode,
  downloadNode,
  initNodeEvents,
  onNodeFail,
  onNodeProgress,
  onNodeReady,
  progressPercent,
} from "./node";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** 模块级引用：switchView 切换视图时联动原生 webview 显隐 */
let tabManager: TabManager;

function appendLog(msg: string): void {
  const logArea = $("log-area");
  logArea.textContent += msg + "\n";
  logArea.scrollTop = logArea.scrollHeight;
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
  // 原生 webview 只应出现在对话视图：离开时隐藏，回来时恢复
  if (tabManager) {
    if (name === "chat") tabManager.restoreActiveWebview();
    else tabManager.hideAllWebviews();
  }
}

async function launch(): Promise<void> {
  appendLog("⏳ 正在启动 DeepSeek Harness...");
  setStatus("waiting", "🚀 启动中，等待服务就绪...");
  try {
    appendLog(await startDsh());
  } catch (e) {
    appendLog("❌ 启动出错: " + String(e));
    setStatus("error", "⚠️ 启动失败，请检查 Node.js (>=22.15) 与网络；可在「设置」查看 Node 环境");
  }
}

// ===== Node.js 环境准备向导 =====
// 系统无 Node（或版本 < 22.15 / 无 npx）时弹出；下载安装成功后自动继续启动 DSH
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
      status.textContent = "✅ Node.js " + r.version + " 已就绪，正在启动 DSH...";
      bar.style.width = "100%";
      log.textContent +=
        "✅ Node.js " + r.version + " 安装成功（" + r.path + "）\n" +
        "🚀 正在启动 DSH（自动预装高亮插件 adhdgofly-dsh-ext，就绪后自动打开对话标签）...\n";
      wizard.classList.remove("show");
      void launch();
    });
    onNodeFail((msg) => {
      status.textContent = "❌ " + msg;
      log.textContent += "❌ " + msg + "\n";
      log.textContent += "💡 可切换「淘宝 npmmirror / 清华 TUNA」源后重试，或先手动安装 Node.js。\n";
      setBusy(false);
    });

    installBtn.addEventListener("click", async () => {
      setBusy(true);
      log.textContent += "⏳ 开始下载 Node.js...\n";
      try {
        await downloadNode(source());
      } catch (e) {
        log.textContent += "❌ " + String(e) + "\n";
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
  // 前端错误兜底：任何 JS 异常都写进日志视图，避免「静默卡死」
  window.addEventListener("error", (e) => {
    appendLog("❌ 前端错误: " + (e.message || String(e.error || e.type)));
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendLog("❌ 前端未处理异常: " + String(e.reason));
  });

  await initDsh();
  onLog(appendLog);

  // ===== 多标签页（对话视图） =====
  tabManager = new TabManager($("tab-list"), $("iframe-stack"), $("url-input") as HTMLInputElement);
  void tabManager.initEvents(); // 注册原生 webview 事件（导航/新窗口/标题）

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

  // 窗口尺寸变化 → 重算网页标签的原生 webview 位置（150ms 去抖）
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => tabManager.refreshActiveWebviewBounds(), 150);
  });

  // ===== 视图切换 =====
  document.querySelectorAll<HTMLElement>(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view || ""));
  });

  // ===== 日志视图 =====
  $("retry-btn").addEventListener("click", launch);

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
    showNodeWizard("⬇️ 选择下载源后点击「下载并安装 Node.js」。若已内置旧版本，将被替换为新版本。");
  });

  // ===== DSH 状态事件 =====
  onReady((url) => {
    setStatus("running", "✅ DSH 运行中");
    appendLog("✅ DSH 就绪: " + url);
    tabManager.markDshReady(); // 首次加载 / 重启后自动重连
    switchView("chat");
  });
  onExit(() => {
    appendLog("⚠️ DSH 进程已退出");
    // 若外部有 DSH（如用户手动启动）在 3080，探测到后自动直连，避免卡死在等待页
    setTimeout(async () => {
      try {
        await fetch("http://127.0.0.1:3080/", { mode: "no-cors" });
        appendLog("✅ 检测到外部 DSH 已在 3080 运行，直接连接");
        setStatus("running", "✅ DSH 运行中");
        tabManager.markDshReady();
        switchView("chat");
      } catch {
        setStatus("error", "⚠️ DSH 已退出，可在日志页点击重新启动");
      }
    }, 1500);
  });

  // ===== 启动：先检查 Node 环境 =====
  // 系统 Node（>=22 + npx）或内置 Node 可用 → 直接启动；
  // 否则弹出 Node 安装向导，安装成功后自动继续（node-ready → launch）
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
