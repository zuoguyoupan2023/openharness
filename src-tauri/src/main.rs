// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

const DSH_URL: &str = "http://127.0.0.1:3080";
// npm 镜像预设（官方默认 "" / 淘宝 npmmirror）由前端 src/config.ts 提供；
// 此处只持久化用户选择的 registry，spawn 时注入 npm_config_registry 环境变量。

/// 预装插件清单：发布到 npm 后，取消注释对应元素即可自动预装。
/// 逻辑已完整实现（幂等：已安装则跳过；先于 web 启动，串行避免 npx/pnpm 并发锁）。
/// 三件套：adhdgofly-dsh-ext（POS 高亮）+ openharness-reader（文件阅读/编辑/MD 预览）。
const AUTO_INSTALL_PLUGINS: &[&str] = &["adhdgofly-dsh-ext", "openharness-reader"];

/// 记录 DSH 子进程 pid，应用退出时连同进程组一起回收
struct DshPid(Mutex<Option<u32>>);

/// DSH 子进程 stdin 句柄，供前端「嵌入式终端面板」写入（终端输入 → 子进程 stdin）
/// 用 tokio::sync::Mutex：write_stdin 需要在持有锁的同时跨 await 写 stdin
/// （std MutexGuard 非 Send，无法满足 Tauri async 命令的 Send 约束）。
struct DshStdin(tokio::sync::Mutex<Option<tokio::process::ChildStdin>>);

/// 一个独立的 shell 终端（用户通过「+」新增，跑本机默认 shell）。
/// stdin 供 term_write 写入；child 所有权交给专门的 wait 任务，线程退出后清理。
struct ShellEntry {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pid: u32,
}
/// 全部 shell 终端注册表（key = 终端 id，全 app 唯一）
struct Shells(tokio::sync::Mutex<std::collections::HashMap<String, ShellEntry>>);

/// 每次启动使用独立的日志文件，避免上一次的日志尾部读取任务互相干扰
static LOG_SEQ: AtomicU32 = AtomicU32::new(0);

// ============================ 设置（npm registry 等） ============================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// npm registry 地址；空串 = 官方默认
    #[serde(default)]
    registry: String,
    /// 关闭 app 时是否同时关闭 3080 上的 DSH（默认 true；自己在终端管理 DSH 的用户可关闭）
    #[serde(default = "default_close_with_app")]
    close_with_app: bool,
}

/// 缺失字段的默认值；close_with_app 缺省为 true（随 app 关闭）
fn default_close_with_app() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            registry: String::new(),
            close_with_app: true,
        }
    }
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

/// 设置「关闭 app 时是否同时关闭 3080 上的 DSH」（默认开启）
#[tauri::command]
fn set_close_with_app(app: AppHandle, enabled: bool) -> Result<Settings, String> {
    let mut s = load_settings(&app);
    s.close_with_app = enabled;
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

// ============================ Node.js 环境（检测 / 安装 / 内置优先） ============================
// 背景：DSH 依赖系统 Node/npx（>=22.15，node:zlib zstd）。macOS 上从 Finder 启动的 GUI 应用 PATH 只有
// /usr/bin:/bin:/usr/sbin:/sbin，找不到 brew/nvm 装的 node —— 因此检测与 spawn 都要额外搜索
// 常见安装目录；若系统 Node 缺失或过旧，app 自动下载官方/镜像预编译包到应用数据目录
// （内置 Node），此后所有子进程（npx dsh、插件安装）优先使用内置 Node。

/// 内置 Node 的 LTS 版本（官方 nodejs.org 与淘宝 npmmirror 已同步）
const NODE_VERSION: &str = "v22.23.2";
/// 清华 TUNA 镜像同步滞后（未同步 v22.23.2），使用其已同步的最新 v22
const NODE_VERSION_TUNA: &str = "v22.16.0";
/// DSH 要求的最低 Node 版本：>= 22.15.0 —— node:zlib 的 zstd API 从 22.15.0 起提供，
/// @deepseek-ai/dsh-session-persistence-jsonl 依赖它（v22.14.0 及更早启动 DSH 直接报错）
const NODE_MIN_VERSION: (u32, u32, u32) = (22, 15, 0);

/// Node 安装任务进行中标记（防止并发下载）
struct NodeBusy(Mutex<bool>);

/// 解析 "v22.15.0" → (22, 15, 0)；解析失败返回 (0,0,0)
fn parse_node_version(v: &str) -> (u32, u32, u32) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let maj = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let min = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let pat = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (maj, min, pat)
}

