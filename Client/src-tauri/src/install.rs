use futures_util::StreamExt;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use suppaftp::AsyncFtpStream;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub game_id: u32,
    pub file_name: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f32,
    pub speed_bps: u64, // bytes per second
    pub status: String,  // "running" | "done" | "error"
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct InstallParams {
    pub server_url: String,
    pub game_id: u32,
    pub file_name: String,
    pub ftp_url: String,
    pub ftp_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("FTP error: {0}")]
    Ftp(String),
    #[error("Missing Content-Length header")]
    MissingContentLength,
    #[error("Bad FTP URL: {0}")]
    BadFtpUrl(String),
}

impl Serialize for InstallError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn parse_ftp_url(ftp_url: &str) -> Result<(String, u16, String, String, String), InstallError> {
    let url = url::Url::parse(ftp_url)
        .map_err(|e| InstallError::BadFtpUrl(e.to_string()))?;
    if url.scheme() != "ftp" {
        return Err(InstallError::BadFtpUrl("Only ftp:// URLs are supported".into()));
    }
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port().unwrap_or(21);
    let user = url.username().to_string();
    let pass = url.password().unwrap_or("").to_string();
    let path = if url.path().is_empty() { "/".to_string() } else { url.path().to_string() };
    Ok((host, port, user, pass, path))
}

/// Stream download from server and upload to Switch FTP simultaneously.
/// Emits "install_progress" events during transfer.
#[tauri::command]
pub async fn install_game(
    app: AppHandle,
    params: InstallParams,
) -> Result<(), InstallError> {
    let event_id = format!("{}:{}", params.game_id, params.file_name);

    // Parse FTP URL
    let (ftp_host, ftp_port, ftp_user, ftp_pass, ftp_dir) =
        parse_ftp_url(&params.ftp_url)?;

    // Build download URL
    let download_url = format!(
        "{}/api/download/{}/{}",
        params.server_url.trim_end_matches('/'),
        params.game_id,
        urlencoding::encode(&params.file_name)
    );

    // Issue HTTP request
    let http_client = HttpClient::new();
    let response = http_client.get(&download_url).send().await?;

    if !response.status().is_success() {
        let msg = format!("Server returned {}", response.status());
        emit_progress(&app, &event_id, &params.file_name, params.game_id, 0, 0, "error", &msg);
        return Err(InstallError::Http(
            response.error_for_status().unwrap_err()
        ));
    }

    let total = response
        .content_length()
        .unwrap_or(0);

    // Connect to FTP
    let addr = format!("{}:{}", ftp_host, ftp_port);
    let mut ftp = AsyncFtpStream::connect(&addr)
        .await
        .map_err(|e| InstallError::Ftp(e.to_string()))?;

    let login_user = if ftp_user.is_empty() { "anonymous" } else { &ftp_user };
    let login_pass = if ftp_pass.is_empty() { "anonymous" } else { &ftp_pass };

    ftp.login(login_user, login_pass)
        .await
        .map_err(|e| InstallError::Ftp(format!("Login failed: {}", e)))?;

    // Navigate to target directory (use ftp_path from params, fallback to URL path)
    let target_dir = if params.ftp_path.is_empty() { &ftp_dir } else { &params.ftp_path };
    ftp.cwd(target_dir)
        .await
        .map_err(|e| InstallError::Ftp(format!("CWD '{}' failed: {}", target_dir, e)))?;

    // Stream: HTTP → FTP via put_with_stream
    // suppaftp's put_file_with_stream requires writing to an AsyncWrite stream.
    // We use append_with_stream so partial writes are supported.
    let mut ftp_stream = ftp
        .put_with_stream(&params.file_name)
        .await
        .map_err(|e| InstallError::Ftp(format!("PUT stream failed: {}", e)))?;

    let mut byte_stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_report = std::time::Instant::now();
    let mut bytes_since_last = 0u64;
    let mut speed_bps: u64 = 0;

    emit_progress(&app, &event_id, &params.file_name, params.game_id, 0, total, "running", "Streaming...");

    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk?;
        ftp_stream
            .write_all(&chunk)
            .await
            .map_err(|e| InstallError::Ftp(format!("FTP write error: {}", e)))?;

        downloaded += chunk.len() as u64;
        bytes_since_last += chunk.len() as u64;

        let elapsed = last_report.elapsed();
        if elapsed.as_millis() >= 300 {
            speed_bps = (bytes_since_last as f64 / elapsed.as_secs_f64()) as u64;
            bytes_since_last = 0;
            last_report = std::time::Instant::now();

            emit_progress(
                &app,
                &event_id,
                &params.file_name,
                params.game_id,
                downloaded,
                total,
                "running",
                "Streaming...",
            );
        }
        let _ = speed_bps; // suppress unused warning
    }

    // Finalize FTP
    ftp.finalize_put_stream(ftp_stream)
        .await
        .map_err(|e| InstallError::Ftp(format!("FTP finalize failed: {}", e)))?;

    ftp.quit().await.ok();

    emit_progress(&app, &event_id, &params.file_name, params.game_id, total, total, "done", "Complete");

    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    event_id: &str,
    file_name: &str,
    game_id: u32,
    downloaded: u64,
    total: u64,
    status: &str,
    message: &str,
) {
    let percent = if total > 0 {
        (downloaded as f32 / total as f32 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "install_progress",
        InstallProgress {
            game_id,
            file_name: file_name.to_string(),
            downloaded,
            total,
            percent,
            speed_bps: 0,
            status: status.to_string(),
            message: message.to_string(),
        },
    );
    let _ = event_id; // used as identifier on frontend
}
