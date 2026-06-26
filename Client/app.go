package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jlaffaye/ftp"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds application state and context
type App struct {
	ctx context.Context
}

// NewApp creates a new App
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// ─────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────

// AppSettings stores user configuration
type AppSettings struct {
	ServerURL string `json:"serverUrl"`
	FtpURL    string `json:"ftpUrl"`
	FtpPath   string `json:"ftpPath"`
}

func settingsFilePath() (string, error) {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("APPDATA")
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "Library", "Application Support")
	default:
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, "SwitchGameManager")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// GetSettings loads settings from disk
func (a *App) GetSettings() AppSettings {
	defaults := AppSettings{
		ServerURL: "http://192.168.1.100:18080",
		FtpURL:    "",
		FtpPath:   "/",
	}
	path, err := settingsFilePath()
	if err != nil {
		return defaults
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return defaults
	}
	var s AppSettings
	if err := json.Unmarshal(data, &s); err != nil {
		return defaults
	}
	return s
}

// SaveSettings persists settings to disk
func (a *App) SaveSettings(s AppSettings) error {
	path, err := settingsFilePath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ─────────────────────────────────────────────
// FTP preflight
// ─────────────────────────────────────────────

// PreflightResult is the result of an FTP connection test
type PreflightResult struct {
	Ok      bool   `json:"ok"`
	Message string `json:"message"`
}

// PreflightFtp tests FTP connectivity
func (a *App) PreflightFtp(ftpUrl string, ftpPath string) PreflightResult {
	conn, err := dialFtp(ftpUrl)
	if err != nil {
		return PreflightResult{Ok: false, Message: fmt.Sprintf("连接失败: %v", err)}
	}
	defer conn.Quit()

	if ftpPath != "" && ftpPath != "/" {
		if err := conn.ChangeDir(ftpPath); err != nil {
			return PreflightResult{Ok: false, Message: fmt.Sprintf("目录不存在: %v", err)}
		}
	}
	return PreflightResult{Ok: true, Message: "连接成功"}
}

// dialFtp parses an ftp:// URL and returns an authenticated connection
func dialFtp(rawURL string) (*ftp.ServerConn, error) {
	if !strings.HasPrefix(rawURL, "ftp://") {
		rawURL = "ftp://" + rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid FTP URL: %w", err)
	}

	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "21"
	}
	addr := host + ":" + port

	conn, err := ftp.Dial(addr, ftp.DialWithTimeout(10*time.Second))
	if err != nil {
		return nil, err
	}

	user := "anonymous"
	pass := "anonymous"
	if u.User != nil {
		user = u.User.Username()
		if p, ok := u.User.Password(); ok {
			pass = p
		}
	}
	if err := conn.Login(user, pass); err != nil {
		conn.Quit()
		return nil, fmt.Errorf("login failed: %w", err)
	}
	return conn, nil
}

// ─────────────────────────────────────────────
// Install
// ─────────────────────────────────────────────

// InstallParams matches the frontend params object
type InstallParams struct {
	ServerURL string `json:"server_url"`
	GameID    uint32 `json:"game_id"`
	FileName  string `json:"file_name"`
	FtpURL    string `json:"ftp_url"`
	FtpPath   string `json:"ftp_path"`
}

// InstallProgress is the event payload emitted during installation
type InstallProgress struct {
	GameID     uint32  `json:"game_id"`
	FileName   string  `json:"file_name"`
	Downloaded int64   `json:"downloaded"`
	Total      int64   `json:"total"`
	Percent    float64 `json:"percent"`
	Status     string  `json:"status"` // "running" | "done" | "error"
	Message    string  `json:"message"`
}

const progressChunkSize = 512 * 1024 // emit every 512 KB

// InstallGame streams a file from the server directly to the Switch via FTP
func (a *App) InstallGame(params InstallParams) error {
	emit := func(p InstallProgress) {
		wailsRuntime.EventsEmit(a.ctx, "install_progress", p)
	}

	// 1. Start HTTP download
	downloadURL := fmt.Sprintf("%s/api/download/%d/%s",
		strings.TrimRight(params.ServerURL, "/"),
		params.GameID,
		params.FileName,
	)
	resp, err := http.Get(downloadURL)
	if err != nil {
		emit(InstallProgress{GameID: params.GameID, FileName: params.FileName,
			Status: "error", Message: fmt.Sprintf("下载失败: %v", err)})
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg := fmt.Sprintf("服务器返回 %d", resp.StatusCode)
		emit(InstallProgress{GameID: params.GameID, FileName: params.FileName,
			Status: "error", Message: msg})
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	total := resp.ContentLength // may be -1 if unknown

	// 2. Connect FTP
	conn, err := dialFtp(params.FtpURL)
	if err != nil {
		emit(InstallProgress{GameID: params.GameID, FileName: params.FileName,
			Status: "error", Message: fmt.Sprintf("FTP连接失败: %v", err)})
		return fmt.Errorf("ftp connect: %w", err)
	}
	defer conn.Quit()

	// Change to target directory
	targetDir := params.FtpPath
	if targetDir == "" {
		targetDir = "/"
	}
	if targetDir != "/" {
		if err := conn.ChangeDir(targetDir); err != nil {
			emit(InstallProgress{GameID: params.GameID, FileName: params.FileName,
				Status: "error", Message: fmt.Sprintf("FTP目录错误: %v", err)})
			return fmt.Errorf("ftp cwd: %w", err)
		}
	}

	// 3. Stream via progress-tracking reader
	pr := &progressReader{
		r:     resp.Body,
		total: total,
		onProgress: func(downloaded int64) {
			var pct float64
			if total > 0 {
				pct = float64(downloaded) / float64(total) * 100
			}
			emit(InstallProgress{
				GameID:     params.GameID,
				FileName:   params.FileName,
				Downloaded: downloaded,
				Total:      total,
				Percent:    pct,
				Status:     "running",
				Message:    fmt.Sprintf("%.1f%%", pct),
			})
		},
	}

	// 4. Upload to FTP
	if err := conn.Stor(params.FileName, pr); err != nil {
		emit(InstallProgress{GameID: params.GameID, FileName: params.FileName,
			Status: "error", Message: fmt.Sprintf("FTP上传失败: %v", err)})
		return fmt.Errorf("ftp stor: %w", err)
	}

	emit(InstallProgress{
		GameID:     params.GameID,
		FileName:   params.FileName,
		Downloaded: pr.downloaded,
		Total:      total,
		Percent:    100,
		Status:     "done",
		Message:    "安装完成",
	})
	return nil
}

// progressReader wraps an io.Reader and fires a callback every progressChunkSize bytes
type progressReader struct {
	r           io.Reader
	total       int64
	downloaded  int64
	lastEmit    int64
	onProgress  func(int64)
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	pr.downloaded += int64(n)

	if pr.downloaded-pr.lastEmit >= progressChunkSize || err == io.EOF {
		pr.onProgress(pr.downloaded)
		pr.lastEmit = pr.downloaded
	}
	return n, err
}

// ─────────────────────────────────────────────
// API Proxy (bypasses CORS in frontend)
// ─────────────────────────────────────────────

// ProxyHttpGet requests the server API from the backend to bypass browser CORS
func (a *App) ProxyHttpGet(targetUrl string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(targetUrl)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("server returned status: %s", resp.Status)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(bodyBytes), nil
}

// ─────────────────────────────────────────────
// Utility (keep compiler happy with strconv import)
// ─────────────────────────────────────────────
var _ = strconv.Itoa