/// macOS GUI 应用常见 Node 安装目录（Finder 启动时进程 PATH 不含这些目录）
fn node_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        // nvm：~/.nvm/versions/node/vXX/bin —— 必须按版本从新到旧排序！
        // 否则可能选中旧版本（如 v22.14.0 缺少 node:zlib 的 zstd API，DSH 无法启动）
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort_by(|a, b| {
                let va = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let vb = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
                parse_node_version(vb).cmp(&parse_node_version(va))
            });
            for p in versions {
                dirs.push(p.join("bin"));
            }
        }
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".local/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin")); // Apple Silicon brew
    dirs.push(PathBuf::from("/usr/local/bin"));    // Intel brew / 官方 pkg
    dirs.push(PathBuf::from("/usr/bin"));
    dirs
}

/// 解析要使用的 npx 可执行文件（内置 Node 优先 → 常见安装目录 → 交给系统 PATH 兜底）
fn resolve_npx(app: &AppHandle) -> String {
    if let Some(dir) = bundled_node_dir(app) {
        let p = dir.join("bin").join("npx");
        if p.exists() {
            return p.display().to_string();
        }
    }
    for d in node_search_dirs() {
        let p = d.join("npx");
        if p.exists() {
            return p.display().to_string();
        }
    }
    "npx".to_string()
}

/// 合并后的 PATH：内置 Node bin（若有）+ 常见 Node 目录 + 原 PATH
fn node_path_env(app: &AppHandle) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = bundled_node_dir(app) {
        parts.push(dir.join("bin").display().to_string());
    }
    for d in node_search_dirs() {
        if d.join("node").exists() {
            parts.push(d.display().to_string());
        }
    }
    if let Ok(p) = std::env::var("PATH") {
        parts.push(p);
    }
    parts.join(":")
}

/// 向子进程注入 PATH（内置 Node 优先），使 `#!/usr/bin/env node` 与 pnpm 都命中正确运行时
fn apply_node_env(cmd: &mut Command, app: &AppHandle) {
    cmd.env("PATH", node_path_env(app));
}

/// 内置 Node 安装目录（应用数据目录/node），存在且含 node 可执行文件则 Some
fn bundled_node_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("node");
    dir.join("bin").join("node").exists().then_some(dir)
}

