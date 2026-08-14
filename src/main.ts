// src/main.ts —— OpenHarness 应用入口
import { initDsh, onLog, onReady, onExit, startDsh } from "./dsh";
import { TabManager } from "./tabs";
import { initPlugins } from "./plugins";
import { initSettings } from "./settings";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

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
}

async function launch(): Promise<void> {
  appendLog("⏳ 正在启动 DeepSeek Harness...");
  setStatus("waiting", "🚀 启动中，等待服务就绪...");
  try {
    appendLog(await startDsh());
  } catch (e) {
    appendLog("❌ 启动出错: " + String(e));
    setStatus("error", "⚠️ 启动失败，请检查 Node.js (>=22) 与网络；可在「设置」切换国内镜像源");
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
  const tabManager = new TabManager($("tab-list"), $("iframe-stack"), $("url-input") as HTMLInputElement);

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

  // ===== 启动 =====
  await launch();
}

void boot();
