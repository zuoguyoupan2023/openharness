// src/dsh.ts —— DSH 生命周期与事件总线（与 Rust 后端通信）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const DSH_URL = "http://127.0.0.1:3080";

export interface InstalledPlugins {
  deps: Record<string, string>;
  bundles: string[];
  profile: string;
  error?: string | null;
}

type Listener<T> = (payload: T) => void;

const logListeners: Listener<string>[] = [];
const readyListeners: Listener<string>[] = [];
const exitListeners: Listener<void>[] = [];
const updateCheckListeners: Listener<DshUpdateCheck>[] = [];

export function onLog(fn: Listener<string>): void {
  logListeners.push(fn);
}
export function onReady(fn: Listener<string>): void {
  readyListeners.push(fn);
}
export function onExit(fn: Listener<void>): void {
  exitListeners.push(fn);
}
/** 后台更新检查结果事件（spawn_dsh 后 3 秒推送一次；是否提示由调用方 semver 判断） */
export function onUpdateCheck(fn: Listener<DshUpdateCheck>): void {
  updateCheckListeners.push(fn);
}

/** semver 比较（含预发布）：a > b 返回 1；a < b 返回 -1；相等返回 0。
 *  先比 base 三段数字；base 相等时正式版 > 预发布（0.1.0 > 0.1.0-rc.6）。 */
