// src/plugins.ts —— 插件中心
// 定位（决策 C）：app 管「生命周期」（安装/更新/卸载/重启生效/版本检查），dsh web 管「配置」。
// 索引来源：awesome-dsh-plugin.com/plugins.json（机器可读，社区插件）+ npm registry 补版本。
// P0 收尾（2026-08-15）：
//  - 缓存落盘：版本号缓存从 localStorage 升级为 Rust 侧 $APP_DATA/plugin-cache.json（get/set_plugin_cache）
//  - 自动更新检查：启动 + 每 6 小时后台静默拉取已安装插件最新版本，侧边栏「插件」按钮角标提示可更新数
//  - 插件详情页：点击插件行展开行内详情（完整描述 / 版本历史 npm time / README / 依赖 / 作者 / 许可证）
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

interface AwesomePlugin {
  name: string;
  owner: string;
  url: string;
  category: string;
  description: { en?: string; zh?: string };
  install: string;
  added?: string;
}

interface CategoryMap {
  [key: string]: { en: string; zh: string };
}

/** Rust 侧插件缓存（$APP_DATA/plugin-cache.json） */
interface PluginCache {
  /** pkgName -> npm 最新版本（失败的 "—" 不落盘） */
  versions: Record<string, string>;
  /** 最近一次成功检查时间（ISO） */
  updatedAt?: string;
}

const OFFICIAL_PKGS: Array<{ name: string; descKey: string }> = [
  { name: "@deepseek-ai/dsh-base", descKey: "plugins.official.base" },
  { name: "@deepseek-ai/dsh-web-app", descKey: "plugins.official.web" },
  { name: "@deepseek-ai/dsh-headless", descKey: "plugins.official.headless" },
  { name: "@deepseek-ai/dsh-llm-deepseek", descKey: "plugins.official.llm" },
];

const INDEX_URL = "https://awesome-dsh-plugin.com/plugins.json";
const CATEGORY_ORDER = ["ui", "theme", "session", "memory", "tools", "skill", "workflow", "notify", "model", "dev", "fun"];
/** 自动更新检查间隔：每 6 小时后台静默检查已安装插件 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 旧版 localStorage 缓存键（一次性迁移到 Rust 侧后删除） */
const LEGACY_VERSION_KEY = "oh-plugin-versions";
const LEGACY_BASELINE_KEY = "oh-plugin-baseline";
const REGISTRY_BASES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];

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

export interface PluginCenterOptions {
  /** 动作反馈：切到日志视图并追加一行日志 */
  onAction: (msg: string) => void;
}

