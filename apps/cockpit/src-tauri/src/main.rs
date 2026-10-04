// Toros cockpit shell.
//
// This process hosts a webview and exposes only the minimal runtime
// configuration command. It is deliberately not a general file reader:
// SPEC 4.1 requires that the cockpit hold no policy authority or privileged
// filesystem backdoor.
//
// Everything the cockpit displays comes from Node Core over loopback HTTP,
// authenticated with a bearer token, through the same surface any other
// client uses.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct NodeCoreConfig {
    port: u16,
    token: String,
    operator_token: Option<String>,
}

#[derive(Serialize)]
struct CockpitStatus {
    approvals_configured: bool,
}

struct NodeCoreClient(reqwest::Client);
#[derive(Serialize)]

struct ProxyResponse {
    status: u16,
    body: serde_json::Value,
}

const NODE_CORE_TASK_NAME: &str = r"\Toros Node Core";

fn scheduled_task_args() -> [&'static str; 3] {
    ["/Run", "/TN", NODE_CORE_TASK_NAME]
}

#[cfg(target_os = "windows")]
fn start_scheduled_node_core(port: u16) -> Result<(), String> {
    use std::net::{SocketAddr, TcpStream};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "Windows system directory is unavailable".to_string())?;
    let schtasks = PathBuf::from(system_root)
        .join("System32")
        .join("schtasks.exe");
    let status = Command::new(schtasks)
        .args(scheduled_task_args())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "Windows could not launch the Toros Node Core task".to_string())?;
    if !status.success() {
        return Err("Windows refused to start the Toros Node Core task".to_string());
    }

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Node Core did not become reachable within 10 seconds".to_string())
}

#[cfg(not(target_os = "windows"))]
fn start_scheduled_node_core(_port: u16) -> Result<(), String> {
    Err("Starting Node Core from Cockpit is available on Windows only".to_string())
}

fn approvals_configured(config: &NodeCoreConfig) -> bool {
    config
        .operator_token
        .as_deref()
        .is_some_and(|token| !token.is_empty())
}

fn credential_for(config: &NodeCoreConfig, operator_operation: bool) -> Result<&str, String> {
    let credential = if operator_operation {
        config
            .operator_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "Approvals are not configured on this node".to_string())?
    } else {
        config.token.as_str()
    };
    if credential.is_empty() {
        return Err("Node Core config has no valid token".to_string());
    }
    Ok(credential)
}

fn config_path() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var_os("LOCALAPPDATA").ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Toros")
        .join("config.json"))
}

