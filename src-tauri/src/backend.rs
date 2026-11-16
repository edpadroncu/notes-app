// Pure file-system backend for the notes app, mirroring server/backend.cjs.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const ATTACHMENTS: &str = "_attachments";
const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct NoteFile {
    pub path: String,
    pub contents: String,
}

#[derive(Serialize, Default)]
pub struct MarkdownScan {
    pub notes: Vec<NoteFile>,
    pub assets: Vec<String>,
}

/// Join a vault-relative path onto root, refusing anything that could escape it.
pub fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let r = rel.replace('\\', "/");
    if Path::new(&r).is_absolute() {
        return Err(format!("Invalid path: {rel}"));
    }
    let mut out = PathBuf::from(root);
    for part in r.split('/').filter(|p| !p.is_empty()) {
        if part == ".." || part == "." || part.contains(':') {
            return Err(format!("Invalid path: {rel}"));
        }
        out.push(part);
    }
    Ok(out)
}

fn ext_lower(p: &str) -> String {
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// Every visible file and folder under root, as forward-slash relative paths, parents first.
fn walk(root: &Path, rel: &str, out: &mut Vec<Entry>) {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let mut entries: Vec<_> = match fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
        if is_dir {
            out.push(Entry { path: child.clone(), is_dir: true });
            walk(root, &child, out);
        } else if is_file {
            out.push(Entry { path: child, is_dir: false });
        }
    }
}

pub fn list_vault(root: &str) -> Result<Vec<Entry>, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    walk(Path::new(root), "", &mut all);
    Ok(all
        .into_iter()
        .filter(|e| {
            e.path != ATTACHMENTS
                && !e.path.starts_with(&format!("{ATTACHMENTS}/"))
                && (e.is_dir || ext_lower(&e.path) == "note")
        })
        .collect())
}

pub fn read_all_notes(root: &str) -> Result<Vec<NoteFile>, String> {
    let mut all = Vec::new();
    walk(Path::new(root), "", &mut all);
    let mut out = Vec::new();
    for e in all.iter().filter(|e| !e.is_dir && ext_lower(&e.path) == "note") {
        let full = Path::new(root).join(e.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Ok(contents) = fs::read_to_string(&full) {
            out.push(NoteFile { path: e.path.clone(), contents });
        }
    }
    Ok(out)
}

pub fn write_note(root: &str, rel: &str, contents: &str) -> Result<(), String> {
    let target = safe_join(root, rel)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write to a temp file first so a crash mid-write never truncates a note.
    let tmp = target.with_extension("note.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create_dir(root: &str, rel: &str) -> Result<(), String> {
    fs::create_dir_all(safe_join(root, rel)?).map_err(|e| e.to_string())
}

pub fn rename_entry(root: &str, from: &str, to: &str) -> Result<(), String> {
    let src = safe_join(root, from)?;
    let dst = safe_join(root, to)?;
    // Allow case-only renames on case-insensitive filesystems.
    if dst.exists() && from.to_lowercase() != to.to_lowercase() {
        return Err("Something with that name already exists".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

pub fn delete_entries(root: &str, rels: &[String]) -> Result<(), String> {
    for rel in rels {
        let target = safe_join(root, rel)?;
        if target.exists() {
            trash::delete(&target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Read every markdown file (and list image files) in an Obsidian vault. Read-only.
pub fn scan_markdown(root: &str) -> Result<MarkdownScan, String> {
    if !Path::new(root).is_dir() {
        return Err("Folder not found".into());
    }
    let mut all = Vec::new();
    walk(Path::new(root), "", &mut all);
    let mut scan = MarkdownScan::default();
    for e in all.iter().filter(|e| !e.is_dir) {
        let el = ext_lower(&e.path);
        let full = Path::new(root).join(e.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if el == "md" {
            if let Ok(contents) = fs::read_to_string(&full) {
                scan.notes.push(NoteFile { path: e.path.clone(), contents });
            }
        } else if IMAGE_EXTS.contains(&el.as_str()) {
            scan.assets.push(e.path.clone());
        }
    }
    Ok(scan)
}

pub fn copy_asset(src_root: &str, src_rel: &str, dst_root: &str, dst_rel: &str) -> Result<(), String> {
    let dst = safe_join(dst_root, dst_rel)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(safe_join(src_root, src_rel)?, &dst).map_err(|e| e.to_string())?;
    Ok(())
}
