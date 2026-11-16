import type { JSONContent } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent, ReactNode } from 'react'
import { EMPTY_DOC, api, basename, cleanName, dirname, join, titleOf } from './api'
import type { Entry, NoteData } from './api'
import './App.css'
import Editor from './Editor'
import type { Jump } from './Editor'
import { setVaultRoot } from './extensions'
import { importVault } from './importer'
import { clearIndex, docText, search, upsert } from './search'
import type { Hit } from './search'

type TNode = { name: string; path: string; is_dir: boolean; children: TNode[] }
type Ask = {
  title: string
  value?: string
  confirm?: boolean
  okLabel?: string
  resolve: (v: string | null) => void
}
type Menu = { x: number; y: number; node: TNode | null }

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
}

function buildTree(entries: Entry[]): TNode[] {
  const root: TNode = { name: '', path: '', is_dir: true, children: [] }
  const byPath = new Map<string, TNode>([['', root]])
  for (const e of entries) {
    const node: TNode = { name: basename(e.path), path: e.path, is_dir: e.is_dir, children: [] }
    byPath.set(e.path, node)
    byPath.get(dirname(e.path))?.children.push(node)
  }
  const sort = (n: TNode) => {
    n.children.sort(
      (a, b) =>
        Number(b.is_dir) - Number(a.is_dir) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    )
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const I = {
  note: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 12v6M9 15h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5',
  import: 'M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5M3 12h11M10 8l4 4-4 4',
  theme: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  vault: 'M4 6h16M4 12h16M4 18h10',
  folderItem: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  fileItem: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v4h1',
}

// A small info icon that reveals an explanation on hover or keyboard focus.
function InfoTip({ children }: { children: ReactNode }) {
  return (
    <span className="info" tabIndex={0} aria-label="More information">
      <Icon d={I.info} />
      <span className="info-pop" role="tooltip">
        {children}
      </span>
    </span>
  )
}

export default function App() {
  const [vault, setVault] = useState<string | null>(() => store.get('vault'))
  const [entries, setEntries] = useState<Entry[]>([])
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [jump, setJump] = useState<Jump | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [indexVersion, setIndexVersion] = useState(0)
  const [switcher, setSwitcher] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState('')
  const [dark, setDark] = useState(() => {
    const saved = store.get('theme')
    return saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  })
  // Drag-and-drop to move notes/folders. dropTarget is the destination folder
  // being hovered ('' = vault root, null = none).
  const [drag, setDrag] = useState<{ path: string; isDir: boolean } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // True while a native folder dialog is open, to stop a second one from opening.
  const [picking, setPicking] = useState(false)
  const [defaultPath, setDefaultPath] = useState('')
  // Sidebar selection for multi-delete (Ctrl toggles, Shift selects a range).
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [selAnchor, setSelAnchor] = useState<string | null>(null)

  const vaultRef = useRef(vault)
  vaultRef.current = vault
  const cache = useRef(new Map<string, NoteData>())
  const pending = useRef(new Map<string, number>())
  const searchRef = useRef<HTMLInputElement>(null)

  const notes = useMemo(() => entries.filter((e) => !e.is_dir), [entries])
  const tree = useMemo(() => buildTree(entries), [entries])
  const hits = useMemo(() => search(query), [query, indexVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rows currently visible in the tree, top-to-bottom, for Shift range-selection.
  const flatVisible = useMemo(() => {
    const out: TNode[] = []
    const walk = (nodes: TNode[]) => {
      for (const n of nodes) {
        out.push(n)
        if (n.is_dir && expanded.has(n.path)) walk(n.children)
      }
    }
    walk(tree)
    return out
  }, [tree, expanded])

  const fail = useCallback((e: unknown) => setToast(String(e)), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    store.set('theme', dark ? 'dark' : 'light')
  }, [dark])

  const prompt = (title: string, value = '', okLabel = 'OK') =>
    new Promise<string | null>((resolve) => setAsk({ title, value, okLabel, resolve }))
  const confirm = (title: string, okLabel: string) =>
    new Promise<boolean>((resolve) =>
      setAsk({ title, confirm: true, okLabel, resolve: (v) => resolve(v !== null) }),
    )

  // ---------- saving ----------
  const saveNow = useCallback(async (path: string) => {
    clearTimeout(pending.current.get(path))
    pending.current.delete(path)
    const note = cache.current.get(path)
    const root = vaultRef.current
    if (!note || !root) return
    note.updated = Date.now()
    try {
      await api.writeNote(root, path, JSON.stringify(note))
      upsert(path, titleOf(path), docText(note.doc))
      setIndexVersion((v) => v + 1)
    } catch (e) {
      setToast(`Could not save "${titleOf(path)}": ${e}`)
    }
  }, [])

  const flush = useCallback(
    () => Promise.all([...pending.current.keys()].map(saveNow)),
    [saveNow],
  )

  const onChange = useCallback(
    (path: string, doc: JSONContent) => {
      const note = cache.current.get(path)
      if (!note) return
      note.doc = doc
      clearTimeout(pending.current.get(path))
      pending.current.set(path, window.setTimeout(() => saveNow(path), 400))
    },
    [saveNow],
  )

  // ---------- loading ----------
  const loadVault = useCallback(
    async (root: string) => {
      setVaultRoot(root)
      try {
        const [list, files] = await Promise.all([api.listVault(root), api.readAllNotes(root)])
        cache.current.clear()
        clearIndex()
        for (const f of files) {
          let note: NoteData
          try {
            note = JSON.parse(f.contents)
            if (!note.doc) throw new Error('no doc')
          } catch {
            continue // unreadable file: leave it alone on disk, just don't show content
          }
          cache.current.set(f.path, note)
          upsert(f.path, titleOf(f.path), docText(note.doc))
        }
        setEntries(list)
        setIndexVersion((v) => v + 1)
        const exists = (p: string) => cache.current.has(p)
        const existsAny = new Set(list.map((e) => e.path))
        setTabs((t) => t.filter(exists))
        setActive((a) => (a && exists(a) ? a : null))
        setSelection((s) => new Set([...s].filter((p) => existsAny.has(p))))
      } catch (e) {
        fail(e)
      }
    },
    [fail],
  )

  useEffect(() => {
    if (!vault) return
    setBusy('Opening…')
    void loadVault(vault).finally(() => setBusy(''))
  }, [vault, loadVault])

  useEffect(() => {
    // Heartbeat: lets the local server shut down once this window is gone.
    const ping = () => void fetch('/api/ping', { method: 'POST' }).catch(() => {})
    ping()
    const id = setInterval(ping, 3000)
    const onHide = () => {
      void flush()
      navigator.sendBeacon?.('/api/bye')
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(id)
      window.removeEventListener('pagehide', onHide)
    }
  }, [flush])

  const chooseVault = async (useDefault: boolean) => {
    if (picking) return // a folder dialog is already open
    setPicking(true)
    try {
      const dir = useDefault
        ? await api.defaultVault()
        : await api.pickFolder('Choose a folder for your notes')
      if (typeof dir !== 'string') return
      await flush()
      setTabs([])
      setActive(null)
      store.set('vault', dir)
      setVault(dir)
    } catch (e) {
      fail(e)
    } finally {
      setPicking(false)
    }
  }

  // ---------- note actions ----------
  const openNote = useCallback((path: string, term?: string) => {
    if (!cache.current.has(path)) return
    setTabs((t) => (t.includes(path) ? t : [...t, path]))
    setActive(path)
    setJump(term ? { term, n: Date.now() } : null)
    // Reveal it in the tree.
    setExpanded((s) => {
      const next = new Set(s)
      for (let d = dirname(path); d; d = dirname(d)) next.add(d)
      return next
    })
  }, [])

  const closeTab = (path: string) => {
    const i = tabs.indexOf(path)
    const next = tabs.filter((t) => t !== path)
    setTabs(next)
    if (active === path) setActive(next[Math.min(i, next.length - 1)] ?? null)
  }

  const uniquePath = (folder: string, name: string, ext: string) => {
    const taken = new Set(entries.map((e) => e.path.toLowerCase()))
    for (let n = 0; ; n++) {
      const p = join(folder, `${name}${n ? ` ${n + 1}` : ''}${ext}`)
      if (!taken.has(p.toLowerCase())) return p
    }
  }

  const newNote = async (folder = '') => {
    if (!vault) return
    const path = uniquePath(folder, 'Untitled', '.note')
    const now = Date.now()
    const note: NoteData = { v: 1, doc: EMPTY_DOC, created: now, updated: now }
    try {
      await api.writeNote(vault, path, JSON.stringify(note))
      cache.current.set(path, note)
      upsert(path, titleOf(path), '')
      setEntries(await api.listVault(vault))
      openNote(path)
    } catch (e) {
      fail(e)
    }
  }

  const newFolder = async (parent = '') => {
    if (!vault) return
    const name = cleanName((await prompt('New folder name', '', 'Create')) ?? '')
    if (!name) return
    try {
      await api.createDir(vault, join(parent, name))
      setEntries(await api.listVault(vault))
      setExpanded((s) => new Set(s).add(parent).add(join(parent, name)))
    } catch (e) {
      fail(e)
    }
  }

  const moveTo = (from: string, to: string, busyLabel = 'Moving…') => moveMany([from], to, busyLabel)

  // Move one or more items into destFolder. Skips items that can't go there (already
  // in it, or a folder into itself), and keeps open tabs/selection pointing at the moved files.
  const moveMany = async (paths: string[], destFolder: string, busyLabel?: string) => {
    if (!vault) return
    const items = topLevelOnly([...new Set(paths)].filter(Boolean)).filter((p) =>
      canDrop({ path: p, isDir: !cache.current.has(p) }, destFolder),
    )
    if (!items.length) return
    const moves = items.map((from) => [from, join(destFolder, basename(from))] as const)
    setBusy(busyLabel ?? (moves.length === 1 ? 'Moving…' : `Moving ${moves.length} items…`))
    try {
      await flush()
      for (const [from, to] of moves) await api.rename(vault, from, to)
      const remap = (p: string) => {
        for (const [from, to] of moves) {
          if (p === from) return to
          if (p.startsWith(from + '/')) return to + p.slice(from.length)
        }
        return p
      }
      await loadVault(vault)
      setTabs(() => tabs.map(remap).filter((p) => cache.current.has(p)))
      setActive(active ? remap(active) : null)
      setExpanded((s) => new Set([...s].map(remap)))
      setSelection(new Set(items.map((from) => join(destFolder, basename(from)))))
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }

  const renameNode = async (node: TNode) => {
    const current = node.is_dir ? node.name : titleOf(node.path)
    const name = cleanName((await prompt('Rename', current, 'Rename')) ?? '')
    if (name && name !== current)
      await moveTo(node.path, join(dirname(node.path), name + (node.is_dir ? '' : '.note')), 'Renaming…')
  }

  const toggleExpand = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (!n.delete(p)) n.add(p)
      return n
    })

  // Drop paths that are already inside another path in the list (a folder covers its notes).
  const topLevelOnly = (paths: string[]) =>
    paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + '/')))

  const describe = (p: string) =>
    cache.current.has(p) ? `"${titleOf(p)}"` : `folder "${basename(p)}" and everything in it`

  const deletePaths = async (paths: string[]) => {
    if (!vault) return
    const targets = topLevelOnly([...new Set(paths)].filter(Boolean))
    if (!targets.length) return
    const label = targets.length === 1 ? describe(targets[0]) : `${targets.length} items`
    if (!(await confirm(`Move ${label} to the Recycle Bin?`, 'Delete'))) return
    setBusy(targets.length === 1 ? `Deleting ${label}…` : `Deleting ${targets.length} items…`)
    try {
      await flush()
      await api.removeMany(vault, targets) // one call recycles them all
      await loadVault(vault)
      setSelection(new Set())
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }

  const deleteNode = (node: TNode) =>
    deletePaths(selection.has(node.path) && selection.size > 1 ? [...selection] : [node.path])

  // Click in the tree: Ctrl toggles one row, Shift selects a range, a plain click
  // selects just that row and opens the note (or toggles the folder).
  const onRowClick = (node: TNode, e: RMouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelection((s) => {
        const n = new Set(s)
        if (!n.delete(node.path)) n.add(node.path)
        return n
      })
      setSelAnchor(node.path)
      return
    }
    if (e.shiftKey && selAnchor) {
      const paths = flatVisible.map((n) => n.path)
      const a = paths.indexOf(selAnchor)
      const b = paths.indexOf(node.path)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        setSelection(new Set(paths.slice(lo, hi + 1)))
      }
      return
    }
    setSelection(new Set([node.path]))
    setSelAnchor(node.path)
    if (node.is_dir) toggleExpand(node.path)
    else openNote(node.path)
  }

  const openLink = useCallback(
    (href: string) => {
      if (!href.startsWith('note://')) {
        api.openUrl(href).catch(fail)
        return
      }
      let title = href.slice(7)
      try {
        title = decodeURIComponent(title)
      } catch {
        /* keep raw */
      }
      const wanted = title.replace(/\.(md|note)$/i, '').toLowerCase()
      const target = [...cache.current.keys()].find((p) => titleOf(p).toLowerCase() === wanted)
      if (target) openNote(target)
      else setToast(`No note named "${title}"`)
    },
    [fail, openNote],
  )

  const runImport = async (destParent = '') => {
    if (!vault || picking) return
    setPicking(true)
    let src: string | null
    try {
      src = await api.pickFolder('Choose your Obsidian vault folder')
    } finally {
      setPicking(false)
    }
    try {
      if (typeof src !== 'string') return
      await flush()
      // Importing into a chosen folder drops the notes straight into it; importing
      // with no folder (toolbar / root) creates a new folder named after the vault.
      const srcName = cleanName(basename(src.replace(/\\/g, '/').replace(/\/$/, ''))) || 'Imported'
      const dest = destParent || uniquePath('', srcName, '')
      setBusy('Reading vault…')
      const res = await importVault(src, vault, dest, (done, total) =>
        setBusy(`Importing notes… ${done} / ${total}`),
      )
      await loadVault(vault)
      setExpanded((s) => new Set(s).add(dest))
      setToast(
        `Imported ${res.notes} notes and ${res.images} images into "${dest || 'the vault root'}"` +
          (res.failed.length ? ` — ${res.failed.length} failed: ${res.failed[0]}` : ''),
      )
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return // a blocking operation is running
      // Don't hijack keys while typing in the editor, a text field, or a dialog.
      const el = document.activeElement as HTMLElement | null
      const typing = !!el?.closest('input, textarea, [contenteditable="true"], .ProseMirror')
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        const targets = selection.size ? [...selection] : active ? [active] : []
        if (targets.length) {
          e.preventDefault()
          void deletePaths(targets)
        }
        return
      }
      if (!typing && e.key === 'Escape' && selection.size) {
        setSelection(new Set())
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'p' || k === 'o') {
        e.preventDefault()
        setSwitcher(true)
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (k === 'n') {
        e.preventDefault()
        void newNote(active ? dirname(active) : '')
      } else if (k === 'w' && active) {
        e.preventDefault()
        closeTab(active)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // On the welcome screen, show where "Use Documents / Notes" will put things.
  useEffect(() => {
    if (vault) return
    api.suggestedVault().then(setDefaultPath).catch(() => {})
  }, [vault])

  // ---------- render ----------
  if (!vault) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="logo">≡</div>
          <h1>Notes</h1>
          <p>Choose where your notes live. They are plain files in a folder you control.</p>

          <div className="welcome-row">
            <button className="primary" disabled={picking} onClick={() => chooseVault(true)}>
              Use Documents / Notes
            </button>
            <InfoTip>
              Creates a <b>Notes</b> folder inside your Documents and uses it — the simplest choice.
              {defaultPath && (
                <>
                  <br />
                  <code>{defaultPath}</code>
                </>
              )}
            </InfoTip>
          </div>

          <div className="welcome-row">
            <button disabled={picking} onClick={() => chooseVault(false)}>
              {picking ? 'Opening chooser…' : 'Choose another folder…'}
            </button>
            <InfoTip>
              Pick any existing folder instead — for example a synced OneDrive or Dropbox folder, a
              different drive, or a folder of notes you already have.
            </InfoTip>
          </div>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    )
  }

  // Which folder a drop onto `node` targets: a folder itself, else the note's parent.
  const dropFolderOf = (node: TNode) => (node.is_dir ? node.path : dirname(node.path))

  const canDrop = (src: { path: string; isDir: boolean } | null, destFolder: string) => {
    if (!src) return false
    if (destFolder === dirname(src.path)) return false // already there
    if (src.isDir && (destFolder === src.path || destFolder.startsWith(src.path + '/'))) return false // into itself
    return true
  }

  const dropInto = async (destFolder: string) => {
    const src = drag
    setDrag(null)
    setDropTarget(null)
    if (!src) return
    // Dragging one of the selected rows moves the whole selection; otherwise just that row.
    const paths = selection.has(src.path) && selection.size > 1 ? [...selection] : [src.path]
    if (destFolder) setExpanded((s) => new Set(s).add(destFolder))
    await moveMany(paths, destFolder)
  }

  // While dragging a selected row, the whole selection moves together.
  const draggingMany = !!drag && selection.has(drag.path) && selection.size > 1

  const renderNode = (node: TNode, depth: number) => {
    const open = expanded.has(node.path)
    const folder = dropFolderOf(node)
    const isDropTarget = !!drag && dropTarget === folder && canDrop(drag, folder)
    const isDragging = draggingMany ? selection.has(node.path) : drag?.path === node.path
    const onContext = (e: RMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Right-clicking a row that isn't in the selection makes it the selection.
      if (!selection.has(node.path)) {
        setSelection(new Set([node.path]))
        setSelAnchor(node.path)
      }
      setMenu({ x: e.clientX, y: e.clientY, node })
    }
    return (
      <div key={node.path}>
        <div
          className={
            'row' +
            (node.path === active ? ' active' : '') +
            (selection.has(node.path) ? ' selected' : '') +
            (isDragging ? ' dragging' : '') +
            (isDropTarget ? ' drop-into' : '')
          }
          style={{ paddingLeft: 10 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            // Dragging a row that isn't selected makes it the sole selection first.
            if (!selection.has(node.path)) {
              setSelection(new Set([node.path]))
              setSelAnchor(node.path)
            }
            setDrag({ path: node.path, isDir: node.is_dir })
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.path)
          }}
          onDragEnd={() => {
            setDrag(null)
            setDropTarget(null)
          }}
          onDragOver={(e) => {
            if (!canDrop(drag, folder)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget(folder)
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void dropInto(folder)
          }}
          onContextMenu={onContext}
          onClick={(e) => onRowClick(node, e)}
        >
          {node.is_dir ? (
            <span className={'chev' + (open ? ' open' : '')}>
              <Icon d={I.chevron} />
            </span>
          ) : (
            <span className="chev" />
          )}
          <span className="row-icon">
            <Icon d={node.is_dir ? I.folderItem : I.fileItem} />
          </span>
          <span className="row-name">{node.is_dir ? node.name : titleOf(node.path)}</span>
        </div>
        {node.is_dir && open && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const note = active ? cache.current.get(active) : undefined
  const vaultName = basename(vault.replace(/\\/g, '/').replace(/\/$/, ''))

  return (
    <div className="app" onClick={() => menu && setMenu(null)}>
      <aside className="sidebar">
        <div className="side-head">
          <button className="vault" title={`${vault}\nClick to switch folder`} onClick={() => chooseVault(false)}>
            <Icon d={I.vault} />
            <span>{vaultName}</span>
          </button>
          <button className="icon" title="New note (Ctrl+N)" onClick={() => newNote()}>
            <Icon d={I.note} />
          </button>
          <button className="icon" title="New folder" onClick={() => newFolder()}>
            <Icon d={I.folder} />
          </button>
          <button className="icon" title="Import Obsidian vault" onClick={() => runImport()}>
            <Icon d={I.import} />
          </button>
          <button className="icon" title="Light / dark" onClick={() => setDark((d) => !d)}>
            <Icon d={I.theme} />
          </button>
        </div>
        <div className="search-box">
          <Icon d={I.search} />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search all notes  (Ctrl+Shift+F)"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter' && hits[0]) openNote(hits[0].path, hits[0].snippet?.match)
            }}
          />
          {query && (
            <button className="clear" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        {query.trim() ? (
          <div className="side-body">
            <div className="side-label">
              {hits.length} result{hits.length === 1 ? '' : 's'}
            </div>
            {hits.map((h) => (
              <HitRow key={h.path} hit={h} onOpen={() => openNote(h.path, h.snippet?.match)} />
            ))}
          </div>
        ) : (
          <div
            className={'side-body' + (drag && dropTarget === '' && canDrop(drag, '') ? ' drop-root' : '')}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, node: null })
            }}
            onDragOver={(e) => {
              // Drops on the empty area (not on a row) move the item to the vault root.
              if (!canDrop(drag, '')) return
              e.preventDefault()
              setDropTarget('')
            }}
            onDrop={(e) => {
              e.preventDefault()
              void dropInto('')
            }}
          >
            {tree.length ? (
              tree.map((n) => renderNode(n, 0))
            ) : (
              <div className="empty-side">
                No notes yet.
                <button onClick={() => newNote()}>Create a note</button>
                <button onClick={() => runImport()}>Import from Obsidian</button>
              </div>
            )}
          </div>
        )}
        <div className="side-foot">
          {notes.length} note{notes.length === 1 ? '' : 's'}
          <button className="linkish" onClick={() => setSwitcher(true)}>
            Quick open · Ctrl+P
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t}
              className={'tab' + (t === active ? ' active' : '')}
              onClick={() => {
                setActive(t)
                setJump(null)
              }}
              onAuxClick={(e) => e.button === 1 && closeTab(t)}
            >
              <span>{titleOf(t)}</span>
              <button
                title="Close (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {active && note ? (
          <Editor
            key={active}
            doc={note.doc}
            jump={jump}
            onChange={(doc) => onChange(active, doc)}
            onOpenLink={openLink}
            askLink={(current) => prompt('Link address (leave empty to remove)', current, 'Save')}
            header={
              <input
                key={active}
                className="title"
                defaultValue={titleOf(active)}
                spellCheck={false}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) => {
                  const name = cleanName(e.target.value)
                  if (!name) e.target.value = titleOf(active)
                  else if (name !== titleOf(active))
                    void moveTo(active, join(dirname(active), name + '.note'))
                }}
              />
            }
          />
        ) : (
          <div className="blank">
            <div className="logo">≡</div>
            <p>Open a note from the left, or</p>
            <button className="primary" onClick={() => newNote()}>
              New note <kbd>Ctrl+N</kbd>
            </button>
            <button onClick={() => setSwitcher(true)}>
              Quick open <kbd>Ctrl+P</kbd>
            </button>
          </div>
        )}
      </main>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }}>
          {(() => {
            const node = menu.node
            const folder = node ? (node.is_dir ? node.path : dirname(node.path)) : ''
            return (
              <>
                <button onClick={() => newNote(folder)}>New note</button>
                <button onClick={() => newFolder(folder)}>New folder</button>
                <button onClick={() => runImport(folder)}>
                  {folder ? `Import Obsidian vault into “${basename(folder)}”` : 'Import Obsidian vault here'}
                </button>
                {node && !(selection.has(node.path) && selection.size > 1) && (
                  <button onClick={() => renameNode(node)}>Rename</button>
                )}
                {node && (
                  <button className="danger" onClick={() => deleteNode(node)}>
                    {selection.has(node.path) && selection.size > 1
                      ? `Delete ${selection.size} items`
                      : 'Delete'}
                  </button>
                )}
              </>
            )
          })()}
        </div>
      )}

      {switcher && (
        <Switcher
          paths={notes.map((n) => n.path)}
          recent={tabs}
          onClose={() => setSwitcher(false)}
          onOpen={(path, term) => {
            setSwitcher(false)
            openNote(path, term)
          }}
        />
      )}

      {ask && (
        <AskModal
          ask={ask}
          onDone={(v) => {
            ask.resolve(v)
            setAsk(null)
          }}
        />
      )}
      {busy && (
        <div className="overlay busy-overlay">
          <div className="modal busy">
            <span className="spinner" />
            <span>{busy}</span>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" onClick={() => setToast('')}>
          {toast}
        </div>
      )}
    </div>
  )
}

