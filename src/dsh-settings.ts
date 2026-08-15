// src/dsh-settings.ts —— 壳 UI 与 DSH web（127.0.0.1:3080）的主题 / 语言双向同步
//
// 背景：Tauri 壳页面与 DSH web 不同源（3080 严格校验 Origin 为回环），壳前端无法跨源直连 /api，
// 因此所有读写都走 Rust 侧的 reqwest 命令（reqwest 不携带浏览器 Origin，3080 对回环放行）。
//
// 方向一（壳 → DSH）：用户切主题 / 语言时通过 theme-changed / lang-changed 触发 pushPref()，
//   Rust 命令 dsh_settings_set() → POST /api/settings.mutate 写入 ui-theme / locale。
// 方向二（DSH → 壳）：定时轮询 dsh_settings_snapshot()（Rust GET /describe），
//   检测到差异则把 DSH 当前值应用到壳；applyingRemote 标志抑制「应用 → 再回推」的循环。
import { invoke } from "@tauri-apps/api/core";
import { setThemePref, getThemePref, type ThemePref } from "./theme";
import { setLang, getLang, type Lang } from "./i18n";

const POLL_MS = 2000;

let syncing = false; // 轮询防重入
let applyingRemote = false; // 远程（DSH→壳）应用期间，抑制向 DSH 回推，避免无限循环

/**
 * 壳 → DSH：把一项偏好写入 DSH web。
 * @param ns   "ui-theme" 或 "locale"
 * @param value ui-theme 取 light/dark/system；locale 取 zh/en
 */
export async function pushPref(ns: "ui-theme" | "locale", value: string): Promise<void> {
  if (applyingRemote) return; // 本次是 DSH→壳的同步结果，不再回推
  try {
    await invoke("dsh_settings_set", { ns, value });
  } catch {
    // DSH 未就绪 / 未启动：静默，等轮询对齐
  }
}

/**
 * 同步助手：读取 DSH web 当前主题 / 语言并应用到壳（反向同步 + 启动对齐）。
 * 在相同值时不动作（幂等），因此不会造成多余写入。
 */
function applySync(): void {
  if (syncing) return;
  syncing = true;
  void (async () => {
    try {
      let snap: { theme: string; lang: string };
      try {
        const r = await invoke("dsh_settings_snapshot");
        snap = r as { theme: string; lang: string };
      } catch {
        return; // DSH 不可达：保持壳当前状态，下一次轮询再试
      }
      applyingRemote = true;
      try {
        const t = snap.theme as ThemePref | undefined;
        const l = snap.lang as Lang | undefined;
        if (t && t !== getThemePref()) setThemePref(t);
        if (l && l !== getLang()) setLang(l);
      } finally {
        applyingRemote = false;
      }
    } finally {
      syncing = false;
    }
  })();
}

/**
 * 启动双向同步：立即对齐一次，并开启定时轮询。
 */
export function startDshSettingsSync(): void {
  applySync();
  window.setInterval(applySync, POLL_MS);
}
