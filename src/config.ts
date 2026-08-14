// src/config.ts —— 壳设置（npm registry 镜像等）
import { invoke } from "@tauri-apps/api/core";

/** 官方默认源：空串 = 不注入，使用用户/系统默认 npm 配置 */
export const NPM_OFFICIAL = "";
/** 淘宝 npmmirror 国内加速源 */
export const NPM_MIRROR = "https://registry.npmmirror.com";

export interface Settings {
  registry: string;
}

export async function getSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("get_settings");
  } catch {
    return { registry: NPM_OFFICIAL };
  }
}

export async function setRegistry(url: string): Promise<Settings> {
  return invoke<Settings>("set_registry", { url });
}
