use futures_util::TryStreamExt;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use suppaftp::AsyncFtpStream;
use tauri::{AppHandle, Emitter};
use tokio_util::compat::TokioAsyncReadCompatExt;
use tokio_util::io::StreamReader;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub game_id: u32,
    pub file_name: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f32,
    pub status: String, // "running" | "done" | "error"
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
    let url = url::Url::parse(ftp_url).map_err(|e| InstallError::BadFtpUrl(e.to_string()))?;
    if url.scheme() != "ftp" {
        return Err(InstallError::BadFtpUrl(
            "Only ftp:// URLs are supported".into(),
        ));
    }
    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port().unwrap_or(21);
    let user = url.username().to_string();
    let pass = url.password().unwrap_or("").to_string();
    let path = if url.path().is_empty() {
        "/".to_string()
    } else {
        url.path().to_string()
    };
    Ok((host, port, user, pass, path))
}

// ── Progress-tracking AsyncRead wrapper ──────────────────────────────────────

/// Wraps an inner `futures-io` AsyncRead and counts bytes as they pass through.
/// Every `report_every` bytes, calls the report callback with total downloaded so far.
struct ProgressReader<R> {
    inner: R,
    counter: Arc<Mutex<u64>>,
    report_every: u64,
    since_last: u64,
    on_progress: Box<dyn Fn(u64) + Send>,
}

// SAFETY: ProgressReader contains no self-referential data.
impl<R> Unpin for ProgressReader<R> {}

impl<R: futures_util::AsyncRead + Unpin> futures_util::AsyncRead for ProgressReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let n = match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(n)) => n,
            other => return other,
        };
        if n > 0 {
            let mut total = self.counter.lock().unwrap();
            *total += n as u64;
            let t = *total;
            drop(total);

            self.since_last += n as u64;
            if self.since_last >= self.report_every {
                self.since_last = 0;
                (self.on_progress)(t);
            }
        }
        Poll::Ready(Ok(n))
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/// Stream download from server and upload to Switch FTP simultaneously.
/// Emits "install_progress" events to the frontend during transfer.
#[tauri::command]
pub async fn install_game(app: AppHandle, params: InstallParams) -> Result<(), InstallError> {
    // Parse FTP URL
    let (ftp_host, ftp_port, ftp_user, ftp_pass, ftp_dir) = parse_ftp_url(&params.ftp_url)?;

    // Build download URL
    let download_url = format!(
        "{}/api/download/{}/{}",
        params.server_url.trim_end_matches('/'),
        params.game_id,
        urlencoding::encode(&params.file_name)
    );

    // Issue HTTP request (streaming)
    let http_client = HttpClient::new();
    let response = http_client.get(&download_url).send().await?;

    if !response.status().is_success() {
        let msg = format!("Server returned {}", response.status());
        emit_progress(&app, &params.file_name, params.game_id, 0, 0, "error", &msg);
        return Err(InstallError::Http(response.error_for_status().unwrap_err()));
    }

    let total = response.content_length().unwrap_or(0);

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

    let target_dir = if params.ftp_path.is_empty() { &ftp_dir } else { &params.ftp_path };
    ftp.cwd(target_dir)
        .await
        .map_err(|e| InstallError::Ftp(format!("CWD '{}' failed: {}", target_dir, e)))?;

    emit_progress(&app, &params.file_name, params.game_id, 0, total, "running", "Streaming...");

    // Convert reqwest bytes stream → tokio AsyncRead → futures-io AsyncRead
    let bytes_stream = response
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let tokio_reader = StreamReader::new(bytes_stream);
    let futures_reader = tokio_reader.compat(); // TokioAsyncReadCompatExt → futures_io::AsyncRead

    // Wrap with progress tracking
    let counter = Arc::new(Mutex::new(0u64));
    let app_clone = app.clone();
    let file_name_clone = params.file_name.clone();
    let game_id = params.game_id;
    let report_every: u64 = 512 * 1024; // report every 512 KB

    let progress_reader = ProgressReader {
        inner: futures_reader,
        counter: counter.clone(),
        report_every,
        since_last: 0,
        on_progress: Box::new(move |downloaded| {
            emit_progress(
                &app_clone,
                &file_name_clone,
                game_id,
                downloaded,
                total,
                "running",
                "Streaming...",
            );
        }),
    };

    // suppaftp's put_file_with_stream drives reading from our AsyncRead
    let mut progress_reader = progress_reader;
    ftp.put_file_with_stream(&params.file_name, &mut progress_reader)
        .await
        .map_err(|e| InstallError::Ftp(format!("FTP upload failed: {}", e)))?;

    ftp.quit().await.ok();

    let downloaded = *counter.lock().unwrap();
    emit_progress(&app, &params.file_name, params.game_id, downloaded, total, "done", "Complete");

    Ok(())
}

fn emit_progress(
    app: &AppHandle,
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
            status: status.to_string(),
            message: message.to_string(),
        },
    );
}
