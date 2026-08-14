// src/settings.ts —— 设置视图（npm 镜像源、Node 环境、DSH 生命周期、外观、语言）
import { restartDsh } from "./dsh";
import { getSettings, setRegistry, setCloseWithApp, NPM_MIRROR } from "./config";
import { t, setLang, getLang } from "./i18n";
import { setThemePref, getThemePref, ThemePref } from "./theme";
import { getIndexSourcePref, getIndexSourceCustom, setIndexSourcePref, type IndexSource } from "./plugin-sources";

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

  // ===== 插件索引源（006 双数据源后台刷新取源） =====
  const idxRadios = document.getElementsByName("plugin-index-source") as NodeListOf<HTMLInputElement>;
  const idxCustom = document.getElementById("plugin-index-source-custom") as HTMLInputElement | null;
  const syncIdxRadios = (): void => {
    const pref = getIndexSourcePref();
    idxRadios.forEach((r) => {
      if (r.value === "__custom") r.checked = pref === "custom";
      else r.checked = r.value === pref;
    });
    if (idxCustom && pref === "custom") idxCustom.value = getIndexSourceCustom();
  };
  syncIdxRadios();
  idxRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      if (r.value === "__custom") {
        setIndexSourcePref("custom", (idxCustom?.value || "").trim());
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

  // 语言变化后重新同步语言单选（设置页本身不重渲染，保持选中态）
  window.addEventListener("lang-changed", syncLangRadios);
}
