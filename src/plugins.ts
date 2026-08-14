// src/plugins.ts —— 插件中心
// 定位（决策 C）：app 管「生命周期」（安装/更新/卸载/重启生效/版本检查），dsh web 管「配置」。
// 索引来源：awesome-dsh-plugin.com/plugins.json（机器可读，143+ 社区插件）+ npm registry 补版本。
import {
  listInstalled,
  installedNames,
  runDshCmd,
  restartDsh,
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

const OFFICIAL_PKGS: Array<{ name: string; descKey: string }> = [
  { name: "@deepseek-ai/dsh-base", descKey: "plugins.official.base" },
  { name: "@deepseek-ai/dsh-web-app", descKey: "plugins.official.web" },
  { name: "@deepseek-ai/dsh-headless", descKey: "plugins.official.headless" },
  { name: "@deepseek-ai/dsh-llm-deepseek", descKey: "plugins.official.llm" },
];

const INDEX_URL = "https://awesome-dsh-plugin.com/plugins.json";
const CATEGORY_ORDER = ["ui", "session", "tools", "workflow", "notify", "dev", "fun"];
const VERSION_CACHE_KEY = "oh-plugin-versions";
const BASELINE_KEY = "oh-plugin-baseline";

export interface PluginCenterOptions {
  /** 动作反馈：切到日志视图并追加一行日志 */
  onAction: (msg: string) => void;
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

async function fetchVersion(name: string): Promise<string> {
  const tryFetch = async (base: string): Promise<string | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(name)}/latest`, { signal: ctrl.signal });
      if (r.ok) {
        const d = (await r.json()) as { version?: string };
        if (d.version) return d.version;
      }
    } catch {
      // 国内网络可能失败，回退 npmmirror
    } finally {
      clearTimeout(timer);
    }
    return null;
  };
  const v = (await tryFetch("https://registry.npmjs.org")) ??
    (await tryFetch("https://registry.npmmirror.com"));
  return v ?? "—";
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
  };

  let categories: CategoryMap = {};
  let plugins: AwesomePlugin[] = [];
  let filterCat = "";
  let filterText = "";
  let installed: InstalledPlugins = { deps: {}, bundles: [], profile: "" };
  let versions: Record<string, string> = {};
  try {
    versions = JSON.parse(localStorage.getItem(VERSION_CACHE_KEY) || "{}") as Record<string, string>;
  } catch {
    versions = {};
  }

  const isInstalled = (name: string): boolean => installedNames(installed).includes(name);

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
      const el = document.createElement("span");
      el.className = "chip";
      const v = (installed.deps || {})[n];
      el.innerHTML = v ? `${n} <b>@${v}</b>` : n;
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
      const ver = npm && versions[pkgNameOf(spec)] ? versions[pkgNameOf(spec)] : "—";
      const installedFlag = isInstalled(p.name);
      const baseline = JSON.parse(localStorage.getItem(BASELINE_KEY) || "{}") as Record<string, string>;
      const prev = baseline[p.name];
      const updatable = installedFlag && npm && ver !== "—" && prev && compareVer(ver, prev) > 0;

      const esc = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      // 非 npm 源（github: 等）没有 npm 版本号，版本列给个弱标签说明来源
      let verHtml = esc(ver);
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
            ? `<button class="install-btn btn-icon" data-act="update" data-spec="${esc(pkgNameOf(spec!))}">${iconSvg("upload")}${t("plugins.update")}</button> `
            : "") +
          `<button class="install-btn btn-icon" data-act="remove" data-name="${esc(p.name)}">${iconSvg("trash-2")}${t("plugins.remove")}</button>`;
      } else {
        actionsHtml = `<button class="install-btn btn-icon" data-act="install" data-spec="${esc(spec ?? p.name)}">${iconSvg("download")}${t("plugins.install")}</button>`;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="pkg"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></td>
        <td class="ver">${verHtml}</td>
        <td>${tagHtml}</td>
        <td class="desc">${esc(p.description?.zh ?? p.description?.en ?? "—")}</td>
        <td style="text-align:right;">${actionsHtml}</td>`;
      tr.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "install") performAction(`${t("plugins.install")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "add", b.dataset.spec!]);
          else if (act === "update") performAction(`${t("plugins.update")} ${b.dataset.spec}`, ["plugin", "--profile", "web", "update", b.dataset.spec!]);
          else if (act === "remove") performAction(`${t("plugins.remove")} ${b.dataset.name}`, ["plugin", "--profile", "web", "remove", b.dataset.name!]);
        });
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
  }

  /** 拉取 npm 版本（并发池，结果缓存到 localStorage；失败的 "—" 不缓存，下次刷新重试） */
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
        if (i % 20 === 0) persistVersions();
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, unique.length) }, () => worker()));
    persistVersions();
  }

  function persistVersions(): void {
    try {
      // 只缓存真实版本号，"—"（失败）不落盘，保证下次刷新会重试
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(versions)) {
        if (v && v !== "—") clean[k] = v;
      }
      localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify(clean));
      // 更新基线：记录本次看到的最新版本，下次对比出「可更新」
      const baseline: Record<string, string> = {};
      plugins.forEach((p) => {
        const spec = specOf(p);
        if (spec && isNpmSpec(spec)) {
          const v = versions[pkgNameOf(spec)];
          if (v && v !== "—") baseline[p.name] = v;
        }
      });
      localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
    } catch {
      // ignore
    }
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
  });

  // 初始加载
  void loadInstalled().then(() => {
    renderOfficial();
    void refreshIndex();
  });
}