/// 运行 `prog --version`，成功返回版本字符串（如 "v22.23.2"）
async fn run_version(prog: &str) -> Option<String> {
    let out = tokio::process::Command::new(prog)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeCheck {
    ok: bool,
    /// 系统 node 版本（可能为 null）
    system: Option<String>,
    /// 系统 npx 是否可用
    system_npx: bool,
    /// 内置 node 版本（可能为 null）
    bundled: Option<String>,
    /// 内置 node 路径（可能为 null）
    bundled_path: Option<String>,
    message: String,
}

/// 检测 Node 环境：系统 node（常见安装目录 + PATH）与内置 node 二选一可用即 ok
#[tauri::command]
async fn check_node(app: AppHandle) -> NodeCheck {
    // 系统 node：先查常见安装目录，查不到再走进程 PATH
    let sys_dir = node_search_dirs().into_iter().find(|d| d.join("node").exists());
    let (system, system_npx) = match &sys_dir {
        Some(d) => (
            run_version(&d.join("node").display().to_string()).await,
            d.join("npx").exists(),
        ),
        None => (run_version("node").await, run_version("npx").await.is_some()),
    };
    let sys_ok = system
        .as_ref()
        .map(|v| parse_node_version(v) >= NODE_MIN_VERSION)
        .unwrap_or(false)
        && system_npx;

    // 内置 node
    let (bundled, bundled_path) = match bundled_node_dir(&app) {
        Some(dir) => {
            let prog = dir.join("bin").join("node").display().to_string();
            match run_version(&prog).await {
                Some(v) => (Some(v), Some(dir.display().to_string())),
                None => (None, None),
            }
        }
        None => (None, None),
    };
    let bundled_ok = bundled
        .as_ref()
        .map(|v| parse_node_version(v) >= NODE_MIN_VERSION)
        .unwrap_or(false);

    let ok = sys_ok || bundled_ok;
    let min_str = format!(
        "≥ {}.{}.0（DSH 依赖 node:zlib zstd）",
        NODE_MIN_VERSION.0, NODE_MIN_VERSION.1
    );
    let message = if ok {
        if bundled_ok {
            format!(
                "✅ 使用内置 Node.js {}（{}）",
                bundled.as_deref().unwrap_or("?"),
                bundled_path.as_deref().unwrap_or("")
            )
        } else {
            format!(
                "✅ 检测到系统 Node.js {}（npx {}{}）",
                system.as_deref().unwrap_or("?"),
                if system_npx { "可用" } else { "不可用" },
                sys_dir
                    .as_ref()
                    .map(|d| format!(" @ {}", d.display()))
                    .unwrap_or_default()
            )
        }
    } else {
        let sys_part = match &system {
            Some(v) => format!("系统 Node.js {}（需要 {} 且 npx 可用）", v, min_str),
            None => format!("未检测到系统 Node.js（需要 {} 且 npx 可用）", min_str),
        };
        format!(
            "⚠️ {}；内置 Node 未安装。点击「下载并安装 Node.js」即可从官方/镜像源自动获取并内置。",
            sys_part
        )
    };
    NodeCheck {
        ok,
        system,
        system_npx,
        bundled,
        bundled_path,
        message,
    }
}

// ---- Node 下载与安装 ----

#[derive(Clone, Copy)]
enum NodeSource {
    Official,
    Npmmirror,
    Tuna,
}

impl NodeSource {
    fn name(&self) -> &'static str {
        match self {
            NodeSource::Official => "官方 nodejs.org",
            NodeSource::Npmmirror => "淘宝 npmmirror",
            NodeSource::Tuna => "清华 TUNA",
        }
    }
    fn key(&self) -> &'static str {
        match self {
            NodeSource::Official => "official",
            NodeSource::Npmmirror => "npmmirror",
            NodeSource::Tuna => "tuna",
        }
    }
    /// 该源上的 Node 版本（TUNA 同步滞后，用其已同步的版本）
    fn version(&self) -> &'static str {
        match self {
            NodeSource::Official | NodeSource::Npmmirror => NODE_VERSION,
            NodeSource::Tuna => NODE_VERSION_TUNA,
        }
    }
    fn url(&self, os: &str, arch: &str) -> String {
        let v = self.version();
        let file = format!("node-{}-{}-{}.tar.gz", v, os, arch);
        match self {
            NodeSource::Official => {
                format!("https://nodejs.org/dist/{}/{}", v, file)
            }
            NodeSource::Npmmirror => {
                format!("https://npmmirror.com/mirrors/node/{}/{}", v, file)
            }
            NodeSource::Tuna => {
                format!(
                    "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/{}/{}",
                    v, file
                )
            }
        }
    }
}

