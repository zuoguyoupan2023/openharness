// src/terminal.ts —— 多终端：DSH 日志（只读 xterm）+ 可交互 shell 终端（xterm.js，真实 PTY）
// 增强：Ctrl+F 搜索（addon-search）、主题跟随壳暗色模式（theme）、URL 链接/Unicode 选字
//       （web-links/unicode11）、WebGL 渲染（webgl + 降级）、标签标题随 shell（onTitleChange）。
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { effectiveTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";

export interface TermCallbacks {
  /** 用户在某个 shell 终端输入了一段数据（转发到 shell stdin） */
  onShellInput(id: string, data: string): void;
  /** shell 终端的实际渲染尺寸变化（rows/cols，行/列）。外层应同步回发 PTY。 */
  onShellResize(id: string, rows: number, cols: number): void;
  /** 用户点了某个 shell 终端的关闭按钮（外层负责 term_kill + 移除） */
  onCloseShell(id: string): void;
  /** 点击了终端输出中的 URL（外层用 opener 在系统浏览器打开） */
  onWebLink?(uri: string): void;
}

/** 终端颜色主题（跟随壳暗色/亮色模式） */
function termTheme(dark: boolean): Record<string, string> {
  return dark
    ? {
        background: "#111418",
        foreground: "#d4d4d8",
        cursor: "#e4e4e7",
        cursorAccent: "#111418",
        selectionBackground: "#3f3f46",
        selectionInactiveBackground: "#27272a",
        black: "#0e1013", red: "#f85149", green: "#56d364", yellow: "#e3b341",
        blue: "#5b8dee", magenta: "#d2a8ff", cyan: "#39c5cf", white: "#e4e4e7",
        brightBlack: "#6b7280", brightRed: "#ff6b6b", brightGreen: "#7ce38b",
        brightYellow: "#f4d079", brightBlue: "#8db0f5", brightMagenta: "#e0b8ff",
        brightCyan: "#6fe3ea", brightWhite: "#ffffff",
      }
    : {
        background: "#ffffff",
        foreground: "#24292f",
        cursor: "#0969da",
        cursorAccent: "#ffffff",
        selectionBackground: "#d4d4d8",
        selectionInactiveBackground: "#e9e9ec",
        black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700",
        blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#d0d7de",
        brightBlack: "#6e7781", brightRed: "#be1d22", brightGreen: "#1a7f37",
        brightYellow: "#795400", brightBlue: "#0b62c2", brightMagenta: "#6639ba",
        brightCyan: "#087b87", brightWhite: "#f6f8fa",
      };
}

interface TermEntry {
  id: string;
  kind: "log" | "shell";
  pane: HTMLElement;
  tab: HTMLElement;
  xterm: Terminal;
  fit: FitAddon;
  search?: SearchAddon;
  searchEl?: HTMLDivElement;
  searchInput?: HTMLInputElement;
  dead: boolean;
}

export class TermManager {
  private map = new Map<string, TermEntry>();
  private order: string[] = [];
  private active: string | null = null;
  private shellSeq = 0;
  private dark = effectiveTheme() === "dark";

  constructor(
    private stack: HTMLElement,
    private tabs: HTMLElement,
    private cb: TermCallbacks
  ) {
    // 壳主题变化 → 同步刷新所有终端主题
    window.addEventListener("theme-changed", () => {
      this.dark = effectiveTheme() === "dark";
      for (const e of this.map.values()) {
        try {
          e.xterm.options.theme = termTheme(this.dark);
        } catch {
          /* ignore */
        }
      }
    });
  }

  /** 供外部观察当前生效主题 */
  isDark(): boolean {
    return this.dark;
  }

  /** 是否已有某 id 的终端 */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /** 新建 DSH 日志只读终端（无关闭按钮）；若已存在则激活 */
  ensureLog(id: string, label: string): void {
    if (this.map.has(id)) {
      this.activate(id);
      return;
    }
    const entry = this.createEntry(id, "log");
    this.tabTitle(entry, label);
    this.finish(id, entry);
  }

  /** 新建一个 shell 终端（交互，带关闭按钮），返回 id */
  newShell(id: string, label: string): void {
    const entry = this.createEntry(id, "shell");
    this.tabTitle(entry, label);
    this.tabAddClose(entry, id);
    this.finish(id, entry);
  }

  /** 追加原始输出到某终端（shell stdout 已含控制序列/换行，直接写） */
  feed(id: string, data: string): void {
    const e = this.map.get(id);
    if (!e || e.dead) return;
    try {
      e.xterm.write(data);
    } catch {
      /* ignore */
    }
  }

  /** 追加一行（自动补换行）——用于 DSH 日志流 */
  feedLine(id: string, line: string): void {
    this.feed(id, line + "\r\n");
  }

  activate(id: string): void {
    this.active = id;
    for (const entry of this.map.values()) {
      entry.pane.classList.toggle("active", entry.id === id);
      entry.tab.classList.toggle("active", entry.id === id);
    }
    this.fit(id);
  }

  getActive(): string | null {
    return this.active;
  }

  /** 关闭 shell 终端 UI（需先 term_kill，或由外层决定顺序） */
  closeShell(id: string): void {
    const e = this.map.get(id);
    if (!e || e.kind !== "shell") return;
    this.map.delete(id);
    this.order = this.order.filter((x) => x !== id);
    e.tab.remove();
    e.pane.remove();
    try {
      e.xterm.dispose();
    } catch {
      /* ignore */
    }
    if (this.active === id) {
      const next = this.order[this.order.length - 1];
      if (next) this.activate(next);
      else this.active = null;
    }
  }

  /** 标记某 shell 终端进程已退出（保留终端，显示退出提示） */
  markExited(id: string, message: string): void {
    const e = this.map.get(id);
    if (!e || e.kind !== "shell" || e.dead) return;
    e.dead = true;
    e.tab.classList.add("killed");
    try {
      e.xterm.write("\r\n\x1b[90m" + message + "\x1b[0m\r\n");
    } catch {
      /* ignore */
    }
  }

  clear(id: string): void {
    const e = this.map.get(id);
    if (!e) return;
    try {
      e.xterm.clear();
    } catch {
      /* ignore */
    }
  }

  /** 清空 DSH 日志终端 */
  clearLog(logId: string): void {
    this.clear(logId);
  }

  fit(id?: string): void {
    if (id) {
      const e = this.map.get(id);
      if (e) this.fitEntry(e);
      return;
    }
    for (const entry of this.map.values()) this.fitEntry(entry);
  }

  /** 生成下一个 shell 终端的 id */
  nextShellId(prefix = "shell"): string {
    this.shellSeq += 1;
    return `${prefix}-${this.shellSeq}`;
  }

  // ---- 内部 ----
  private createEntry(id: string, kind: "log" | "shell"): TermEntry {
    const pane = document.createElement("div");
    pane.className = "term-pane";
    pane.dataset.term = id;
    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;inset:0;padding:2px;box-sizing:border-box;";
    pane.appendChild(host);
    this.stack.appendChild(pane);

    const tab = document.createElement("div");
    tab.className = "term-tab";
    tab.dataset.tabb = id;
    tab.title = id;
    tab.addEventListener("click", () => this.activate(id));
    this.tabs.appendChild(tab);

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
      convertEol: true,
      scrollback: 8000,
      allowProposedApi: true,
      theme: termTheme(this.dark),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);

    // Unicode 11 选字规范（中文/emoji 不切半个字符）
    try {
      const uni = new Unicode11Addon();
      xterm.loadAddon(uni);
      xterm.unicode.activeVersion = "11";
    } catch {
      /* ignore */
    }

    // WebGL 渲染（失败则静默降级回 Canvas/DOM）
    try {
      xterm.loadAddon(new WebglAddon());
    } catch {
      /* ignore */
    }

    // 输出中的 URL / 文件路径可点
    try {
      const links = new WebLinksAddon((_ev, uri) => {
        this.cb.onWebLink?.(uri);
      });
      xterm.loadAddon(links);
    } catch {
      /* ignore */
    }

    // 终端内 Ctrl+F 搜索
    const search = new SearchAddon();
    xterm.loadAddon(search);
    const { searchEl, searchInput } = this.buildSearchBar(pane);

    xterm.open(host);
    setTimeout(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }, 0);

    // 拦截 Ctrl+F 显示搜索条；Esc 关闭
    try {
      xterm.attachCustomKeyEventHandler((e) => {
        const m = e.ctrlKey || e.metaKey;
        if (m && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          this.showSearch(searchEl, searchInput, search);
          return false;
        }
        if (e.key === "Escape") this.hideSearch(searchEl, searchInput, search);
        return true;
      });
    } catch {
      /* ignore */
    }

    if (kind === "shell") {
      xterm.onData((data) => {
        const e = this.map.get(id);
        if (!e || e.dead) return;
        this.cb.onShellInput(id, data);
      });
      xterm.onResize(({ cols, rows }) => {
        const e = this.map.get(id);
        if (!e || e.dead) return;
        this.cb.onShellResize(id, rows, cols);
      });
      // 标题随 shell（OSC 0/2 title，含 PWD 集成）→ 更新标签名
      xterm.onTitleChange((title) => {
        const e = this.map.get(id);
        if (!e || e.dead) return;
        const clean = title.trim();
        if (clean) {
          e.tab.dataset.name = clean;
          const span = e.tab.querySelector<HTMLElement>(".term-tab-name");
          if (span) span.textContent = clean;
          e.tab.title = clean;
        }
      });
    }

    return { id, kind, pane, tab, xterm, fit, search, searchEl, searchInput, dead: false };
  }

  /** 构建每个终端右上角的搜索条（默认隐藏） */
  private buildSearchBar(pane: HTMLElement): {
    searchEl: HTMLDivElement;
    searchInput: HTMLInputElement;
  } {
    const searchEl = document.createElement("div");
    searchEl.className = "term-search";
    searchEl.style.cssText =
      "position:absolute;top:6px;right:6px;z-index:5;display:none;align-items:center;" +
      "gap:4px;padding:2px 4px;border-radius:6px;background:rgba(0,0,0,.6);" +
      "color:#fff;font:12px/20px ui-monospace,monospace;backdrop-filter:blur(2px);";
    const icon = document.createElement("span");
    icon.textContent = "⌕";
    const input = document.createElement("input");
    input.style.cssText =
      "width:170px;border:none;background:transparent;color:inherit;outline:none;font:inherit;";
    input.placeholder = "搜索…";
    input.title = "Enter 下一条 · Enter 后再搜索 上一条";
    const prev = this.searchBtn("↑", "上一条");
    const next = this.searchBtn("↓", "下一条");
    const close = this.searchBtn("×", "关闭");
    searchEl.append(icon, input, prev, next, close);
    pane.appendChild(searchEl);

    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.shiftKey
          ? this.doSearch(pane, -1)
          : this.doSearch(pane, 1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        searchEl.style.display = "none";
      }
    });
    prev.addEventListener("click", () => this.doSearch(pane, -1));
    next.addEventListener("click", () => this.doSearch(pane, 1));
    close.addEventListener("click", () => (searchEl.style.display = "none"));
    return { searchEl, searchInput: input };
  }

  private searchBtn(text: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.style.cssText =
      "border:none;background:transparent;color:inherit;cursor:pointer;padding:0 3px;font:inherit;";
    return b;
  }

  private showSearch(
    el: HTMLDivElement,
    input: HTMLInputElement,
    search: SearchAddon
  ): void {
    el.style.display = "flex";
    input.focus();
    input.select();
    const q = input.value.trim();
    if (q) this.doSearch(el.parentElement!, 1);
    void search;
  }

  private hideSearch(
    el: HTMLDivElement,
    input: HTMLInputElement,
    _search: SearchAddon
  ): void {
    el.style.display = "none";
    input.value = "";
    try {
      this.clearHighlights(el.parentElement!);
    } catch {
      /* ignore */
    }
  }

  /** 对某个 pane 执行搜索 */
  private doSearch(pane: HTMLElement, delta: 1 | -1): void {
    const e = this.findEntryByPane(pane);
    const input = e?.searchInput;
    if (!e || !e.search || !input) return;
    const q = input.value.trim();
    if (!q) return;
    try {
      if (delta > 0) e.search.findNext(q, { incremental: true });
      else e.search.findPrevious(q, { incremental: true });
    } catch {
      /* ignore */
    }
  }

  private clearHighlights(pane: HTMLElement): void {
    const e = this.findEntryByPane(pane);
    if (e?.search) e.search.clearDecorations();
  }

  private findEntryByPane(pane: HTMLElement): TermEntry | undefined {
    const id = pane.dataset.term;
    return id ? this.map.get(id) : undefined;
  }

  /** 返回某个终端的当前实际渲染尺寸（行/列），用于初始 spawn PTY 时对齐。 */
  getSize(id: string): { rows: number; cols: number } {
    const e = this.map.get(id);
    if (!e) return { rows: 24, cols: 80 };
    const cols = e.xterm.cols || 80;
    const rows = e.xterm.rows || 24;
    return { rows, cols };
  }

  private tabTitle(entry: TermEntry, text: string): void {
    const span = document.createElement("span");
    span.className = "term-tab-name";
    span.textContent = text;
    entry.tab.appendChild(span);
    entry.tab.dataset.name = text;
  }

  private tabAddClose(entry: TermEntry, id: string): void {
    const btn = document.createElement("button");
    btn.className = "term-tab-close";
    btn.textContent = "×";
    btn.setAttribute("aria-label", "close");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.cb.onCloseShell(id);
    });
    entry.tab.appendChild(btn);
  }

  private finish(id: string, entry: TermEntry): void {
    this.map.set(id, entry);
    this.order.push(id);
    this.activate(id);
  }

  private fitEntry(entry: TermEntry): void {
    try {
      entry.fit.fit();
    } catch {
      /* ignore */
    }
  }
}