function HitRow({ hit, onOpen, selected }: { hit: Hit; onOpen: () => void; selected?: boolean }) {
  return (
    <div
      className={'hit' + (selected ? ' selected' : '')}
      onClick={onOpen}
      ref={(el) => {
        if (selected) el?.scrollIntoView({ block: 'nearest' })
      }}
    >
      <div className="hit-title">{hit.title}</div>
      {dirname(hit.path) && <div className="hit-path">{dirname(hit.path)}</div>}
      {hit.snippet && (
        <div className="hit-snippet">
          {hit.snippet.before}
          <mark>{hit.snippet.match}</mark>
          {hit.snippet.after}
        </div>
      )}
    </div>
  )
}

function Switcher(p: {
  paths: string[]
  recent: string[]
  onClose: () => void
  onOpen: (path: string, term?: string) => void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  const results = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    const plain = (path: string): Hit => ({ path, title: titleOf(path), snippet: null })
    if (!needle) {
      const rest = p.paths.filter((x) => !p.recent.includes(x))
      return [...[...p.recent].reverse(), ...rest].slice(0, 50).map(plain)
    }
    // Notes whose name matches come first, then matches inside the text.
    const byName = p.paths
      .filter((x) => titleOf(x).toLowerCase().includes(needle))
      .sort((a, b) => titleOf(a).length - titleOf(b).length)
      .map(plain)
    const seen = new Set(byName.map((h) => h.path))
    return [...byName, ...search(q).filter((h) => !seen.has(h.path))].slice(0, 50)
  }, [q, p.paths, p.recent])

  const onKey = (e: RKeyboardEvent) => {
    if (e.key === 'Escape') p.onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && results[sel]) {
      p.onOpen(results[sel].path, results[sel].snippet?.match)
    }
  }

  return (
    <div className="overlay top" onMouseDown={p.onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Find a note by name or by text inside it…"
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKey}
        />
        <div className="switcher-list">
          {results.map((h, i) => (
            <HitRow
              key={h.path}
              hit={h}
              selected={i === sel}
              onOpen={() => p.onOpen(h.path, h.snippet?.match)}
            />
          ))}
          {!results.length && <div className="none">Nothing found</div>}
        </div>
      </div>
    </div>
  )
}

function AskModal({ ask, onDone }: { ask: Ask; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(ask.value ?? '')
  return (
    <div className="overlay" onMouseDown={() => onDone(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onDone(null)}
        onSubmit={(e) => {
          e.preventDefault()
          onDone(value)
        }}
      >
        <div className="modal-title">{ask.title}</div>
        {!ask.confirm && (
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" autoFocus={ask.confirm}>
            {ask.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
