//! CodingAgentDriver — 统一 CLI Agent 工具接口
//!
//! 实现此 trait 即可接入任何 CLI 编码 Agent（agy / claude / codex / cursor 等）。

use std::path::PathBuf;

// ── 执行结果 ──────────────────────────────────────────────────────────────────

/// 单次工具调用的执行结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverResult {
    pub success: bool,
    pub output: String,
    pub exit_code: Option<i32>,
    /// 本次执行后提取到的 session ID（如有）
    pub session_id: Option<String>,
}

// ── 驱动状态 ──────────────────────────────────────────────────────────────────

/// 驱动当前状态（供 UI 展示）
#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub authenticated: bool,
    pub enabled: bool,
    pub binary_path: Option<String>,
}

// ── Trait 定义 ────────────────────────────────────────────────────────────────

/// 所有 CLI Agent 工具必须实现此 trait
pub trait CodingAgentDriver: Send + Sync {
    // ── 元信息 ───────────────────────────────────────────────────────────────

    /// 工具 ID，用于路由，小写无空格（如 "agy", "claude", "codex"）
    fn id(&self) -> &str;

    /// UI 显示名称
    fn display_name(&self) -> &str;

    // ── 安装与认证 ───────────────────────────────────────────────────────────

    /// 查找可执行文件路径（None = 未安装）
    fn find_binary(&self) -> Option<PathBuf>;

    /// 检查是否已完成认证（通过检查 credentials 文件等方式，不启动进程）
    fn is_authenticated(&self) -> bool;

    // ── 执行参数构建 ─────────────────────────────────────────────────────────

    /// 构建命令参数
    ///
    /// - `prompt`: 任务描述
    /// - `cwd`: 工作目录
    /// - `session_id`: 上一次的 session ID（None = 新建 session）
    fn build_run_args(&self, prompt: &str, cwd: &str, session_id: Option<&str>) -> Vec<String>;

    /// 是否支持 session 恢复（默认 true）
    fn supports_session_resume(&self) -> bool {
        true
    }

    /// 每次执行的超时秒数（0 = 不限时，默认 0）
    fn default_timeout_secs(&self) -> u64 {
        0
    }

    // ── Session 管理 ─────────────────────────────────────────────────────────

    /// 从 stdout 中提取 session ID
    ///
    /// 返回 None 表示该工具不在 stdout 中输出 session ID
    /// （可能在 config 文件里，由 `read_latest_session_id` 负责）
    fn extract_session_id_from_stdout(&self, _stdout: &str) -> Option<String> {
        None
    }

    /// 从文件系统读取最新的 session ID（用于不在 stdout 中输出 ID 的工具）
    fn read_latest_session_id(&self) -> Option<String> {
        None
    }

    /// 获取 session ID：先尝试 stdout，再尝试文件系统
    fn resolve_session_id(&self, stdout: &str) -> Option<String> {
        self.extract_session_id_from_stdout(stdout)
            .or_else(|| self.read_latest_session_id())
    }

    // ── 额外 CLI 参数 ────────────────────────────────────────────────────────

    /// 追加到每次执行的固定参数（如 --dangerously-skip-permissions）
    fn extra_args(&self) -> Vec<String> {
        vec![]
    }

    // ── 状态报告 ─────────────────────────────────────────────────────────────

    fn status(&self) -> DriverStatus {
        let binary = self.find_binary();
        let installed = binary.is_some();
        DriverStatus {
            id: self.id().to_string(),
            display_name: self.display_name().to_string(),
            installed,
            authenticated: if installed { self.is_authenticated() } else { false },
            enabled: true,
            binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        }
    }
}
