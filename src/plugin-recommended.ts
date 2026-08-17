// src/plugin-recommended.ts —— 「特别推荐」静态名单（013 §2.4）
// 原则：app 发布给其他用户后不能依赖开发机目录，名单必须编译进前端；
//       不扫描本地文件系统，registry 未收录也照常展示（安装动作用自带 installSpec）。
// 初版名单 5 项（2026-08-17 用户确认；openharness-voice 不列入）。

export interface RecommendedPlugin {
  /** 稳定 id */
  id: string;
  /** 展示名 = npm 包名 / repo 短名 */
  name: string;
  /** 已发布 npm 包名（优先作为 installSpec / 更新语义最完整） */
  npmPkg: string;
  /** "owner/repo" */
  githubRepo: string;
  /** GitHub 仓库链接 */
  url: string;
  /** 安装规格（npm 包名） */
  installSpec: string;
  /** i18n key：推荐理由 */
  reasonKey: string;
  /** 发布状态：本期 5 项均为双发布；未来未发布候选置 "pending" 并置灰 */
  published: "npm+github" | "pending";
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    id: "openharness-reader",
    name: "openharness-reader",
    npmPkg: "openharness-reader",
    githubRepo: "zuoguyoupan2023/openharness-reader",
    url: "https://github.com/zuoguyoupan2023/openharness-reader",
    installSpec: "openharness-reader",
    reasonKey: "plugins.recommended.reason.reader",
    published: "npm+github",
  },
  {
    id: "openharness-reply-in-cn",
    name: "openharness-reply-in-cn",
    npmPkg: "openharness-reply-in-cn",
    githubRepo: "zuoguyoupan2023/openharness-reply-in-cn",
    url: "https://github.com/zuoguyoupan2023/openharness-reply-in-cn",
    installSpec: "openharness-reply-in-cn",
    reasonKey: "plugins.recommended.reason.replyInCn",
    published: "npm+github",
  },
  {
    id: "openharness-rule-for-dsh-plugin",
    name: "openharness-rule-for-dsh-plugin",
    npmPkg: "openharness-rule-for-dsh-plugin",
    githubRepo: "zuoguyoupan2023/openharness-rule-for-dsh-plugin",
    url: "https://github.com/zuoguyoupan2023/openharness-rule-for-dsh-plugin",
    installSpec: "openharness-rule-for-dsh-plugin",
    reasonKey: "plugins.recommended.reason.ruleForDsh",
    published: "npm+github",
  },
  {
    id: "openharness-core-rule",
    name: "openharness-core-rule",
    npmPkg: "openharness-core-rule",
    githubRepo: "zuoguyoupan2023/openharness-core-rule",
    url: "https://github.com/zuoguyoupan2023/openharness-core-rule",
    installSpec: "openharness-core-rule",
    reasonKey: "plugins.recommended.reason.coreRule",
    published: "npm+github",
  },
  {
    id: "adhdgofly-dsh-ext",
    name: "adhdgofly-dsh-ext",
    npmPkg: "adhdgofly-dsh-ext",
    githubRepo: "zuoguyoupan2023/adhdgofly-dsh-ext",
    url: "https://github.com/zuoguyoupan2023/adhdgofly-dsh-ext",
    installSpec: "adhdgofly-dsh-ext",
    reasonKey: "plugins.recommended.reason.adhd",
    published: "npm+github",
  },
];
