// src/theme.ts —— 浅色 / 深色主题（壳 UI；对话网页内容由 DSH 自身控制）
const KEY = "oh-theme";
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

let pref: ThemePref = "system";
const mq = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  return pref;
}

export function effectiveTheme(): Theme {
  if (pref === "system") return mq.matches ? "dark" : "light";
  return pref;
}

/** 把生效主题写到 <html data-theme> 与 color-scheme（原生滚动条/输入控件跟随） */
export function applyTheme(): void {
  const t = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  window.dispatchEvent(new Event("theme-changed"));
}

export function setThemePref(p: ThemePref): void {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
  applyTheme();
}

/** 快捷按钮：亮 ↔ 暗 直接切换（离开「跟随系统」） */
export function cycleTheme(): void {
  setThemePref(effectiveTheme() === "dark" ? "light" : "dark");
}

export function initTheme(): void {
  try {
    const saved = localStorage.getItem(KEY) as ThemePref | null;
    if (saved === "light" || saved === "dark" || saved === "system") pref = saved;
  } catch {
    pref = "system";
  }
  applyTheme();
  mq.addEventListener("change", () => {
    if (pref === "system") applyTheme();
  });
}