export function cmpSemver(a: string, b: string): number {
  const preA = a.split("+")[0].split("-");
  const preB = b.split("+")[0].split("-");
  const baseA = preA[0].split(".").map((n) => parseInt(n, 10) || 0);
  const baseB = preB[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(baseA.length, baseB.length); i++) {
    const d = (baseA[i] || 0) - (baseB[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const ra = preA.length > 1 ? preA[1] : "";
  const rb = preB.length > 1 ? preB[1] : "";
  if (ra === rb) return 0;
  if (ra === "") return 1; // 正式版 > 预发布
  if (rb === "") return -1;
  return ra < rb ? -1 : 1;
}

let initialized = false;

/** 注册一次 Tauri 事件监听（幂等） */
export async function initDsh(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<string>("dsh-log", (e) => logListeners.forEach((f) => f(e.payload)));
  await listen<string>("dsh-ready", (e) => readyListeners.forEach((f) => f(e.payload)));
  await listen<void>("dsh-exit", () => exitListeners.forEach((f) => f()));
  await listen<DshUpdateCheck>("dsh-update-check", (e) =>
    updateCheckListeners.forEach((f) => f(e.payload))
  );
  await listen<TermOutput>("term-output", (e) =>
    termOutputListeners.forEach((f) => f(e.payload))
  );
  await listen<TermOutput>("term-exit", (e) =>
    termExitListeners.forEach((f) => f(e.payload))
  );
  await listen<TermOutput>("term-input-debug", (e) =>
    termInputDebugListeners.forEach((f) => f(e.payload))
  );
}

export type TermInputDebugListener = (payload: TermOutput) => void;
const termInputDebugListeners: TermInputDebugListener[] = [];
export function onTermInputDebug(fn: TermInputDebugListener): void {
  termInputDebugListeners.push(fn);
}

export async function startDsh(): Promise<string> {
  return invoke<string>("start_dsh");
}

export async function restartDsh(): Promise<string> {
  return invoke<string>("restart_dsh");
}

// ===== DSH 版本管理（版本检查 / 更新模式） =====

export interface DshVersionInfo {
  /** 当前实际使用（将使用）的版本；不可用时为 null */
  current: string | null;
  /** registry 上最新版本；不可用时为 null */
  latest: string | null;
  /** 锁定版本（未锁定为 null） */
  locked: string | null;
  /** 更新模式：auto = 自动更新；manual = 手动更新 */
  updateMode: string;
}

/** 后台更新检查结果（spawn_dsh 后 3 秒后端推送一次，事件 `dsh-update-check`） */
export interface DshUpdateCheck {
  /** 上次 spawn 记录的实际使用版本（无记录为 null） */
  current: string | null;
  /** registry 最新版本（查询失败为 null） */
  latest: string | null;
  /** 更新模式：auto / manual */
  updateMode: string;
}

/** 版本信息：当前使用 / 最新 / 锁定 / 更新模式（设置页「DSH 更新」卡片） */
export function getDshVersionInfo(): Promise<DshVersionInfo> {
  return invoke<DshVersionInfo>("dsh_version_info");
}

/** 手动触发一次更新检查（设置页「重新检查」；结果事件 `dsh-update-check` 会推给全局 banner） */
export function checkDshUpdateNow(): Promise<DshUpdateCheck | null> {
  return invoke<DshUpdateCheck | null>("check_dsh_update_now");
}

/** 预下载指定 DSH 版本到 npx 缓存（不启动服务；下载/校验失败抛错，正在运行的版本不受影响） */
export function predownloadDshVersion(version: string): Promise<string> {
  return invoke<string>("predownload_dsh_version", { version });
}

/** 锁定 / 解锁 DSH 版本：传版本号锁定；传 null 解锁（跟随最新）。改动需重启 DSH 生效。 */
export function setDshVersionLock(version: string | null): Promise<unknown> {
  return invoke("set_dsh_version_lock", { version });
}

/** 设置 DSH 更新模式：auto = 自动更新（跟随最新）；manual = 手动更新。切 auto 会自动解锁。 */
export function setDshUpdateMode(mode: "auto" | "manual"): Promise<unknown> {
  return invoke("set_dsh_update_mode", { mode });
}

export async function runDshCmd(args: string[]): Promise<string> {
  return invoke<string>("run_dsh_cmd", { args });
}

/** 嵌入式终端：向 DSH 子进程 stdin 写入片段（终端输入 → 子进程）。
 * 返回空串表示当前没有可写的子进程（外部实例 / 未启动）。 */
export async function writeStdin(chunk: string): Promise<string> {
  return invoke<string>("write_stdin", { chunk });
}

// ===== 多 shell 终端 =====

/** 新建一个独立 shell 终端（提供真实 PTY）。id 需全局唯一；rows/cols 为初始尺寸。 */
export function termSpawn(id: string, rows: number, cols: number): Promise<string> {
  return invoke<string>("term_spawn", { id, rows, cols });
}
/** 向某个 shell 终端写入输入片段 */
export function termWrite(id: string, data: string): Promise<void> {
  return invoke<void>("term_write", { id, data });
}
/** 同步某个 shell 终端的窗口尺寸到 PTY（供 vim/top 等自适应） */
export function termResize(id: string, rows: number, cols: number): Promise<void> {
  return invoke<void>("term_resize", { id, rows, cols });
}
/** 关闭某个 shell 终端 */
export function termKill(id: string): Promise<void> {
  return invoke<void>("term_kill", { id });
}

// ===== 智能体启动器（L1：检测 + 一键启动）=====

export interface AgentInfo {
  key: string;
  name: string;
  installed: boolean;
  path: string;
}

/** 检测所有已知智能体是否已安装 */
export function agentList(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>("agent_list");
}

/** 一键启动某个已安装的智能体（在独立 PTY 里直接运行其 CLI） */
export function agentSpawn(id: string, rows: number, cols: number, agent: string): Promise<string> {
  return invoke<string>("agent_spawn", { id, rows, cols, agent });
}

export interface TermOutput {
  id: string;
  data: string;
}
type TermOutputListener = (payload: TermOutput) => void;
type TermExitListener = (payload: TermOutput) => void;
const termOutputListeners: TermOutputListener[] = [];
const termExitListeners: TermExitListener[] = [];
export function onTermOutput(fn: TermOutputListener): void {
  termOutputListeners.push(fn);
}
export function onTermExit(fn: TermExitListener): void {
  termExitListeners.push(fn);
}

export async function listInstalled(): Promise<InstalledPlugins> {
  try {
    return await invoke<InstalledPlugins>("list_installed_plugins");
  } catch {
    return { deps: {}, bundles: [], profile: "" };
  }
}

/** 读取插件缓存（Rust 侧 $APP_DATA/plugin-cache.json；缺失返回空对象） */
export async function getPluginCache(): Promise<Record<string, unknown>> {
  try {
    return (await invoke<Record<string, unknown>>("get_plugin_cache")) || {};
  } catch {
    return {};
  }
}

/** 写入插件缓存（原子替换） */
export async function setPluginCache(cache: Record<string, unknown>): Promise<void> {
  await invoke("set_plugin_cache", { cache });
}

export function installedNames(p: InstalledPlugins): string[] {
  // deps 与 bundles 可能重叠（bundle 层通常同时是 dependency），去重避免重复 chips
  return [...new Set([...Object.keys(p.deps || {}), ...(p.bundles || [])])];
}
