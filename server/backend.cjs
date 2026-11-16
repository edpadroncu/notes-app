// File-system backend for the notes app. Pure Node: no Electron imports, so it can be tested alone.
const fs = require('node:fs/promises')
const path = require('node:path')

const ATTACHMENTS = '_attachments'
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

/** Join a vault-relative path onto the root, refusing anything that could escape it. */
function safeJoin(root, rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean)
  if (path.isAbsolute(String(rel)) || parts.some((p) => p === '..' || p === '.' || p.includes(':'))) {
    throw new Error(`Invalid path: ${rel}`)
  }
  return path.join(root, ...parts)
}

/** Every visible file and folder under root, as forward-slash relative paths, parents first. */
async function walk(root, rel = '', out = []) {
  let entries
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push({ path: child, is_dir: true })
      await walk(root, child, out)
    } else if (e.isFile()) {
      out.push({ path: child, is_dir: false })
    }
  }
  return out
}

const ext = (p) => path.extname(p).toLowerCase()
const exists = (p) => fs.access(p).then(() => true, () => false)

const commands = {
  async list_vault({ root }) {
    await fs.mkdir(root, { recursive: true })
    return (await walk(root)).filter(
      (e) =>
        e.path !== ATTACHMENTS &&
        !e.path.startsWith(ATTACHMENTS + '/') &&
        (e.is_dir || ext(e.path) === '.note'),
    )
  },

  async read_all_notes({ root }) {
    const files = (await walk(root)).filter((e) => !e.is_dir && ext(e.path) === '.note')
    const out = []
    for (const f of files) {
      try {
        out.push({ path: f.path, contents: await fs.readFile(path.join(root, f.path), 'utf8') })
      } catch {
        /* unreadable: skip */
      }
    }
    return out
  },

  async write_note({ root, rel, contents }) {
    const target = safeJoin(root, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Write to a temp file first so a crash mid-write never truncates a note.
    const tmp = target + '.tmp'
    await fs.writeFile(tmp, contents, 'utf8')
    await fs.rename(tmp, target)
  },

  async create_dir({ root, rel }) {
    await fs.mkdir(safeJoin(root, rel), { recursive: true })
  },

  async rename_entry({ root, from, to }) {
    const src = safeJoin(root, from)
    const dst = safeJoin(root, to)
    // Allow case-only renames on case-insensitive filesystems.
    if ((await exists(dst)) && from.toLowerCase() !== to.toLowerCase()) {
      throw new Error('Something with that name already exists')
    }
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.rename(src, dst)
  },

  /** Read every markdown file (and list image files) in an Obsidian vault. Read-only. */
  async scan_markdown({ root }) {
    if (!(await fs.stat(root).then((s) => s.isDirectory(), () => false))) {
      throw new Error('Folder not found')
    }
    const scan = { notes: [], assets: [] }
    for (const e of await walk(root)) {
      if (e.is_dir) continue
      if (ext(e.path) === '.md') {
        try {
          scan.notes.push({ path: e.path, contents: await fs.readFile(path.join(root, e.path), 'utf8') })
        } catch {
          /* unreadable: skip */
        }
      } else if (IMAGE_EXTS.has(ext(e.path))) {
        scan.assets.push(e.path)
      }
    }
    return scan
  },

  async copy_asset({ srcRoot, srcRel, dstRoot, dstRel }) {
    const dst = safeJoin(dstRoot, dstRel)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(safeJoin(srcRoot, srcRel), dst)
  },
}

module.exports = { commands, safeJoin }
