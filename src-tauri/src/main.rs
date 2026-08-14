// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

const DSH_URL: &str = "http://127.0.0.1:3080";
// npm 镜像预设（官方默认 "" / 淘宝 npmmirror）由前端 src/config.ts 提供；
// 此处只持久化用户选择的 registry，spawn 时注入 npm_config_registry 环境变量。

/// 预装插件清单：发布到 npm 后，取消注释对应元素即可自动预装。
/// 逻辑已完整实现（幂等：已安装则跳过；先于 web 启动，串行避免 npx/pnpm 并发锁）。
const AUTO_INSTALL_PLUGINS: &[&str] = &["adhdgofly-dsh-ext"];

/// 记录 DSH 子进程 pid，应用退出时连同进程组一起回收
struct DshPid(Mutex<Option<u32>>);

/// 每次启动使用独立的日志文件，避免上一次的日志尾部读取任务互相干扰
static LOG_SEQ: AtomicU32 = AtomicU32::new(0);

// ============================ 设置（npm registry 等） ============================

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(default)]
struct Settings {
    /// npm registry 地址；空串 = 官方默认
    registry: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("❌ 无法获取配置目录: {}", e))?;
    Ok(dir.join("config.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(p) = settings_path(app) else {
        return Settings::default();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("❌ 无法创建配置目录: {}", e))?;
    }
    let json =
        serde_json::to_string_pretty(s).map_err(|e| format!("❌ 序列化配置失败: {}", e))?;
    std::fs::write(&p, json).map_err(|e| format!("❌ 无法写入配置: {}", e))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
fn set_registry(app: AppHandle, url: String) -> Result<Settings, String> {
    let mut s = load_settings(&app);
    s.registry = url.trim().to_string();
    save_settings(&app, &s)?;
    Ok(s)
}

/// 按设置向子进程注入 npm registry 环境变量。
/// `npm_config_registry` 会级联到 npx（下载 dsh）与 pnpm（`dsh plugin` 内部）的所有子进程。
fn apply_registry_env(cmd: &mut Command, app: &AppHandle) {
    let s = load_settings(app);
    if !s.registry.is_empty() {
        cmd.env("npm_config_registry", &s.registry)
            .env("NPM_CONFIG_REGISTRY", &s.registry);
    }
}

// ============================ 工具函数 ============================

/// 从日志行里提取 http(s) URL
fn extract_url(line: &str) -> Option<String> {
    let start = line.find("http")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ')' | ']' | ';'))
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// 探测 127.0.0.1:3080 是否已在提供服务
async fn dsh_already_running() -> bool {
    TcpStream::connect(("127.0.0.1", 3080)).await.is_ok()
}

/// 杀掉 DSH 进程组（npx -> node 两级进程），并清空记录
fn kill_dsh(app: &AppHandle) {
    if let Some(pid) = app.state::<DshPid>().0.lock().unwrap().take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
}

/// 读取 web profile 的 package.json → (dependencies, bundles)
fn read_web_profile() -> (serde_json::Value, Vec<String>) {
    let home = std::env::var("DSH_HOME").unwrap_or_else(|_| {
        std::env::var("HOME")
            .map(|h| format!("{}/.dsh", h))
            .unwrap_or_else(|_| "~/.dsh".to_string())
    });
    let pkg_path = format!("{}/profiles/web/package.json", home);
    let empty: (serde_json::Value, Vec<String>) = (serde_json::json!({}), vec![]);
    let Ok(content) = std::fs::read_to_string(&pkg_path) else {
        return empty;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
        return empty;
    };
    let deps = pkg
        .get("dependencies")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let bundles = pkg
        .pointer("/dsh/profile/bundles")
        .cloned()
        .and_then(|b| serde_json::from_value(b).ok())
        .unwrap_or_default();
    (deps, bundles)
}

/// 插件是否已安装（依赖或 bundle 命中）
fn plugin_installed(pkg: &str) -> bool {
    let (deps, bundles) = read_web_profile();
    deps.get(pkg).is_some() || bundles.iter().any(|b| b == pkg)
}

// ============================ 核心：DSH 进程托管 ============================

