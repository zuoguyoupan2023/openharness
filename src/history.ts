// src/history.ts —— 浏览历史记录（Chrome 风格：按天分组，点击重新打开）
// 记录来源：统一打开链接（open-link）与网页标签每次导航（tabs.ts 埋点）。
import { t } from "./i18n";
import { iconSvg } from "./icons";

export interface HistoryItem {
  url: string;
  title: string;
  time: number;
}

const KEY = "dsh-browser-history-v1";
const MAX = 800;
/** 同一 URL 在 n 毫秒内的再次访问视为重复，只更新标题与时间 */
const MERGE_MS = 60_000;

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function read(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is HistoryItem =>
        !!x && typeof (x as HistoryItem).url === "string" && typeof (x as HistoryItem).time === "number"
    );
  } catch {
    return [];
  }
}

function write(items: HistoryItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
  } catch {
    /* localStorage 满/不可用：静默 */
  }
}

/** 记录一次访问（时间倒序存储，最新在前） */
export function recordHistory(url: string, title?: string): void {
  const u = (url || "").trim();
  if (!/^https?:\/\//i.test(u)) return; // 只记录网页
  const items = read();
  const now = Date.now();
  const clean = title?.trim() ? title.trim() : hostOf(u);
  const idx = items.findIndex((it) => it.url === u);
  if (idx >= 0 && now - items[idx].time < MERGE_MS) {
    // 同 URL 短时间重复：更新标题与时间，提到最前
    items[idx] = { ...items[idx], title: clean || items[idx].title, time: now };
    const [hit] = items.splice(idx, 1);
    items.unshift(hit);
  } else if (idx >= 0) {
    items[idx] = { ...items[idx], title: clean || items[idx].title, time: now };
    const [hit] = items.splice(idx, 1);
    items.unshift(hit);
  } else {
    items.unshift({ url: u, title: clean, time: now });
  }
  write(items);
}

export function getHistory(): HistoryItem[] {
  return read();
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

interface Group {
  label: string;
  items: HistoryItem[];
}

/** 按 今天 / 昨天 / 更早（YYYY年M月D日） 分组，顺序即显示顺序 */
export function groupHistory(items: HistoryItem[]): Group[] {
  const now = new Date();
  const todayKey = dayKey(now.getTime());
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const yesterdayKey = dayKey(y.getTime());
  const groups: Group[] = [];
  const bucket = new Map<string, { label: string; items: HistoryItem[] }>();
  for (const it of items) {
    const k = dayKey(it.time);
    let label: string;
    if (k === todayKey) label = t("history.today");
    else if (k === yesterdayKey) label = t("history.yesterday");
    else {
      const d = new Date(it.time);
      label = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }
    let g = bucket.get(label);
    if (!g) {
      g = { label, items: [] };
      bucket.set(label, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}

/** 渲染历史面板内容；onOpen 由调用方提供（打开新标签并关闭面板） */
export function renderHistoryList(
  container: HTMLElement,
  onOpen: (item: HistoryItem) => void
): void {
  const items = getHistory();
  container.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = t("history.empty");
    container.appendChild(empty);
    return;
  }
  for (const g of groupHistory(items)) {
    const title = document.createElement("div");
    title.className = "history-group-title";
    title.textContent = g.label;
    container.appendChild(title);
    for (const it of g.items) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.title = it.url;
      const icon = document.createElement("span");
      icon.className = "hi-icon";
      icon.innerHTML = iconSvg("globe");
      const main = document.createElement("div");
      main.className = "hi-main";
      const name = document.createElement("div");
      name.className = "hi-title";
      name.textContent = it.title || hostOf(it.url);
      const url = document.createElement("div");
      url.className = "hi-url";
      url.textContent = it.url;
      main.appendChild(name);
      main.appendChild(url);
      const time = document.createElement("span");
      time.className = "hi-time";
      time.textContent = fmtTime(it.time);
      row.appendChild(icon);
      row.appendChild(main);
      row.appendChild(time);
      row.addEventListener("click", () => onOpen(it));
      container.appendChild(row);
    }
  }
}