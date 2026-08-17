// src/config.ts —— 壳设置（npm registry 镜像等）
import { invoke } from "@tauri-apps/api/core";

/** 官方默认源：空串 = 不注入，使用用户/系统默认 npm 配置 */
export const NPM_OFFICIAL = "";
/** 淘宝 npmmirror 国内加速源 */
export const NPM_MIRROR = "https://registry.npmmirror.com";

export interface Settings {
  registry: string;
  /** 关闭 app 时是否同时关闭 3080 上的 DSH（默认 true） */
  closeWithApp: boolean;
  /** DSH 版本锁定：x.y.z = 固定该版本；null = 跟随最新（默认） */
  dshVersionLocked: string | null;
  /** DSH 更新模式：auto = 自动更新（默认）；manual = 手动更新 */
  dshUpdateMode: string;
}

export async function getSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("get_settings");
  } catch {
    return { registry: NPM_OFFICIAL, closeWithApp: true, dshVersionLocked: null, dshUpdateMode: "auto" };
  }
}

export async function setRegistry(url: string): Promise<Settings> {
  return invoke<Settings>("set_registry", { url });
}

export async function setCloseWithApp(enabled: boolean): Promise<Settings> {
  return invoke<Settings>("set_close_with_app", { enabled });
}
