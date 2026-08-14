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
  type SourceTab,
} from "./plugin-sources";

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

/** 已安装 chip 的版本标签：file:/link: 本地链接显示「本地」；npm spec 原样 */
function chipVersionLabel(v: string): string {
  if (!v) return "";
  if (/^(file:|link:|\.|\/)/.test(v)) return t("plugins.chipLocal");
  return v;
}

// ============================ 主入口 ============================

export function initPlugins(opts: PluginCenterOptions): void {
  const els = {
    refresh: $("plugins-refresh") as HTMLButtonElement,
    refreshLabel: $("plugins-refresh-label") as HTMLSpanElement,
    search: $("plugins-search") as HTMLInputElement,
    sourceTabs: $("plugin-source-tabs"),
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
  };

  let snapshot: RegistrySnapshot = getSnapshot();
  let plugins: PluginEntry[] = snapshot.plugins;
  let categoriesLabels: Record<string, { zh?: string; en?: string }> = snapshot.awesome?.categories ?? {};
  let filterSource: SourceTab = "awesome";
  let filterCat = "";
  let filterText = "";
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
      const el = document.createElement("span");
      el.className = "chip";
      el.title = spec ? `${n}@${spec}` : n;
      const txt = document.createElement("span");
      txt.textContent = label ? `${n} @${label}` : n;
      el.appendChild(txt);
      if (isDep) {
        const rm = document.createElement("button");
        rm.className = "chip-rm";
        rm.title = t("plugins.remove") + " " + n;
        rm.innerHTML = iconSvg("x");
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          performAction(`${t("plugins.remove")} ${n}`, ["plugin", "--profile", "web", "remove", n]);
        });
        el.appendChild(rm);
      }
      els.chips.appendChild(el);
    });
  }

  // —— 来源 tabs ——
  function renderSourceTabs(): void {
    els.sourceTabs.innerHTML = "";
    const mk = (id: SourceTab, key: string, icon: string): void => {
      const b = document.createElement("button");
      b.className = "src-tab" + (filterSource === id ? " active" : "");
      b.innerHTML = `${iconSvg(icon)}<span>${t(key)}</span>`;
      b.addEventListener("click", () => {
        filterSource = id;
        filterCat = ""; // 切源时重置分类
        renderSourceTabs();
        renderCategories();
        renderTable();
      });
      els.sourceTabs.appendChild(b);
    };
    mk("awesome", "plugins.source.awesome", "star");
    mk("topic", "plugins.source.topic", "github");
    mk("all", "plugins.source.all", "boxes");
  }

  // —— 分类 chips（依据当前来源词汇表）——
  function renderCategories(): void {
    els.cats.innerHTML = "";
    const lang = getLang();
    const mk = (key: string, label: string): void => {
      const chip = document.createElement("button");
      chip.className = "cat-chip" + (filterCat === key ? " active" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => {
        filterCat = filterCat === key ? "" : key;
        renderCategories();
        renderTable();
      });
      els.cats.appendChild(chip);
    };
    mk("", t("plugins.allCat"));
    if (filterSource === "topic") {
      TOPIC_CATEGORY_ORDER.forEach((c) => mk(c, t(`plugins.topicCat.${c}`) || c));
    } else {
      AWESOME_CATEGORY_ORDER.forEach((c) => mk(c, categoriesLabels[c]?.[lang] ?? c));
    }
  }

  function renderOfficial(): void {
    els.official.innerHTML = "";
    OFFICIAL_PKGS.forEach((p) => {
      const card = document.createElement("div");
      card.className = "official-card";
      const btn = document.createElement("button");
      btn.className = "btn-icon";
      if (isInstalled(p.name)) {
        btn.textContent = t("plugins.installedTag");
        btn.disabled = true;
      } else {
        btn.innerHTML = iconSvg("download");
        btn.appendChild(document.createTextNode(t("plugins.install")));
        btn.addEventListener("click", () =>
          performAction(`${t("plugins.install")} ${p.name}`, ["plugin", "--profile", "web", "add", p.name])
        );
      }
      card.innerHTML = `<div class="official-name">${p.name}</div><div class="official-desc">${t(p.descKey)}</div>`;
      card.appendChild(btn);
      els.official.appendChild(card);
    });
  }

  /** 当前来源 + 分类 + 搜索 过滤后的条目 */
  function filtered(): PluginEntry[] {
    const q = filterText.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filterSource === "awesome" && !p.sources.includes("awesome")) return false;
      if (filterSource === "topic" && !p.sources.includes("topic")) return false;
      if (filterSource === "all") {
        /* keep all */
      }
      if (filterCat) {
        if (filterSource === "topic") {
          if (p.topicCategory !== filterCat) return false;
        } else {
          if (p.category !== filterCat) return false;
        }
      }
      if (!q) return true;
      const hay = `${p.name} ${p.description?.zh ?? ""} ${p.description?.en ?? ""} ${p.pkg_name ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /** 详情页操作按钮（安装/更新/卸载） */
  function appendDetailActions(container: HTMLElement, p: PluginEntry): void {
    const spec = p.installSpec;
    const pkg = p.pkg_name ?? pkgNameOf(spec);
    const installedFlag = isInstalled(pkg) || isInstalled(p.name);
    container.innerHTML = "";
    if (installedFlag) {
      if (p.isNpm) {
        const up = document.createElement("button");
        up.className = "install-btn btn-icon";
        up.innerHTML = iconSvg("upload") + t("plugins.update");
        up.addEventListener("click", () =>
          performAction(`${t("plugins.update")} ${pkg}`, ["plugin", "--profile", "web", "update", pkg])
        );
        container.appendChild(up);
      }
      const rm = document.createElement("button");
      rm.className = "install-btn btn-icon";
      rm.innerHTML = iconSvg("trash-2") + t("plugins.remove");
      rm.addEventListener("click", () =>
        performAction(`${t("plugins.remove")} ${p.name}`, ["plugin", "--profile", "web", "remove", p.name])
      );
      container.appendChild(rm);
    } else {
      const inst = document.createElement("button");
      inst.className = "install-btn btn-icon";
      inst.innerHTML = iconSvg("download") + t("plugins.install");
      inst.addEventListener("click", () =>
        performAction(`${t("plugins.install")} ${spec}`, ["plugin", "--profile", "web", "add", spec])
      );
      container.appendChild(inst);
    }
  }

  /** 行内详情：npm 版本历史 / 依赖 / README / 作者 / 许可证 */
  async function renderNpmDetail(body: HTMLElement, pkg: string): Promise<void> {
    const meta = await fetchNpmMeta(pkg);
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

    body.innerHTML = html;

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
      filterSource === "topic"
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

  /** 展开/收起行内详情（单页无路由：点击插件行切换） */
  function toggleDetail(tr: HTMLTableRowElement, p: PluginEntry): void {
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
      void renderNpmDetail(body, pkg);
    } else {
      const note = document.createElement("div");
      note.className = "detail-note";
      note.textContent = t("plugins.detail.nonNpm", { spec: p.installSpec });
      body.appendChild(note);
    }
  }

  function renderTable(): void {
    const rows = filtered();
    els.count.textContent = String(rows.length);
    els.tbody.innerHTML = "";
    els.table.style.display = rows.length ? "table" : "none";
    if (!rows.length) {
      els.loading.textContent = t("plugins.noMatch");
      els.loading.style.display = "block";
      return;
    }
    els.loading.style.display = "none";
    rows.forEach((p) => {
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
      if (installedFlag) tagHtml = `<span class="tag installed">${t("plugins.installedTag")}</span>`;
      else if (npm && ver && ver !== "—") tagHtml = `<span class="tag latest">${t("plugins.latestTag")}</span>`;
      if (updatable) tagHtml = `<span class="tag update">${t("plugins.updateTag")}</span>`;

      let actionsHtml = "";
      if (installedFlag) {
        actionsHtml =
          (npm
            ? `<button class="install-btn btn-icon" data-act="update" data-spec="${escHtml(pkg)}" title="${escHtml(t("plugins.update"))}">${iconSvg("upload")}</button> `
            : "") +
          `<button class="install-btn btn-icon" data-act="remove" data-name="${escHtml(p.name)}" title="${escHtml(t("plugins.remove"))}">${iconSvg("trash-2")}</button>`;
      } else {
        actionsHtml = `<button class="install-btn btn-icon" data-act="install" data-spec="${escHtml(spec)}" title="${escHtml(t("plugins.install"))}">${iconSvg("download")}</button>`;
      }

      const desc = (p.description?.zh || p.description?.en || "").slice(0, 120);
      const tr = document.createElement("tr");
      tr.className = "plugin-row";
      tr.title = t("plugins.detail.hint");
      tr.innerHTML = `
        <td class="pkg"><a href="${escHtml(p.url || "#")}" target="_blank" rel="noopener">${escHtml(p.name)}</a></td>
        <td class="desc">${escHtml(desc)}</td>
        <td class="ver">${verHtml}</td>
        <td class="stars">${iconSvg("star")}<span>${escHtml(formatStars(p.stars))}</span></td>
        <td class="src">${sourceBadgesHtml(p)}</td>
        <td>${tagHtml}</td>
        <td class="actions">${actionsHtml}</td>`;
      tr.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "install") performAction(`${t("plugins.install")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "add", b.dataset.spec!]);
          else if (act === "update") performAction(`${t("plugins.update")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "update", b.dataset.spec!]);
          else if (act === "remove") performAction(`${t("plugins.remove")} ${b.dataset.name}`, ["plugin", "--profile", "web", "remove", b.dataset.name!]);
        });
      });
      tr.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest("a, button, [data-act]")) return;
        toggleDetail(tr, p);
      });
      els.tbody.appendChild(tr);
    });
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

  async function performAction(label: string, args: string[]): Promise<void> {
    opts.onAction(`⏳ ${label} …`);
    try {
      await runDshCmd(args);
      opts.onAction(`✅ ${t("plugins.actDone", { label })}`);
      await restartDsh();
      opts.onAction(t("plugins.actRestarted"));
    } catch (e) {
      opts.onAction(`❌ ${t("plugins.actFail", { label })}${e}`);
    }
    await loadInstalled();
    renderOfficial();
    renderTable();
    updateBadge();
  }

  /** 自动更新检查：拉取已安装 npm 插件的最新版本。force=false 只补缺；force=true 强制刷新 */
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
    let i = 0;
    const pool = 3;
    const worker = async (): Promise<void> => {
      while (i < todo.length) {
        const name = todo[i++];
        versions[name] = await fetchVersion(name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, todo.length) }, () => worker()));
    await persistCache(false);
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
    renderTable();
    updateBadge();
    await persistCache(true);
    els.refresh.disabled = false;
    els.refreshLabel.textContent = t("plugins.refresh");
  }

  els.refresh.addEventListener("click", () => {
    void refreshLatest().then(() =>
      void checkInstalledUpdates(true).then(() => {
        updateBadge();
        renderTable();
      })
    );
  });
  els.search.addEventListener("input", () => {
    filterText = els.search.value;
    renderTable();
  });

  window.addEventListener("lang-changed", () => {
    els.refreshLabel.textContent = t("plugins.refresh");
    void loadInstalled();
    renderSourceTabs();
    renderCategories();
    renderOfficial();
    renderTable();
    renderBanner();
    updateBadge();
  });

  // 初始化：已安装 → 缓存（含 registry 快照 + 版本播种，跳过已安装）→ 秒开渲染快照 → 后台刷新 + 已安装更新检查 + 每 6h 定时
  void (async () => {
    await loadInstalled();
    await loadCache();
    renderSourceTabs();
    renderCategories();
    renderOfficial();
    renderTable();
    renderBanner();
    await checkInstalledUpdates(false);
    updateBadge();
    void refreshLatest();
    window.setInterval(() => {
      void checkInstalledUpdates(true).then(() => {
        updateBadge();
        if (document.getElementById("view-plugins")?.classList.contains("active")) renderTable();
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  })();
}