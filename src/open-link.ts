// src/open-link.ts —— 链接打开方式统一入口
// 所有「打开网址」的入口（网页标签新窗口、插件详情链接、终端 URL、全局链接点击）都汇聚到这里：
// 按用户设置（每次询问 / App 内打开 / 系统浏览器）决定打开方式；
// 「每次询问」时弹出统一风格的选择框，可勾选「不再提示」把该选择固化为默认。
import { recordHistory } from "./history";

export type LinkOpenMode = "ask" | "internal" | "external";

const MODE_KEY = "dsh-link-open-mode";
const DEFAULT_MODE: LinkOpenMode = "ask";

export function getLinkMode(): LinkOpenMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "internal" || v === "external" || v === "ask") return v;
  } catch {
    /* 忽略 */
  }
  return DEFAULT_MODE;
}

export function setLinkMode(m: LinkOpenMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* 忽略 */
  }
}

/** 由 main.ts 注入实际打开动作（避免本模块与 tabManager / openUrl 循环依赖） */
export interface LinkOpener {
  /** 在 App 内新标签页打开 */
  openInApp: (url: string, title?: string) => void;
  /** 用系统浏览器打开 */
  openExternal: (url: string) => void;
}
let opener: LinkOpener | null = null;
export function registerLinkOpener(o: LinkOpener): void {
  opener = o;
}

/** 是否为可安全引导的 http(s) 链接（否则交给系统默认处理，如 mailto:） */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

let pendingUrl = "";
let dialogEl: HTMLElement | null = null;
let urlEl: HTMLElement | null = null;
let rememberEl: HTMLInputElement | null = null;
let bound = false;

function bindDialog(): void {
  if (bound) return;
  bound = true;
  dialogEl = document.getElementById("link-dialog");
  urlEl = document.getElementById("link-dialog-url");
  rememberEl = document.getElementById("link-remember") as HTMLInputElement | null;
  document.getElementById("link-in-app")?.addEventListener("click", () => {
    doOpen(pendingUrl, "internal", rememberEl?.checked ?? false);
  });
  document.getElementById("link-external")?.addEventListener("click", () => {
    doOpen(pendingUrl, "external", rememberEl?.checked ?? false);
  });
  // 点击遮罩关闭
  dialogEl?.addEventListener("click", (ev) => {
    if (ev.target === dialogEl) closeDialog();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && dialogEl && !dialogEl.hidden) {
      ev.preventDefault();
      closeDialog();
    }
  });
}

function doOpen(url: string, mode: "internal" | "external", remember: boolean): void {
  if (remember) setLinkMode(mode);
  // 记录历史：App 内打开与浏览器打开都留痕，便于历史面板回溯
  recordHistory(url);
  if (mode === "internal") opener?.openInApp(url);
  else opener?.openExternal(url);
  closeDialog();
}

export function closeDialog(): void {
  if (dialogEl) dialogEl.hidden = true;
  pendingUrl = "";
}

/** 显示打开方式选择框 */
export function showLinkDialog(url: string): void {
  bindDialog();
  pendingUrl = url;
  if (urlEl) urlEl.textContent = url;
  if (rememberEl) rememberEl.checked = false;
  if (dialogEl) dialogEl.hidden = false;
}

/**
 * 统一打开链接入口：
 * - 非 http(s)（mailto: / tel: 等）直接交给系统默认打开器；
 * - internal / external 按记住的偏好直接执行；
 * - ask（默认）弹出选择框。
 */
export function openLink(url: string, opts?: { forceAsk?: boolean }): void {
  const u = (url || "").trim();
  if (!u) return;
  if (!isHttpUrl(u)) {
    // 非网页协议：交给系统默认处理
    opener?.openExternal(u);
    return;
  }
  const mode = opts?.forceAsk ? "ask" : getLinkMode();
  if (mode === "internal") {
    recordHistory(u);
    opener?.openInApp(u);
    return;
  }
  if (mode === "external") {
    recordHistory(u);
    opener?.openExternal(u);
    return;
  }
  showLinkDialog(u);
}