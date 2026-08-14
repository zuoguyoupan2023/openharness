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

export function onLog(fn: Listener<string>): void {
  logListeners.push(fn);
}
export function onReady(fn: Listener<string>): void {
  readyListeners.push(fn);
}
export function onExit(fn: Listener<void>): void {
  exitListeners.push(fn);
}

let initialized = false;

/** 注册一次 Tauri 事件监听（幂等） */
export async function initDsh(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<string>("dsh-log", (e) => logListeners.forEach((f) => f(e.payload)));
  await listen<string>("dsh-ready", (e) => readyListeners.forEach((f) => f(e.payload)));
  await listen<void>("dsh-exit", () => exitListeners.forEach((f) => f()));
}

export async function startDsh(): Promise<string> {
  return invoke<string>("start_dsh");
}

export async function restartDsh(): Promise<string> {
  return invoke<string>("restart_dsh");
}

export async function runDshCmd(args: string[]): Promise<string> {
  return invoke<string>("run_dsh_cmd", { args });
}

export async function listInstalled(): Promise<InstalledPlugins> {
  try {
    return await invoke<InstalledPlugins>("list_installed_plugins");
  } catch {
    return { deps: {}, bundles: [], profile: "" };
  }
}

export function installedNames(p: InstalledPlugins): string[] {
  return [...Object.keys(p.deps || {}), ...(p.bundles || [])];
}
