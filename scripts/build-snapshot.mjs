#!/usr/bin/env node
// scripts/build-snapshot.mjs
// 006 计划 · 构建期生成「自维护插件 registry」。
//
// 流程（006 §6 决策）：
//   上游只读不维护：
//     ① awesome-dsh-plugin.com/plugins.json（人工精选、含安装命令/中文描述/stars）
//     ② bradeGithub/DSH-Plugins-Marketplace registry.json（GitHub topic `dsh-plugin` 全量、静态免限流、字段全）
//   ↓ 本脚本：拉取 → plugin-filter.json 黑白名单过滤 → 归一为 PluginEntry → 按 full_name 合并去重（awesome 优先）
//   ↓ 生成产物：
//     · src/plugin-registry.generated.json   —— 打包快照（随 app 发布，秒开/离线，前端 import）
//     · plugins.registry.json（repo 根）      —— 分发用（jsdelivr CDN / GitHub raw，后台刷新取最新）
//
// 质量标注：自动过滤、人工未逐条审核；过滤规则在 scripts/plugin-filter.json 手维护可迭代。
// 前端不做过滤——比「前端过滤」更快、体积更小、逻辑更简单。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const AWESOME_URL = "https://awesome-dsh-plugin.com/plugins.json";
// marketplace 静态文件：jsdelivr CDN（自动从 GitHub 同步、国内有节点）→ GitHub raw 兜底
const MARKETPLACE_URLS = [
  "https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/registry.json",
  "https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/registry.json",
];
const FETCH_TIMEOUT_MS = 60_000;

const FILTER_PATH = join(ROOT, "scripts", "plugin-filter.json");
const OUT_SNAPSHOT = join(ROOT, "src", "plugin-registry.generated.json");
const OUT_REGISTRY = join(ROOT, "plugins.registry.json");

/** 归一化后的统一条目（与 src/plugin-sources.ts 的 PluginEntry 对齐） */
/** @typedef {{zh?:string,en?:string}} Desc */

/** 带超时的 fetch（AbortController），失败抛错 */
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发拉取所有候选 URL，按 count（或 repos 长度）取最新的一个。
 * 解决 jsdelivr CDN 缓存滞后（实测比 raw 旧 ~10h、少近一半条目）的问题。
 */
async function fetchAllPickNewest(urls, what) {
  const settled = await Promise.allSettled(
    urls.map(async (u) => {
      console.log(`  → 候选 ${what}: ${u}`);
      return { data: await fetchJson(u), url: u };
    })
  );
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (!ok.length) {
    const reasons = settled.filter((s) => s.status === "rejected").map((s) => String(s.reason?.message || s.reason));
    throw new Error(`所有镜像均失败（${what}）: ${reasons.join(" / ")}`);
  }
  ok.sort(
    (a, b) => (b.data.count || 0) - (a.data.count || 0) || (b.data.repos?.length || 0) - (a.data.repos?.length || 0)
  );
  const best = ok[0];
  console.log(`  ✓ ${what}: ${best.data.count} 条 @ ${best.data.generated_at || "?"}（取 ${ok.length} 个候选中最新者）`);
  for (const o of ok.slice(1)) {
    console.warn(`     跳过较旧候选：${o.data.count} 条 @ ${o.data.generated_at || "?"}`);
  }
  return best.data;
}

// ============================ 过滤规则 ============================

let FILTER;
async function loadFilter() {
  const raw = await readFile(FILTER_PATH, "utf8");
  FILTER = JSON.parse(raw);
}