/// Node 目标平台（当前仅 macOS；其它平台明确报错而不是静默失败）
fn node_os_arch() -> Result<(String, String), String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => {
            return Err(format!(
                "❌ 暂不支持自动安装 Node：当前系统为 {}（本版本仅支持 macOS）",
                other
            ))
        }
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => {
            return Err(format!(
                "❌ 暂不支持自动安装 Node：不支持的 CPU 架构 {}",
                other
            ))
        }
    };
    Ok((os.to_string(), arch.to_string()))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeProgress {
    source: String,
    /// checking / download / extract / verify
    phase: String,
    downloaded: u64,
    total: u64,
    message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeReady {
    version: String,
    path: String,
}

/// 下载单个源的 tarball 到数据目录，边下边推进度事件
async fn download_tarball(
    app: &AppHandle,
    src: NodeSource,
    url: &str,
    data_dir: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("客户端初始化失败: {}", e))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let tmp = data_dir.join("node-download.tar.gz");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("无法创建临时文件: {}", e))?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "node-progress",
            NodeProgress {
                source: src.key().into(),
                phase: "download".into(),
                downloaded,
                total,
                message: format!(
                    "⬇️ {} 下载中 {:.1} MB / {:.1} MB",
                    src.name(),
                    downloaded as f64 / 1048576.0,
                    total as f64 / 1048576.0
                ),
            },
        );
    }
    file.flush().await.map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 解压 tarball 到数据目录/node 并校验（原子替换）
async fn install_tarball(
    app: &AppHandle,
    src: NodeSource,
    data_dir: &Path,
) -> Result<String, String> {
    let tmp_tar = data_dir.join("node-download.tar.gz");
    let tmp_dir = data_dir.join(format!("node-tmp-{}", std::process::id()));
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).ok();
    }
    let _ = app.emit(
        "node-progress",
        NodeProgress {
            source: src.key().into(),
            phase: "extract".into(),
            downloaded: 0,
            total: 0,
            message: format!("📦 {} 下载完成，正在解压安装...", src.name()),
        },
    );

    let file = std::fs::File::open(&tmp_tar).map_err(|e| format!("打开压缩包失败: {}", e))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&tmp_dir)
        .map_err(|e| format!("解压失败: {}", e))?;

    // 定位解压出的 node-vXX-... 目录
    let inner = std::fs::read_dir(&tmp_dir)
        .map_err(|e| format!("读取解压目录失败: {}", e))?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("node-v"))
                    .unwrap_or(false)
        })
        .ok_or_else(|| "解压内容中未找到 node 目录".to_string())?;

    // 原子替换：先移除旧内置目录，再改名
    let dest = data_dir.join("node");
    if dest.exists() {
        std::fs::remove_dir_all(&dest).ok();
    }
    std::fs::rename(&inner, &dest).map_err(|e| format!("移动 node 目录失败: {}", e))?;
    std::fs::remove_dir_all(&tmp_dir).ok();

    // 校验：运行内置 node --version
    let _ = app.emit(
        "node-progress",
        NodeProgress {
            source: src.key().into(),
            phase: "verify".into(),
            downloaded: 0,
            total: 0,
            message: format!("✅ {} 安装完成，正在校验...", src.name()),
        },
    );
    let prog = dest.join("bin").join("node").display().to_string();
    let version = run_version(&prog)
        .await
        .ok_or_else(|| "安装后校验失败：无法运行内置 node".to_string())?;
    let _ = std::fs::remove_file(&tmp_tar);
    Ok(version)
}

