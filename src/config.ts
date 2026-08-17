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
  /** 启动时额外默认打开的标签页 URL 列表（不含 3080，3080 固定主标签） */
  defaultTabs: string[];
  /** 启动时是否恢复上次会话（默认 true） */
  restoreSession: boolean;
  /** 网页标签下载保存目录；null / 空 = 系统默认下载目录 */
  downloadDir: string | null;
}

/** 下载目录查询结果 */
export interface DownloadDirInfo {
  /** 用户配置的目录；未配置为 null */
  configured: string | null;
  /** 当前实际生效的绝对路径（配置优先，否则系统默认下载目录） */
  effective: string;
}

export async function getSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("get_settings");
  } catch {
    return {
      registry: NPM_OFFICIAL,
      closeWithApp: true,
      dshVersionLocked: null,
      dshUpdateMode: "auto",
      defaultTabs: [],
      restoreSession: true,
      downloadDir: null,
    };
  }
}

/** 查询当前实际生效的下载目录 */
export async function getDownloadDir(): Promise<DownloadDirInfo> {
  return invoke<DownloadDirInfo>("get_download_dir");
}

/** 设置下载目录（空串 = 恢复系统默认） */
export async function setDownloadDir(dir: string): Promise<Settings> {
  return invoke<Settings>("set_download_dir", { dir });
}

export async function setDefaultTabs(tabs: string[]): Promise<Settings> {
  return invoke<Settings>("set_default_tabs", { tabs });
}

export async function setRestoreSession(enabled: boolean): Promise<Settings> {
  return invoke<Settings>("set_restore_session", { enabled });
}

export async function setRegistry(url: string): Promise<Settings> {
  return invoke<Settings>("set_registry", { url });
}

export async function setCloseWithApp(enabled: boolean): Promise<Settings> {
  return invoke<Settings>("set_close_with_app", { enabled });
}