/** 从 awesome url 解析 owner/repo（lowercased），回退 owner+name */
function awesomeFullName(p) {
  const m = /github\.com\/([^/]+)\/([^/?#]+?)(?:[/?#]|$)/i.exec(p.url || "");
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  if (p.owner && p.name) return `${p.owner}/${p.name}`.toLowerCase();
  return p.name ? p.name.toLowerCase() : "";
}

/** marketplace：pkg_name 是否含 dsh/deepseek 命名身份（去掉 @scope 后判断） */
function pkgBasePkg(pkg) {
  return String(pkg || "").toLowerCase().replace(/^@[^/]+\//, "");
}

/** 命名身份闸门：pkg 或 repo name 含 dsh/deepseek，或在 awesome，或带强正类 topic */
function nameGate(r, awesomeNameSet, awesomeFullSet) {
  const name = String(r.name || "").toLowerCase();
  const pkg = pkgBasePkg(r.pkg_name);
  const full = String(r.full_name || "").toLowerCase();
  if (awesomeNameSet.has(name)) return true;
  if (awesomeFullSet.has(full)) return true;
  if (pkg && FILTER.namingKeywords.some((k) => pkg.includes(k))) return true;
  if (name && FILTER.namingKeywords.some((k) => name.includes(k))) return true;
  if ((r.topics || []).some((t) => FILTER.keepTopics.includes(t))) return true;
  return false;
}

function softBlacklistHit(desc) {
  const d = String(desc || "").toLowerCase();
  return FILTER.softBlacklist.keywords.some((k) => d.includes(k));
}

// ============================ 归一化 ============================

const isNpmSpec = (spec) => !/^(github:|git\+|file:|\.(\/|$))/i.test(spec || "");
/** 从 awesome install 命令解析安装 spec */
function specOfInstall(install) {
  const m = /add\s+(\S+?)(?:\s|$)/.exec(install || "");
  return m ? m[1] : null;
}
/** 去末尾版本号 */
function pkgNameOf(spec) {
  const idx = String(spec || "").lastIndexOf("@");
  if (idx > 0 && /^\d/.test(spec.slice(idx + 1))) return spec.slice(0, idx);
  return spec;
}

/**
 * 归一化为统一的 PluginEntry（合并时 awesome 优先，topic 补元数据）。
 * sources 记录来源成员关系：awesome / topic。schema 精简以控体积（install 命令可由 installSpec 重建）。
 * 字段：id,name,sources,url,category,topicCategory,desc{zh,en},added,stars,license,updated_at,pkg,version,installSpec,isNpm
 */
const DESC_MAX = 160;

function normalizeAwesome(p, metaStars) {
  const spec = specOfInstall(p.install);
  const npm = spec !== null && isNpmSpec(spec);
  const pkg = spec ? pkgNameOf(spec) : p.name;
  const fullName = awesomeFullName(p);
  return {
    id: fullName || (p.npm ? String(p.npm).toLowerCase() : String(p.name).toLowerCase()),
    name: p.name,
    sources: ["awesome"],
    url: p.url || undefined,
    category: p.category || undefined,
    description: { zh: p.description?.zh || undefined, en: p.description?.en || undefined },
    added: p.added || undefined,
    stars: typeof metaStars === "number" ? metaStars : (typeof p.stars === "number" ? p.stars : undefined),
    pkg_name: p.npm || (npm ? pkg : undefined),
    installSpec: spec || (p.npm ? p.npm : `github:${fullName}`),
    isNpm: spec ? npm : !!p.npm,
  };
}

function normalizeTopic(r, overrideDesc) {
  const pkg = r.pkg_name && String(r.pkg_name).trim() ? String(r.pkg_name) : null;
  const installSpec = pkg ? pkg : `github:${String(r.full_name || "")}`;
  let en = overrideDesc?.en || r.description || undefined;
  if (en && en.length > DESC_MAX) en = en.slice(0, DESC_MAX - 1) + "…";
  return {
    id: String(r.full_name || "").toLowerCase(),
    name: r.name,
    sources: ["topic"],
    url: r.html_url || undefined,
    topicCategory: r.category || undefined,
    stars: typeof r.stargazers_count === "number" ? r.stargazers_count : undefined,
    license: r.license || undefined,
    updated_at: r.updated_at || undefined,
    pkg_name: pkg || undefined,
    version: r.version || undefined,
    description: { zh: overrideDesc?.zh || undefined, en },
    installSpec,
    isNpm: !!pkg,
  };
}

// ============================ 主流程 ============================

async function main() {
  await loadFilter();

  console.log("⏳ 拉取上游数据源…");
  let awesome = null;
  try {
    awesome = await fetchJson(AWESOME_URL);
    console.log(`  ✓ awesome: ${awesome.count} 条（${Object.keys(awesome.categories || {}).length} 分类）`);
  } catch (e) {
    console.warn(`  ✗ awesome 拉取失败（${String(e.message || e)}），将仅用 marketplace 生成（部分中英文描述/安装命令将缺失）`);
  }

  let market = null;
  try {
    market = await fetchAllPickNewest(MARKETPLACE_URLS, "marketplace registry");
  } catch (e) {
    console.warn(`  ✗ marketplace 拉取失败（${String(e.message || e)}），将仅用 awesome 生成`);
  }

  if (!awesome && !market) {
    throw new Error("两个上游数据源均拉取失败，无法生成 registry；请检查网络。");
  }

  const awesomePlugins = awesome?.plugins || [];
  const awesomeNameSet = new Set(awesomePlugins.map((p) => String(p.name || "").toLowerCase()));
  const awesomeFullSet = new Set(awesomePlugins.map((p) => awesomeFullName(p)).filter(Boolean));

  const repoRepos = market?.repos || [];

  // —— 归一 awesome ——
  // 同一 repo（monorepo 多子包共用 GitHub URL）会映射到同一 id：发生碰撞时优先保留
  // 「npm 可安装」的条目（用户可一键装），其余子包经详情里的仓库链接可达。统计碰撞以供维护参考。
  const byId = new Map();
  let awesomeCollisions = 0;
  for (const p of awesomePlugins) {
    const e = normalizeAwesome(p, p.stars);
    if (!e.id) continue;
    const existing = byId.get(e.id);
    if (existing) {
      awesomeCollisions++;
      // 优先保留 npm 可安装；若两者都是 npm 或都是 github，保留更早收录（added 更小者）
      if (e.isNpm && !existing.isNpm) byId.set(e.id, e);
      else if (e.isNpm === existing.isNpm && (e.added || "") < (existing.added || "")) byId.set(e.id, e);
    } else {
      byId.set(e.id, e);
    }
  }
  if (awesomeCollisions) console.log(`  · awesome monorepo 同 repo 碰撞合并：${awesomeCollisions} 个子包并入其 repo（优先 npm 可安装条目）`);

  // —— 过滤 + 归一 marketplace ——
  let dropped = [];
  let keptTopic = 0;
  for (const r of repoRepos) {
    const full = String(r.full_name || "").toLowerCase();
    if (FILTER.blacklistRepos?.includes(full)) { dropped.push([r.stargazers_count, r.full_name, "blacklistRepos"]); continue; }
    const gate = nameGate(r, awesomeNameSet, awesomeFullSet) || (FILTER.whitelistRepos || []).includes(full);
    if (!gate) { dropped.push([r.stargazers_count, r.full_name, "no-naming-identity"]); continue; }
    // 命名身份通过后，softBlacklist 仅剔除「非 awesome 且高星 + 通用工具关键词」
    const inAwesome = awesomeNameSet.has(String(r.name || "").toLowerCase()) || awesomeFullSet.has(full);
    if (!inAwesome && softBlacklistHit(r.description) && (r.stargazers_count || 0) >= (FILTER.softBlacklist.minStars || 0)) {
      dropped.push([r.stargazers_count, r.full_name, "softBlacklist"]);
      continue;
    }
    const ov = FILTER.overrides?.[full] || {};
    const e = normalizeTopic(r, ov.description);
    keptTopic++;
    // 合并：若 awesome 已有同 id，则以 awesome 为主、topic 补元数据
    if (byId.has(e.id)) {
      const a = byId.get(e.id);
      a.sources = ["awesome", "topic"];
      if (!a.url) a.url = e.url;
      // stars 取 topic 的（GitHub 权威），无则保留 awesome 的
      if (typeof e.stars === "number") a.stars = e.stars;
      a.license = e.license || a.license;
      a.updated_at = e.updated_at || a.updated_at;
      a.pkg_name = a.pkg_name || e.pkg_name;
      a.version = a.version || e.version;
      a.topicCategory = e.topicCategory;
      // 描述：awesome 的 zh 优先；若 awesome 缺 en 则用 marketplace description
      if (!a.description?.en && e.description?.en) a.description.en = e.description.en;
    } else {
      byId.set(e.id, e);
    }
  }

  // —— overrides.license / category 等字段覆盖（手工修正）——
  for (const [full, ov] of Object.entries(FILTER.overrides || {})) {
    const e = byId.get(full);
    if (!e) continue;
    if (ov.description?.zh) e.description = e.description || {}, e.description.zh = ov.description.zh;
    if (ov.description?.en) e.description = e.description || {}, e.description.en = ov.description.en;
    if (ov.install) { e.install = ov.install; const s = specOfInstall(ov.install); if (s) { e.installSpec = s; e.isNpm = isNpmSpec(s); e.pkg_name = isNpmSpec(s) ? pkgNameOf(s) : e.pkg_name; } }
    if (ov.category) e.category = ov.category;
    if (ov.license) e.license = ov.license;
  }

  const plugins = [...byId.values()];
  // 排序：合并态 > awesome > topic；同组内 stars 降序；name 兜底
  const srcRank = (e) => (e.sources.length >= 2 ? 0 : e.sources.includes("awesome") ? 1 : 2);
  plugins.sort((a, b) => srcRank(a) - srcRank(b) || (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name));

  const snapshot = {
    generated_at: new Date().toISOString(),
    count: plugins.length,
    awesome: { updated: awesome?.updated || null, count: awesomePlugins.length, categories: awesome?.categories || null },
    marketplace: { generated_at: market?.generated_at || null, count: repoRepos.length },
    filter_note: "自动过滤、人工未逐条审核；规则见 scripts/plugin-filter.json，迭代可手工增删",
    plugins,
  };

  console.log(`\n✓ 生成 registry：${plugins.length} 条`);
  console.log(`   - awesome 归一：${awesomePlugins.length}；topic 保留：${keptTopic}；剔除：${dropped.length}`);
  const topDrop = dropped.sort((a, b) => b[0] - a[0]).slice(0, 8);
  console.log(`   - 剔除 top 8（高星通用工具，应为非 DSH 插件）：`);
  for (const [s, fn, why] of topDrop) console.log(`       ★${s}  ${fn}  [${why}]`);

  await mkdir(dirname(OUT_SNAPSHOT), { recursive: true });
  const minified = JSON.stringify(snapshot);
  await writeFile(OUT_SNAPSHOT, minified, "utf8");
  await writeFile(OUT_REGISTRY, minified, "utf8");
  const kb = (Buffer.byteLength(minified, "utf8") / 1024).toFixed(1);
  console.log(`\n📦 写出：`);
  console.log(`   · ${OUT_SNAPSHOT.replace(ROOT + "/", "")}  (${kb} KB)`);
  console.log(`   · ${OUT_REGISTRY.replace(ROOT + "/", "")}  (${kb} KB)`);
  console.log(`✅ build-snapshot 完成`);
}

main().catch((e) => {
  console.error("❌ build-snapshot 失败:", e);
  process.exit(1);
});