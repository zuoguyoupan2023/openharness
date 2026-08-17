// src/plugins.ts —— 插件中心（006 计划：双数据源 + 详情 + 秒开）
// 定位（决策 C）：app 管「生命周期」（安装/更新/卸载/重启生效/版本检查），dsh web 管「配置」。
//
// 006 变更：索引源升级为「自维护 registry」（plugin-sources.ts）——
//   ① 打包快照（构建期 build-snapshot.mjs 生成 awesome + marketplace 归一去重）导入即秒开、离线可用；
//   ② 后台从 CDN 拉 plugins.registry.json 最新版，按 id diff 更新（stars/version/新增），失败静默回退快照；
//   ③ 缓存复用 P0 的 plugin-cache.json（versions + registry 快照）。
// 不再运行时直拉 awesome-dsh-plugin.com。
// UI：来源 tabs（精选 awesome / GitHub Topic / 全部合并）+ ★stars + 来源徽标 + 状态/操作 + 行内详情。
import {
  listInstalled,
  installedNames,
  runDshCmd,
  restartDsh,
  getPluginCache,
  setPluginCache,
  type InstalledPlugins,
} from "./dsh";
import { open } from "@tauri-apps/plugin-dialog";
import { t, getLang } from "./i18n";
import { iconSvg } from "./icons";
import {
  getSnapshot,
  fetchLatestRegistry,
  diffRegistries,
  seedVersionsFromRegistry,
  AWESOME_CATEGORY_ORDER,
  TOPIC_CATEGORY_ORDER,
  type PluginEntry,
  type RegistrySnapshot,
} from "./plugin-sources";
import { RECOMMENDED_PLUGINS } from "./plugin-recommended";

const OFFICIAL_PKGS: Array<{ name: string; descKey: string }> = [
  { name: "@deepseek-ai/dsh-base", descKey: "plugins.official.base" },
  { name: "@deepseek-ai/dsh-web-app", descKey: "plugins.official.web" },
  { name: "@deepseek-ai/dsh-headless", descKey: "plugins.official.headless" },
  { name: "@deepseek-ai/dsh-llm-deepseek", descKey: "plugins.official.llm" },
];