/// 按顺序尝试下载源，成功后返回 ()（node-ready 事件由内部发出）
async fn download_node_inner(app: &AppHandle, requested: String) -> Result<(), String> {
    let (os, arch) = node_os_arch()?;
    let order: Vec<NodeSource> = match requested.as_str() {
        "official" => vec![NodeSource::Official],
        "npmmirror" => vec![NodeSource::Npmmirror],
        "tuna" => vec![NodeSource::Tuna],
        // auto（默认）：官方 → 淘宝 → 清华，逐个回退
        _ => vec![
            NodeSource::Official,
            NodeSource::Npmmirror,
            NodeSource::Tuna,
        ],
    };

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("❌ 无法获取应用数据目录: {}", e))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("❌ 无法创建数据目录: {}", e))?;

    let mut last_err: Option<String> = None;
    for src in order {
        let url = src.url(&os, &arch);
        let _ = app.emit(
            "node-progress",
            NodeProgress {
                source: src.key().into(),
                phase: "checking".into(),
                downloaded: 0,
                total: 0,
                message: format!("🔗 正在连接{}（{}）...", src.name(), url),
            },
        );
        match download_tarball(app, src, &url, &data_dir).await {
            Ok(()) => match install_tarball(app, src, &data_dir).await {
                Ok(version) => {
                    let path = data_dir.join("node").display().to_string();
                    let _ = app.emit(
                        "node-ready",
                        NodeReady {
                            version: version.clone(),
                            path: path.clone(),
                        },
                    );
                    let _ = app.emit(
                        "node-progress",
                        NodeProgress {
                            source: src.key().into(),
                            phase: "done".into(),
                            downloaded: 0,
                            total: 0,
                            message: format!(
                                "✅ Node.js 安装成功（{}），路径：{}",
                                version, path
                            ),
                        },
                    );
                    return Ok(());
                }
                Err(e) => last_err = Some(format!("{} 安装失败: {}", src.name(), e)),
            },
            Err(e) => {
                last_err = Some(format!("{} 下载失败: {}", src.name(), e));
                let _ = app.emit(
                    "node-progress",
                    NodeProgress {
                        source: src.key().into(),
                        phase: "checking".into(),
                        downloaded: 0,
                        total: 0,
                        message: format!("⚠️ {} 不可用（{}），尝试下一个源...", src.name(), e),
                    },
                );
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "❌ Node 安装失败".to_string()))
}

/// 下载并安装内置 Node（后台任务，进度/结果走事件：node-progress / node-ready / node-fail）
#[tauri::command]
async fn download_node(app: AppHandle, source: String) -> Result<String, String> {
    {
        let state = app.state::<NodeBusy>();
        let mut busy = state.0.lock().unwrap();
        if *busy {
            return Err("⏳ 已有 Node 安装任务进行中，请稍候".into());
        }
        *busy = true;
    }
    let app_task = app.clone();
    tokio::spawn(async move {
        let res = download_node_inner(&app_task, source).await;
        *app_task.state::<NodeBusy>().0.lock().unwrap() = false;
        if let Err(e) = res {
            let _ = app_task.emit("node-fail", &e);
        }
    });
    Ok("✅ Node 安装任务已启动".into())
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

/// 同步查找监听 127.0.0.1:<port> 的进程 PID（lsof），用于退出/重启兜底回收
fn port_listener_pid_sync(port: u16) -> Option<u32> {
    let out = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.trim().parse::<u32>().ok())
}

