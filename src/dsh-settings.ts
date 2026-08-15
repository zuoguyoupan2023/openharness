// src/dsh-settings.ts —— 壳 UI 与 DSH web（127.0.0.1:3080）的主题 / 语言双向同步
//
// 背景：Tauri 壳页面与 DSH web 不同源（3080 严格校验 Origin 为回环），壳前端无法跨源直连 /api，
// 因此所有读写都走 Rust 侧的 reqwest / WebSocket（Rust 不携带浏览器 Origin，3080 对回环放行）。
//
// 方向一（壳 → DSH）：用户切主题 / 语言时通过 theme-changed / lang-changed 触发 pushPref()，
//   Rust 命令 dsh_settings_set() → POST /api/settings.mutate 写入 ui-theme / locale。
// 方向二（DSH → 壳，实时）：Rust 后台订阅 ws://127.0.0.1:3080/api/events.host，
//   收到 settings/document-updated 帧后 emit "dsh-settings-event"(ns)，前端监听后调用
//   dsh_settings_snapshot() 拉取最新值应用；applyingRemote 标志抑制「应用 → 再回推」的循环。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { setThemePref, getThemePref, type ThemePref } from "./theme";
import { setLang, getLang, type Lang } from "./i18n";

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
    // DSH 未就绪 / 未启动：静默，DSH 就绪后的首次反向应用会再次对齐
  }
}

/**
 * 拉取 DSH web 当前主题 / 语言并应用到壳（DSH → 壳反向同步）。
 * 相同值时不动作（幂等），因此不会造成多余写入。
 */
async function applyFromDsh(): Promise<void> {
  let snap: { theme: string; lang: string };
  try {
    const r = await invoke("dsh_settings_snapshot");
    snap = r as { theme: string; lang: string };
  } catch {
    return; // DSH 不可达：保持壳当前状态
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
}

/**
 * 启动双向同步：
 * 1. 立即对齐一次（启动时以 DSH 当前偏好为准）。
 * 2. 调用 Rust 后台 WebSocket 订阅；DSH web 内任何主题/语言变更都会实时推回来，触发反向应用。
 * 返回卸载函数（用于停止监听）。
 */
export async function startDshSettingsSync(): Promise<UnlistenFn> {
  // 立即对齐一次
  void applyFromDsh();

  // 订阅 DSH 设置变更事件（Rust 侧 WebSocket → Tauri event）
  const unlisten = await listen<string>("dsh-settings-event", (e) => {
    const ns = e.payload;
    if (ns === "ui-theme" || ns === "locale") void applyFromDsh();
  });

  // 启动 Rust 后台订阅（常驻重连）；失败也无妨，Rust 端会自己重连
  try {
    await invoke("dsh_settings_subscribe");
  } catch {
    /* 静默：下次仍可重试 */
  }

  return unlisten;
}
