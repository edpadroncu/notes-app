import type { JSONContent } from '@tiptap/core'
import { invoke as tauriInvoke, convertFileSrc } from '@tauri-apps/api/core'

/** True when running inside the Tauri desktop shell (not a plain browser). */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Dual-mode command bridge:
 * - In the Tauri app, calls the Rust command directly over IPC (no server).
 * - In a plain browser (dev/preview), posts to the local Node server over HTTP.
 */
const invoke = async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
  if (isTauri) {
    return tauriInvoke<T>(name, args ?? {})
  }
  const res = await fetch('/api/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args: args ?? {} }),
  })
  const data = (await res.json().catch(() => ({ error: `Request failed (${res.status})` }))) as {
    result?: T
    error?: string
  }
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`)
  return data.result as T
}

/** URL the page can load for an image file on disk. */
export function fileUrl(absPath: string) {
  // Tauri: use the asset protocol so the webview can read the file directly.
  if (isTauri) return convertFileSrc(absPath)
  // Browser: the local server serves it from /vault-file.
  return '/vault-file?p=' + encodeURIComponent(absPath.replace(/\//g, '\\'))
}

export type Entry = { path: string; is_dir: boolean }
export type NoteFile = { path: string; contents: string }
export type MarkdownScan = { notes: NoteFile[]; assets: string[] }

/** On-disk format of a `.note` file. */
export type NoteData = { v: 1; doc: JSONContent; created: number; updated: number }

export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export const api = {
  defaultVault: () => invoke<string>('default_vault'),
  suggestedVault: () => invoke<string>('suggested_vault'),
  pickFolder: (title: string) => invoke<string | null>('pick_folder', { title }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  listVault: (root: string) => invoke<Entry[]>('list_vault', { root }),
  readAllNotes: (root: string) => invoke<NoteFile[]>('read_all_notes', { root }),
  writeNote: (root: string, rel: string, contents: string) =>
    invoke<void>('write_note', { root, rel, contents }),
  createDir: (root: string, rel: string) => invoke<void>('create_dir', { root, rel }),
  rename: (root: string, from: string, to: string) =>
    invoke<void>('rename_entry', { root, from, to }),
  remove: (root: string, rel: string) => invoke<void>('delete_entry', { root, rel }),
  removeMany: (root: string, rels: string[]) => invoke<void>('delete_entries', { root, rels }),
  scanMarkdown: (root: string) => invoke<MarkdownScan>('scan_markdown', { root }),
  copyAsset: (srcRoot: string, srcRel: string, dstRoot: string, dstRel: string) =>
    invoke<void>('copy_asset', { srcRoot, srcRel, dstRoot, dstRel }),
}

// Vault-relative paths always use forward slashes.
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const join = (...parts: string[]) => parts.filter(Boolean).join('/')
export const titleOf = (p: string) => basename(p).replace(/\.note$/, '')
export const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
