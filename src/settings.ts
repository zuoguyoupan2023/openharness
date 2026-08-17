// src/settings.ts —— 设置视图（npm 镜像源、Node 环境、DSH 生命周期、外观、语言、DSH 版本）
import { restartDsh, getDshVersionInfo, setDshVersionLock } from "./dsh";
import { getSettings, setRegistry, setCloseWithApp, NPM_MIRROR } from "./config";
import { t, setLang, getLang } from "./i18n";
import { setThemePref, getThemePref, ThemePref } from "./theme";
import { getLinkMode, setLinkMode, LinkOpenMode } from "./open-link";
import { getIndexSourcePref, getIndexSourceCustom, setIndexSourcePref, getIndexSourceGitee, setIndexSourceGitee, getDefaultGiteeUrl, type IndexSource } from "./plugin-sources";

export function initSettings(): void {
  const radios = document.getElementsByName("registry") as NodeListOf<HTMLInputElement>;
  const custom = document.getElementById("registry-custom") as HTMLInputElement;
  const save = document.getElementById("registry-save") as HTMLButtonElement;
  const saved = document.getElementById("registry-saved") as HTMLSpanElement;
  const restartBtn = document.getElementById("settings-restart") as HTMLButtonElement;
  const closeWithApp = document.getElementById("settings-close-with-app") as HTMLInputElement;
  const lcSaved = document.getElementById("settings-lc-saved") as HTMLSpanElement;

  void getSettings().then((s) => {
    const isMirror = s.registry === NPM_MIRROR;
    const isCustom = s.registry !== "" && s.registry !== NPM_MIRROR;
    radios.forEach((r) => {
      if (r.value === "__custom") r.checked = isCustom;
      else if (r.value === NPM_MIRROR) r.checked = isMirror;
      else r.checked = s.registry === "";
    });
    if (isCustom) custom.value = s.registry;
    closeWithApp.checked = s.closeWithApp;
  });

  save.addEventListener("click", async () => {
    let url = "";
    for (const r of radios) {
      if (!r.checked) continue;
      url = r.value === "__custom" ? custom.value.trim() : r.value;
      break;
    }
    if (url !== "" && !/^https?:\/\//.test(url)) {
      saved.textContent = t("settings.registry.errUrl");
      return;
    }
    try {
      await setRegistry(url);
      saved.textContent = t("settings.registry.saved");
    } catch (e) {
      saved.textContent = t("settings.registry.errSave") + String(e);
    }
    setTimeout(() => {
      saved.textContent = "";
    }, 5000);
  });

  // 关闭 app 时是否同时关闭 3080 上的 DSH（默认开启）
  closeWithApp.addEventListener("change", async () => {
    try {
      await setCloseWithApp(closeWithApp.checked);
      lcSaved.textContent = closeWithApp.checked
        ? t("settings.dsh.savedOn")
        : t("settings.dsh.savedOff");
    } catch (e) {
      lcSaved.textContent = t("settings.registry.errSave") + String(e);
    }
    setTimeout(() => {
      lcSaved.textContent = "";
    }, 5000);
  });

  restartBtn.addEventListener("click", async () => {
    saved.textContent = t("settings.dsh.restarting");
    try {
      // 重启后 dsh-ready 事件会触发标签页自动重连
      await restartDsh();
      saved.textContent = t("settings.dsh.restarted");
    } catch (e) {
      saved.textContent = t("settings.registry.errSave") + String(e);
    }
    setTimeout(() => {
      saved.textContent = "";
    }, 5000);
  });

  // ===== 外观：跟随系统 / 亮色 / 暗色 =====
  const themeRadios = document.getElementsByName("theme") as NodeListOf<HTMLInputElement>;
  const syncThemeRadios = (): void => {
    const pref = getThemePref();
    themeRadios.forEach((r) => {
      r.checked = r.value === pref;
    });
  };
  syncThemeRadios();
  themeRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) setThemePref(r.value as ThemePref);
    });
  });

  // ===== 语言：中文 / English =====
  const langRadios = document.getElementsByName("lang") as NodeListOf<HTMLInputElement>;
  const syncLangRadios = (): void => {
    const l = getLang();
    langRadios.forEach((r) => {
      r.checked = r.value === l;
    });
  };
  syncLangRadios();
  langRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) setLang(r.value === "zh" ? "zh" : "en");
    });
  });

  // ===== 链接打开方式：每次询问 / App 内打开 / 系统浏览器 =====
  const linkRadios = document.getElementsByName("link-mode") as NodeListOf<HTMLInputElement>;
  const linkSaved = document.getElementById("settings-links-saved") as HTMLSpanElement | null;
  const syncLinkRadios = (): void => {
    const m = getLinkMode();
    linkRadios.forEach((r) => {
      r.checked = r.value === m;
    });
  };
  syncLinkRadios();
  // 语言切换后若文案变化，保持选中态
  window.addEventListener("lang-changed", syncLinkRadios);
  linkRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      setLinkMode(r.value as LinkOpenMode);
      if (linkSaved) {
        linkSaved.textContent = t("settings.links.saved");
        setTimeout(() => {
          linkSaved.textContent = "";
        }, 3000);
      }
    });
  });

  // ===== 插件索引源（006 双数据源后台刷新取源） =====
  const idxRadios = document.getElementsByName("plugin-index-source") as NodeListOf<HTMLInputElement>;
  const idxCustom = document.getElementById("plugin-index-source-custom") as HTMLInputElement | null;
  const idxGitee = document.getElementById("plugin-index-source-gitee") as HTMLInputElement | null;
  const syncIdxRadios = (): void => {
    const pref = getIndexSourcePref();
    idxRadios.forEach((r) => {
      if (r.value === "__custom") r.checked = pref === "custom";
      else r.checked = r.value === pref;
    });
    if (idxCustom && pref === "custom") idxCustom.value = getIndexSourceCustom();
    if (idxGitee) idxGitee.value = pref === "gitee" ? getIndexSourceGitee() || getDefaultGiteeUrl() : "";
  };
  syncIdxRadios();
  idxRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      if (r.value === "__custom") {
        setIndexSourcePref("custom", (idxCustom?.value || "").trim());
      } else if (r.value === "gitee") {
        // 选中 gitee：若未填 URL 则采用默认地址（与 GitHub 仓库同 owner/repo 名）
        const url = (idxGitee?.value || "").trim() || getDefaultGiteeUrl();
        setIndexSourcePref("gitee");
        setIndexSourceGitee(url);
        if (idxGitee) idxGitee.value = url;
      } else {
        setIndexSourcePref(r.value as IndexSource);
      }
    });
  });
  if (idxCustom) {
    idxCustom.addEventListener("change", () => {
      if (getIndexSourcePref() === "custom") setIndexSourcePref("custom", idxCustom.value.trim());
    });
  }
  if (idxGitee) {
    idxGitee.addEventListener("change", () => {
      // 与「自定义」一致：仅当前源为 gitee 时持久化其 URL；其它源下编辑不自动启用 gitee。
      // 选中 gitee 后存入的 URL（默认或自填）会一并前置进入 auto 候选链。
      if (getIndexSourcePref() === "gitee") setIndexSourceGitee(idxGitee.value.trim());
    });
  }

  // 语言变化后重新同步语言单选（设置页本身不重渲染，保持选中态）
  window.addEventListener("lang-changed", syncLangRadios);

  // ===== DSH 运行时版本（版本检查 / 锁定 / 解锁） =====
  const versionCurrent = document.getElementById("version-current") as HTMLSpanElement | null;
  const versionLatest = document.getElementById("version-latest") as HTMLSpanElement | null;
  const versionLocked = document.getElementById("version-locked") as HTMLSpanElement | null;
  const versionLockBtn = document.getElementById("version-lock") as HTMLButtonElement | null;
  const versionUnlockBtn = document.getElementById("version-unlock") as HTMLButtonElement | null;
  const versionRefreshBtn = document.getElementById("version-refresh") as HTMLButtonElement | null;
  const versionSaved = document.getElementById("version-saved") as HTMLSpanElement | null;

  // 简单版本比较："0.24.2" → [0,24,2]；a > b 返回 1 / 相等 0 / 小于 -1
  const cmpVersion = (a: string, b: string): number => {
    const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
    const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  };

  const verSet = (
    el: HTMLElement | null,
    val: string,
    cls: "muted" | "good" | "warn" | "" = ""
  ): void => {
    if (el) {
      el.textContent = val;
      el.className = "vval" + (cls ? " " + cls : "");
    }
  };
  const verMsg = (m: string): void => {
    if (versionSaved) {
      versionSaved.textContent = m;
      setTimeout(() => {
        versionSaved.textContent = "";
      }, 6000);
    }
  };

  async function loadVersionInfo(): Promise<void> {
    verSet(versionCurrent, t("settings.version.checking"), "muted");
    verSet(versionLatest, "…", "muted");
    verSet(versionLocked, t("settings.version.checking"), "muted");
    if (versionLockBtn) versionLockBtn.disabled = true;
    if (versionUnlockBtn) versionUnlockBtn.disabled = true;
    let current: string | null = null;
    let locked: string | null = null;
    try {
      const info = await getDshVersionInfo();
      current = info.current;
      locked = info.locked;
      verSet(
        versionCurrent,
        current ? "v" + current : t("settings.version.failed"),
        current ? "" : "muted"
      );
      if (info.latest) {
        const upToDate = current === info.latest || (current !== null && cmpVersion(current, info.latest) >= 0);
        verSet(
          versionLatest,
          "v" + info.latest + (upToDate ? "（" + t("settings.version.upToDate") + "）" : "（" + t("settings.version.outdated") + "）"),
          upToDate ? "good" : "warn"
        );
      } else {
        verSet(versionLatest, t("settings.version.failed"), "muted");
      }
      verSet(
        versionLocked,
        locked ? t("settings.version.lockedFmt", { v: locked }) : t("settings.version.unlocked"),
        locked ? "good" : "muted"
      );
    } catch {
      verSet(versionCurrent, t("settings.version.failed"), "muted");
      verSet(versionLatest, "—", "muted");
      verSet(versionLocked, "—", "muted");
    }
    // 按钮可用性：可锁定 = 当前版本可查且未锁该版本；可解锁 = 已锁定
    if (versionLockBtn) versionLockBtn.disabled = !current || current === locked;
    if (versionUnlockBtn) versionUnlockBtn.disabled = !locked;
  }

  if (versionLockBtn) {
    versionLockBtn.addEventListener("click", async () => {
      let cur: string | null = null;
      try {
        const info = await getDshVersionInfo();
        cur = info.current;
      } catch (e) {
        verMsg(t("settings.version.errSave") + String(e));
        return;
      }
      if (!cur) {
        verMsg(t("settings.version.failed"));
        return;
      }
      try {
        await setDshVersionLock(cur);
        verMsg(t("settings.version.lockSaved"));
      } catch (e) {
        verMsg(t("settings.version.errSave") + String(e));
      }
      void loadVersionInfo();
    });
  }
  if (versionUnlockBtn) {
    versionUnlockBtn.addEventListener("click", async () => {
      try {
        await setDshVersionLock(null);
        verMsg(t("settings.version.unlockSaved"));
      } catch (e) {
        verMsg(t("settings.version.errSave") + String(e));
      }
      void loadVersionInfo();
    });
  }
  if (versionRefreshBtn) {
    versionRefreshBtn.addEventListener("click", () => void loadVersionInfo());
  }
  // 初始化时异步加载版本信息（设置页打开即显示）
  void loadVersionInfo();
}