/// 执行任意 dsh CLI 命令（stdout/stderr 实时推送到日志视图），内部实现
async fn run_dsh_cmd_inner(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new("npx");
    cmd.arg("--yes").arg("@deepseek-ai/dsh").args(args);
    apply_registry_env(&mut cmd, app);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("❌ 启动命令失败: {}", e))?;

    let stdout = child.stdout.take().expect("无法获取 stdout");
    let stderr = child.stderr.take().expect("无法获取 stderr");

    let app1 = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app1.emit("dsh-log", &line);
        }
    });
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app2.emit("dsh-log", &format!("⚠️ {}", line));
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("❌ 等待命令结束失败: {}", e))?;
    let code = status.code().unwrap_or(-1);
    if code != 0 {
        return Err(format!("❌ 命令执行失败 (exit {})", code));
    }
    Ok(())
}

/// spawn `npx @deepseek-ai/dsh web`：日志写文件、尾部跟踪、就绪检测、退出监听
async fn spawn_dsh(app: &AppHandle) -> Result<(), String> {
    // 子进程日志写入文件而非管道：app 被强杀/重启时管道会断，DSH 写日志会 EPIPE 崩溃
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    let log_path = std::env::temp_dir().join(format!("openharness-dsh-{}.log", seq));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("❌ 无法打开日志文件: {}", e))?;
    let log_file2 = log_file
        .try_clone()
        .map_err(|e| format!("❌ 无法复制日志句柄: {}", e))?;

    let mut cmd = Command::new("npx");
    cmd.args(["--yes", "@deepseek-ai/dsh", "web"]);
    apply_registry_env(&mut cmd, app);
    cmd.stdout(Stdio::from(log_file)).stderr(Stdio::from(log_file2));
    #[cfg(unix)]
    {
        // 独立进程组，应用退出时整组回收（npx -> node 两级进程）
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("❌ 启动失败: {}", e))?;

    // 记录 pid，供退出回收
    if let Some(pid) = child.id() {
        *app.state::<DshPid>().0.lock().unwrap() = Some(pid);
    }

    // 监听子进程退出
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        *app_clone.state::<DshPid>().0.lock().unwrap() = None;
        let _ = app_clone.emit("dsh-exit", ());
    });

    // 尾部跟踪日志文件，实时推送给前端
    let app_clone = app.clone();
    tokio::spawn(async move {
        let Ok(file) = tokio::fs::OpenOptions::new().read(true).open(&log_path).await else {
            return;
        };
        let mut reader = BufReader::new(file);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => {
                    // EOF：子进程尚未写入更多内容，稍候再读
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let _ = app_clone.emit("dsh-log", &line);
                    // 就绪检测：DSH 实际输出形如 "dsh web: http://127.0.0.1:3080"
                    let lower = line.to_ascii_lowercase();
                    let ready = lower.contains("running on")
                        || lower.contains("listening")
                        || lower.contains("dsh web:")
                        || line.contains("127.0.0.1:3080");
                    if ready {
                        let url = extract_url(&line).unwrap_or_else(|| DSH_URL.to_string());
                        let _ = app_clone.emit("dsh-ready", &url);
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

// ============================ 多 webview（网页标签 · 阶段 2） ============================
// 用户自开的网页标签使用 Tauri 原生子 webview（不受 iframe X-Frame-Options 拒嵌限制）；
// DSH 标签保持 iframe（稳定、不丢会话）。需启用 tauri 的 unstable feature。
// 参考官方 multiwebview 示例：在 async 命令内调用 add_child，避免阻塞主线程死锁。

use std::collections::HashMap;
use tauri::webview::NewWindowResponse;

/// 已创建的原生子 webview 注册表（key = 标签页 id，全 app 唯一）
struct WebviewRegistry(Mutex<HashMap<String, tauri::Webview>>);

#[derive(Clone, serde::Serialize)]
struct WebviewEvent {
    id: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
struct WebviewTitleEvent {
    id: String,
    title: String,
}

fn main_window(app: &AppHandle) -> Result<tauri::Window, String> {
    app.get_window("main")
        .ok_or_else(|| "❌ 主窗口不存在".to_string())
}

fn parse_http_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw
        .trim()
        .parse()
        .map_err(|e| format!("❌ URL 解析失败: {}", e))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("❌ 仅支持 http/https 地址".into());
    }
    Ok(url)
}

fn get_webview(
    state: &tauri::State<'_, WebviewRegistry>,
    id: &str,
) -> Result<tauri::Webview, String> {
    state
        .0
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "❌ webview 不存在".to_string())
}

/// 创建网页标签的原生子 webview（创建后隐藏，由 webview_show 定位显示；幂等）
#[tauri::command]
async fn webview_create(
    app: AppHandle,
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    {
        let reg = state.0.lock().unwrap();
        if reg.contains_key(&id) {
            return Ok(());
        }
    }
    let parsed = parse_http_url(&url)?;
    let label = id.clone();
    let label_nav = label.clone();
    let label_new = label.clone();
    let label_title = label.clone();
    let app_nav = app.clone();
    let app_new = app.clone();
    let app_title = app.clone();
    let builder = tauri::WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(parsed))
        .on_navigation(move |u| {
            // 导航开始（链接点击 / 重定向 / 前进后退）：同步网址栏与历史栈
            let _ = app_nav.emit(
                "webview-nav",
                WebviewEvent {
                    id: label_nav.clone(),
                    url: u.to_string(),
                },
            );
            true
        })
        .on_new_window(move |u, _features| {
            // window.open / target=_blank：不开新 OS 窗口，交给前端开新标签
            let _ = app_new.emit(
                "webview-new-window",
                WebviewEvent {
                    id: label_new.clone(),
                    url: u.to_string(),
                },
            );
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_wv, title| {
            let _ = app_title.emit(
                "webview-title",
                WebviewTitleEvent {
                    id: label_title.clone(),
                    title,
                },
            );
        });
    let window = main_window(&app)?;
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(w, h),
        )
        .map_err(|e| format!("❌ 创建 webview 失败: {}", e))?;
    // 默认隐藏：由前端在激活标签时调用 webview_show 显示
    let _ = webview.hide();
    state.0.lock().unwrap().insert(id, webview);
    Ok(())
}

/// 定位并显示网页标签的原生 webview（坐标为窗口内容区逻辑坐标）
#[tauri::command]
async fn webview_show(
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("❌ 定位 webview 失败: {}", e))?;
    wv.set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| format!("❌ 调整 webview 尺寸失败: {}", e))?;
    wv.show().map_err(|e| format!("❌ 显示 webview 失败: {}", e))?;
    // kick：重设一次尺寸，规避 macOS 多 webview 渲染白屏（tauri#10011）
    let _ = wv.set_size(tauri::LogicalSize::new(w, h));
    Ok(())
}