fn read_config() -> Result<NodeCoreConfig, String> {
    let bytes =
        std::fs::read(config_path()?).map_err(|_| "Node Core config is unavailable".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Node Core config is invalid".to_string())
}

#[tauri::command]
fn cockpit_status() -> Result<CockpitStatus, String> {
    let config = read_config()?;
    Ok(CockpitStatus {
        approvals_configured: approvals_configured(&config),
    })
}

#[tauri::command]
async fn start_node_core() -> Result<(), String> {
    let port = read_config()?.port;
    tauri::async_runtime::spawn_blocking(move || start_scheduled_node_core(port))
        .await
        .map_err(|_| "The Node Core start worker failed".to_string())?
}

fn operation_path(operation: &str) -> Option<(&'static str, bool)> {
    match operation {
        "job_status" => Some(("/tools/job_status", false)),
        "job_complete" => Some(("/tools/job_complete", false)),
        "job_block" => Some(("/tools/job_block", false)),
        "list_capabilities" => Some(("/tools/list_capabilities", false)),
        "list_sessions" => Some(("/tools/list_sessions", false)),
        "list_activity" => Some(("/tools/list_activity", false)),
        "create_checkpoint" => Some(("/tools/create_checkpoint", false)),
        "create_local_relay" => Some(("/tools/create_local_relay", false)),
        "operator_approvals" => Some(("/operator/approvals", true)),
        "operator_approve" => Some(("/operator/approve", true)),
        "operator_findings" => Some(("/operator/findings", true)),
        "operator_catalog" => Some(("/operator/catalog", true)),
        "operator_jobs" => Some(("/operator/jobs", true)),
        "operator_pipelines" => Some(("/operator/pipelines", true)),
        "operator_pipeline_create" => Some(("/operator/pipeline_create", true)),
        "operator_pipeline_pause" => Some(("/operator/pipeline_pause", true)),
        "operator_pipeline_resume" => Some(("/operator/pipeline_resume", true)),
        "operator_pipeline_stop" => Some(("/operator/pipeline_stop", true)),
        "operator_browser_status" => Some(("/operator/browser_status", true)),
        "operator_browser_pairing" => Some(("/operator/browser_pairing", true)),
        "operator_browser_acquisitions" => Some(("/operator/browser_acquisitions", true)),
        "operator_browser_acquisition_create" => {
            Some(("/operator/browser_acquisition_create", true))
        }
        "operator_browser_acquisition_pause" => Some(("/operator/browser_acquisition_pause", true)),
        "operator_browser_acquisition_resume" => {
            Some(("/operator/browser_acquisition_resume", true))
        }
        "operator_browser_acquisition_stop" => Some(("/operator/browser_acquisition_stop", true)),
        "operator_create_job" => Some(("/operator/create_job", true)),
        "operator_job_archive" => Some(("/operator/job_archive", true)),
        "operator_hermes_status" => Some(("/operator/hermes_status", true)),
        "operator_hermes_start" => Some(("/operator/hermes_start", true)),
        "operator_hermes_stop" => Some(("/operator/hermes_stop", true)),
        "operator_checkpoint" => Some(("/operator/checkpoint", true)),
        "operator_conversation" => Some(("/operator/conversation", true)),
        "operator_conversations" => Some(("/operator/conversations", true)),
        "operator_conversation_create" => Some(("/operator/conversation_create", true)),
        "operator_conversation_send" => Some(("/operator/conversation_send", true)),
        "operator_conversation_turns" => Some(("/operator/conversation_turns", true)),
        "operator_conversation_archive" => Some(("/operator/conversation_archive", true)),
        "operator_conversation_usage" => Some(("/operator/conversation_usage", true)),
        "operator_accept_proposal" => Some(("/operator/accept_proposal", true)),
        "operator_reject_proposal" => Some(("/operator/reject_proposal", true)),
        _ => None,
    }
}

#[tauri::command]
async fn node_core_request(
    operation: String,
    client: tauri::State<'_, NodeCoreClient>,
    body: serde_json::Value,
) -> Result<ProxyResponse, String> {
    let (path, operator_operation) =
        operation_path(&operation).ok_or_else(|| "Operation is not allowed".to_string())?;
    let config = read_config()?;
    let credential = credential_for(&config, operator_operation)?;

    let url = format!("http://127.0.0.1:{}{}", config.port, path);
    let response = client
        .0
        .post(url)
        .timeout(std::time::Duration::from_secs(30))
        .bearer_auth(credential)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Node Core request could not be completed".to_string())?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Node Core response could not be read".to_string())?;
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
    });

    Ok(ProxyResponse { status, body })
}

