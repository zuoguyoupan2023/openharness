// scripts/extract-icons.mjs —— 从 @iconify-json/lucide 提取少量图标，生成 src/icons.generated.ts
// 用法：node scripts/extract-icons.mjs
// 产物：src/icons.generated.ts（纯数据，离线内联，不依赖 Iconify API）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const lucide = JSON.parse(
  readFileSync(join(root, "node_modules/@iconify-json/lucide/icons.json"), "utf8")
);

// 需要用到的图标（lucide 集；新增图标在此追加后重跑脚本）
const NEEDED = [
  "message-square", // 对话
  "terminal", // 日志
  "puzzle", // 插件
  "settings", // 设置
  "sun",
  "moon",
  "globe", // 语言快捷切换
  "languages", // 语言设置组
  "plus", // 新建标签
  "x", // 关闭标签
  "arrow-left",
  "arrow-right",
  "refresh-cw", // 刷新/重启/重试
  "house", // 主页（lucide 新名，旧 home 已改名）
  "download", // 安装
  "upload", // 更新
  "trash-2", // 卸载
  "search", // 检测
  "wrench", // Node 向导
  "save", // 保存
  "circle-check", // 已安装区标题
  "package", // 官方组合包标题
  "boxes", // 社区插件标题
  "sun-moon", // 外观设置组
  "star", // 插件中心：来源 tabs「精选」+ ★stars 列
  "github", // 插件中心：来源 tabs「GitHub Topic」
  "check", // 插件中心：刷新成功提示条
  "triangle-alert", // 插件中心：刷新失败提示条（lucide 新名，旧 alert-triangle 已改名）
  "folder-open", // 插件中心：安装本地插件
];

const out = {};
const missing = [];
for (const name of NEEDED) {
  const icon = lucide.icons?.[name];
  if (!icon) {
    missing.push(name);
    continue;
  }
  // 仅保留 iconSvg 实际使用的字段（body / width / height），剔除 lucide 的 hidden/aliases 等
  const slim = { body: icon.body };
  if (icon.width) slim.width = icon.width;
  if (icon.height) slim.height = icon.height;
  out[name] = slim;
}
if (missing.length) {
  console.error("缺失图标:", missing.join(", "));
  process.exit(1);
}

const lines = [
  "// ⚠️ 自动生成文件 —— 由 scripts/extract-icons.mjs 生成，请勿手改。",
  "// 新增图标：在 scripts/extract-icons.mjs 的 NEEDED 中追加后运行 `node scripts/extract-icons.mjs`。",
  "",
  "export interface IconData { body: string; width?: number; height?: number }",
  "",
  "export const GENERATED_ICONS: Record<string, IconData> = " +
    JSON.stringify(out, null, 2) +
    ";",
  "",
];

writeFileSync(join(root, "src/icons.generated.ts"), lines.join("\n"));
console.log(
  `已生成 src/icons.generated.ts：${Object.keys(out).length} 个图标（${NEEDED.length} 个请求）`
);