/// 仅更新位置/尺寸（窗口 resize 时由前端调用）
#[tauri::command]
async fn webview_set_bounds(
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("❌ 定位 webview 失败: {}", e))?;
    wv.set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| format!("❌ 调整 webview 尺寸失败: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn webview_hide(state: tauri::State<'_, WebviewRegistry>, id: String) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.hide().map_err(|e| format!("❌ 隐藏 webview 失败: {}", e))
}

/// 导航到指定地址（网址栏输入 / 前进后退）
#[tauri::command]
async fn webview_navigate(
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
    url: String,
) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    let wv = get_webview(&state, &id)?;
    wv.navigate(parsed)
        .map_err(|e| format!("❌ 导航失败: {}", e))
}

#[tauri::command]
async fn webview_back(state: tauri::State<'_, WebviewRegistry>, id: String) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.eval("history.back()")
        .map_err(|e| format!("❌ 后退失败: {}", e))
}

#[tauri::command]
async fn webview_forward(
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.eval("history.forward()")
        .map_err(|e| format!("❌ 前进失败: {}", e))
}

#[tauri::command]
async fn webview_reload(
    state: tauri::State<'_, WebviewRegistry>,
    id: String,
) -> Result<(), String> {
    let wv = get_webview(&state, &id)?;
    wv.eval("location.reload()")
        .map_err(|e| format!("❌ 刷新失败: {}", e))
}

