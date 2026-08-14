// src/plugin-sources.ts —— 006 计划：插件中心「自维护 registry」数据层 adapter
//
// 分层（006 §6 决策）：
//   ① 打包快照 —— 构建期由 scripts/build-snapshot.mjs 生成 src/plugin-registry.generated.json，
//      随 app 发布、import 进 bundle，零网络、离线可用、秒开。
//   ② 后台刷新 —— 从 CDN（jsdelivr / GitHub raw）拉取 repo 根的 plugins.registry.json 最新版，
//      按 id diff 更新（stars / version / 新增），失败静默回退到快照；缓存复用 P0 的 plugin-cache.json。
//
// 上游只读不维护；过滤逻辑全在构建脚本（前端只读产物）。本文件只负责：取快照、拉最新、diff、版本播种。
import registryJson from "./plugin-registry.generated.json";

// ============================ 类型（与构建产物 schema 对齐） ============================

export type PluginSource = "awesome" | "topic";

export interface PluginEntry {
  /** 唯一键：lowercased full_name（owner/repo），或 npm 包名 */
  id: string;
  name: string;
  /** 来源成员关系：["awesome"] | ["topic"] | ["awesome","topic"]（后者为两源合并条目） */
  sources: PluginSource[];
  /** 展示链接（GitHub 仓库） */
  url?: string;
  /** awesome 分类（ui/theme/…）——来自 awesome 源时存在 */
  category?: string;
  /** marketplace 分类（web-ui/tool/…）——来自 topic 源时存在 */
  topicCategory?: string;
  description?: { zh?: string; en?: string };
  added?: string;
  stars?: number;
  license?: string;
  updated_at?: string;
  /** npm 包名（用于版本检查 / 详情）；github: 源或无 npm 字段时缺省 */
  pkg_name?: string;
  /** marketplace 探测的 npm 版本（可直接播种版本缓存，减少 npm 调用） */
  version?: string;
  /** 可直接 `dsh plugin add <installSpec>` 的安装规格 */
  installSpec: string;
  /** 是否 npm 可安装（非 github:/git+/file:） */
  isNpm: boolean;
}

export interface RegistrySnapshot {
  generated_at: string;
  count: number;
  awesome?: { updated?: string | null; count?: number; categories?: Record<string, { zh?: string; en?: string }> | null };
  marketplace?: { generated_at?: string | null; count?: number };
  filter_note?: string;
  plugins: PluginEntry[];
}

export interface RegistryDiff {
  latest: RegistrySnapshot;
  added: number;
  /** stars/version/license/updated_at 发生变化的条目数 */
  updated: number;
  /** base 中存在、latest 中消失的条目数（保留展示，仅统计） */
  removed: number;
}

// ============================ 常量 ============================

/** 自维护 registry 分发地址（构建产物写于 repo 根 plugins.registry.json）。
 *  gitee 镜像（国内最快，需自建同步）→ jsdelivr CDN（国内有节点、自动从 GitHub 同步）→ GitHub raw 兜底；
 *  并发拉取取 count 最新者，规避 jsdelivr 缓存滞后（gitee/jsdelivr→raw 实测 raw 最及时）。 */
const REGISTRY_CDN_URLS = [
  "https://cdn.jsdelivr.net/gh/zuoguyoupan2023/openharness@main/plugins.registry.json",
  "https://raw.githubusercontent.com/zuoguyoupan2023/openharness/main/plugins.registry.json",
];
/** gitee 镜像的默认地址（与 GitHub 仓库同 owner/repo 名；用户可在设置页改为自己的 gitee 镜像仓库）。
 *  仅在用户显式选择 gitee / 已填写 gitee URL 时参与取源，避免未配置时多一次无效请求。 */
const DEFAULT_GITEE_URL = "https://gitee.com/zuoguyoupan2023/openharness/raw/main/plugins.registry.json";
const LATEST_TIMEOUT_MS = 12_000;

/** awesome 11 分类顺序（标签来自快照 awesome.categories） */
export const AWESOME_CATEGORY_ORDER = ["ui", "theme", "session", "memory", "tools", "skill", "workflow", "notify", "model", "dev", "fun"];
/** marketplace 12 分类顺序（标签由 i18n 提供 plugins.topicCat.<key>） */
export const TOPIC_CATEGORY_ORDER = ["web-ui", "tool", "agent", "coding", "vision", "memory", "conversation", "notify", "model", "document", "resource", "other"];

/** 来源切换 tab id */
export type SourceTab = "awesome" | "topic" | "all";

// ============================ 索引源偏好（设置页「插件索引源」，localStorage，免新增 Rust 命令） ============================

/** 索引源：auto=全候选取最新；jsdelivr/raw=单源；gitee=自建 gitee 镜像（国内最快）；custom=任意镜像 URL */
export type IndexSource = "auto" | "jsdelivr" | "raw" | "gitee" | "custom";
const PREF_KEY = "oh-plugin-index-source";
const CUSTOM_KEY = "oh-plugin-index-source-custom";
const GITEE_KEY = "oh-plugin-index-source-gitee";

