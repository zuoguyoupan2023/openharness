// src/tabs.ts —— 多标签页管理器（iframe 池，阶段 1 MVP）
// 阶段 2 计划：DSH 标签保持 iframe，用户网页标签升级为 Tauri 原生子 webview。
import { DSH_URL } from "./dsh";

export type TabType = "dsh" | "web" | "blank";

export interface TabData {
  id: string;
  title: string;
  url: string;
  type: TabType;
  history: string[];
  historyIdx: number;
}

/** 默认搜索引擎（Bing 在国内可用） */
const SEARCH_ENGINE = "https://www.bing.com/search?q=";
const STORAGE_KEY = "openharness-tabs-v1";

const HOME_LINKS: Array<{ label: string; url: string }> = [
  { label: "🧠 DeepSeek Harness 主界面", url: DSH_URL },
  { label: "📦 npm", url: "https://www.npmjs.com" },
  { label: "🐙 GitHub", url: "https://github.com" },
  { label: "🔧 DeepSeek-Harness 仓库", url: "https://github.com/deepseek-ai/DeepSeek-Harness" },
  { label: "🧩 awesome-dsh-plugin", url: "https://awesome-dsh-plugin.com" },
  { label: "📖 DSH 插件开发文档", url: "https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.zh.md" },
];

