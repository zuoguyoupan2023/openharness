// src/downloads.ts —— 网页标签下载记录（Chrome 风格：文件名 / 来源 / 状态 / 目标路径）
// 数据来源：Rust 端 download-start / download-complete 事件（webview 下载由 WKDownload 原生接管）。
// 状态：downloading（进行中）→ completed / failed（由完成事件决定）。
import { t } from "./i18n";
import { iconSvg } from "./icons";
import { getDownloadDir, setDownloadDir } from "./config";
import { open } from "@tauri-apps/plugin-dialog";

export type DownloadStatus = "downloading" | "completed" | "failed";

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  path: string;
  status: DownloadStatus;
  time: number;
}

const KEY = "dsh-downloads-v1";
const MAX = 200;

function read(): DownloadItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is DownloadItem => {
      if (!x || typeof (x as DownloadItem).url !== "string") return false;
      const st = (x as DownloadItem).status;
      return st === "downloading" || st === "completed" || st === "failed";
    });
  } catch {
    return [];
  }
}

function write(items: DownloadItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
  } catch {
    /* localStorage 满/不可用：静默 */
  }
}

/** 记录一次下载开始（最新在前；同 URL 的旧记录保留，便于回溯反复下载） */
export function recordDownloadStart(url: string, filename: string, path: string): void {
  const items = read();
  items.unshift({
    id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    url,
    filename: filename || url.split("/").pop() || url,
    path,
    status: "downloading",
    time: Date.now(),
  });
  write(items);
}

/** 下载结束：把该 URL 最近一条「下载中」记录置为完成/失败（成功与否由系统回调决定） */
export function markDownloadEnd(url: string, success: boolean): void {
  const items = read();
  const idx = items.findIndex((it) => it.status === "downloading" && it.url === url);
  if (idx >= 0) items[idx].status = success ? "completed" : "failed";
  write(items);
}

export function getDownloads(): DownloadItem[] {
  return read();
}

