// PG Kernel Visualizer - Tauri Desktop Application
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Log startup
            println!("PG Visualizer starting...");

            // Get main window
            let window = app.get_webview_window("main").expect("failed to get main window");

            // Window is ready
            println!("Main window ready");

            let _ = window.set_title("PG Kernel Visualizer");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
