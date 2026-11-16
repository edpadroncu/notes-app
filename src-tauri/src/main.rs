// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn notes_dir() -> std::path::PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Notes")
}

#[tauri::command]
fn suggested_vault() -> String {
    notes_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn default_vault() -> Result<String, String> {
    let dir = notes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn pick_folder(app: tauri::AppHandle, title: String) -> Option<String> {
    app.dialog()
        .file()
        .set_title(&title)
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn list_vault(root: String) -> Result<Vec<backend::Entry>, String> {
    backend::list_vault(&root)
}

#[tauri::command(rename_all = "camelCase")]
fn read_all_notes(root: String) -> Result<Vec<backend::NoteFile>, String> {
    backend::read_all_notes(&root)
}

#[tauri::command(rename_all = "camelCase")]
fn write_note(root: String, rel: String, contents: String) -> Result<(), String> {
    backend::write_note(&root, &rel, &contents)
}

#[tauri::command(rename_all = "camelCase")]
fn create_dir(root: String, rel: String) -> Result<(), String> {
    backend::create_dir(&root, &rel)
}

#[tauri::command(rename_all = "camelCase")]
fn rename_entry(root: String, from: String, to: String) -> Result<(), String> {
    backend::rename_entry(&root, &from, &to)
}

#[tauri::command(rename_all = "camelCase")]
fn delete_entry(root: String, rel: String) -> Result<(), String> {
    backend::delete_entries(&root, &[rel])
}

#[tauri::command(rename_all = "camelCase")]
fn delete_entries(root: String, rels: Vec<String>) -> Result<(), String> {
    backend::delete_entries(&root, &rels)
}

#[tauri::command(rename_all = "camelCase")]
fn scan_markdown(root: String) -> Result<backend::MarkdownScan, String> {
    backend::scan_markdown(&root)
}

#[tauri::command(rename_all = "camelCase")]
fn copy_asset(
    src_root: String,
    src_rel: String,
    dst_root: String,
    dst_rel: String,
) -> Result<(), String> {
    backend::copy_asset(&src_root, &src_rel, &dst_root, &dst_rel)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            default_vault,
            suggested_vault,
            pick_folder,
            open_url,
            list_vault,
            read_all_notes,
            write_note,
            create_dir,
            rename_entry,
            delete_entry,
            delete_entries,
            scan_markdown,
            copy_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
