mod install;
mod ftp;

use install::install_game;
use ftp::preflight_ftp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![install_game, preflight_ftp])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