/** 已安装 chip 的版本标签：file:/link: 本地链接显示「本地」；npm spec 原样 */
function chipVersionLabel(v: string): string {
  if (!v) return "";
  if (/^(file:|link:|\.|\/)/.test(v)) return t("plugins.chipLocal");
  return v;
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
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

/** 从 install 命令提取可安装 spec（add 之后的参数） */
function specOf(p: AwesomePlugin): string | null {
  const m = /add\s+(\S+)$/.exec(p.install || "");
  return m ? m[1] : null;
}

/** 是否 npm 可安装（github:/git+/file: 走非 npm 渠道，无版本号） */
function isNpmSpec(spec: string): boolean {
  return !/^(github:|git\+|file:|\.\/|\/)/.test(spec);
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

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function initPlugins(opts: PluginCenterOptions): void {
  const els = {
    refresh: $("plugins-refresh") as HTMLButtonElement,
    refreshLabel: $("plugins-refresh-label") as HTMLSpanElement,
    search: $("plugins-search") as HTMLInputElement,
    cats: $("plugin-cats"),
    chips: $("installed-chips"),
    path: $("profile-path"),
    official: $("official-grid"),
    tbody: $("plugin-tbody"),
    table: $("plugin-table"),
    count: $("plugin-count"),
    loading: $("plugin-loading"),
    badge: document.getElementById("nav-plugins-badge") as HTMLElement | null,
  };

  let categories: CategoryMap = {};
  let plugins: AwesomePlugin[] = [];
  let filterCat = "";
  let filterText = "";
  let installed: InstalledPlugins = { deps: {}, bundles: [], profile: "" };
  let versions: Record<string, string> = {};

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
    if (!spec || !isNpmSpec(spec)) return false;
    const iv = installedVersionOf(spec);
    return iv !== null && compareVer(latest, iv) > 0;
  };

  /** 可更新的已安装插件数量（侧边栏角标） */
  const countUpdatable = (): number => {
    let n = 0;
    for (const name of installedNames(installed)) {
      const pkg = pkgNameOf(name);
      const spec = installedSpecOf(pkg, name);
      if (!spec || !isNpmSpec(spec)) continue;
      const latest = versions[pkg];
      if (!latest || latest === "—") continue;
      const iv = installedVersionOf(spec);
      if (iv !== null && compareVer(latest, iv) > 0) n++;
    }
    return n;
  };

  /** 侧边栏「插件」按钮角标：可更新数量 */
  const updateBadge = (): void => {
    if (!els.badge) return;
    const n = countUpdatable();
    els.badge.hidden = n === 0;
    els.badge.textContent = n > 99 ? "99+" : String(n);
    els.badge.title = n ? t("plugins.badgeUpdates", { n }) : "";
  };

  /** 版本/基线缓存落盘（Rust 侧 plugin-cache.json；旧 localStorage 数据一次性迁移后清除） */
  const persistCache = async (): Promise<void> => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(versions)) {
      if (v && v !== "—") clean[k] = v;
    }
    const cache: PluginCache = { versions: clean, updatedAt: new Date().toISOString() };
    try {
      await setPluginCache(cache as unknown as Record<string, unknown>);
    } catch {
      // 磁盘失败不影响 UI，下次再试
    }
    try {
      localStorage.removeItem(LEGACY_VERSION_KEY);
      localStorage.removeItem(LEGACY_BASELINE_KEY);
    } catch {
      /* ignore */
    }
  };

  /** 从 Rust 侧加载缓存；为空时迁移旧 localStorage 版本号 */
  const loadCache = async (): Promise<void> => {
    try {
      const cached = (await getPluginCache()) as Partial<PluginCache>;
      if (cached.versions && typeof cached.versions === "object") {
        versions = { ...versions, ...cached.versions };
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
      // title：file:/link: 规格展示真实路径，方便排查
      el.title = spec ? `${n}@${spec}` : n;
      const txt = document.createElement("span");
      txt.textContent = label ? `${n} @${label}` : n;
      el.appendChild(txt);
      // 仅 dependency 可卸载（bundle 层如官方组合包不在此卸载）
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

  function renderCategories(): void {
    els.cats.innerHTML = "";
    const mk = (key: string, label: string): void => {
      const chip = document.createElement("button");
      chip.className = "cat-chip" + (filterCat === key ? " active" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => {
        filterCat = key;
        renderCategories();
        renderTable();
      });
      els.cats.appendChild(chip);
    };
    mk("", t("plugins.allCat"));
    const lang = getLang();
    CATEGORY_ORDER.forEach((c) => mk(c, categories[c]?.[lang] ?? c));
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

  function filtered(): AwesomePlugin[] {
    const q = filterText.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filterCat && p.category !== filterCat) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.owner} ${p.description?.zh ?? ""} ${p.description?.en ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /** 详情页操作按钮（安装/更新/卸载），与表格行内动作一致 */
  function appendDetailActions(container: HTMLElement, p: AwesomePlugin): void {
    const spec = specOf(p);
    const npm = spec !== null && isNpmSpec(spec);
    const pkg = spec ? pkgNameOf(spec) : p.name;
    const installedFlag = isInstalled(p.name);
    container.innerHTML = "";
    if (installedFlag) {
      if (npm) {
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
        performAction(`${t("plugins.install")} ${spec ?? p.name}`, ["plugin", "--profile", "web", "add", spec ?? p.name])
      );
      container.appendChild(inst);
    }
  }

  /** 行内详情：版本历史（npm time）/ 依赖 / README / 作者 / 许可证 */
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

    // 版本历史：time 中确属 versions 的键，按时间倒序取前 10
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

    // README 可能含任意内容 → 一律 textContent 渲染，滚动容器限高
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

  /** 展开/收起行内详情（单页无路由：点击插件行切换） */
  function toggleDetail(tr: HTMLTableRowElement, p: AwesomePlugin): void {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains("plugin-detail-row")) {
      existing.remove();
      tr.classList.remove("open");
      return;
    }
    // 收起其它已展开行
    els.tbody.querySelectorAll<HTMLTableRowElement>(".plugin-detail-row").forEach((r) => r.remove());
    els.tbody.querySelectorAll<HTMLTableRowElement>("tr.open").forEach((r) => r.classList.remove("open"));

    const spec = specOf(p);
    const npm = spec !== null && isNpmSpec(spec);
    const pkg = spec ? pkgNameOf(spec) : null;

    const detailTr = document.createElement("tr");
    detailTr.className = "plugin-detail-row";
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "plugin-detail-td";

    const box = document.createElement("div");
    box.className = "plugin-detail";

    const head = document.createElement("div");
    head.className = "detail-head";
    const nameEl = document.createElement("span");
    nameEl.className = "detail-name";
    nameEl.textContent = p.name;
    head.appendChild(nameEl);
    const catEl = document.createElement("span");
    catEl.className = "tag latest";
    catEl.textContent = p.category || "—";
    head.appendChild(catEl);
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
    const descEl = document.createElement("div");
    descEl.className = "detail-desc";
    descEl.textContent = desc;
    meta.appendChild(descEl);
    if (spec) {
      const specRow = document.createElement("div");
      specRow.className = "detail-spec";
      const lbl = document.createElement("span");
      lbl.textContent = t("plugins.detail.installSpec");
      const code = document.createElement("code");
      code.textContent = spec;
      specRow.appendChild(lbl);
      specRow.appendChild(code);
      meta.appendChild(specRow);
    }

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

    if (npm && pkg) {
      body.textContent = t("plugins.detail.loading");
      void renderNpmDetail(body, pkg);
    } else {
      const note = document.createElement("div");
      note.className = "detail-note";
      note.textContent = t("plugins.detail.nonNpm", { spec: spec ?? "—" });
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
      return;
    }
    rows.forEach((p) => {
      const spec = specOf(p);
      const npm = spec !== null && isNpmSpec(spec);
      const pkg = spec ? pkgNameOf(spec) : p.name;
      const ver = npm && versions[pkg] ? versions[pkg] : "—";
      const installedFlag = isInstalled(p.name);
      const updatable = isUpdatable(p.name, pkg, versions[pkg]);

      // 非 npm 源（github: 等）没有 npm 版本号，版本列给个弱标签说明来源
      let verHtml = escHtml(ver);
      if (!npm && spec) {
        const srcTag = spec.startsWith("github:") ? "github" : "git";
        verHtml = `<span class="ver-src">${srcTag}</span>`;
      }

      let tagHtml = "";
      if (installedFlag) tagHtml = `<span class="tag installed">${t("plugins.installedTag")}</span>`;
      else if (npm && ver !== "—") tagHtml = `<span class="tag latest">${t("plugins.latestTag")}</span>`;
      if (updatable) tagHtml = `<span class="tag update">${t("plugins.updateTag")}</span>`;

      let actionsHtml = "";
      if (installedFlag) {
        actionsHtml =
          (npm
            ? `<button class="install-btn btn-icon" data-act="update" data-spec="${escHtml(pkg)}">${iconSvg("upload")}${t("plugins.update")}</button> `
            : "") +
          `<button class="install-btn btn-icon" data-act="remove" data-name="${escHtml(p.name)}">${iconSvg("trash-2")}${t("plugins.remove")}</button>`;
      } else {
        actionsHtml = `<button class="install-btn btn-icon" data-act="install" data-spec="${escHtml(spec ?? p.name)}">${iconSvg("download")}${t("plugins.install")}</button>`;
      }

      const tr = document.createElement("tr");
      tr.className = "plugin-row";
      tr.title = t("plugins.detail.hint");
      tr.innerHTML = `
        <td class="pkg"><a href="${escHtml(p.url)}" target="_blank" rel="noopener">${escHtml(p.name)}</a></td>
        <td class="ver">${verHtml}</td>
        <td>${tagHtml}</td>
        <td class="desc">${escHtml(p.description?.zh ?? p.description?.en ?? "—")}</td>
        <td style="text-align:right;">${actionsHtml}</td>`;
      tr.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "install") performAction(`${t("plugins.install")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "add", b.dataset.spec!]);
          else if (act === "update") performAction(`${t("plugins.update")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "update", b.dataset.spec!]);
          else if (act === "remove") performAction(`${t("plugins.remove")} ${b.dataset.name}`, ["plugin", "--profile", "web", "remove", b.dataset.name!]);
        });
      });
      // 点击行（非链接/按钮区域）展开详情
      tr.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest("a, button, [data-act]")) return;
        toggleDetail(tr, p);
      });
      els.tbody.appendChild(tr);
    });
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

  /** 拉取 npm 版本（并发池，结果缓存到 Rust 侧；失败的 "—" 不缓存，下次刷新重试） */
  async function refreshVersions(): Promise<void> {
    const tasks = plugins
      .map((p) => specOf(p))
      .filter((s): s is string => s !== null && isNpmSpec(s))
      .map(pkgNameOf)
      .filter((n) => !versions[n] || versions[n] === "—");
    const unique = [...new Set(tasks)];
    let i = 0;
    const pool = 5;
    const worker = async (): Promise<void> => {
      while (i < unique.length) {
        const name = unique[i++];
        versions[name] = await fetchVersion(name);
        if (i % 20 === 0) void persistCache();
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, unique.length) }, () => worker()));
    await persistCache();
  }

  /** 自动更新检查：拉取已安装 npm 插件的最新版本。force=false 只补缺（启动用，秒级）；force=true 强制刷新（定时用） */
  async function checkInstalledUpdates(force: boolean): Promise<void> {
    const names = [
      ...new Set(
        installedNames(installed)
          .map((n) => installedSpecOf(pkgNameOf(n), n))
          .filter((s): s is string => !!s && isNpmSpec(s))
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
    await persistCache();
  }

  async function refreshIndex(): Promise<void> {
    els.refresh.disabled = true;
    els.refreshLabel.textContent = t("plugins.fetchingShort");
    els.loading.textContent = t("plugins.fetching");
    try {
      const r = await fetch(INDEX_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as {
        categories: CategoryMap;
        plugins: AwesomePlugin[];
      };
      categories = d.categories || {};
      plugins = d.plugins || [];
      els.loading.textContent = "";
      renderCategories();
      await refreshVersions();
    } catch (e) {
      els.loading.textContent = t("plugins.fetchFail", { err: String(e) });
    }
    await loadInstalled();
    renderOfficial();
    renderTable();
    updateBadge();
    els.refresh.disabled = false;
    els.refreshLabel.textContent = t("plugins.refresh");
  }

  els.refresh.addEventListener("click", refreshIndex);
  els.search.addEventListener("input", () => {
    filterText = els.search.value;
    renderTable();
  });

  // 语言切换后重渲染动态列表
  window.addEventListener("lang-changed", () => {
    els.refreshLabel.textContent = t("plugins.refresh");
    void loadInstalled();
    renderCategories();
    renderOfficial();
    renderTable();
    updateBadge();
  });

  // 初始加载：缓存（Rust 侧）→ 已安装 → 索引 → 启动静默更新检查 + 每 6h 定时检查
  void (async () => {
    await loadCache();
    await loadInstalled();
    renderOfficial();
    void refreshIndex();
    await checkInstalledUpdates(false);
    updateBadge();
    window.setInterval(() => {
      void checkInstalledUpdates(true).then(() => {
        updateBadge();
        if (document.getElementById("view-plugins")?.classList.contains("active")) renderTable();
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  })();
}
