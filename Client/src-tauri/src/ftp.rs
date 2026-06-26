use serde::Serialize;
use suppaftp::AsyncFtpStream;

#[derive(Debug, Serialize)]
pub struct PreflightResult {
    pub ok: bool,
    pub message: String,
}

/// Test FTP connectivity. Returns ok=true if we can connect, login, and CWD.
#[tauri::command]
pub async fn preflight_ftp(ftp_url: String, ftp_path: String) -> PreflightResult {
    match do_preflight(&ftp_url, &ftp_path).await {
        Ok(msg) => PreflightResult { ok: true, message: msg },
        Err(e) => PreflightResult { ok: false, message: e },
    }
}

async fn do_preflight(ftp_url: &str, ftp_path: &str) -> Result<String, String> {
    let url = url::Url::parse(ftp_url).map_err(|e| format!("Bad FTP URL: {}", e))?;
    if url.scheme() != "ftp" {
        return Err("Only ftp:// URLs are supported".into());
    }

    let host = url.host_str().unwrap_or("").to_string();
    let port = url.port().unwrap_or(21);
    let user = url.username().to_string();
    let pass = url.password().unwrap_or("").to_string();
    let url_path = if url.path().is_empty() { "/" } else { url.path() };
    let target = if ftp_path.is_empty() { url_path } else { ftp_path };

    let addr = format!("{}:{}", host, port);
    let mut ftp = AsyncFtpStream::connect(&addr)
        .await
        .map_err(|e| format!("Cannot connect to {}: {}", addr, e))?;

    let login_user = if user.is_empty() { "anonymous" } else { &user };
    let login_pass = if pass.is_empty() { "anonymous" } else { &pass };

    ftp.login(login_user, login_pass)
        .await
        .map_err(|e| format!("Login failed: {}", e))?;

    ftp.cwd(target)
        .await
        .map_err(|e| format!("CWD '{}' failed: {}", target, e))?;

    ftp.quit().await.ok();

    Ok(format!("FTP OK: {}:{}{}", host, port, target))
}