/// 强制回收 3080 上的 DSH（重启用，不遵循 close_with_app 设置）：
/// 1) 杀记录的 pid 的进程组（自启场景，npx→node 两级）+ 其本身；
/// 2) 兜底直接杀当前监听 3080 的进程（覆盖未记录的孤儿/被接管的外部实例）。
fn kill_3080(app: &AppHandle) {
    if let Some(pid) = app.state::<DshPid>().0.lock().unwrap().take() {
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
    if let Some(pid) = port_listener_pid_sync(3080) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
}

/// 应用退出时回收：遵循设置（close_with_app 默认 true = 3080 随 app 关闭）
fn kill_dsh_on_exit(app: &AppHandle) {
    let s = load_settings(app);
    if !s.close_with_app {
        return;
    }
    kill_3080(app);
}

/// web profile 目录（~/.dsh/profiles/web，遵循 DSH_HOME）
fn web_profile_dir() -> PathBuf {
    let home = std::env::var("DSH_HOME").unwrap_or_else(|_| {
        std::env::var("HOME")
            .map(|h| format!("{}/.dsh", h))
            .unwrap_or_else(|_| "~/.dsh".to_string())
    });
    PathBuf::from(home).join("profiles").join("web")
}

/// 读取 web profile 的 package.json → (dependencies, bundles)
fn read_web_profile() -> (serde_json::Value, Vec<String>) {
    let pkg_path = web_profile_dir().join("package.json");
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

/// pnpm ≥10 的 workspace-root 兼容：DSH 的 profile 由 `initProfile` 写入
/// `pnpm-workspace.yaml`（`packages: - .`），使 profile 目录成为 pnpm workspace root；
/// 而 `dsh plugin add` 内部调 `pnpm add` 时不传 `-w`，pnpm ≥10 会直接报
/// `ERR_PNPM_ADDING_TO_ROOT` 拒绝写入根依赖——本机与任何新用户都会装不上插件。
/// 解法：向 profile 写入 `.npmrc` 的 `ignore-workspace-root-check=true`
/// （pnpm 在 profile 目录内运行时会读取；同时修复用户在终端手动 `dsh plugin` 的场景）。
/// 写入失败时返回 false，由调用方回退到环境变量注入。
fn ensure_pnpm_root_add_compat() -> bool {
    let dir = web_profile_dir();
    let _ = std::fs::create_dir_all(&dir);
    let rc = dir.join(".npmrc");
    let key = "ignore-workspace-root-check=true";
    match std::fs::read_to_string(&rc) {
        Ok(s) if s.contains(key) => return true,
        Ok(s) => {
            let mut next = s.trim_end().to_string();
            if !next.is_empty() {
                next.push('\n');
            }
            next.push_str(key);
            next.push('\n');
            return std::fs::write(&rc, next).is_ok();
        }
        Err(_) => std::fs::write(&rc, format!("{key}\n")).is_ok(),
    }
}

/// 执行任意 dsh CLI 命令（stdout/stderr 实时推送到日志视图），内部实现
async fn run_dsh_cmd_inner(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(resolve_npx(app));
    cmd.arg("--yes").arg("@deepseek-ai/dsh").args(args);
    apply_registry_env(&mut cmd, app);
    apply_node_env(&mut cmd, app);
    // 插件管理命令需要 pnpm workspace-root 兼容：优先写 profile .npmrc；
    // 写入失败（如只读环境）则注入环境变量兜底（pnpm 亦读取 npm_config_* 配置）
    if !ensure_pnpm_root_add_compat() {
        cmd.env("npm_config_ignore_workspace_root_check", "true")
            .env("NPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK", "true");
    }
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

    let mut cmd = Command::new(resolve_npx(app));
    cmd.args(["--yes", "@deepseek-ai/dsh", "web"]);
    apply_registry_env(&mut cmd, app);
    apply_node_env(&mut cmd, app);
    cmd.stdout(Stdio::from(log_file)).stderr(Stdio::from(log_file2));
    // stdin 改为 piped：嵌入式终端面板通过 write_stdin 写入子进程 stdin
    cmd.stdin(Stdio::piped());
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

    // 暂存 stdin 句柄，供 write_stdin 命令写入（Child 不 drop，句柄保持打开）
    *app.state::<DshStdin>().0.lock().await = child.stdin.take();

    // 监听子进程退出
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        *app_clone.state::<DshPid>().0.lock().unwrap() = None;
        let _ = app_clone.state::<DshStdin>().0.lock().await.take();
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

/// 嵌入式终端面板：向前端写入 DSH 子进程 stdin（chunk 可多次分批，保持字节序）。
/// 返回实际发给子进程的原始字符串；无活动进程时返回空串。
#[tauri::command]
async fn write_stdin(app: AppHandle, chunk: String) -> Result<String, String> {
    let state = app.state::<DshStdin>();
    let mut guard = state.0.lock().await;
    let Some(mut stdin) = guard.take() else {
        return Ok(String::new());
    };
    let bytes: Vec<u8> = chunk.into_bytes();
    use tokio::io::AsyncWriteExt;
    if let Err(e) = stdin.write_all(&bytes).await {
        return Err(format!("❌ 写入 stdin 失败: {}", e));
    }
    // 显式 flush，确保字节立刻送达子进程
    if let Err(e) = stdin.flush().await {
        return Err(format!("❌ 刷新 stdin 失败: {}", e));
    }
    *guard = Some(stdin);
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ============================ 多终端（shell 终端 + 只读 DSH 日志终端） ============================

/// 新建一个独立的 shell 终端：spawn 本机默认 shell，stdout/stderr 经 term-output 事件推给前端，
/// 输入经 term_write 写入其 stdin；退出时发 term-exit 并摘除。
#[tauri::command]
async fn term_spawn(app: AppHandle, id: String) -> Result<String, String> {
    // 同 id 已存在则先清理（幂等）
    kill_shell(&app, &id).await;

    let shell = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    };

    let mut cmd = Command::new(&shell);
    if cfg!(windows) {
        cmd.arg("/Q");
    } else {
        // 登录 shell，加载用户环境（PATH/别名）
        cmd.arg("-l");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("❌ 启动 shell 失败 ({}): {}", shell, e))?;
    let pid = child.id().unwrap_or(0);

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "❌ 无法获取 shell stdin".to_string())?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| "❌ 无法获取 shell stdout".to_string())?,
    );
    let mut stderr = BufReader::new(
        child
            .stderr
            .take()
            .ok_or_else(|| "❌ 无法获取 shell stderr".to_string())?,
    );

    // stdout 读取任务
    let id_out = id.clone();
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match stdout.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app_out.emit(
                        "term-output",
                        &ShellData { id: id_out.clone(), data: String::from_utf8_lossy(&buf).to_string() },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // stderr 读取任务
    let id_err = id.clone();
    let app_err = app.clone();
    tokio::spawn(async move {
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match stderr.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app_err.emit(
                        "term-output",
                        &ShellData { id: id_err.clone(), data: String::from_utf8_lossy(&buf).to_string() },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // 注册 stdin / pid（缺省，child 所有权交给 wait 任务）
    {
        let state = app.state::<Shells>();
        let mut all = state.0.lock().await;
        all.insert(
            id.clone(),
            ShellEntry { stdin: tokio::sync::Mutex::new(stdin), pid },
        );
    }

    // 退出监听：这个任务独占 child，wait 结束后发 term-exit 并摘除注册表
    let app_wait = app.clone();
    let id_wait = id.clone();
    tokio::spawn(async move {
        let code = child
            .wait()
            .await
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(-1);
        let _ = app_wait.emit(
            "term-exit",
            &ShellData { id: id_wait.clone(), data: code.to_string() },
        );
        kill_shell(&app_wait, &id_wait).await;
    });

    Ok(format!("✅ 终端 {} 已启动 ({})", id, shell))
}

/// 向指定 shell 终端的 stdin 写入片段（终端输入 → shell）
#[tauri::command]
async fn term_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<Shells>();
    let all = state.0.lock().await;
    let Some(entry) = all.get(&id) else {
        return Err(format!("终端 {} 不存在", id));
    };
    let mut stdin = entry.stdin.lock().await;
    stdin
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("❌ 写入 shell stdin 失败: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("❌ 刷新 shell stdin 失败: {}", e))?;
    Ok(())
}

/// 关闭某个 shell 终端
#[tauri::command]
async fn term_kill(app: AppHandle, id: String) -> Result<(), String> {
    kill_shell(&app, &id).await;
    Ok(())
}

/// 帮助函数：杀掉并摘除某个 shell 终端的子进程（通过 pid 发 SIGKILL）
async fn kill_shell(app: &AppHandle, id: &str) {
    let pid = {
        let state = app.state::<Shells>();
        let mut all = state.0.lock().await;
        all.remove(id).map(|e| e.pid)
    };
    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct ShellData {
    id: String,
    data: String,
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
        // 接管现有实例：记录监听 PID，退出时（若设置开启）一并回收，避免孤儿残留
        if let Some(pid) = port_listener_pid_sync(3080) {
            *app.state::<DshPid>().0.lock().unwrap() = Some(pid);
            let _ = app.emit(
                "dsh-log",
                format!(
                    "🔌 检测到 DSH 已在 3080 运行（PID {}），已接管并随 app 管理（可在「设置」改为不随 app 关闭）",
                    pid
                ),
            );
        } else {
            let _ = app.emit(
                "dsh-log",
                "✅ 检测到 DSH 已在 http://127.0.0.1:3080 运行，直接连接...",
            );
        }
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

/// 重启 DSH：强制回收 3080（含接管的外部实例）→ 等待端口释放 → 重新 spawn（插件装/卸/更后生效）
#[tauri::command]
async fn restart_dsh(app: AppHandle) -> Result<String, String> {
    kill_3080(&app);
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

// ============================ 插件缓存落盘（$APP_DATA/plugin-cache.json） ============================
// P0「缓存落盘升级」：插件中心的版本号/基线等从 localStorage 升级为 Rust 侧 JSON 文件。
// 通用 JSON blob 设计：当前存 versions/updatedAt，006 计划的「索引快照缓存」可复用同一文件。

fn plugin_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("❌ 无法获取应用数据目录: {}", e))?;
    Ok(dir.join("plugin-cache.json"))
}

/// 读取插件缓存（缺失/损坏时返回空对象，不报错）
#[tauri::command]
fn get_plugin_cache(app: AppHandle) -> serde_json::Value {
    let Ok(p) = plugin_cache_path(&app) else {
        return serde_json::json!({});
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 写入插件缓存（原子替换：先写临时文件再改名，避免中断写坏）
#[tauri::command]
fn set_plugin_cache(app: AppHandle, cache: serde_json::Value) -> Result<(), String> {
    let p = plugin_cache_path(&app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("❌ 无法创建数据目录: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&cache)
        .map_err(|e| format!("❌ 序列化插件缓存失败: {}", e))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("❌ 无法写入插件缓存: {}", e))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("❌ 无法写入插件缓存: {}", e))
}

/// 读取 web profile 的已安装插件（dependencies + bundles）
#[tauri::command]
fn list_installed_plugins() -> Result<serde_json::Value, String> {
    let pkg_path = web_profile_dir().join("package.json");
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

/// 应用退出/重启时：强制回收所有 shell 终端子进程（blocking_lock 用于非 async 的 run 闭包）
fn kill_all_shells(app: &AppHandle) {
    let state = app.state::<Shells>();
    let pids: Vec<u32> = state.0.blocking_lock().values().map(|e| e.pid).collect();
    for pid in pids {
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(DshPid(Mutex::new(None)))
        .manage(DshStdin(tokio::sync::Mutex::new(None)))
        .manage(Shells(tokio::sync::Mutex::new(std::collections::HashMap::new())))
        .manage(WebviewRegistry(Mutex::new(HashMap::new())))
        .manage(NodeBusy(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            start_dsh,
            restart_dsh,
            run_dsh_cmd,
            write_stdin,
            term_spawn,
            term_write,
            term_kill,
            list_installed_plugins,
            get_plugin_cache,
            set_plugin_cache,
            get_settings,
            set_registry,
            set_close_with_app,
            check_node,
            download_node,
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
            // 应用退出时回收 DSH（遵循 close_with_app 设置，默认随 app 关闭），避免残留占用 3080
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_all_shells(app_handle);
                kill_dsh_on_exit(app_handle);
            }
            _ => {}
        });
}