export function getIndexSourcePref(): IndexSource {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(PREF_KEY)) || "";
  return v === "jsdelivr" || v === "raw" || v === "gitee" || v === "custom" ? (v as IndexSource) : "auto";
}
export function getIndexSourceCustom(): string {
  return (typeof localStorage !== "undefined" && localStorage.getItem(CUSTOM_KEY)) || "";
}
/** gitee 镜像 URL（用户已配置则为该值；未配置返回空串——auto 链路仅在非空时纳入 gitee 候选） */
export function getIndexSourceGitee(): string {
  return (typeof localStorage !== "undefined" && localStorage.getItem(GITEE_KEY)) || "";
}
/** gitee 镜像的默认地址（设置页输入框 placeholder 用） */
export function getDefaultGiteeUrl(): string {
  return DEFAULT_GITEE_URL;
}
export function setIndexSourcePref(src: IndexSource, custom?: string): void {
  try {
    localStorage.setItem(PREF_KEY, src);
    if (custom !== undefined) localStorage.setItem(CUSTOM_KEY, custom);
  } catch {
    /* ignore */
  }
}
/** 持久化 gitee 镜像 URL；传空串则清除（auto 链路随之不再纳入 gitee） */
export function setIndexSourceGitee(url: string): void {
  try {
    if (url) localStorage.setItem(GITEE_KEY, url);
    else localStorage.removeItem(GITEE_KEY);
  } catch {
    /* ignore */
  }
}

/** 按偏好解析本次刷新的候选 URL：
 *  - auto：jsdelivr + raw，若已配置 gitee 则前置 gitee（国内最快优先）；
 *  - gitee：仅 gitee（未配置则回退 jsdelivr，避免直选 gitee 但未建镜像时报错）；
 *  - jsdelivr / raw / custom：单源。 */
function resolveRegistryUrls(): string[] {
  const pref = getIndexSourcePref();
  if (pref === "custom") {
    const cu = getIndexSourceCustom().trim();
    if (cu) return [cu];
  }
  const giteeUrl = getIndexSourceGitee().trim();
  if (pref === "gitee") return giteeUrl ? [giteeUrl] : REGISTRY_CDN_URLS;
  if (pref === "jsdelivr") return [REGISTRY_CDN_URLS[0]];
  if (pref === "raw") return [REGISTRY_CDN_URLS[1]];
  // auto：已配置 gitee 则前置（Promise.allSettled 并发取最新，gitee 不可达自动跳过）
  return giteeUrl ? [giteeUrl, ...REGISTRY_CDN_URLS] : [...REGISTRY_CDN_URLS];
}

// ============================ 快照（秒开基线） ============================

const SNAPSHOT = registryJson as unknown as RegistrySnapshot;

/** 打包快照（同步、零网络、离线可用）——进入插件中心即渲染此数据 */
export function getSnapshot(): RegistrySnapshot {
  return SNAPSHOT;
}

export function indexById(snap: RegistrySnapshot): Map<string, PluginEntry> {
  const m = new Map<string, PluginEntry>();
  for (const p of snap.plugins) if (p.id) m.set(p.id, p);
  return m;
}

// ============================ 后台刷新（CDN latest） ============================

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 并发拉取所有 CDN 候选，按 count（条目数）取最新者；全部失败返回 null（静默回退快照）。
 * 与 build-snapshot.mjs 同策略：规避 jsdelivr CDN 缓存滞后（实测比 raw 旧 ~10h）。
 */
export async function fetchLatestRegistry(timeoutMs = LATEST_TIMEOUT_MS): Promise<RegistrySnapshot | null> {
  const urls = resolveRegistryUrls();
  const settled = await Promise.allSettled(
    urls.map(async (u) => {
      const r = await fetchWithTimeout(u, timeoutMs);
      return (await r.json()) as RegistrySnapshot;
    })
  );
  const ok = settled.filter((s): s is PromiseFulfilledResult<RegistrySnapshot> => s.status === "fulfilled").map((s) => s.value);
  if (!ok.length) return null;
  ok.sort((a, b) => (b.count || 0) - (a.count || 0) || (b.plugins?.length || 0) - (a.plugins?.length || 0));
  return ok[0];
}

// ============================ diff（后台刷新后增量更新） ============================

/** 比较 base 与 latest（按 id），返回新增/变化/消失计数 + latest 原始快照 */
export function diffRegistries(base: RegistrySnapshot, latest: RegistrySnapshot): RegistryDiff {
  const baseMap = indexById(base);
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const p of latest.plugins) {
    const b = baseMap.get(p.id);
    if (!b) {
      added++;
      continue;
    }
    if (
      p.stars !== b.stars ||
      p.version !== b.version ||
      p.license !== b.license ||
      p.updated_at !== b.updated_at ||
      p.description?.zh !== b.description?.zh ||
      p.description?.en !== b.description?.en
    ) {
      updated++;
    }
  }
  const latestIds = new Set(latest.plugins.map((p) => p.id));
  for (const id of baseMap.keys()) if (!latestIds.has(id)) removed++;
  return { latest, added, updated, removed };
}

// ============================ 版本播种（复用 marketplace 探测的 version，减少 npm 调用） ============================

/**
 * 从 registry 条目中提取可播种的 npm 版本（pkg_name + version + npm 源），
 * 供 plugins.ts 合入 P0 的 plugin-cache.versions（缺省时填充，不覆盖已更新的）。
 */
export function seedVersionsFromRegistry(entries: PluginEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of entries) {
    if (p.isNpm && p.pkg_name && p.version && /^\d+\.\d+\./.test(p.version)) {
      out[p.pkg_name] = p.version;
    }
  }
  return out;
}

/** 条目的可读来源标签集合（UI 徽标用） */
export function sourceLabels(p: PluginEntry): PluginSource[] {
  return p.sources;
}