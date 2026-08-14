// src/icons.ts —— 图标：从 Iconify（lucide 集）提取为内联 SVG（禁用 emoji 约定）
// 数据源 src/icons.generated.ts 由 scripts/extract-icons.mjs 生成（离线，不依赖 Iconify API / 网络）。
// 用内联 <svg> 而非 iconify-icon Web Component：组件走 shadow DOM 且尺寸靠 1em 继承，
// 在 Tauri WKWebView 下尺寸不可控（图标过大/溢出）；内联 svg 由 CSS 的 em 精确控制。
import { GENERATED_ICONS } from "./icons.generated";

/** 生成内联 SVG 字符串（svg 自带 1em 尺寸，随外层 font-size 缩放；在 [data-icon] 容器内同样适用） */
export function iconSvg(name: string): string {
  const d = GENERATED_ICONS[name];
  if (!d) return "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    d.body +
    `</svg>`
  );
}

/** 把 [data-icon] 占位元素填充为内联 SVG（静态 HTML 图标统一走这里） */
export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const name = el.dataset.icon || "";
    el.innerHTML = iconSvg(name);
  });
}
