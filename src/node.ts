// src/node.ts —— Node.js 环境检测与安装向导 API（与 Rust 后端通信）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface NodeCheck {
  ok: boolean;
  system: string | null;
  systemNpx: boolean;
  bundled: string | null;
  bundledPath: string | null;
  message: string;
}

export interface NodeProgress {
  source: string;
  /** checking / download / extract / verify / done */
  phase: string;
  downloaded: number;
  total: number;
  message: string;
}

export interface NodeReady {
  version: string;
  path: string;
}

export type NodeSourceKey = "auto" | "official" | "npmmirror" | "tuna";

/** 检测 Node 环境：系统（>=22 + npx）或内置 Node 二选一可用即 ok */
export async function checkNode(): Promise<NodeCheck> {
  try {
    return await invoke<NodeCheck>("check_node");
  } catch (e) {
    return {
      ok: false,
      system: null,
      systemNpx: false,
      bundled: null,
      bundledPath: null,
      message: "❌ 无法检测 Node 环境: " + String(e),
    };
  }
}

/** 启动内置 Node 下载安装（后台任务，进度走事件；source 见 NodeSourceKey） */
export async function downloadNode(source: string): Promise<string> {
  return invoke<string>("download_node", { source });
}

let listenersBound = false;
const progressListeners: ((p: NodeProgress) => void)[] = [];
const readyListeners: ((r: NodeReady) => void)[] = [];
const failListeners: ((msg: string) => void)[] = [];

export function onNodeProgress(fn: (p: NodeProgress) => void): void {
  progressListeners.push(fn);
}
export function onNodeReady(fn: (r: NodeReady) => void): void {
  readyListeners.push(fn);
}
export function onNodeFail(fn: (msg: string) => void): void {
  failListeners.push(fn);
}

/** 注册一次 Node 事件监听（幂等） */
export async function initNodeEvents(): Promise<void> {
  if (listenersBound) return;
  listenersBound = true;
  await listen<NodeProgress>("node-progress", (e) =>
    progressListeners.forEach((f) => f(e.payload))
  );
  await listen<NodeReady>("node-ready", (e) => readyListeners.forEach((f) => f(e.payload)));
  await listen<string>("node-fail", (e) => failListeners.forEach((f) => f(e.payload)));
}

/** 进度条百分比（download 阶段） */
export function progressPercent(p: NodeProgress): number {
  if (p.phase !== "download" || !p.total) return 0;
  return Math.min(100, Math.round((p.downloaded / p.total) * 100));
}
