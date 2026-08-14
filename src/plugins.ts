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

const OFFICIAL_PKGS: Array<{ name: string; desc: string }> = [
  { name: "@deepseek-ai/dsh-base", desc: "官方基础组合包（框架核心）" },
  { name: "@deepseek-ai/dsh-web-app", desc: "官方 Web 应用组合包" },
  { name: "@deepseek-ai/dsh-headless", desc: "官方 headless 组合包" },
  { name: "@deepseek-ai/dsh-llm-deepseek", desc: "DeepSeek LLM 接入插件" },
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
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (r.ok) {
      const d = (await r.json()) as { version?: string };
      if (d.version) return d.version;
    }
  } catch {
    // 国内网络可能失败，回退 npmmirror
  }
  try {
    const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(name)}/latest`);
    if (r.ok) {
      const d = (await r.json()) as { version?: string };
      if (d.version) return d.version;
    }
  } catch {
    // ignore
  }
  return "—";
}

export function initPlugins(opts: PluginCenterOptions): void {
  const els = {
    refresh: $("plugins-refresh") as HTMLButtonElement,
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
      els.chips.textContent = "暂无已安装插件（profile 未初始化）";
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
    mk("", "全部");
    CATEGORY_ORDER.forEach((c) => mk(c, categories[c]?.zh ?? c));
  }

  function renderOfficial(): void {
    els.official.innerHTML = "";
    OFFICIAL_PKGS.forEach((p) => {
      const card = document.createElement("div");
      card.className = "official-card";
      const btn = document.createElement("button");
      if (isInstalled(p.name)) {
        btn.textContent = "已安装";
        btn.disabled = true;
      } else {
        btn.textContent = "⬇ 安装";
        btn.addEventListener("click", () =>
          performAction(`安装 ${p.name}`, ["plugin", "--profile", "web", "add", p.name])
        );
      }
      card.innerHTML = `<div class="official-name">${p.name}</div><div class="official-desc">${p.desc}</div>`;
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
      els.loading.textContent = "没有匹配的插件";
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

      let tagHtml = "";
      if (installedFlag) tagHtml = '<span class="tag installed">已安装</span>';
      else if (npm && ver !== "—") tagHtml = '<span class="tag latest">最新</span>';

      let actionsHtml = "";
      if (installedFlag) {
        actionsHtml =
          (npm
            ? `<button class="install-btn" data-act="update" data-spec="${pkgNameOf(spec!)}">⬆ 更新</button> `
            : "") +
          `<button class="install-btn" data-act="remove" data-name="${p.name}">🗑 卸载</button>`;
        if (updatable) tagHtml = '<span class="tag update">🆕 可更新</span>';
      } else {
        actionsHtml = `<button class="install-btn" data-act="install" data-spec="${spec ?? p.name}">⬇ 安装</button>`;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="pkg"><a href="${p.url}" target="_blank" rel="noopener">${p.name}</a></td>
        <td class="ver">${ver}</td>
        <td>${tagHtml}</td>
        <td class="desc">${p.description?.zh ?? p.description?.en ?? "—"}</td>
        <td style="text-align:right;">${actionsHtml}</td>`;
      tr.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "install") performAction(`安装 ${b.dataset.spec}`, ["plugin", "--profile", "web", "add", b.dataset.spec!]);
          else if (act === "update") performAction(`更新 ${b.dataset.spec}`, ["plugin", "--profile", "web", "update", b.dataset.spec!]);
          else if (act === "remove") performAction(`卸载 ${b.dataset.name}`, ["plugin", "--profile", "web", "remove", b.dataset.name!]);
        });
      });
      els.tbody.appendChild(tr);
    });
  }

  async function performAction(label: string, args: string[]): Promise<void> {
    opts.onAction(`⏳ ${label} …`);
    try {
      await runDshCmd(args);
      opts.onAction(`✅ ${label} 完成，正在重启 DSH 使插件生效…`);
      await restartDsh();
      opts.onAction("🔄 DSH 已重启，插件已生效");
    } catch (e) {
      opts.onAction(`❌ ${label} 失败: ${e}`);
    }
    await loadInstalled();
    renderOfficial();
    renderTable();
  }

  /** 拉取 npm 版本（并发池，结果缓存到 localStorage） */
  async function refreshVersions(): Promise<void> {
    const tasks = plugins
      .map((p) => specOf(p))
      .filter((s): s is string => s !== null && isNpmSpec(s))
      .map(pkgNameOf)
      .filter((n) => !versions[n]);
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
      localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify(versions));
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
    els.refresh.textContent = "📡 获取中…";
    els.loading.textContent = "⏳ 正在获取插件索引…";
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
      els.loading.textContent = "⚠️ 获取插件索引失败：" + String(e) + "（请检查网络）";
    }
    await loadInstalled();
    renderOfficial();
    renderTable();
    els.refresh.disabled = false;
    els.refresh.textContent = "📡 刷新插件索引";
  }

  els.refresh.addEventListener("click", refreshIndex);
  els.search.addEventListener("input", () => {
    filterText = els.search.value;
    renderTable();
  });

  // 初始加载
  void loadInstalled().then(() => {
    renderOfficial();
    void refreshIndex();
  });
}