fn main() {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("Node Core HTTP client could not be initialized");
    tauri::Builder::default()
        .manage(NodeCoreClient(client))
        .invoke_handler(tauri::generate_handler![
            cockpit_status,
            start_node_core,
            node_core_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Toros cockpit");
}

#[cfg(test)]
mod tests {
    use super::{
        approvals_configured, credential_for, operation_path, scheduled_task_args, CockpitStatus,
        NodeCoreConfig,
    };

    #[test]
    fn operation_allowlist_excludes_work_driving_tools() {
        for (operation, path) in [
            ("job_status", "/tools/job_status"),
            ("job_complete", "/tools/job_complete"),
            ("job_block", "/tools/job_block"),
            ("list_capabilities", "/tools/list_capabilities"),
            ("list_sessions", "/tools/list_sessions"),
            ("list_activity", "/tools/list_activity"),
            ("create_checkpoint", "/tools/create_checkpoint"),
            ("create_local_relay", "/tools/create_local_relay"),
        ] {
            assert_eq!(operation_path(operation), Some((path, false)));
        }
        assert_eq!(
            operation_path("operator_approvals"),
            Some(("/operator/approvals", true))
        );
        assert_eq!(
            operation_path("operator_approve"),
            Some(("/operator/approve", true))
        );
        assert_eq!(
            operation_path("operator_findings"),
            Some(("/operator/findings", true))
        );
        for (operation, path) in [
            ("operator_catalog", "/operator/catalog"),
            ("operator_jobs", "/operator/jobs"),
            ("operator_pipelines", "/operator/pipelines"),
            ("operator_pipeline_create", "/operator/pipeline_create"),
            ("operator_pipeline_pause", "/operator/pipeline_pause"),
            ("operator_pipeline_resume", "/operator/pipeline_resume"),
            ("operator_pipeline_stop", "/operator/pipeline_stop"),
            ("operator_browser_status", "/operator/browser_status"),
            ("operator_browser_pairing", "/operator/browser_pairing"),
            (
                "operator_browser_acquisitions",
                "/operator/browser_acquisitions",
            ),
            (
                "operator_browser_acquisition_create",
                "/operator/browser_acquisition_create",
            ),
            (
                "operator_browser_acquisition_pause",
                "/operator/browser_acquisition_pause",
            ),
            (
                "operator_browser_acquisition_resume",
                "/operator/browser_acquisition_resume",
            ),
            (
                "operator_browser_acquisition_stop",
                "/operator/browser_acquisition_stop",
            ),
            ("operator_create_job", "/operator/create_job"),
            ("operator_job_archive", "/operator/job_archive"),
            ("operator_hermes_status", "/operator/hermes_status"),
            ("operator_hermes_start", "/operator/hermes_start"),
            ("operator_hermes_stop", "/operator/hermes_stop"),
            ("operator_checkpoint", "/operator/checkpoint"),
            ("operator_conversation", "/operator/conversation"),
            ("operator_conversations", "/operator/conversations"),
            (
                "operator_conversation_create",
                "/operator/conversation_create",
            ),
            ("operator_conversation_send", "/operator/conversation_send"),
            (
                "operator_conversation_turns",
                "/operator/conversation_turns",
            ),
            (
                "operator_conversation_archive",
                "/operator/conversation_archive",
            ),
            (
                "operator_conversation_usage",
                "/operator/conversation_usage",
            ),
            ("operator_accept_proposal", "/operator/accept_proposal"),
            ("operator_reject_proposal", "/operator/reject_proposal"),
        ] {
            assert_eq!(operation_path(operation), Some((path, true)));
        }
        assert_eq!(operation_path("start_cli"), None);
        assert_eq!(operation_path("invoke_app_action"), None);
        assert_eq!(operation_path("http://example.test"), None);
    }

    #[test]
    fn status_and_credentials_stay_on_the_rust_side() {
        let config = NodeCoreConfig {
            port: 4899,
            token: "coordinator-secret".to_string(),
            operator_token: Some("operator-secret".to_string()),
        };
        let serialized = serde_json::to_value(CockpitStatus {
            approvals_configured: approvals_configured(&config),
        })
        .expect("status serializes");

        assert_eq!(
            serialized,
            serde_json::json!({ "approvals_configured": true })
        );
        assert_eq!(credential_for(&config, false), Ok("coordinator-secret"));
        assert_eq!(credential_for(&config, true), Ok("operator-secret"));
    }

    #[test]
    fn operator_operation_refuses_an_absent_or_empty_token() {
        for operator_token in [None, Some(String::new())] {
            let config = NodeCoreConfig {
                port: 4899,
                token: "coordinator-secret".to_string(),
                operator_token,
            };
            assert!(credential_for(&config, true).is_err());
        }
    }
    #[test]
    fn node_core_start_command_has_one_fixed_task_target() {
        assert_eq!(scheduled_task_args(), ["/Run", "/TN", r"\Toros Node Core"]);
    }
}