/// 关闭并销毁网页标签的原生 webview（幂等）
#[tauri::command]
async fn webview_close(state: tauri::State<'_, WebviewRegistry>, id: String) -> Result<(), String> {
    if let Some(wv) = state.0.lock().unwrap().remove(&id) {
        let _ = wv.close();
    }
    Ok(())
}

// ============================ Tauri 命令 ============================

/// 启动 DSH：若 3080 已在运行则直接连接；否则先预装插件，再 spawn dsh web
#[tauri::command]
async fn start_dsh(app: AppHandle) -> Result<String, String> {
    // 3080 已在服务（上次残留实例 / 手动启动的 DSH）→ 直接连接，避免重复启动冲突
    if dsh_already_running().await {
        let _ = app.emit(
            "dsh-log",
            "✅ 检测到 DSH 已在 http://127.0.0.1:3080 运行，直接连接...",
        );
        let _ = app.emit("dsh-ready", DSH_URL);
        return Ok("✅ 已连接现有 DSH 实例".into());
    }

    // 预装插件（先于 web 启动，串行执行，避免 npx/pnpm 并发锁）
    for pkg in AUTO_INSTALL_PLUGINS {
        if plugin_installed(pkg) {
            let _ = app.emit("dsh-log", format!("✅ 预装插件 {} 已存在，跳过", pkg));
            continue;
        }
        let _ = app.emit("dsh-log", format!("📦 正在预装插件 {} ...", pkg));
        run_dsh_cmd_inner(&app, &["plugin", "--profile", "web", "add", pkg]).await?;
        let _ = app.emit("dsh-log", format!("✅ 预装插件 {} 完成", pkg));
    }

    spawn_dsh(&app).await?;
    Ok("🚀 DSH 正在启动，请稍候...".into())
}

/// 重启 DSH：杀掉当前进程组 → 等待端口释放 → 重新 spawn（插件装/卸/更后生效）
#[tauri::command]
async fn restart_dsh(app: AppHandle) -> Result<String, String> {
    kill_dsh(&app);
    // 等待旧实例释放 3080，避免误判「已在运行」而跳过启动
    for _ in 0..25 {
        if !dsh_already_running().await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    spawn_dsh(&app).await?;
    Ok("🔄 DSH 已重启".into())
}

/// 执行任意 dsh CLI 命令（如插件安装/更新/卸载），输出实时推送到日志视图
#[tauri::command]
async fn run_dsh_cmd(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_dsh_cmd_inner(&app, &refs).await?;
    Ok("✅ 命令执行完毕".into())
}

/// 读取 web profile 的已安装插件（dependencies + bundles）
#[tauri::command]
fn list_installed_plugins() -> Result<serde_json::Value, String> {
    let home = std::env::var("DSH_HOME").unwrap_or_else(|_| {
        std::env::var("HOME")
            .map(|h| format!("{}/.dsh", h))
            .unwrap_or_else(|_| "~/.dsh".to_string())
    });
    let pkg_path = format!("{}/profiles/web/package.json", home);
    let empty = serde_json::json!({
        "deps": {},
        "bundles": [],
        "profile": pkg_path,
        "error": null
    });
    let Ok(content) = std::fs::read_to_string(&pkg_path) else {
        return Ok(empty);
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(serde_json::json!({
            "deps": {},
            "bundles": [],
            "profile": pkg_path,
            "error": "profile package.json 解析失败"
        }));
    };
    let deps = pkg
        .get("dependencies")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let bundles = pkg
        .pointer("/dsh/profile/bundles")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    Ok(serde_json::json!({
        "deps": deps,
        "bundles": bundles,
        "profile": pkg_path,
        "error": null
    }))
}

fn main() {
    tauri::Builder::default()
        .manage(DshPid(Mutex::new(None)))
        .manage(WebviewRegistry(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            start_dsh,
            restart_dsh,
            run_dsh_cmd,
            list_installed_plugins,
            get_settings,
            set_registry,
            webview_create,
            webview_show,
            webview_set_bounds,
            webview_hide,
            webview_navigate,
            webview_back,
            webview_forward,
            webview_reload,
            webview_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // 应用退出时回收 DSH 进程组，避免残留占用 3080
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_dsh(app_handle);
            }
            _ => {}
        });
}
