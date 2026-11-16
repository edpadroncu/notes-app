import { generateJSON } from '@tiptap/core'
import MarkdownIt from 'markdown-it'
import { api, basename, join } from './api'
import type { NoteData } from './api'
import { extensions } from './extensions'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i
const ATTACH = '_attachments'

export type ImportResult = { notes: number; images: number; failed: string[] }

/** Rewrite Obsidian-only syntax into plain markdown (applied outside code blocks only). */
function obsidianToMarkdown(text: string): string {
  return (
    text
      .replace(/%%[\s\S]*?%%/g, '')
      // ![[image.png|300]] -> image, ![[Other note]] -> link to that note
      .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, target: string) => {
        const name = basename(target.trim().replace(/\\/g, '/'))
        return IMAGE_RE.test(name)
          ? `![](${encodeURIComponent(name)})`
          : `[${name}](note://${encodeURIComponent(name.split('#')[0])})`
      })
      // [[Note#Heading|Alias]] -> link
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
        const note = basename(target.trim().replace(/\\/g, '/')).split('#')[0]
        const label = (alias ?? target).trim()
        return note ? `[${label}](note://${encodeURIComponent(note)})` : label
      })
      .replace(/==([^=\n]+)==/g, '$1')
      // > [!note] Title  ->  > **Title**
      .replace(
        /^(\s*>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/gm,
        (_m, pre: string, type: string, title: string) =>
          `${pre}**${title || type[0].toUpperCase() + type.slice(1)}**`,
      )
  )
}

function preprocess(source: string): string {
  const body = source.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '')
  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : obsidianToMarkdown(part)))
    .join('')
}

/** Turn `- [ ] item` list items into checklists. */
function convertTaskLists(root: HTMLElement) {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const first = document.createTreeWalker(li, NodeFilter.SHOW_TEXT).nextNode()
    const m = first?.nodeValue?.match(/^\s*\[( |x|X)\]\s+/)
    if (!first || !m) continue
    first.nodeValue = first.nodeValue!.slice(m[0].length)
    li.setAttribute('data-type', 'taskItem')
    li.setAttribute('data-checked', m[1] === ' ' ? 'false' : 'true')
  }
  for (const ul of Array.from(root.querySelectorAll('ul'))) {
    const items = Array.from(ul.children)
    if (!items.some((li) => li.getAttribute('data-type') === 'taskItem')) continue
    ul.setAttribute('data-type', 'taskList')
    for (const li of items) {
      if (!li.hasAttribute('data-type')) {
        li.setAttribute('data-type', 'taskItem')
        li.setAttribute('data-checked', 'false')
      }
    }
  }
}

/**
 * Convert every markdown note in an Obsidian vault into `.note` files under
 * `destFolder` of our vault. The source vault is only read, never modified.
 */
export async function importVault(
  srcRoot: string,
  vaultRoot: string,
  destFolder: string,
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const scan = await api.scanMarkdown(srcRoot)
  // Obsidian resolves attachments by file name, wherever they live in the vault.
  const assetsByName = new Map(scan.assets.map((p) => [basename(p).toLowerCase(), p]))
  const usedAssets = new Map<string, string>()
  const result: ImportResult = { notes: 0, images: 0, failed: [] }

  for (const [i, file] of scan.notes.entries()) {
    try {
      const html = md.render(preprocess(file.contents))
      const dom = new DOMParser().parseFromString(html, 'text/html').body
      convertTaskLists(dom)

      for (const img of Array.from(dom.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? ''
        if (/^(https?:|data:)/i.test(src)) continue
        let name = src
        try {
          name = decodeURIComponent(src)
        } catch {
          /* keep raw */
        }
        name = basename(name.replace(/\\/g, '/'))
        const found = assetsByName.get(name.toLowerCase())
        if (!found) {
          img.replaceWith(document.createTextNode(`[missing image: ${name}]`))
          continue
        }
        usedAssets.set(found, join(ATTACH, basename(found)))
        img.setAttribute('src', join(ATTACH, basename(found)))
      }

      const now = Date.now()
      const note: NoteData = {
        v: 1,
        doc: generateJSON(dom.innerHTML, extensions),
        created: now,
        updated: now,
      }
      const rel = join(destFolder, file.path.replace(/\.md$/i, '.note'))
      await api.writeNote(vaultRoot, rel, JSON.stringify(note))
      result.notes++
    } catch (e) {
      result.failed.push(`${file.path}: ${e}`)
    }
    onProgress(i + 1, scan.notes.length)
  }

  for (const [src, dst] of usedAssets) {
    try {
      await api.copyAsset(srcRoot, src, vaultRoot, dst)
      result.images++
    } catch (e) {
      result.failed.push(`${src}: ${e}`)
    }
  }
  return result
}
