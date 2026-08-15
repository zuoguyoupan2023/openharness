// src/terminal.ts —— 多终端：DSH 日志（只读 xterm）+ 可交互 shell 终端（xterm.js）
// 日志视图重建为「标签栏 + 终端栈」：默认固定一个「DSH 日志」只读终端实时展示 DSH 进程
// 输出；点「+」新增真正的本地 shell 终端，用户可敲命令（输入经 IPC 转发到 shell stdin）。
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TermCallbacks {
  /** 用户在某个 shell 终端输入了一段数据（转发到 shell stdin） */
  onShellInput(id: string, data: string): void;
  /** shell 终端的实际渲染尺寸变化（rows/cols，行/列）。外层应同步回发 PTY。 */
  onShellResize(id: string, rows: number, cols: number): void;
  /** 用户点了某个 shell 终端的关闭按钮（外层负责 term_kill + 移除） */
  onCloseShell(id: string): void;
}

interface TermEntry {
  id: string;
  kind: "log" | "shell";
  pane: HTMLElement;
  tab: HTMLElement;
  xterm: Terminal;
  fit: FitAddon;
  dead: boolean;
}

export class TermManager {
  private map = new Map<string, TermEntry>();
  private order: string[] = [];
  private active: string | null = null;
  private shellSeq = 0;

  constructor(
    private stack: HTMLElement,
    private tabs: HTMLElement,
    private cb: TermCallbacks
  ) {}

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
    // 追加到标签栏末尾（在“+”按钮之前由 CSS/Toolbar 顺序控制）
    this.tabs.appendChild(tab);

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: "#111418",
        foreground: "#d4d4d8",
        cursor: "#e4e4e7",
        selectionBackground: "#3f3f46",
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    setTimeout(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }, 0);

    if (kind === "shell") {
      xterm.onData((data) => {
        const e = this.map.get(id);
        if (!e || e.dead) return;
        this.cb.onShellInput(id, data);
      });
      // 尺寸变化（fit / 窗口缩放 / 折叠恢复）→ 回发给 Rust 侧同步 PTY
      xterm.onResize(({ cols, rows }) => {
        const e = this.map.get(id);
        if (!e || e.dead) return;
        this.cb.onShellResize(id, rows, cols);
      });
    }

    return { id, kind, pane, tab, xterm, fit, dead: false };
  }

  /** 返回某个终端的当前实际渲染尺寸（行/列），用于初始 spawn PTY 时对齐。 */
  getSize(id: string): { rows: number; cols: number } {
    const e = this.map.get(id);
    if (!e) return { rows: 24, cols: 80 };
    // xterm 的 buffer 尺寸即为当前可视行列（fit 后即实际）
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