export function clearDownloads(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

export function removeDownload(id: string): void {
  write(read().filter((it) => it.id !== id));
}

let hintEl: HTMLElement | null = null;

/** 页面内浮层提示（下载记录页内显示操作结果，避免干扰其它视图） */
function showHint(container: HTMLElement, msg: string): void {
  hideHint();
  hintEl = document.createElement("div");
  hintEl.className = "downloads-hint";
  hintEl.textContent = msg;
  container.appendChild(hintEl);
  window.setTimeout(() => hideHint(), 3500);
}

function hideHint(): void {
  hintEl?.remove();
  hintEl = null;
}

/** 弹出目录选择器，返回用户选中的目录；取消返回 null */
export async function pickDownloadDir(): Promise<string | null> {
  try {
    const sel = await open({ multiple: false, directory: true, title: t("downloads.changePath") });
    return typeof sel === "string" && sel.trim() ? sel.trim() : null;
  } catch {
    return null;
  }
}

/** 修改下载目录（空串 = 恢复默认）。返回 (ok, 提示消息) */
export async function applyDownloadDir(dir: string): Promise<{ ok: boolean; message: string }> {
  try {
    await setDownloadDir(dir);
    return { ok: true, message: dir ? t("downloads.pathChanged") : t("downloads.pathReset") };
  } catch (e) {
    return { ok: false, message: t("downloads.errChange") + String(e) };
  }
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DownloadsPageHandlers {
  /** 点击「修改目录」：选择新目录并保存（由调用方处理后重渲染） */
  onChangePath: (dir: string) => void;
  /** 点击「恢复默认下载目录」 */
  onResetPath: () => void;
  onClear: () => void;
  onRemove: (item: DownloadItem) => void;
  /** 用系统默认应用打开文件 */
  onOpenFile: (item: DownloadItem) => void;
  /** 在文件管理器中显示（打开所在文件夹） */
  onReveal: (item: DownloadItem) => void;
}

function statusLabel(st: DownloadStatus): string {
  if (st === "downloading") return t("downloads.downloading");
  if (st === "completed") return t("downloads.completed");
  return t("downloads.failed");
}

function statusIcon(st: DownloadStatus): string {
  if (st === "downloading") return "download";
  if (st === "completed") return "circle-check";
  return "triangle-alert";
}

function statusCls(st: DownloadStatus): string {
  if (st === "downloading") return "downloading";
  if (st === "completed") return "completed";
  return "failed";
}

/** 并发防护：同一容器并发渲染时（async 中途 await 交错），只允许最新一次调用把结果落盘，
 * 防止旧调用恢复后把已过期的页面再 append 上去（曾出现上下重复两份的 bug）。 */
const renderGen = new WeakMap<HTMLElement, number>();

/** 渲染下载记录整页（Chrome 风格：头部标题 + 清空、保存路径栏、状态列表） */
export async function renderDownloadsPage(
  container: HTMLElement,
  h: DownloadsPageHandlers
): Promise<void> {
  const gen = (renderGen.get(container) ?? 0) + 1;
  renderGen.set(container, gen);
  const stale = (): boolean => renderGen.get(container) !== gen;
  container.innerHTML = "";
  const page = document.createElement("div");
  page.className = "downloads-page";

  // ===== 头部：标题 + 清空记录 =====
  const head = document.createElement("div");
  head.className = "downloads-page-head";
  const title = document.createElement("div");
  title.className = "downloads-page-title";
  title.innerHTML = `${iconSvg("download")}<span>${t("downloads.title")}</span>`;
  const clearBtn = document.createElement("button");
  clearBtn.className = "btn-icon link-btn downloads-clear-btn";
  clearBtn.innerHTML = `${iconSvg("trash-2")}<span>${t("downloads.clear")}</span>`;
  clearBtn.addEventListener("click", () => h.onClear());
  head.appendChild(title);
  head.appendChild(clearBtn);
  page.appendChild(head);

  // ===== 保存路径栏：当前生效目录 + 修改 / 恢复默认 =====
  const pathRow = document.createElement("div");
  pathRow.className = "downloads-path-row";
  const icon = document.createElement("span");
  icon.className = "dl-path-icon";
  icon.innerHTML = iconSvg("folder-open");
  const pathVal = document.createElement("span");
  pathVal.className = "dl-path-value";
  let dirInfo: { configured: string | null; effective: string };
  try {
    dirInfo = await getDownloadDir();
  } catch {
    dirInfo = { configured: null, effective: "" };
  }
  // await 期间可能已有更新的渲染调用接管本容器：本次结果作废，避免重复 append
  if (stale()) return;
  pathVal.textContent = dirInfo.effective || "—";
  pathVal.title = dirInfo.effective;
  const changeBtn = document.createElement("button");
  changeBtn.className = "btn-icon";
  changeBtn.innerHTML = `${iconSvg("folder-open")}<span>${t("downloads.changePath")}</span>`;
  changeBtn.addEventListener("click", async () => {
    const dir = await pickDownloadDir();
    if (!dir) return;
    const r = await applyDownloadDir(dir);
    showHint(container, r.message);
    if (r.ok) h.onChangePath(dir);
  });
  pathRow.appendChild(icon);
  pathRow.appendChild(pathVal);
  if (!dirInfo.configured) {
    const tag = document.createElement("span");
    tag.className = "dl-path-default";
    tag.textContent = t("downloads.defaultDir");
    pathRow.appendChild(tag);
  }
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-icon link-btn";
  resetBtn.innerHTML = `${iconSvg("refresh-cw")}<span>${t("settings.download.reset")}</span>`;
  resetBtn.style.fontSize = "0.72rem";
  resetBtn.addEventListener("click", async () => {
    const r = await applyDownloadDir("");
    showHint(container, r.message);
    if (r.ok) h.onResetPath();
  });
  pathRow.appendChild(changeBtn);
  if (dirInfo.configured) pathRow.appendChild(resetBtn);
  page.appendChild(pathRow);

  // ===== 下载列表 =====
  const list = document.createElement("div");
  list.className = "downloads-page-list";
  const items = getDownloads();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = t("downloads.empty");
    list.appendChild(empty);
  } else {
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "downloads-item";
      row.title = it.url;

      const stIcon = document.createElement("span");
      stIcon.className = `dl-icon ${statusCls(it.status)}`;
      stIcon.innerHTML = iconSvg(statusIcon(it.status));

      const main = document.createElement("div");
      main.className = "dl-main";
      const name = document.createElement("div");
      name.className = "dl-name";
      name.textContent = it.filename;
      name.title = it.filename;
      const url = document.createElement("div");
      url.className = "dl-url";
      url.textContent = it.url;
      const pathline = document.createElement("div");
      pathline.className = "dl-pathline";
      pathline.textContent = it.path || "—";
      pathline.title = it.path;
      main.appendChild(name);
      main.appendChild(url);
      if (it.status !== "downloading") main.appendChild(pathline);
      row.appendChild(stIcon);
      row.appendChild(main);

      const side = document.createElement("div");
      side.className = "dl-side";
      const status = document.createElement("span");
      status.className = `dl-status ${statusCls(it.status)}`;
      status.textContent = statusLabel(it.status);
      const time = document.createElement("span");
      time.className = "dl-time";
      time.textContent = fmtTime(it.time);
      side.appendChild(status);
      if (it.status === "completed") {
        const actions = document.createElement("div");
        actions.className = "dl-actions";
        const openBtn = document.createElement("button");
        openBtn.className = "btn-icon link-btn";
        openBtn.innerHTML = `${iconSvg("external-link")}<span>${t("downloads.openFile")}</span>`;
        openBtn.addEventListener("click", () => h.onOpenFile(it));
        const revealBtn = document.createElement("button");
        revealBtn.className = "btn-icon link-btn";
        revealBtn.innerHTML = `${iconSvg("folder-open")}<span>${t("downloads.openFolder")}</span>`;
        revealBtn.addEventListener("click", () => h.onReveal(it));
        actions.appendChild(openBtn);
        actions.appendChild(revealBtn);
        side.appendChild(actions);
      }
      side.appendChild(time);
      row.appendChild(side);

      const del = document.createElement("button");
      del.className = "dl-del";
      del.textContent = "×";
      del.title = t("downloads.remove");
      del.addEventListener("click", () => h.onRemove(it));
      row.appendChild(del);

      list.appendChild(row);
    }
  }
  page.appendChild(list);
  container.appendChild(page);
}