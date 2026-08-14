// src/settings.ts —— 设置视图（npm 镜像源、DSH 生命周期等）
import { restartDsh } from "./dsh";
import { getSettings, setRegistry, setCloseWithApp, NPM_MIRROR } from "./config";

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
      saved.textContent = "⚠️ 请输入以 http(s):// 开头的镜像地址";
      return;
    }
    try {
      await setRegistry(url);
      saved.textContent = "✓ 已保存（对之后的新下载生效；已运行的 DSH 重启后生效）";
    } catch (e) {
      saved.textContent = "⚠️ 保存失败：" + String(e);
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
        ? "✓ 已保存：3080 将随 app 一起关闭"
        : "✓ 已保存：3080 将不随 app 关闭（退出后 DSH 继续运行）";
    } catch (e) {
      lcSaved.textContent = "⚠️ 保存失败：" + String(e);
    }
    setTimeout(() => {
      lcSaved.textContent = "";
    }, 5000);
  });

  restartBtn.addEventListener("click", async () => {
    saved.textContent = "🔄 正在重启 DSH…";
    try {
      // 重启后 dsh-ready 事件会触发标签页自动重连
      await restartDsh();
      saved.textContent = "✓ DSH 已重启";
    } catch (e) {
      saved.textContent = "⚠️ 重启失败：" + String(e);
    }
    setTimeout(() => {
      saved.textContent = "";
    }, 5000);
  });
}