function normalizeInput(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^(https?:\/\/|file:\/\/|about:|data:)/i.test(v)) return v;
  const looksLikeHost =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(v) ||
    /^localhost(:\d+)?([/?#].*)?$/i.test(v) ||
    /^127\.0\.0\.1(:\d+)?([/?#].*)?$/i.test(v);
  if (looksLikeHost) return "https://" + v;
  return SEARCH_ENGINE + encodeURIComponent(v);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function makeId(): string {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export class TabManager {
  private tabs: TabData[] = [];
  private activeId = "";
  private dshReady = false;
  private tabListEl: HTMLElement;
  private stackEl: HTMLElement;
  private urlInput: HTMLInputElement;

  constructor(
    tabListEl: HTMLElement,
    stackEl: HTMLElement,
    urlInput: HTMLInputElement
  ) {
    this.tabListEl = tabListEl;
    this.stackEl = stackEl;
    this.urlInput = urlInput;
    this.restore();
  }

  // ================= 公开操作 =================

  getActive(): TabData | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  addTab(type: TabType, url?: string, activate = true): TabData {
    const u = url ?? (type === "dsh" ? DSH_URL : "");
    const tab: TabData = {
      id: makeId(),
      title: type === "dsh" ? "DeepSeek Harness" : type === "blank" ? "新标签页" : hostOf(u),
      url: u,
      type,
      history: u ? [u] : [],
      historyIdx: u ? 0 : -1,
    };
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    else this.renderTabBar();
    this.persist();
    return tab;
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    this.stackEl.querySelector(`[data-id="${id}"]`)?.remove();
    if (this.tabs.length === 0) {
      this.addTab("blank");
      return;
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activate(next.id);
    } else {
      this.renderTabBar();
    }
    this.persist();
  }

  activate(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    this.tabs.forEach((t) => {
      const pane = this.stackEl.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
      if (pane) pane.style.display = t.id === id ? "flex" : "none";
    });
    this.ensurePane(tab);
    this.renderTabBar();
    this.syncUrlBar();
  }

  /** 网址栏：输入网址或搜索词并前往 */
  navigate(raw: string): void {
    const tab = this.getActive();
    if (!tab) return;
    const url = normalizeInput(raw);
    if (!url) return;
    if (tab.type === "blank") tab.type = "web";
    if (tab.type === "dsh" && url !== DSH_URL) tab.type = "web";
    // 历史栈：截断前进记录，压入新记录
    tab.history = tab.history.slice(0, tab.historyIdx + 1);
    tab.history.push(url);
    tab.historyIdx = tab.history.length - 1;
    this.loadUrl(tab, url);
  }

  goBack(): void {
    const tab = this.getActive();
    if (!tab || tab.historyIdx <= 0) return;
    tab.historyIdx--;
    this.loadUrl(tab, tab.history[tab.historyIdx]);
  }

  goForward(): void {
    const tab = this.getActive();
    if (!tab || tab.historyIdx >= tab.history.length - 1) return;
    tab.historyIdx++;
    this.loadUrl(tab, tab.history[tab.historyIdx]);
  }

  reload(): void {
    const tab = this.getActive();
    if (!tab) return;
    const pane = this.stackEl.querySelector<HTMLElement>(`[data-id="${tab.id}"]`);
    const frame = pane?.querySelector<HTMLIFrameElement>("iframe");
    if (frame && tab.type !== "blank") {
      frame.src = frame.src; // 重新设置 src 触发刷新
    }
  }

  /** DSH 就绪：加载/刷新 DSH 标签（重启后自动重连） */
  markDshReady(): void {
    this.dshReady = true;
    this.tabs.forEach((t) => {
      if (t.type !== "dsh") return;
      const pane = this.stackEl.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
      if (pane) pane.querySelector<HTMLElement>(".tab-overlay")!.style.display = "none";
      const frame = pane?.querySelector<HTMLIFrameElement>("iframe");
      if (frame && frame.src) {
        frame.src = frame.src; // 重启后刷新，连接新实例
      } else {
        this.loadUrl(t, DSH_URL);
      }
    });
  }

  // ================= 内部实现 =================

  private restore(): void {
    let saved: { tabs: TabData[]; active: string } | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) as { tabs: TabData[]; active: string };
    } catch {
      saved = null;
    }
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
      this.tabs = saved.tabs
        .filter((t) => t && typeof t.id === "string")
        .map((t) => ({
          id: t.id,
          title: t.title || "标签页",
          url: t.url || "",
          type: t.type === "dsh" ? "dsh" : t.type === "blank" ? "blank" : "web",
          history: Array.isArray(t.history) ? t.history : t.url ? [t.url] : [],
          historyIdx:
            typeof t.historyIdx === "number" && t.historyIdx >= 0 ? t.historyIdx : 0,
        }));
      this.activeId = saved.active || this.tabs[0].id;
      if (!this.tabs.some((t) => t.id === this.activeId)) this.activeId = this.tabs[0].id;
    }
    // 保证至少有一个 DSH 标签
    if (!this.tabs.some((t) => t.type === "dsh")) {
      const dshTab: TabData = {
        id: "dsh-" + makeId(),
        title: "DeepSeek Harness",
        url: DSH_URL,
        type: "dsh",
        history: [DSH_URL],
        historyIdx: 0,
      };
      this.tabs.unshift(dshTab);
      this.activeId = dshTab.id;
    }
    if (!this.getActive()) this.activeId = this.tabs[0].id;
    // 激活初始标签：创建首个 pane（DSH 未就绪时显示等待动画）
    this.activate(this.activeId);
  }

  private ensurePane(tab: TabData): HTMLElement {
    let pane = this.stackEl.querySelector<HTMLElement>(`[data-id="${tab.id}"]`);
    if (pane) return pane;

    pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.id = tab.id;
    pane.style.display = "flex";

    const frame = document.createElement("iframe");
    frame.className = "tab-frame";
    frame.setAttribute("allowfullscreen", "true");
    pane.appendChild(frame);

    const overlay = document.createElement("div");
    overlay.className = "tab-overlay";
    pane.appendChild(overlay);

    // 未就绪的 DSH 标签：加载前显示等待动画
    if (tab.type === "dsh" && !this.dshReady) {
      overlay.style.display = "flex";
      overlay.innerHTML = `
        <div class="spinner"></div>
        <div>⏳ 正在启动 DeepSeek Harness，请稍候…</div>
        <div style="font-size:0.8rem;opacity:.7;">可在左侧「日志」查看启动进度</div>`;
    } else if (tab.type === "blank") {
      overlay.style.display = "flex";
      overlay.innerHTML = this.newTabPageHtml();
      overlay.querySelectorAll<HTMLButtonElement>("[data-url]").forEach((btn) => {
        btn.addEventListener("click", () => this.navigate(btn.dataset.url || ""));
      });
    } else {
      overlay.style.display = "none";
      frame.src = tab.url;
    }

    this.stackEl.appendChild(pane);
    return pane;
  }

  private newTabPageHtml(): string {
    const links = HOME_LINKS.map(
      (l) => `<button class="quick-link" data-url="${l.url}">${l.label}</button>`
    ).join("");
    return `
      <div class="newtab">
        <div class="newtab-title">🖖 新标签页</div>
        <div class="newtab-sub">在网址栏输入网址，或直接搜索；常用入口：</div>
        <div class="quick-links">${links}</div>
      </div>`;
  }

  private loadUrl(tab: TabData, url: string): void {
    tab.url = url;
    tab.title = tab.type === "dsh" ? "DeepSeek Harness" : tab.type === "blank" ? "新标签页" : hostOf(url);
    const pane = this.ensurePane(tab);
    const frame = pane.querySelector<HTMLIFrameElement>("iframe");
    const overlay = pane.querySelector<HTMLElement>(".tab-overlay")!;
    if (tab.type === "blank") {
      overlay.style.display = "flex";
      overlay.innerHTML = this.newTabPageHtml();
      overlay.querySelectorAll<HTMLButtonElement>("[data-url]").forEach((btn) => {
        btn.addEventListener("click", () => this.navigate(btn.dataset.url || ""));
      });
    } else {
      overlay.style.display = "none";
      if (frame) frame.src = url;
    }
    this.renderTabBar();
    this.persist();
    this.syncUrlBar();
  }

  private renderTabBar(): void {
    this.tabListEl.innerHTML = "";
    this.tabs.forEach((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === this.activeId ? " active" : "");
      el.dataset.id = t.id;
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = t.title;
      title.title = t.url || "";
      const x = document.createElement("button");
      x.className = "tab-x";
      x.textContent = "×";
      x.title = "关闭标签";
      el.appendChild(title);
      el.appendChild(x);
      el.addEventListener("click", () => this.activate(t.id));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(t.id);
      });
      this.tabListEl.appendChild(el);
    });
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tabs: this.tabs, active: this.activeId })
      );
    } catch {
      // 忽略配额/隐私模式错误
    }
  }

  /** 激活标签时同步网址栏 */
  syncUrlBar(): void {
    const tab = this.getActive();
    if (!tab) return;
    this.urlInput.value = tab.type === "blank" ? "" : tab.url;
  }
}
