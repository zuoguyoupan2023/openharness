// src/settings.ts —— 设置视图（npm 镜像源、Node 环境、DSH 生命周期、外观、语言、DSH 更新、默认标签页）
import { restartDsh, getDshVersionInfo, setDshVersionLock, setDshUpdateMode, checkDshUpdateNow, predownloadDshVersion, cmpSemver, DSH_URL } from "./dsh";
import { confirm } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getSettings, setRegistry, setCloseWithApp, setDefaultTabs, setRestoreSession, setDownloadDir, getDownloadDir, NPM_MIRROR } from "./config";
import { t, setLang, getLang } from "./i18n";
import { setThemePref, getThemePref, ThemePref } from "./theme";
import { getLinkMode, setLinkMode, LinkOpenMode } from "./open-link";
import { getIndexSourcePref, getIndexSourceCustom, setIndexSourcePref, getIndexSourceGitee, setIndexSourceGitee, getDefaultGiteeUrl, type IndexSource } from "./plugin-sources";
import { pickDownloadDir } from "./downloads";

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

  // ===== DSH 更新（更新模式 / 版本检查 / 手动更新按钮） =====
  const versionCurrent = document.getElementById("version-current") as HTMLSpanElement | null;
  const versionLatest = document.getElementById("version-latest") as HTMLSpanElement | null;
  const versionLocked = document.getElementById("version-locked") as HTMLSpanElement | null;
  const versionLockedLine = document.getElementById("version-locked-line") as HTMLElement | null;
  const versionUpdateBtn = document.getElementById("version-update") as HTMLButtonElement | null;
  const versionRefreshBtn = document.getElementById("version-refresh") as HTMLButtonElement | null;
  const versionSaved = document.getElementById("version-saved") as HTMLSpanElement | null;
  const modeRadios = document.getElementsByName("dsh-update-mode") as NodeListOf<HTMLInputElement>;

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

  // 当前模式与版本状态（loadVersionInfo 填充）
  let curMode: "auto" | "manual" = "auto";
  let curVersion: string | null = null;

  const syncModeUI = (): void => {
    modeRadios.forEach((r) => {
      r.checked = r.value === curMode;
    });
    const manual = curMode === "manual";
    if (versionLockedLine) versionLockedLine.hidden = !manual;
    if (versionUpdateBtn) versionUpdateBtn.hidden = !manual;
  };

  async function loadVersionInfo(): Promise<void> {
    verSet(versionCurrent, t("settings.version.checking"), "muted");
    verSet(versionLatest, "…", "muted");
    verSet(versionLocked, t("settings.version.checking"), "muted");
    let current: string | null = null;
    let locked: string | null = null;
    try {
      const info = await getDshVersionInfo();
      current = info.current;
      locked = info.locked;
      curVersion = current;
      curMode = info.updateMode === "manual" ? "manual" : "auto";
      verSet(
        versionCurrent,
        current ? "v" + current : t("settings.version.failed"),
        current ? "" : "muted"
      );
      if (info.latest) {
        const upToDate =
          current !== null && info.latest !== null && cmpSemver(current, info.latest) >= 0;
        verSet(
          versionLatest,
          "v" +
            info.latest +
            (upToDate ? "（" + t("settings.version.upToDate") + "）" : "（" + t("settings.version.outdated") + "）"),
          upToDate ? "good" : "warn"
        );
      } else {
        verSet(versionLatest, t("settings.version.failed"), "muted");
      }
      verSet(
        versionLocked,
        locked ? t("settings.version.lockedFmt", { v: locked }) : "—",
        locked ? "good" : "muted"
      );
    } catch {
      verSet(versionCurrent, t("settings.version.failed"), "muted");
      verSet(versionLatest, "—", "muted");
      verSet(versionLocked, "—", "muted");
    }
    syncModeUI();
    if (versionUpdateBtn) versionUpdateBtn.disabled = !current;
  }

  // 更新模式切换：manual 需锁定当前版本；auto 由后端自动解锁
  modeRadios.forEach((r) => {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      if (r.value === "manual") {
        try {
          await setDshUpdateMode("manual");
          let lockedVer = curVersion;
          if (!curVersion) {
            const info = await getDshVersionInfo();
            lockedVer = info.current;
            curVersion = info.current;
          }
          if (lockedVer) {
            await setDshVersionLock(lockedVer);
            verMsg(t("settings.version.modeManualSaved", { v: lockedVer }));
          } else {
            verMsg(t("settings.version.failed"));
          }
          curMode = "manual";
        } catch (e) {
          verMsg(t("settings.version.errSave") + String(e));
        }
      } else {
        try {
          await setDshUpdateMode("auto");
          curMode = "auto";
          verMsg(t("settings.version.modeAutoSaved"));
        } catch (e) {
          verMsg(t("settings.version.errSave") + String(e));
        }
      }
      syncModeUI();
      void loadVersionInfo();
    });
  });

  // 手动模式：更新到最新版（锁定最新 → 重启 DSH 生效）
  if (versionUpdateBtn) {
    versionUpdateBtn.addEventListener("click", async () => {
      let latest: string | null = null;
      try {
        const info = await getDshVersionInfo();
        latest = info.latest;
      } catch (e) {
        verMsg(t("settings.version.errSave") + String(e));
        return;
      }
      if (!latest) {
        verMsg(t("settings.version.failed"));
        return;
      }
      if (curVersion && cmpSemver(curVersion, latest) >= 0) {
        verMsg(t("settings.version.upToDate"));
        return;
      }
      try {
        // ① 锁定新版本（即使不立即重启，下次启动也会用新版）
        await setDshVersionLock(latest);
        // ② 预下载 + 完整性校验：失败时正在运行的旧版本不受影响
        verMsg(t("settings.version.downloading", { latest }));
        const downloaded = await predownloadDshVersion(latest);
        verMsg("");
        // ③ 下载完成 → 弹窗：确定 = 立即重启整个 app；稍后 = 版本已锁定，重启后生效
        const ok = await confirm(
          t("settings.version.readyBody", { latest: downloaded || latest }),
          {
            title: t("settings.version.readyTitle"),
            kind: "info",
            okLabel: t("settings.version.readyOk"),
            cancelLabel: t("settings.version.readyLater"),
          }
        );
        if (ok) {
          // ④ 确定 → 重启整个 app（DSH 随 app 重启并加载新版本）
          await relaunch();
        } else {
          // ⑤ 稍后 → 不重启（避免打断当前任务）；版本已锁定，下次启动/手动重启即生效
          verMsg(t("settings.version.readyLaterSaved", { latest: downloaded || latest }));
        }
      } catch (e) {
        verMsg(t("settings.version.errDownload") + String(e));
      }
      void loadVersionInfo();
    });
  }
  if (versionRefreshBtn) {
    versionRefreshBtn.addEventListener("click", () => {
      void loadVersionInfo();
      // 同时触发一次后台检查：结果事件 dsh-update-check 会让全局 banner 显示新版本提示
      void checkDshUpdateNow();
    });
  }
  // 初始化：恢复上次选择的更新模式 + 异步加载版本信息
  void getSettings().then((s) => {
    curMode = s.dshUpdateMode === "manual" ? "manual" : "auto";
    syncModeUI();
    void loadVersionInfo();
  });

  // ===== 默认打开标签页（3080 固定 + 用户默认标签 + 恢复会话开关） =====
  const defTabsList = document.getElementById("default-tabs-list") as HTMLElement | null;
  const defTabsInput = document.getElementById("default-tabs-input") as HTMLInputElement | null;
  const defTabsAdd = document.getElementById("default-tabs-add") as HTMLButtonElement | null;
  const defTabsSaved = document.getElementById("default-tabs-saved") as HTMLSpanElement | null;
  const restoreSessionEl = document.getElementById("settings-restore-session") as HTMLInputElement | null;

  let defaultTabs: string[] = [];

  const defMsg = (m: string): void => {
    if (defTabsSaved) {
      defTabsSaved.textContent = m;
      setTimeout(() => {
        defTabsSaved.textContent = "";
      }, 6000);
    }
  };

  const renderDefaultTabs = (): void => {
    if (!defTabsList) return;
    defTabsList.innerHTML = "";
    // 固定行：3080（DSH 主标签，不可删除）
    const fixed = document.createElement("div");
    fixed.className = "default-tab-item";
    const fixedUrl = document.createElement("span");
    fixedUrl.className = "dt-url";
    fixedUrl.textContent = DSH_URL;
    const fixedTag = document.createElement("span");
    fixedTag.className = "dt-fixed";
    fixedTag.textContent = t("settings.tabs.fixed");
    fixed.appendChild(fixedUrl);
    fixed.appendChild(fixedTag);
    defTabsList.appendChild(fixed);
    // 用户默认标签行
    for (const url of defaultTabs) {
      const item = document.createElement("div");
      item.className = "default-tab-item";
      const span = document.createElement("span");
      span.className = "dt-url";
      span.textContent = url;
      span.title = url;
      const del = document.createElement("button");
      del.className = "dt-del";
      del.textContent = "×";
      del.title = t("tab.close");
      del.addEventListener("click", () => void removeDefaultTab(url));
      item.appendChild(span);
      item.appendChild(del);
      defTabsList.appendChild(item);
    }
  };

  const saveDefaultTabs = async (next: string[]): Promise<void> => {
    try {
      const s = await setDefaultTabs(next);
      defaultTabs = s.defaultTabs || [];
      renderDefaultTabs();
    } catch (e) {
      defMsg(t("settings.tabs.errSave") + String(e));
    }
  };

  const removeDefaultTab = async (url: string): Promise<void> => {
    await saveDefaultTabs(defaultTabs.filter((u) => u !== url));
    defMsg(t("settings.tabs.removed"));
  };

  if (defTabsAdd && defTabsInput) {
    const tryAdd = async (): Promise<void> => {
      const raw = defTabsInput!.value.trim();
      if (!raw) return;
      const before = defaultTabs.length;
      await saveDefaultTabs([...defaultTabs, raw]);
      // 保存成功与否看后端规范化后的长度：+1 = 合法新标签；不变 = 无效/重复/3080
      if (defaultTabs.length <= before) {
        defMsg(t("settings.tabs.invalid"));
        return;
      }
      defTabsInput!.value = "";
      defMsg(t("settings.tabs.added"));
    };
    defTabsAdd.addEventListener("click", () => void tryAdd());
    defTabsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void tryAdd();
    });
  }

  if (restoreSessionEl) {
    restoreSessionEl.addEventListener("change", async () => {
      try {
        await setRestoreSession(restoreSessionEl.checked);
        defMsg(t("settings.tabs.saved"));
      } catch (e) {
        defMsg(t("settings.tabs.errSave") + String(e));
      }
    });
  }

  // 初始化：加载默认标签列表与恢复会话开关状态
  void getSettings().then((s) => {
    defaultTabs = Array.isArray(s.defaultTabs) ? s.defaultTabs : [];
    if (restoreSessionEl) restoreSessionEl.checked = s.restoreSession !== false;
    renderDefaultTabs();
  });

  // ===== 下载位置（设置页）：显示当前生效目录，可修改 / 恢复默认 =====
  const dlDirEl = document.getElementById("settings-download-dir") as HTMLElement | null;
  const dlChangeBtn = document.getElementById("settings-download-change") as HTMLButtonElement | null;
  const dlResetBtn = document.getElementById("settings-download-reset") as HTMLButtonElement | null;
  const dlSaved = document.getElementById("settings-download-saved") as HTMLSpanElement | null;

  const dlMsg = (m: string): void => {
    if (dlSaved) {
      dlSaved.textContent = m;
      window.setTimeout(() => {
        dlSaved.textContent = "";
      }, 5000);
    }
  };

  const syncDownloadDir = async (): Promise<void> => {
    if (!dlDirEl) return;
    try {
      const info = await getDownloadDir();
      dlDirEl.textContent = info.effective || "—";
      dlDirEl.title = info.effective;
    } catch {
      dlDirEl.textContent = "—";
    }
  };

  dlChangeBtn?.addEventListener("click", async () => {
    const dir = await pickDownloadDir();
    if (!dir) return;
    try {
      await setDownloadDir(dir);
      dlMsg(t("downloads.pathChanged"));
      void syncDownloadDir();
    } catch (e) {
      dlMsg(t("downloads.errChange") + String(e));
    }
  });

  dlResetBtn?.addEventListener("click", async () => {
    try {
      await setDownloadDir("");
      dlMsg(t("downloads.pathReset"));
      void syncDownloadDir();
    } catch (e) {
      dlMsg(t("downloads.errChange") + String(e));
    }
  });

  void syncDownloadDir();
}