/** npm registry 元数据（详情页用：版本历史 / README / 依赖 / 作者） */
interface NpmMeta {
  name?: string;
  description?: string;
  author?: string | { name?: string };
  license?: string;
  readme?: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

/** 详情页元数据会话级缓存（同一插件只拉一次） */
const metaCache = new Map<string, NpmMeta | null>();

const REGISTRY_BASES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
/** 自动更新检查间隔：每 6 小时后台静默检查已安装插件 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 旧版 localStorage 缓存键（一次性迁移到 Rust 侧后删除） */
const LEGACY_VERSION_KEY = "oh-plugin-versions";
const LEGACY_BASELINE_KEY = "oh-plugin-baseline";

/** P0 插件缓存（$APP_DATA/plugin-cache.json）；006 扩展：新增 registry 快照缓存 */
interface PluginCache {
  /** pkgName -> npm 最新版本（失败的 "—" 不落盘） */
  versions: Record<string, string>;
  updatedAt?: string;
  registry?: { snapshot: RegistrySnapshot; fetchedAt: string };
}

export interface PluginCenterOptions {
  /** 动作反馈：切到日志视图并追加一行日志 */
  onAction: (msg: string) => void;
}

// ============================ 小工具 ============================

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compareVer(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 去掉末尾版本号：@scope/name@1.2.3 -> @scope/name；name@1.2.3 -> name */
function pkgNameOf(spec: string): string {
  const idx = spec.lastIndexOf("@");
  if (idx > 0 && /^\d/.test(spec.slice(idx + 1))) return spec.slice(0, idx);
  return spec;
}

/** 从安装 spec 解析可比较版本：^0.3.4 -> 0.3.4；file:/github:/workspace: 等返回 null */
function installedVersionOf(spec: string): string | null {
  if (!spec || /^(file:|link:|github:|git\+|workspace:)/.test(spec)) return null;
  const m = /^[~^>=<v]*(\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?)/.exec(spec.trim());
  return m ? m[1] : null;
}

function formatStars(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** 带超时 + 镜像回退的 registry GET */
async function fetchWithFallback<T>(path: string): Promise<T | null> {
  for (const base of REGISTRY_BASES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${base}${path}`, { signal: ctrl.signal });
      if (r.ok) return (await r.json()) as T;
    } catch {
      // 国内网络可能失败，回退 npmmirror
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function fetchVersion(name: string): Promise<string> {
  const d = await fetchWithFallback<{ version?: string }>(`/${encodeURIComponent(name)}/latest`);
  return d?.version ?? "—";
}

/** 拉取 npm 完整元数据（详情页：版本历史 time / README / 依赖 / 作者），失败返回 null */
async function fetchNpmMeta(name: string): Promise<NpmMeta | null> {
  if (metaCache.has(name)) return metaCache.get(name) ?? null;
  const d = await fetchWithFallback<NpmMeta>(`/${encodeURIComponent(name)}`);
  metaCache.set(name, d);
  return d;
}

/** npm registry 搜索结果（/-/v1/search 简写） */
interface NpmSearchItem {
  package?: { name?: string; version?: string; description?: string; links?: { homepage?: string } };
}
interface NpmSearchResult {
  objects?: NpmSearchItem[];
}
/** 按文本在 npm registry 实时搜索（镜像回退），失败返回空数组 */
async function searchNpm(text: string): Promise<NpmSearchItem[]> {
  const d = await fetchWithFallback<NpmSearchResult>(
    `/-/v1/search?text=${encodeURIComponent(text)}&size=12`
  );
  return d?.objects ?? [];
}

/** 已安装 chip 的版本标签：file:/link: 本地链接显示「本地」；npm spec 原样 */
function chipVersionLabel(v: string): string {
  if (!v) return "";
  if (/^(file:|link:|\.|\/)/.test(v)) return t("plugins.chipLocal");
  return v;
}

// ============================ 本地插件安装（.tgz / 本地目录） ============================

/**
 * 计算「更新」一个已安装插件要执行的 dsh 命令：
 *  - npm 包：`dsh plugin update <pkgName>`（走 registry 升级到最新，含版本比较语义）；
 *  - github / 本地 file: 等非 npm：`dsh plugin add <installSpec>`（重新解析同一源，取最新）。
 * 由已安装依赖的 spec 值（installed.deps[name]）判断：本地 file:/link: 或 github 走 add。
 */
function updateCommandFor(isNpm: boolean, spec: string | undefined, pkgFallback: string): string[] {
  const specVal = spec ?? "";
  if (isNpm && !/^(github:|git\+|file:|link:|\.|\/)/.test(specVal)) {
    // npm 源：走 pnpm update 到最新
    return ["plugin", "--profile", "web", "update", pkgFallback];
  }
  // github: / file: / 本地目录 / link：无法用 npm 版本语义比较，重新 add 同一 spec 即可
  const target = specVal && !/^\.{0,2}\//.test(specVal) ? specVal : pkgFallback;
  return ["plugin", "--profile", "web", "add", target];
}

// ============================ 主入口 ============================

export function initPlugins(opts: PluginCenterOptions): void {
  const els = {
    refresh: $("plugins-refresh") as HTMLButtonElement,
    refreshLabel: $("plugins-refresh-label") as HTMLSpanElement,
    search: $("plugins-search") as HTMLInputElement, // 共享搜索框（随主 tab 切换语义）
    searchGo: $("plugins-search-go") as HTMLButtonElement,
    mainTabs: $("plugin-main-tabs"),
    githubViews: $("plugin-github-views"),
    cats: $("plugin-cats"),
    chips: $("installed-chips"),
    path: $("profile-path"),
    official: $("official-grid"),
    tbody: $("plugin-tbody"),
    table: $("plugin-table"),
    count: $("plugin-count"),
    loading: $("plugin-loading"),
    banner: $("plugin-snapshot-banner"),
    badge: document.getElementById("nav-plugins-badge") as HTMLElement | null,
    npmSearch: $("plugins-search") as HTMLInputElement, // npm tab 下即包名搜索
    npmGo: $("plugins-search-go") as HTMLButtonElement,
    npmResults: $("plugins-npm-results") as HTMLElement,
    filterMode: $("plugin-filter-mode") as HTMLSelectElement,
    sortMode: $("plugin-sort-mode") as HTMLSelectElement,
    indexMeta: $("plugin-index-meta"),
    localBtns: $("plugins-local-btns"),
    localDirBtn: $("local-dir-btn") as HTMLButtonElement,
    localTgzBtn: $("local-tgz-btn") as HTMLButtonElement,
    localError: $("local-error"),
    localList: $("local-installed-list"),
    githubPanel: $("plugin-github-panel"),
    npmPanel: $("plugin-npm-panel"),
    localPanel: $("plugin-local-panel"),
    officialQuick: $("official-quick") as HTMLButtonElement,
  };

  // —— P1 信息架构状态（013 已确认：主 tab 默认 GitHub，GitHub 二级默认 awesome）——
  type MainTab = "github" | "npm" | "local";
  type GithubView = "awesome" | "topics" | "all" | "recommended";
  type FilterMode = "all" | "installed" | "updatable" | "notinstalled";
  type SortMode = "default" | "stars" | "updated" | "name";
  let mainTab: MainTab = "github";
  let githubView: GithubView = "awesome";
  let filterMode: FilterMode = "all";
  let sortMode: SortMode = "default";
  let filterCat = "";
  let filterText = "";

  // —— P2：UI 状态持久化（013 §P2：主 tab / 二级视图 / 分类 / 筛选 / 排序 / 搜索 / 滚动位置 localStorage 重启恢复）——
  const UI_STATE_KEY = "dsh-plugins-ui-state";
  interface UiState {
    mainTab: MainTab;
    githubView: GithubView;
    filterCat: string;
    filterMode: FilterMode;
    sortMode: SortMode;
    filterText: string;
    scrollTop: number;
  }
  const isOneOf = <T extends string>(v: string | undefined, arr: readonly T[]): v is T =>
    !!v && (arr as readonly string[]).includes(v);
  const readUiState = (): UiState => {
    const def: UiState = { mainTab: "github", githubView: "awesome", filterCat: "", filterMode: "all", sortMode: "default", filterText: "", scrollTop: 0 };
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return def;
      const s = JSON.parse(raw) as Partial<UiState>;
      return {
        mainTab: isOneOf(s.mainTab, ["github", "npm", "local"] as const) ? s.mainTab : def.mainTab,
        githubView: isOneOf(s.githubView, ["awesome", "topics", "all", "recommended"] as const) ? s.githubView : def.githubView,
        filterCat: typeof s.filterCat === "string" ? s.filterCat : "",
        filterMode: isOneOf(s.filterMode, ["all", "installed", "updatable", "notinstalled"] as const) ? s.filterMode : def.filterMode,
        sortMode: isOneOf(s.sortMode, ["default", "stars", "updated", "name"] as const) ? s.sortMode : def.sortMode,
        filterText: typeof s.filterText === "string" ? s.filterText : "",
        scrollTop: typeof s.scrollTop === "number" && s.scrollTop > 0 ? s.scrollTop : 0,
      };
    } catch {
      return def;
    }
  };
  const saveUiState = (): void => {
    const v = document.getElementById("view-plugins");
    const state: UiState = {
      mainTab,
      githubView,
      filterCat,
      filterMode,
      sortMode,
      filterText,
      scrollTop: v ? v.scrollTop : 0,
    };
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
    } catch {
      /* localStorage 不可用时静默，不影响 UI */
    }
  };
  const savedState = readUiState();
  mainTab = savedState.mainTab;
  githubView = savedState.githubView;
  filterCat = savedState.filterCat;
  filterMode = savedState.filterMode;
  sortMode = savedState.sortMode;
  filterText = savedState.filterText;
  let snapshot: RegistrySnapshot = getSnapshot();
  let plugins: PluginEntry[] = snapshot.plugins;
  let categoriesLabels: Record<string, { zh?: string; en?: string }> = snapshot.awesome?.categories ?? {};
  let installed: InstalledPlugins = { deps: {}, bundles: [], profile: "" };
  let versions: Record<string, string> = {};
  /** 当前展示快照来源：bundle / cache / cdn */
  let snapshotSource: "bundle" | "cache" | "cdn" = "bundle";
  /** 最近一次后台 diff 提示（初始无提示） */
  let diffHint: { kind: "ok" | "fresh" | "fail" | null; n?: number; added?: number; updated?: number; at?: string } = { kind: null };

  const isInstalled = (name: string): boolean => installedNames(installed).includes(name);

  /** 已安装 spec 查找：优先 npm 包名，其次索引名（两源名称可能不一致） */
  const installedSpecOf = (pkg: string, indexName: string): string | undefined => {
    const deps = installed.deps || {};
    return deps[pkg] ?? deps[indexName];
  };

  /** 是否「可更新」：已安装 npm 包，且最新版本 > 已安装版本 */
  const isUpdatable = (indexName: string, pkg: string, latest: string | undefined): boolean => {
    if (!latest || latest === "—") return false;
    const spec = installedSpecOf(pkg, indexName);
    if (!spec) return false;
    const iv = installedVersionOf(spec);
    return iv !== null && compareVer(latest, iv) > 0;
  };

  /** 可更新的已安装插件数量（侧边栏角标） */
  const countUpdatable = (): number => {
    let n = 0;
    for (const name of installedNames(installed)) {
      const pkg = pkgNameOf(name);
      const spec = installedSpecOf(pkg, name);
      if (!spec) continue;
      const latest = versions[pkg];
      if (!latest || latest === "—") continue;
      const iv = installedVersionOf(spec);
      if (iv !== null && compareVer(latest, iv) > 0) n++;
    }
    return n;
  };

  const updateBadge = (): void => {
    if (!els.badge) return;
    const n = countUpdatable();
    els.badge.hidden = n === 0;
    els.badge.textContent = n > 99 ? "99+" : String(n);
    els.badge.title = n ? t("plugins.badgeUpdates", { n }) : "";
  };

  // —— 缓存读写（P0 plugin-cache.json；006 扩展 registry 快照）——

  const persistCache = async (withRegistry = false): Promise<void> => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(versions)) {
      if (v && v !== "—") clean[k] = v;
    }
    const cache: PluginCache = { versions: clean, updatedAt: new Date().toISOString() };
    if (withRegistry) cache.registry = { snapshot, fetchedAt: new Date().toISOString() };
    try {
      await setPluginCache(cache as unknown as Record<string, unknown>);
    } catch {
      /* 磁盘失败不影响 UI，下次再试 */
    }
    try {
      localStorage.removeItem(LEGACY_VERSION_KEY);
      localStorage.removeItem(LEGACY_BASELINE_KEY);
    } catch {
      /* ignore */
    }
  };

  /**
   * 从 Rust 侧加载缓存：
   *  - versions（并迁移旧 localStorage 版本号）；
   *  - registry 快照：若比打包快照更新（generated_at 更晚或 count 更多），则改用缓存快照作展示基线。
   * 随后用 registry 条目播种 versions（marketplace 探测的 version，减少 npm 调用）。
   */
  const loadCache = async (): Promise<void> => {
    try {
      const cached = (await getPluginCache()) as Partial<PluginCache>;
      if (cached.versions && typeof cached.versions === "object") {
        versions = { ...versions, ...cached.versions };
      }
      if (cached.registry?.snapshot) {
        const c = cached.registry.snapshot;
        const newer =
          (c.generated_at || "") > (snapshot.generated_at || "") ||
          (c.count || 0) > (snapshot.count || 0);
        if (newer) {
          snapshot = c;
          plugins = c.plugins;
          categoriesLabels = c.awesome?.categories ?? {};
          snapshotSource = "cache";
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_VERSION_KEY) || "{}") as Record<string, unknown>;
      for (const [k, v] of Object.entries(legacy)) {
        if (typeof v === "string" && v !== "—" && !versions[k]) versions[k] = v;
      }
    } catch {
      /* ignore */
    }
    // 种子：用 registry 探测的 version 填充缺省（仅未安装插件——已安装的由 checkInstalledUpdates 拉 npm 真最新，保证「可更新」检测时效）
    const installedPkgSet = new Set(installedNames(installed).map(pkgNameOf));
    const seeded = seedVersionsFromRegistry(plugins);
    for (const [k, v] of Object.entries(seeded)) {
      if ((!versions[k] || versions[k] === "—") && !installedPkgSet.has(k)) versions[k] = v;
    }
  };

  async function loadInstalled(): Promise<void> {
    installed = await listInstalled();
    els.path.textContent = installed.profile || "";
    const names = installedNames(installed);
    els.chips.innerHTML = "";
    if (!names.length) {
      els.chips.textContent = t("plugins.emptyInstalled");
      return;
    }
    names.forEach((n) => {
      const spec = (installed.deps || {})[n];
      const isDep = spec !== undefined;
      const label = chipVersionLabel(spec);
      const pkg = pkgNameOf(n);
      const el = document.createElement("span");
      el.className = "chip";
      el.title = spec ? `${n}@${spec}` : n;
      const txt = document.createElement("span");
      txt.textContent = label ? `${n} @${label}` : n;
      if (isDep) txt.classList.add("chip-open"); // P1-4：chip 主体可点击跳转来源详情
      txt.title = isDep ? t("plugins.chipJumpHint") : "";
      txt.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (isDep) chipOpenDetail(n, spec);
      });
      el.appendChild(txt);
      if (isDep) {
        // 更新图标仅「npm 且可更新」时出现；github/本地 chips 不显示更新图标（语义不同，走重新安装，见表格/详情）
        const updatable = isUpdatable(n, pkg, versions[pkg]);
        if (updatable && !/^(github:|git\+)/.test(spec || "")) {
          const upCmd = updateCommandFor(true, spec, pkg);
          const up = document.createElement("button");
          up.className = "chip-rm";
          up.title = t("plugins.update") + " " + pkg;
          up.innerHTML = iconSvg("refresh-cw");
          up.addEventListener("click", (ev) => {
            ev.stopPropagation();
            enqueueAction([{ label: `${t("plugins.update")} ${pkg}`, cmd: upCmd }]);
          });
          el.appendChild(up);
        }
        const rm = document.createElement("button");
        rm.className = "chip-rm";
        rm.title = t("plugins.remove") + " " + n;
        rm.innerHTML = iconSvg("x");
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          armChipRemove(el, n, `${t("plugins.remove")} ${n}`);
        });
        el.appendChild(rm);
      }
      els.chips.appendChild(el);
    });
  }

  /** P1-4：已安装 chip 点击 → 跳到对应来源 tab 并展开详情 / 搜索该包 */
  function chipOpenDetail(name: string, spec: string | undefined): void {
    const pkg = pkgNameOf(name);
    if (/^(file:|link:)/.test(spec || "")) {
      switchMainTab("local"); // 本地 → 本地 tab（列表可见）
      return;
    }
    if (/^(github:|git\+)/.test(spec || "")) {
      // GitHub → 「全部」视图 + 搜索该包 + 定位展开
      switchMainTab("github");
      githubView = "all";
      filterCat = "";
      filterText = pkg;
      els.search.value = pkg;
      renderGithubViews();
      renderCategories();
      renderTable(true);
      const v = document.getElementById("view-plugins");
      if (v) v.scrollTop = 0;
      locateAndOpen(pkg);
      return;
    }
    // npm → 切到 npm tab 并搜索该包（结果行内可展开详情）
    switchMainTab("npm");
    els.search.value = pkg;
    void runNpmSearch();
  }

  function locateAndOpen(pkg: string): void {
    const tr = els.tbody.querySelector<HTMLTableRowElement>(`tr.plugin-row[data-pkg="${CSS.escape(pkg)}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: "center" });
    const idx = Number(tr.dataset.idx || "-1");
    const p = idx >= 0 && idx < currentRows.length ? currentRows[idx] : undefined;
    if (p) toggleDetail(tr, p);
  }

  // —— 主 tabs（GitHub / npm / 本地，默认 GitHub，已确认 2026-08-17）——
  function renderMainTabs(): void {
    els.mainTabs.innerHTML = "";
    const tabs: Array<[MainTab, string, string]> = [
      ["github", "plugins.tab.github", "github"],
      ["npm", "plugins.tab.npm", "package"],
      ["local", "plugins.tab.local", "folder-open"],
    ];
    for (const [id, key, icon] of tabs) {
      const b = document.createElement("button");
      b.className = "main-tab" + (mainTab === id ? " active" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(mainTab === id));
      b.innerHTML = `${iconSvg(icon)}<span>${t(key)}</span>`;
      b.addEventListener("click", () => switchMainTab(id));
      els.mainTabs.appendChild(b);
    }
  }

  /** 切换主 tab：切换面板 / 搜索框语义 / 工具栏可见性 */
  function switchMainTab(next: MainTab): void {
    if (mainTab === next) return;
    mainTab = next;
    renderMainTabs();
    refreshToolbarVisibility();
    els.githubPanel.hidden = mainTab !== "github";
    els.npmPanel.hidden = mainTab !== "npm";
    els.localPanel.hidden = mainTab !== "local";
    els.search.placeholder =
      mainTab === "github" ? t("plugins.searchGithub") : mainTab === "npm" ? t("plugins.searchNpm") : t("plugins.searchLocal");
    if (mainTab === "github") {
      renderGithubViews();
      renderCategories();
      renderTable(true);
      renderIndexInfo();
      const v = document.getElementById("view-plugins");
      if (v) v.scrollTop = 0;
    } else if (mainTab === "npm") {
      closeNpmResults();
    } else {
      renderLocalInstalled();
      hideLocalError();
    }
    saveUiState(); // P2：主 tab 变更即持久化
  }

  /** 工具栏可见性：共享搜索框常显；搜索/本地按钮/筛选/排序/刷新随主 tab 切换 */
  function refreshToolbarVisibility(): void {
    els.searchGo.hidden = mainTab !== "npm";
    els.localBtns.hidden = mainTab !== "local";
    els.filterMode.hidden = mainTab !== "github";
    els.sortMode.hidden = mainTab !== "github";
    els.refresh.hidden = mainTab !== "github";
  }

  // —— GitHub 二级视图（awesome / topics / 全部 / 特别推荐）——
  function renderGithubViews(): void {
    els.githubViews.innerHTML = "";
    const views: Array<[GithubView, string, string]> = [
      ["awesome", "plugins.githubView.awesome", "star"],
      ["topics", "plugins.githubView.topics", "github"],
      ["all", "plugins.githubView.all", "boxes"],
      ["recommended", "plugins.githubView.recommended", "circle-check"],
    ];
    for (const [id, key, icon] of views) {
      const b = document.createElement("button");
      b.className = "src-tab" + (githubView === id ? " active" : "");
      b.setAttribute("aria-pressed", String(githubView === id));
      b.innerHTML = `${iconSvg(icon)}<span>${t(key)}</span>`;
      b.addEventListener("click", () => {
        githubView = id;
        filterCat = ""; // 切视图时重置分类
        renderGithubViews();
        renderCategories();
        renderTable(true);
        const v = document.getElementById("view-plugins");
        if (v) v.scrollTop = 0;
        saveUiState(); // P2
      });
      els.githubViews.appendChild(b);
    }
  }

  // —— 筛选 / 排序下拉（GitHub tab；已确认：全部/已安装/可更新/未安装；Stars/最近更新/名称）——
  function fillModeSelects(): void {
    els.filterMode.innerHTML = "";
    const modes: Array<[FilterMode, string]> = [
      ["all", "plugins.filter.all"],
      ["installed", "plugins.filter.installed"],
      ["updatable", "plugins.filter.updatable"],
      ["notinstalled", "plugins.filter.notInstalled"],
    ];
    for (const [v, key] of modes) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t(key);
      els.filterMode.appendChild(o);
    }
    els.filterMode.value = filterMode;
    els.sortMode.innerHTML = "";
    const sorts: Array<[SortMode, string]> = [
      ["default", "plugins.sort.default"],
      ["stars", "plugins.sort.stars"],
      ["updated", "plugins.sort.updated"],
      ["name", "plugins.sort.name"],
    ];
    for (const [v, key] of sorts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t(key);
      els.sortMode.appendChild(o);
    }
    els.sortMode.value = sortMode;
  }

  // —— 分类 chips（依据当前 GitHub 二级视图词汇表；特别推荐视图不显示）——
  function renderCategories(): void {
    els.cats.innerHTML = "";
    if (githubView === "recommended") return; // 特别推荐不显示大分类 chips（名单很小）
    const lang = getLang();
    const mk = (key: string, label: string): void => {
      const chip = document.createElement("button");
      chip.className = "cat-chip" + (filterCat === key ? " active" : "");
      chip.textContent = label;
      chip.setAttribute("aria-pressed", String(filterCat === key));
      chip.addEventListener("click", () => {
        filterCat = filterCat === key ? "" : key;
        renderCategories();
        renderTable(true);
        const v = document.getElementById("view-plugins");
        if (v) v.scrollTop = 0;
        saveUiState(); // P2
      });
      els.cats.appendChild(chip);
    };
    mk("", t("plugins.allCat"));
    if (githubView === "topics") {
      TOPIC_CATEGORY_ORDER.forEach((c) => mk(c, t(`plugins.topicCat.${c}`) || c));
    } else {
      AWESOME_CATEGORY_ORDER.forEach((c) => mk(c, categoriesLabels[c]?.[lang] ?? c));
    }
  }

  /** 官方组合包卡（P1-5：显示已装版本/最新版本/可更新；按 P0-6 语义给更新/重新安装；不提供卸载，已确认） */
  function renderOfficial(): void {
    els.official.innerHTML = "";
    for (const p of OFFICIAL_PKGS) {
      const card = document.createElement("div");
      card.className = "official-card";
      const installedFlag = isInstalled(p.name);
      const instSpec = (installed.deps || {})[p.name];
      const latest = versions[p.name];
      const updatable = isUpdatable(p.name, p.name, latest);
      const info = document.createElement("div");
      info.className = "official-name";
      info.textContent = p.name;
      card.appendChild(info);
      const desc = document.createElement("div");
      desc.className = "official-desc";
      desc.textContent = t(p.descKey);
      card.appendChild(desc);
      const btn = document.createElement("button");
      btn.className = "btn-icon";
      if (installedFlag) {
        const verLine = document.createElement("div");
        verLine.className = "official-ver";
        let v = `@${instSpec ?? "?"}`;
        if (latest && latest !== "—") v += ` → ${latest}`;
        if (updatable) v += ` · ${t("plugins.updateTag")}`;
        verLine.textContent = v;
        card.appendChild(verLine);
        if (updatable) {
          btn.innerHTML = iconSvg("upload") + t("plugins.update");
          btn.title = latest && latest !== "—" ? `${t("plugins.updateTo")} ${latest}` : t("plugins.update");
          btn.addEventListener("click", () =>
            enqueueAction([{ label: `${t("plugins.update")} ${p.name}`, cmd: ["plugin", "--profile", "web", "update", p.name] }])
          );
        } else {
          btn.innerHTML = iconSvg("refresh-cw") + t("plugins.reinstall");
          btn.title = t("plugins.reinstall");
          btn.addEventListener("click", () =>
            enqueueAction([{ label: `${t("plugins.reinstall")} ${p.name}`, cmd: ["plugin", "--profile", "web", "add", p.name] }])
          );
        }
      } else {
        btn.innerHTML = iconSvg("download") + t("plugins.install");
        btn.addEventListener("click", () =>
          enqueueAction([{ label: `${t("plugins.install")} ${p.name}`, cmd: ["plugin", "--profile", "web", "add", p.name] }])
        );
      }
      card.appendChild(btn);
      els.official.appendChild(card);
    }
  }

  /** 特别推荐合成条目：附带 reasonKey 供表格行 title/aria-label 显示推荐理由 */
  interface RecommendedEntry extends PluginEntry {
    reasonKey?: string;
  }

  /** 特别推荐 5 项 → 合成 PluginEntry（registry 命中则补齐 stars/license/版本/描述；未命中也照常渲染，安装用自带 installSpec） */
  function recommendedEntries(): PluginEntry[] {
    return RECOMMENDED_PLUGINS.map((r) => {
      const hit = plugins.find(
        (p) =>
          p.pkg_name === r.npmPkg ||
          p.name === r.npmPkg ||
          p.name === r.githubRepo ||
          (p.url ?? "").endsWith(r.githubRepo)
      );
      const reason = t(r.reasonKey);
      const e: RecommendedEntry = {
        id: r.id,
        name: r.npmPkg,
        sources: hit?.sources ?? [],
        url: hit?.url ?? r.url,
        description: hit?.description ?? { zh: reason, en: reason },
        category: hit?.category,
        topicCategory: hit?.topicCategory,
        stars: hit?.stars,
        license: hit?.license,
        updated_at: hit?.updated_at,
        pkg_name: r.npmPkg,
        version: hit?.version,
        installSpec: r.installSpec,
        isNpm: true,
        reasonKey: r.reasonKey,
      };
      return e;
    });
  }

  /** 特别推荐行的来源徽标：推荐 + GitHub + npm 双来源（P1-2） */
  function recBadgesHtml(): string {
    return (
      `<span class="src-badge recommended" title="${escHtml(t("plugins.recommendedBadge"))}">${escHtml(t("plugins.recommendedBadge"))}</span>` +
      `<span class="src-badge topic" title="GitHub">GitHub</span>` +
      `<span class="src-badge awesome" title="npm">npm</span>`
    );
  }

  /** 当前 GitHub 视图 + 分类 + 筛选 + 排序 + 搜索 过滤后的条目（P1-2） */
  function filtered(): PluginEntry[] {
    const base =
      githubView === "recommended"
        ? recommendedEntries()
        : plugins.filter((p) => {
            if (githubView === "awesome" && !p.sources.includes("awesome")) return false;
            if (githubView === "topics" && !p.sources.includes("topic")) return false;
            return true; // all
          });
    const q = filterText.trim().toLowerCase();
    const rows = base.filter((p) => {
      const pkg = p.pkg_name ?? pkgNameOf(p.installSpec);
      const installedFlag = isInstalled(pkg) || isInstalled(p.name);
      if (filterCat) {
        if (githubView === "topics") {
          if (p.topicCategory !== filterCat) return false;
        } else if (p.category !== filterCat) return false;
      }
      if (filterMode === "installed" && !installedFlag) return false;
      if (filterMode === "notinstalled" && installedFlag) return false;
      if (filterMode === "updatable" && !isUpdatable(p.name, pkg, versions[pkg])) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.description?.zh ?? ""} ${p.description?.en ?? ""} ${p.pkg_name ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
    if (sortMode === "stars") return [...rows].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    if (sortMode === "updated") return [...rows].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    if (sortMode === "name") return [...rows].sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  /** 详情页操作按钮（安装/更新/重新安装/卸载，P0-6 语义 + P0-3 确认） */
  function appendDetailActions(container: HTMLElement, p: PluginEntry): void {
    const spec = p.installSpec;
    const pkg = p.pkg_name ?? pkgNameOf(spec);
    const installedFlag = isInstalled(pkg) || isInstalled(p.name);
    container.innerHTML = "";
    if (installedFlag) {
      const instSpec = installedSpecOf(pkg, p.name); // 已安装的依赖 spec（含 github:/file: 值）
      const npm = p.isNpm;
      const latest = versions[pkg];
      if (!npm) {
        // github / 本地：重新安装（无 npm 版本语义）
        const upCmd = updateCommandFor(false, instSpec, pkg);
        const up = document.createElement("button");
        up.className = "install-btn btn-icon";
        up.innerHTML = iconSvg("refresh-cw") + t("plugins.reinstall");
        up.title = t("plugins.reinstall");
        up.addEventListener("click", () =>
          enqueueAction([{ label: `${t("plugins.reinstall")} ${pkg}`, cmd: upCmd }])
        );
        container.appendChild(up);
      } else if (isUpdatable(p.name, pkg, latest)) {
        const upCmd = updateCommandFor(true, instSpec, pkg);
        const up = document.createElement("button");
        up.className = "install-btn btn-icon";
        up.innerHTML = iconSvg("upload") + t("plugins.update");
        up.title = latest && latest !== "—" ? `${t("plugins.updateTo")} ${latest}` : t("plugins.update");
        up.addEventListener("click", () =>
          enqueueAction([{ label: `${t("plugins.update")} ${pkg}`, cmd: upCmd }])
        );
        container.appendChild(up);
      } else {
        const up = document.createElement("button");
        up.className = "install-btn btn-icon";
        up.disabled = true;
        up.innerHTML = iconSvg("check") + t("plugins.alreadyLatest");
        up.title = t("plugins.alreadyLatest");
        container.appendChild(up);
      }
      const rm = document.createElement("button");
      rm.className = "install-btn btn-icon";
      rm.innerHTML = iconSvg("trash-2") + t("plugins.remove");
      rm.addEventListener("click", () =>
        confirmRemoveInPlace(rm, `${t("plugins.remove")} ${p.name}`, ["plugin", "--profile", "web", "remove", p.name])
      );
      container.appendChild(rm);
    } else {
      const inst = document.createElement("button");
      inst.className = "install-btn btn-icon";
      inst.innerHTML = iconSvg("download") + t("plugins.install");
      inst.addEventListener("click", () =>
        enqueueAction([{ label: `${t("plugins.install")} ${spec}`, cmd: ["plugin", "--profile", "web", "add", spec] }])
      );
      container.appendChild(inst);
    }
  }

  /** 行内详情：npm 版本历史 / 依赖 / README / 作者 / 许可证 */
  async function renderNpmDetail(body: HTMLElement, pkg: string, seq: number): Promise<void> {
    const meta = await fetchNpmMeta(pkg);
    if (seq !== detailSeq) return; // 详情已关闭或已切换：丢弃过期结果（P0-5）
    if (!meta) {
      body.innerHTML = `<div class="detail-note">${escHtml(t("plugins.detail.fail"))}</div>`;
      return;
    }
    const latest = meta["dist-tags"]?.latest ?? "";
    const author = typeof meta.author === "string" ? meta.author : meta.author?.name ?? "—";
    const license = meta.license ?? "—";
    const updated = (latest && meta.time?.[latest]) || meta.time?.modified || "";

    const history: Array<[string, string]> = [];
    if (meta.time && meta.versions) {
      for (const [v, ts] of Object.entries(meta.time)) {
        if (meta.versions[v] && ts) history.push([v, ts]);
      }
      history.sort((a, b) => (a[1] < b[1] ? 1 : -1));
    }

    const deps = latest ? meta.versions?.[latest]?.dependencies : undefined;
    const depNames = deps ? Object.keys(deps) : [];
    const fmt = (ts: string): string => (ts ? ts.slice(0, 10) : "—");

    let html = "";
    html += `<div class="detail-grid">`;
    html += `<div class="detail-kv"><span>${escHtml(t("plugins.detail.latest"))}</span><b>${escHtml(latest || "—")}</b></div>`;
    html += `<div class="detail-kv"><span>${escHtml(t("plugins.detail.author"))}</span><b>${escHtml(author)}</b></div>`;
    html += `<div class="detail-kv"><span>${escHtml(t("plugins.detail.license"))}</span><b>${escHtml(license)}</b></div>`;
    html += `<div class="detail-kv"><span>${escHtml(t("plugins.detail.updated"))}</span><b>${escHtml(fmt(updated))}</b></div>`;
    html += `</div>`;

    html += `<div class="detail-section"><span class="detail-section-title">${escHtml(t("plugins.detail.versionHistory"))}</span><div class="detail-versions">`;
    if (history.length) {
      for (const [v, ts] of history.slice(0, 10)) {
        const cur = v === latest ? " current" : "";
        html += `<span class="ver-chip${cur}" title="${escHtml(fmt(ts))}">${escHtml(v)}</span>`;
      }
      if (history.length > 10) html += `<span class="ver-more">+${history.length - 10}</span>`;
    } else {
      html += `<span class="detail-note">${escHtml(t("plugins.detail.noHistory"))}</span>`;
    }
    html += `</div></div>`;

    html += `<div class="detail-section"><span class="detail-section-title">${escHtml(t("plugins.detail.deps"))}</span><div class="detail-deps">`;
    if (depNames.length) {
      for (const d of depNames.slice(0, 20)) {
        html += `<code class="dep-chip">${escHtml(d)}<i>@${escHtml(deps?.[d] ?? "")}</i></code>`;
      }
      if (depNames.length > 20) html += `<span class="ver-more">+${depNames.length - 20}</span>`;
    } else {
      html += `<span class="detail-note">${escHtml(t("plugins.detail.noDeps"))}</span>`;
    }
    html += `</div></div>`;

    if (seq !== detailSeq) return;
    body.innerHTML = html;

    if (seq !== detailSeq) return;
    const readme = meta.readme?.trim();
    const sec = document.createElement("div");
    sec.className = "detail-section";
    const title = document.createElement("span");
    title.className = "detail-section-title";
    title.textContent = t("plugins.detail.readme");
    sec.appendChild(title);
    const box = document.createElement("div");
    box.className = "detail-readme";
    if (readme) {
      box.textContent = readme;
    } else {
      box.textContent = t("plugins.detail.noReadme");
      box.classList.add("empty");
    }
    sec.appendChild(box);
    body.appendChild(sec);
  }

  /** 仓库元数据网格（来自 registry 条目本身，无网络）：stars / 许可证 / 最近更新 / 分类 */
  function repoMetaHtml(p: PluginEntry): string {
    const lang = getLang();
    const catLabel =
      githubView === "topics"
        ? p.topicCategory
          ? t(`plugins.topicCat.${p.topicCategory}`) || p.topicCategory
          : "—"
        : p.category
        ? categoriesLabels[p.category]?.[lang] ?? p.category
        : p.topicCategory
        ? t(`plugins.topicCat.${p.topicCategory}`) || p.topicCategory
        : "—";
    const upd = p.updated_at ? p.updated_at.slice(0, 10) : "—";
    return `<div class="detail-grid">
      <div class="detail-kv"><span>${escHtml(t("plugins.detail.stars"))}</span><b>★ ${escHtml(formatStars(p.stars))}</b></div>
      <div class="detail-kv"><span>${escHtml(t("plugins.detail.license"))}</span><b>${escHtml(p.license || "—")}</b></div>
      <div class="detail-kv"><span>${escHtml(t("plugins.detail.updated"))}</span><b>${escHtml(upd)}</b></div>
      <div class="detail-kv"><span>${escHtml(t("plugins.detail.category"))}</span><b>${escHtml(catLabel)}</b></div>
    </div>`;
  }

  /** 来源徽标 HTML */
  function sourceBadgesHtml(p: PluginEntry): string {
    const badges: string[] = [];
    if (p.sources.includes("awesome"))
      badges.push(`<span class="src-badge awesome" title="${escHtml(t("plugins.src.awesomeTip"))}">${escHtml(t("plugins.src.awesome"))}</span>`);
    if (p.sources.includes("topic"))
      badges.push(`<span class="src-badge topic" title="${escHtml(t("plugins.src.topicTip"))}">${escHtml(t("plugins.src.topic"))}</span>`);
    return badges.join("");
  }

  /** 详情竞态序号（P0-5）：打开/关闭详情都递增，使旧 npm 详情写入失效 */
  let detailSeq = 0;
  /** 展开/收起行内详情（单页无路由：点击插件行切换） */
  function toggleDetail(tr: HTMLTableRowElement, p: PluginEntry): void {
    detailSeq++; // 任何切换都使进行中的旧请求失效
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains("plugin-detail-row")) {
      existing.remove();
      tr.classList.remove("open");
      return;
    }
    els.tbody.querySelectorAll<HTMLTableRowElement>(".plugin-detail-row").forEach((r) => r.remove());
    els.tbody.querySelectorAll<HTMLTableRowElement>("tr.open").forEach((r) => r.classList.remove("open"));

    const detailTr = document.createElement("tr");
    detailTr.className = "plugin-detail-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "plugin-detail-td";

    const box = document.createElement("div");
    box.className = "plugin-detail";

    const head = document.createElement("div");
    head.className = "detail-head";
    const nameEl = document.createElement("span");
    nameEl.className = "detail-name";
    nameEl.textContent = p.name;
    head.appendChild(nameEl);
    const srcWrap = document.createElement("span");
    srcWrap.className = "detail-src";
    srcWrap.innerHTML = sourceBadgesHtml(p);
    head.appendChild(srcWrap);
    if (p.url) {
      const link = document.createElement("a");
      link.className = "detail-link";
      link.href = p.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = p.url;
      head.appendChild(link);
    }
    const actions = document.createElement("span");
    actions.className = "detail-actions";
    head.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "detail-meta";
    const desc = p.description?.zh || p.description?.en || "";
    if (desc) {
      const descEl = document.createElement("div");
      descEl.className = "detail-desc";
      descEl.textContent = desc;
      meta.appendChild(descEl);
    }
    const specRow = document.createElement("div");
    specRow.className = "detail-spec";
    const lbl = document.createElement("span");
    lbl.textContent = t("plugins.detail.installSpec");
    const code = document.createElement("code");
    code.textContent = p.installSpec;
    specRow.appendChild(lbl);
    specRow.appendChild(code);
    meta.appendChild(specRow);

    // 仓库元数据网格（无网络）
    const repoMeta = document.createElement("div");
    repoMeta.className = "detail-repo";
    repoMeta.innerHTML = repoMetaHtml(p);
    meta.appendChild(repoMeta);

    const body = document.createElement("div");
    body.className = "detail-body";

    box.appendChild(head);
    box.appendChild(meta);
    box.appendChild(body);
    td.appendChild(box);
    detailTr.appendChild(td);

    tr.classList.add("open");
    tr.after(detailTr);

    appendDetailActions(actions, p);

    if (p.isNpm) {
      const pkg = p.pkg_name ?? pkgNameOf(p.installSpec);
      body.textContent = t("plugins.detail.loading");
      void renderNpmDetail(body, pkg, detailSeq);
    } else {
      const note = document.createElement("div");
      note.className = "detail-note";
      note.textContent = t("plugins.detail.nonNpm", { spec: p.installSpec });
      body.appendChild(note);
    }
  }

  function renderTable(reset = true): void {
    if (reset) visibleRows = TABLE_PAGE;
    const rows = filtered();
    currentRows = rows;
    els.count.textContent = String(rows.length);
    els.tbody.innerHTML = "";
    els.table.style.display = rows.length ? "table" : "none";
    if (!rows.length) {
      els.loading.textContent = t("plugins.noMatch");
      els.loading.style.display = "block";
      renderMore(0);
      return;
    }
    els.loading.style.display = "none";
    const slice = rows.slice(0, visibleRows);
    const isRec = githubView === "recommended";
    slice.forEach((p, i) => {
      const spec = p.installSpec;
      const npm = p.isNpm;
      const pkg = p.pkg_name ?? pkgNameOf(spec);
      const ver = npm ? (versions[pkg] || p.version || "—") : null;
      const installedFlag = isInstalled(pkg) || isInstalled(p.name);
      const updatable = isUpdatable(p.name, pkg, versions[pkg]);

      let verHtml = escHtml(ver ?? "—");
      if (!npm) {
        verHtml = `<span class="ver-src">${spec.startsWith("github:") ? "github" : "git"}</span>`;
      }

      let tagHtml = "";
      if (isRec) tagHtml = `<span class="tag recommended">${t("plugins.recommendedBadge")}</span>`;
      if (installedFlag) tagHtml += `<span class="tag installed">${t("plugins.installedTag")}</span>`;
      else if (npm && ver && ver !== "—") tagHtml += `<span class="tag latest">${t("plugins.latestTag")}</span>`;
      if (updatable) tagHtml += `<span class="tag update">${t("plugins.updateTag")}</span>`;

      const desc = (p.description?.zh || p.description?.en || "").slice(0, 120);
      const reasonKey = isRec ? (p as RecommendedEntry).reasonKey : undefined;
      const reason = reasonKey ? t(reasonKey) : "";
      const tr = document.createElement("tr");
      tr.className = "plugin-row";
      tr.tabIndex = 0; // P1-6 键盘可达
      tr.title = isRec && reason ? `${t("plugins.recommendedBadge")} · ${reason}` : t("plugins.detail.hint");
      tr.setAttribute("aria-label", `${p.name}${reason ? " · " + reason : ""}`);
      tr.dataset.pkg = pkg;
      tr.dataset.idx = String(i);
      tr.innerHTML = `
        <td class="pkg"><a href="${escHtml(p.url || "#")}" target="_blank" rel="noopener">${escHtml(p.name)}</a></td>
        <td class="desc">${escHtml(desc)}</td>
        <td class="ver">${verHtml}</td>
        <td class="stars">${iconSvg("star")}<span>${escHtml(formatStars(p.stars))}</span></td>
        <td class="src">${isRec ? recBadgesHtml() : sourceBadgesHtml(p)}</td>
        <td>${tagHtml}</td>
        <td class="actions">${tableActionsHtmlFor(p)}</td>`;
      bindRowActions(tr, p);
      const openDetail = (): void => toggleDetail(tr, p);
      tr.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest("a, button, [data-act]")) return;
        openDetail();
      });
      tr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openDetail();
        }
      });
      els.tbody.appendChild(tr);
    });
    renderMore(rows.length);
  }

  /** 顶部快照/diff 提示条 */
  function renderBanner(): void {
    if (!els.banner) return;
    if (!diffHint || diffHint.kind === null || diffHint.kind === "fresh") {
      els.banner.style.display = "none";
      return;
    }
    els.banner.style.display = "flex";
    const srcLabel = t(`plugins.snapshot.src.${snapshotSource}`);
    if (diffHint.kind === "ok") {
      const details = diffHint.added || diffHint.updated
        ? `（${t("plugins.snapshot.added", { n: diffHint.added ?? 0 })} · ${t("plugins.snapshot.changed", { n: diffHint.updated ?? 0 })}）`
        : "";
      els.banner.innerHTML = `<i>${iconSvg("check")}</i><span>${escHtml(t("plugins.snapshot.updated", { n: diffHint.n ?? 0 }))}${details}</span>`;
      els.banner.className = "snapshot-banner ok";
    } else {
      els.banner.innerHTML = `<i>${iconSvg("triangle-alert")}</i><span>${escHtml(t("plugins.snapshot.fail", { src: srcLabel, at: snapshot.generated_at || "—" }))}</span>`;
      els.banner.className = "snapshot-banner fail";
    }
    const close = document.createElement("button");
    close.className = "banner-close";
    close.innerHTML = iconSvg("x");
    close.title = t("plugins.snapshot.dismiss");
    close.addEventListener("click", () => {
      els.banner.style.display = "none";
    });
    els.banner.appendChild(close);
  }

  // ================= P0 交互核心（013 已确认）：队列 / 状态条 / 卸载确认 / 分页 / 更新语义 =================
  const TABLE_PAGE = 200;
  let visibleRows = TABLE_PAGE;
  let currentRows: PluginEntry[] = [];
  let actionChain: Promise<void> = Promise.resolve();
  let statusTimer = 0;
  let statusEl: HTMLElement | null = null;
  let moreObs: IntersectionObserver | null = null;
  type QueuedTask = { label: string; cmd: string[] };
  type FailInfo = { label: string; err: string };

  /** 全局 busy：执行中禁掉所有变更按钮（安装/更新/卸载/全部更新/本地安装） */
  function setBusy(on: boolean): void {
    document.getElementById("view-plugins")?.classList.toggle("is-busy", on);
  }

  /** 插件页内状态条（P0-2）：busy=spinner+文字；ok=绿色淡出；error=红色保留 */
  function setPluginStatus(kind: "busy" | "ok" | "error", msg: string, ttl = 0): void {
    if (!statusEl) statusEl = document.getElementById("plugin-action-status");
    if (!statusEl) return;
    window.clearTimeout(statusTimer);
    statusEl.classList.remove("busy", "ok", "error", "fade");
    statusEl.hidden = false;
    statusEl.innerHTML =
      kind === "busy"
        ? `<i class="spin">${iconSvg("refresh-cw")}</i><span>${escHtml(msg)}</span>`
        : `<span>${escHtml(msg)}</span>`;
    statusEl.classList.add(kind);
    if (kind === "ok" && ttl > 0) {
      statusTimer = window.setTimeout(() => statusEl?.classList.add("fade"), ttl);
    }
  }

  // —— 卸载二次确认（P0-3）：全局唯一 armed；外点 / Esc / 3s 复位 ——
  const armedCleanups = new Set<() => void>();
  const resetArmed = (): void => {
    for (const fn of [...armedCleanups]) {
      try { fn(); } catch { /* ignore */ }
    }
    armedCleanups.clear();
  };
  document.addEventListener("click", (ev) => {
    if (!armedCleanups.size) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest(".confirm-armed") || t.closest(".cancel-mini"))) return;
    resetArmed();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") resetArmed();
  });

  /** 表格行 / 详情面板的卸载按钮：就地进入「确认卸载 + 取消」，二次点击才执行 */
  function confirmRemoveInPlace(btn: HTMLButtonElement, label: string, cmd: string[]): void {
    if (btn.dataset.armed === "1") {
      resetArmed();
      enqueueAction([{ label, cmd }]);
      return;
    }
    btn.dataset.armed = "1";
    btn.classList.add("armed", "confirm-armed");
    const origHtml = btn.innerHTML;
    const origTitle = btn.title;
    btn.textContent = t("plugins.confirmRemove");
    btn.title = t("plugins.confirmRemoveHint");
    const cancel = document.createElement("button");
    cancel.className = "install-btn btn-icon cancel-mini";
    cancel.textContent = t("plugins.cancel");
    cancel.addEventListener("click", (ev) => {
      ev.stopPropagation();
      resetArmed();
    });
    btn.after(cancel);
    const cleanup = (): void => {
      if (!armedCleanups.has(cleanup)) return;
      armedCleanups.delete(cleanup);
      btn.dataset.armed = "";
      btn.classList.remove("armed", "confirm-armed");
      btn.innerHTML = origHtml;
      btn.title = origTitle;
      cancel.remove();
    };
    armedCleanups.add(cleanup);
    window.setTimeout(cleanup, 3000);
  }

  /** 已安装 chip 的卸载：chip 就地展开「确认卸载 / 取消」 */
  function armChipRemove(chip: HTMLElement, name: string, label: string): void {
    if (chip.dataset.armed === "1") {
      resetArmed();
      enqueueAction([{ label, cmd: ["plugin", "--profile", "web", "remove", name] }]);
      return;
    }
    chip.dataset.armed = "1";
    chip.classList.add("chip-armed");
    const origHtml = chip.innerHTML;
    chip.textContent = "";
    const txt = document.createElement("span");
    txt.textContent = name;
    chip.appendChild(txt);
    const yes = document.createElement("button");
    yes.className = "chip-rm confirm-armed";
    yes.textContent = t("plugins.confirmRemove");
    yes.addEventListener("click", (ev) => {
      ev.stopPropagation();
      resetArmed();
      enqueueAction([{ label, cmd: ["plugin", "--profile", "web", "remove", name] }]);
    });
    const no = document.createElement("button");
    no.className = "chip-rm cancel-mini";
    no.textContent = t("plugins.cancel");
    no.addEventListener("click", (ev) => {
      ev.stopPropagation();
      resetArmed();
    });
    chip.appendChild(yes);
    chip.appendChild(no);
    const cleanup = (): void => {
      if (!armedCleanups.has(cleanup)) return;
      armedCleanups.delete(cleanup);
      chip.dataset.armed = "";
      chip.classList.remove("chip-armed");
      chip.innerHTML = origHtml;
    };
    armedCleanups.add(cleanup);
    window.setTimeout(cleanup, 3000);
  }

  // —— 动作队列（P0-1）：全部变更操作串行，busy 互斥；批量只重启一次（P0-6）——
  async function runTaskCommands(tasks: QueuedTask[]): Promise<FailInfo[]> {
    const fails: FailInfo[] = [];
    if (tasks.length === 1) {
      const task = tasks[0];
      try {
        await runDshCmd(task.cmd);
        opts.onAction(`✅ ${t("plugins.actDone", { label: task.label })}`);
        await restartDsh();
        opts.onAction(t("plugins.actRestarted"));
      } catch (e) {
        const err = String(e);
        setPluginStatus("error", `${t("plugins.actFail", { label: task.label })}${err.slice(0, 120)}`);
        opts.onAction(`❌ ${t("plugins.actFail", { label: task.label })}${err}`);
        fails.push({ label: task.label, err });
      }
      return fails;
    }
    let done = 0;
    for (const task of tasks) {
      done++;
      setPluginStatus("busy", `${t("plugins.updatingAll", { i: done, n: tasks.length })} · ${task.label}`);
      try {
        await runDshCmd(task.cmd);
        opts.onAction(`✅ ${task.label}`);
      } catch (e) {
        const err = String(e);
        opts.onAction(`❌ ${t("plugins.actFail", { label: task.label })}${err}`);
        fails.push({ label: task.label, err });
      }
    }
    if (tasks.length) {
      try {
        await restartDsh(); // 批量只重启一次
        opts.onAction(t("plugins.actRestarted"));
      } catch (e) {
        fails.push({ label: "restart", err: String(e) });
      }
    }
    return fails;
  }

  /** 全部变更操作统一入口：入队即互斥（禁用全部变更按钮），串行执行，页内可见状态 */
  function enqueueAction(tasks: QueuedTask[]): void {
    // 立即置 busy：双击/连点只产生一次命令（P0-1 验收）；队列期间所有变更按钮禁用
    setBusy(true);
    const run = actionChain.then(async () => {
      setPluginStatus(
        "busy",
        tasks.length === 1
          ? t("plugins.status.busy", { label: tasks[0].label })
          : t("plugins.updatingAll", { i: 0, n: tasks.length })
      );
      const fails = await runTaskCommands(tasks);
      try {
        await loadInstalled();
        renderOfficial();
        renderTable(false);
        updateBadge();
        renderUpdateAllBtn();
        renderLocalInstalled();
      } finally {
        setBusy(false);
      }
      if (tasks.length === 1) {
        if (fails.length) setPluginStatus("error", `${t("plugins.actFail", { label: tasks[0].label })}${fails[0].err.slice(0, 120)}`);
        else setPluginStatus("ok", t("plugins.status.done", { label: tasks[0].label }), 5000);
      } else if (fails.length) {
        setPluginStatus("error", t("plugins.updateAllFail", { n: fails.length }));
      } else {
        setPluginStatus("ok", t("plugins.updateAllDone"), 5000);
      }
    });
    actionChain = run.catch(() => setBusy(false));
    void run;
  }

  // —— 全部更新（P0-6）：npm 可更新 + GitHub 重装批量执行；本地 file/link 不混入 ——
  function collectUpdateTasks(): QueuedTask[] {
    const tasks: QueuedTask[] = [];
    for (const name of installedNames(installed)) {
      const pkg = pkgNameOf(name);
      const spec = installedSpecOf(pkg, name);
      if (!spec) continue;
      if (/^(file:|link:)/.test(spec)) continue; // 本地源不混入批量
      if (/^(github:|git\+)/.test(spec)) {
        // GitHub：以「重新安装」语义批量执行（已确认 npm + GitHub）
        tasks.push({ label: `${t("plugins.reinstall")} ${pkg}`, cmd: ["plugin", "--profile", "web", "add", spec] });
        continue;
      }
      const latest = versions[pkg];
      const iv = installedVersionOf(spec);
      if (latest && latest !== "—" && iv !== null && compareVer(latest, iv) > 0) {
        tasks.push({ label: `${t("plugins.update")} ${pkg}`, cmd: ["plugin", "--profile", "web", "update", pkg] });
      }
    }
    return tasks;
  }

  /** 已安装标题旁的「全部更新（n）」按钮 */
  function renderUpdateAllBtn(): void {
    const btn = document.getElementById("plugins-update-all") as HTMLButtonElement | null;
    if (!btn) return;
    const n = collectUpdateTasks().length;
    btn.hidden = n === 0;
    btn.innerHTML = `${iconSvg("refresh-cw")}<span>${escHtml(t("plugins.updateAll", { n }))}</span>`;
  }

  function updateAllUpdatable(): void {
    const tasks = collectUpdateTasks();
    if (!tasks.length) return;
    enqueueAction(tasks);
  }

  // —— 表格分页（P0-4）：首屏 200 条 + 滚动加载更多 ——
  function renderMore(rowsLen: number): void {
    const moreEl = document.getElementById("plugin-table-more");
    if (!moreEl) return;
    const left = rowsLen - visibleRows;
    if (left <= 0) {
      moreEl.hidden = true;
      if (moreObs) moreObs.disconnect();
      return;
    }
    moreEl.hidden = false;
    moreEl.textContent = t("plugins.loadMore");
    if (moreObs) moreObs.disconnect();
    moreObs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && visibleRows < rowsLen) {
          visibleRows += TABLE_PAGE;
          renderTable(false);
        }
      },
      { root: document.getElementById("view-plugins"), rootMargin: "160px" }
    );
    moreObs.observe(moreEl);
  }

  /** P2：恢复上次滚动位置（分页表格：先加载足够行数，再逐步逼近目标 scrollTop，直到可达或行数耗尽） */
  function restoreScroll(target: number): void {
    const v = document.getElementById("view-plugins");
    if (!v || !target) return;
    let guard = 0;
    v.scrollTop = target;
    while (v.scrollTop < target * 0.95 && guard < 20 && visibleRows < filtered().length) {
      visibleRows += TABLE_PAGE;
      renderTable(false);
      v.scrollTop = target;
      guard++;
    }
  }

  /** 表格行操作区 HTML（P0-6：npm 可更新=更新到 x / 已最新=禁用 / github·本地=重新安装；P1-6 图标按钮带 aria-label） */
  function tableActionsHtmlFor(p: PluginEntry): string {
    const pkg = p.pkg_name ?? pkgNameOf(p.installSpec);
    const installedFlag = isInstalled(pkg) || isInstalled(p.name);
    if (!installedFlag) {
      return `<button class="install-btn btn-icon" data-act="install" data-spec="${escHtml(p.installSpec)}" title="${escHtml(t("plugins.install"))}" aria-label="${escHtml(t("plugins.install"))}">${iconSvg("download")}</button>`;
    }
    const npm = p.isNpm;
    const instSpec = installedSpecOf(pkg, p.name);
    const latest = versions[pkg];
    let upHtml = "";
    if (!npm) {
      const upCmd = updateCommandFor(false, instSpec, pkg);
      upHtml = `<button class="install-btn btn-icon" data-act="update" data-kind="reinstall" data-name="${escHtml(pkg)}" data-cmd="${escHtml(upCmd.join("|"))}" title="${escHtml(t("plugins.reinstall"))}" aria-label="${escHtml(t("plugins.reinstall"))}">${iconSvg("refresh-cw")}</button>`;
    } else if (isUpdatable(p.name, pkg, latest)) {
      const upCmd = updateCommandFor(true, instSpec, pkg);
      const to = latest && latest !== "—" ? `${t("plugins.updateTo")} ${latest}` : t("plugins.update");
      upHtml = `<button class="install-btn btn-icon" data-act="update" data-kind="update" data-name="${escHtml(pkg)}" data-cmd="${escHtml(upCmd.join("|"))}" title="${escHtml(to)}" aria-label="${escHtml(to)}">${iconSvg("upload")}</button>`;
    } else {
      upHtml = `<button class="install-btn btn-icon" disabled title="${escHtml(t("plugins.alreadyLatest"))}" aria-label="${escHtml(t("plugins.alreadyLatest"))}">${iconSvg("check")}</button>`;
    }
    return `${upHtml} <button class="install-btn btn-icon" data-act="remove" data-name="${escHtml(p.name)}" title="${escHtml(t("plugins.remove"))}" aria-label="${escHtml(t("plugins.remove"))}">${iconSvg("trash-2")}</button>`;
  }

  /** 绑定一行内的操作按钮（初始化渲染与版本回包增量共用） */
  function bindRowActions(root: HTMLElement, p: PluginEntry): void {
    const pkg = p.pkg_name ?? pkgNameOf(p.installSpec);
    root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const act = b.dataset.act;
        if (act === "install") {
          enqueueAction([{ label: `${t("plugins.install")} ${b.dataset.spec}`, cmd: ["plugin", "--profile", "web", "add", b.dataset.spec!] }]);
        } else if (act === "update") {
          const cmd = (b.dataset.cmd || "").split("|");
          const args = cmd.length >= 2 ? cmd : ["plugin", "--profile", "web", "update", b.dataset.spec!];
          const label =
            b.dataset.kind === "reinstall"
              ? `${t("plugins.reinstall")} ${b.dataset.name || pkg}`
              : `${t("plugins.update")} ${b.dataset.name || pkg}`;
          enqueueAction([{ label, cmd: args }]);
        } else if (act === "remove") {
          confirmRemoveInPlace(b, `${t("plugins.remove")} ${b.dataset.name || p.name}`, ["plugin", "--profile", "web", "remove", b.dataset.name || p.name]);
        }
      });
    });
  }

  /** 版本异步回包：只更新对应行的版本单元格 + 可更新操作区，不整表重渲（P0-4） */
  function refreshRowVersions(changed: Record<string, string>): void {
    const keys = Object.keys(changed);
    if (!keys.length) return;
    els.tbody.querySelectorAll<HTMLTableRowElement>("tr.plugin-row").forEach((tr) => {
      const latest = changed[tr.dataset.pkg || ""];
      if (latest === undefined || latest === null) return;
      const idx = Number(tr.dataset.idx || "-1");
      const p = idx >= 0 && idx < currentRows.length ? currentRows[idx] : undefined;
      if (!p) return;
      const verCell = tr.querySelector<HTMLElement>("td.ver");
      if (verCell) {
        verCell.innerHTML = p.isNpm ? escHtml(latest || "—") : verCell.innerHTML;
      }
      const actionsCell = tr.querySelector<HTMLElement>("td.actions");
      if (actionsCell && p.isNpm) {
        actionsCell.innerHTML = tableActionsHtmlFor(p);
        bindRowActions(actionsCell, p);
      }
    });
  }

  // ===== 本地插件安装（P1-1 / 用户需求：拆「选择目录」「选择 .tgz」两个入口；路径错误在当前页面提示）=====
  // `dsh plugin add <spec>` 原生支持：file:./x-0.1.0.tgz / file:/abs/path / 本地目录。
  const localSpec = (raw: string): string => {
    const v = raw.trim();
    return v.startsWith("file:") ? v : `file:${v}`;
  };

  function showLocalError(msg: string): void {
    els.localError.textContent = msg;
    els.localError.hidden = false;
  }
  function hideLocalError(): void {
    els.localError.textContent = "";
    els.localError.hidden = true;
  }

  /** 执行一次本地插件安装（spec 为 file: 前缀路径），走统一动作队列；空路径在当前页提示（不加日志页） */
  function doLocalInstall(raw: string, pickPath?: string): void {
    const value = pickPath ?? raw;
    if (!value.trim()) {
      showLocalError(t("plugins.localEmptyInline"));
      return;
    }
    const spec = localSpec(value);
    hideLocalError();
    enqueueAction([{ label: `${t("plugins.install")} ${spec}`, cmd: ["plugin", "--profile", "web", "add", spec] }]);
  }

  els.localDirBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const dir = await open({ multiple: false, directory: true, title: t("plugins.localPickDir") });
        if (dir && typeof dir === "string") {
          els.search.value = dir;
          doLocalInstall("", dir);
        }
      } catch {
        showLocalError(t("plugins.localEmptyInline")); // 对话框不可用：提示走输入框
      }
    })();
  });
  els.localTgzBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const file = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "tgz", extensions: ["tgz"] }],
          title: t("plugins.localPickTgz"),
        });
        if (file && typeof file === "string") {
          els.search.value = file;
          doLocalInstall("", file);
        }
      } catch {
        showLocalError(t("plugins.localEmptyInline"));
      }
    })();
  });

  /** 本地已安装（file:/link:）条目 */
  function localInstalledEntries(): Array<{ n: string; spec: string }> {
    const out: Array<{ n: string; spec: string }> = [];
    for (const n of installedNames(installed)) {
      const spec = (installed.deps || {})[n];
      if (spec && /^(file:|link:)/.test(spec)) out.push({ n, spec });
    }
    return out;
  }

  /** 本地已安装列表（P1-1/P1-4：共享搜索框同时承担过滤） */
  function renderLocalInstalled(): void {
    els.localList.innerHTML = "";
    const q = els.search.value.trim().toLowerCase();
    const rows = localInstalledEntries().filter(
      (r) => !q || r.n.toLowerCase().includes(q) || r.spec.toLowerCase().includes(q)
    );
    if (!rows.length) {
      els.localList.textContent = t("plugins.localInstalledEmpty");
      return;
    }
    for (const { n, spec } of rows) {
      const row = document.createElement("div");
      row.className = "local-installed-row";
      row.innerHTML = `<span class="li-name">${escHtml(n)}</span><span class="li-spec">${escHtml(spec)}</span>`;
      const acts = document.createElement("span");
      acts.className = "li-actions";
      const rein = document.createElement("button");
      rein.className = "install-btn btn-icon";
      rein.innerHTML = iconSvg("refresh-cw") + t("plugins.reinstall");
      rein.title = t("plugins.reinstall");
      rein.addEventListener("click", () =>
        enqueueAction([{ label: `${t("plugins.reinstall")} ${n}`, cmd: ["plugin", "--profile", "web", "add", spec] }])
      );
      acts.appendChild(rein);
      const rm = document.createElement("button");
      rm.className = "install-btn btn-icon";
      rm.innerHTML = iconSvg("trash-2") + t("plugins.remove");
      rm.title = t("plugins.remove");
      rm.addEventListener("click", () =>
        confirmRemoveInPlace(rm, `${t("plugins.remove")} ${n}`, ["plugin", "--profile", "web", "remove", n])
      );
      acts.appendChild(rm);
      row.appendChild(acts);
      els.localList.appendChild(row);
    }
  }

  /** 自动更新检查：拉取已安装 npm 插件的最新版本。force=false 只补缺；force=true 强制刷新。
   * 回包后仅增量更新对应行（P0-4），不整表重渲。 */
  async function checkInstalledUpdates(force: boolean): Promise<void> {
    const names = [
      ...new Set(
        installedNames(installed)
          .map((n) => installedSpecOf(pkgNameOf(n), n))
          .filter((s): s is string => !!s)
          .map(pkgNameOf)
      ),
    ];
    const todo = force ? names : names.filter((n) => !versions[n] || versions[n] === "—");
    if (!todo.length) return;
    const changed: Record<string, string> = {};
    let i = 0;
    const pool = 3;
    const worker = async (): Promise<void> => {
      while (i < todo.length) {
        const name = todo[i++];
        const v = await fetchVersion(name);
        if (v !== "—" && v !== versions[name]) changed[name] = v;
        versions[name] = v;
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, todo.length) }, () => worker()));
    await persistCache(false);
    refreshRowVersions(changed);
    updateBadge();
    renderUpdateAllBtn();
  }

  /** 后台刷新：从 CDN 拉最新 registry → diff → 替换展示 + 持久化缓存 */
  async function refreshLatest(): Promise<void> {
    els.refresh.disabled = true;
    els.refreshLabel.textContent = t("plugins.fetchingShort");
    const beforeCount = snapshot.count;
    const latest = await fetchLatestRegistry();
    if (!latest) {
      diffHint = { kind: "fail", at: snapshot.generated_at };
      renderBanner();
      els.refresh.disabled = false;
      els.refreshLabel.textContent = t("plugins.refresh");
      return;
    }
    // 仅当「更新」时替换（generated_at 更晚或 count 更高）
    const newer =
      (latest.generated_at || "") > (snapshot.generated_at || "") ||
      (latest.count || 0) > beforeCount;
    if (!newer) {
      diffHint = { kind: "fresh" };
      renderBanner();
      els.refresh.disabled = false;
      els.refreshLabel.textContent = t("plugins.refresh");
      return;
    }
    const d = diffRegistries(snapshot, latest);
    snapshot = latest;
    plugins = latest.plugins;
    categoriesLabels = latest.awesome?.categories ?? categoriesLabels;
    snapshotSource = "cdn";
    // 种子新条目版本（跳过已安装，保持 npm 真最新优先）
    const installedPkgSet = new Set(installedNames(installed).map(pkgNameOf));
    const seeded = seedVersionsFromRegistry(plugins);
    for (const [k, v] of Object.entries(seeded)) {
      if ((!versions[k] || versions[k] === "—") && !installedPkgSet.has(k)) versions[k] = v;
    }
    diffHint = {
      kind: "ok",
      n: d.added + d.updated,
      added: d.added,
      updated: d.updated,
      at: latest.generated_at,
    };
    renderBanner();
    renderCategories();
    renderIndexInfo();
    renderTable(true);
    updateBadge();
    await persistCache(true);
    els.refresh.disabled = false;
    els.refreshLabel.textContent = t("plugins.refresh");
  }

  els.refresh.addEventListener("click", () => {
    void refreshLatest().then(() =>
      void checkInstalledUpdates(true).then(() => {
        updateBadge();
        renderUpdateAllBtn();
        renderTable(false);
      })
    );
  });
  // ===== 共享搜索框（P1-1：一个输入框，随主 tab 切换语义：GitHub 过滤 / npm 实时搜索 / 本地路径）=====
  let searchTimer = 0;
  els.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const delay = mainTab === "npm" ? 400 : 150;
    searchTimer = window.setTimeout(() => {
      if (mainTab === "github") {
        filterText = els.search.value;
        renderTable(true);
        const v = document.getElementById("view-plugins");
        if (v) v.scrollTop = 0;
        saveUiState(); // P2：搜索词持久化
      } else if (mainTab === "npm") {
        void runNpmSearch();
      } else {
        renderLocalInstalled();
      }
    }, delay);
  });
  els.searchGo.addEventListener("click", () => void runNpmSearch());
  els.search.addEventListener("keydown", (ev) => {
    if (mainTab === "npm") {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveNpmHighlight(1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveNpmHighlight(-1);
      } else if (ev.key === "Enter") {
        const hi = els.npmResults.querySelector<HTMLButtonElement>('[aria-selected="true"] button.install-btn');
        if (hi) hi.click();
        else void runNpmSearch();
      } else if (ev.key === "Escape") {
        closeNpmResults();
      }
    } else if (mainTab === "local" && ev.key === "Enter") {
      ev.preventDefault();
      doLocalInstall(els.search.value);
    }
  });

  // ===== npm 按包名实时搜索 + 键盘导航 + 行内详情 + 已安装状态（P1-3）=====
  let npmSearchSeq = 0; // P0-5 竞态保护：旧请求不覆盖新结果
  let npmHighlight = -1;

  function closeNpmResults(): void {
    els.npmResults.hidden = true;
    els.npmResults.innerHTML = "";
    npmHighlight = -1;
  }

  function moveNpmHighlight(delta: number): void {
    const rows = els.npmResults.querySelectorAll<HTMLElement>(".npm-result");
    if (!rows.length) return;
    npmHighlight = Math.max(0, Math.min(rows.length - 1, npmHighlight + delta));
    rows.forEach((r, i) => r.setAttribute("aria-selected", String(i === npmHighlight)));
    rows[npmHighlight].scrollIntoView({ block: "nearest" });
  }

  async function runNpmSearch(): Promise<void> {
    if (!els.npmSearch || !els.npmResults || !els.npmGo) return;
    const seq = ++npmSearchSeq;
    const q = els.npmSearch.value.trim();
    if (!q) {
      closeNpmResults();
      return;
    }
    els.npmGo.disabled = true;
    els.npmResults.hidden = false;
    els.npmResults.innerHTML = `<div class="detail-note">${escHtml(t("plugins.npmSearching"))}</div>`;
    npmHighlight = -1;
    try {
      const items = await searchNpm(q);
      if (seq !== npmSearchSeq) return; // 过期结果丢弃
      if (!items.length) {
        els.npmResults.innerHTML = `<div class="detail-note">${escHtml(t("plugins.npmNoResult"))}</div>`;
        return;
      }
      els.npmResults.innerHTML = "";
      const seen = new Set<string>();
      for (const it of items) {
        const name = it.package?.name ?? "";
        if (!name || seen.has(name)) continue; // 去重：同名包只保留一条
        seen.add(name);
        const ver = it.package?.version ?? "";
        const desc = it.package?.description ?? "";
        const installedFlag = isInstalled(name);
        const spec = (installed.deps || {})[name];
        const latest = versions[name];
        const iv = spec ? installedVersionOf(spec) : null;
        const updatable = installedFlag && !!spec && !!latest && latest !== "—" && iv !== null && compareVer(latest, iv) > 0;
        const row = document.createElement("div");
        row.className = "npm-result" + (installedFlag ? " dim" : "");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        const main = document.createElement("div");
        main.className = "npm-result-main";
        const nm = document.createElement("div");
        nm.innerHTML = `<span class="npm-result-name">${escHtml(name)}</span><span class="npm-result-ver">${escHtml(ver)}</span>`;
        if (desc) {
          const d = document.createElement("div");
          d.className = "npm-result-desc";
          d.textContent = desc;
          nm.appendChild(d);
        }
        main.appendChild(nm);
        row.appendChild(main);
        const btn = document.createElement("button");
        btn.className = "install-btn btn-icon";
        if (updatable) {
          btn.innerHTML = iconSvg("upload") + t("plugins.npmUpdateTo", { v: latest });
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            enqueueAction([{ label: `${t("plugins.update")} ${name}`, cmd: ["plugin", "--profile", "web", "update", name] }]);
          });
        } else if (installedFlag) {
          btn.innerHTML = iconSvg("check") + t("plugins.npmInstalledLatest");
          btn.disabled = true;
        } else {
          btn.innerHTML = iconSvg("download") + t("plugins.install");
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            enqueueAction([{ label: `${t("plugins.install")} ${name}`, cmd: ["plugin", "--profile", "web", "add", name] }]);
          });
        }
        row.appendChild(btn);
        const body = document.createElement("div");
        body.className = "npm-result-body";
        body.hidden = true;
        row.appendChild(body);
        row.addEventListener("click", (ev) => {
          if (ev.target instanceof HTMLElement && ev.target.closest("button")) return;
          // 高亮 + 展开/收起行内详情（复用 apply detailSeq 竞态保护）
          const rows = els.npmResults.querySelectorAll<HTMLElement>(".npm-result");
          npmHighlight = [...rows].indexOf(row);
          rows.forEach((r, i) => r.setAttribute("aria-selected", String(i === npmHighlight)));
          detailSeq++;
          if (body.hidden) {
            body.hidden = false;
            body.textContent = t("plugins.detail.loading");
            void renderNpmDetail(body, name, detailSeq);
          } else {
            body.hidden = true;
          }
        });
        els.npmResults.appendChild(row);
      }
    } catch (e) {
      if (seq !== npmSearchSeq) return;
      els.npmResults.innerHTML = `<div class="detail-note">${escHtml(t("plugins.npmSearchFail", { err: String(e) }))}</div>`;
    } finally {
      if (seq === npmSearchSeq) els.npmGo.disabled = false;
    }
  }

  // npm 结果：点击页面其它区域关闭（P1-3）
  document.addEventListener("click", (ev) => {
    if (mainTab !== "npm" || els.npmResults.hidden) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest("#plugins-npm-results") || t.closest("#plugins-search") || t.closest("#plugins-search-go"))) return;
    closeNpmResults();
  });

  // P0-6：全部更新（批量执行，只重启一次 DSH）
  document.getElementById("plugins-update-all")?.addEventListener("click", () => updateAllUpdatable());

  // P1-5：官方组合包全局快捷入口 → 切到 npm tab 官方分区
  els.officialQuick.addEventListener("click", () => {
    if (mainTab !== "npm") switchMainTab("npm");
    els.official.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // P2：滚动位置 250ms 防抖保存（重启恢复）
  let scrollSaveTimer = 0;
  document.getElementById("view-plugins")?.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(scrollSaveTimer);
      scrollSaveTimer = window.setTimeout(() => saveUiState(), 250);
    },
    { passive: true }
  );

  // P1-2：筛选（全部/已安装/可更新/未安装）与排序（Stars/最近更新/名称）变更
  els.filterMode.addEventListener("change", () => {
    filterMode = els.filterMode.value as FilterMode;
    renderTable(true);
    const v = document.getElementById("view-plugins");
    if (v) v.scrollTop = 0;
    saveUiState(); // P2
  });
  els.sortMode.addEventListener("change", () => {
    sortMode = els.sortMode.value as SortMode;
    renderTable(true);
    const v = document.getElementById("view-plugins");
    if (v) v.scrollTop = 0;
    saveUiState(); // P2
  });

  /** 索引来源与更新时间常显（P1-2） */
  function renderIndexInfo(): void {
    const wrap = document.getElementById("plugin-index-info");
    if (!wrap || !els.indexMeta) return;
    wrap.hidden = mainTab !== "github";
    els.indexMeta.textContent = t("plugins.indexInfo", {
      src: t(`plugins.snapshot.src.${snapshotSource}`),
      at: snapshot.generated_at ? snapshot.generated_at.slice(0, 16).replace("T", " ") : "—",
      n: snapshot.count ?? plugins.length,
    });
  }

  window.addEventListener("lang-changed", () => {
    els.refreshLabel.textContent = t("plugins.refresh");
    void loadInstalled();
    renderMainTabs();
    renderGithubViews();
    renderCategories();
    renderOfficial();
    renderTable(true);
    renderBanner();
    renderIndexInfo();
    fillModeSelects();
    refreshToolbarVisibility();
    els.search.placeholder =
      mainTab === "github" ? t("plugins.searchGithub") : mainTab === "npm" ? t("plugins.searchNpm") : t("plugins.searchLocal");
    updateBadge();
    renderUpdateAllBtn();
    renderLocalInstalled();
  });

  // 初始化：已安装 → 缓存（含 registry 快照 + 版本播种，跳过已安装）→ 秒开渲染快照 → 后台刷新 + 已安装更新检查 + 每 6h 定时
  void (async () => {
    await loadInstalled();
    await loadCache();
    renderMainTabs();
    renderGithubViews();
    renderCategories();
    fillModeSelects();
    refreshToolbarVisibility();
    if (mainTab === "github" && filterText) els.search.value = filterText; // P2：恢复上次搜索词（仅 GitHub 过滤语义）
    els.search.placeholder =
      mainTab === "github" ? t("plugins.searchGithub") : mainTab === "npm" ? t("plugins.searchNpm") : t("plugins.searchLocal");
    els.githubPanel.hidden = mainTab !== "github";
    els.npmPanel.hidden = mainTab !== "npm";
    els.localPanel.hidden = mainTab !== "local";
    renderOfficial();
    renderTable(true);
    renderBanner();
    renderIndexInfo();
    renderLocalInstalled();
    restoreScroll(savedState.scrollTop); // P2：恢复上次滚动位置（分页加载至可达）
    await checkInstalledUpdates(false);
    updateBadge();
    renderUpdateAllBtn();
    void refreshLatest();
    window.setInterval(() => {
      void checkInstalledUpdates(true).then(() => {
        updateBadge();
        renderUpdateAllBtn();
        renderLocalInstalled();
        if (document.getElementById("view-plugins")?.classList.contains("active")) renderTable(false);
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  })();
}