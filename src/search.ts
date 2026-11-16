import type { JSONContent } from '@tiptap/core'
import MiniSearch from 'minisearch'

type Indexed = { id: string; title: string; text: string }
export type Hit = {
  path: string
  title: string
  /** Text around the first match, split so the match can be highlighted. */
  snippet: { before: string; match: string; after: string } | null
}

const index = new MiniSearch<Indexed>({
  fields: ['title', 'text'],
  storeFields: ['title', 'text'],
  searchOptions: { prefix: true, fuzzy: 0.15, boost: { title: 3 }, combineWith: 'AND' },
})

/** Plain text of a document, one line per block. */
export function docText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const inner = (node.content ?? []).map(docText)
  const isInline = node.content?.some((c) => c.type === 'text' || c.type === 'hardBreak')
  return inner.join(isInline ? '' : '\n')
}

export function upsert(path: string, title: string, text: string) {
  const doc = { id: path, title, text }
  if (index.has(path)) index.replace(doc)
  else index.add(doc)
}

export function clearIndex() {
  index.removeAll()
}

function snippetFor(text: string, needles: string[]): Hit['snippet'] {
  const lower = text.toLowerCase()
  for (const needle of needles) {
    const at = needle ? lower.indexOf(needle.toLowerCase()) : -1
    if (at < 0) continue
    const start = Math.max(0, at - 50)
    const end = Math.min(text.length, at + needle.length + 90)
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    return {
      before: (start > 0 ? '…' : '') + flat(text.slice(start, at)),
      match: text.slice(at, at + needle.length),
      after: flat(text.slice(at + needle.length, end)) + (end < text.length ? '…' : ''),
    }
  }
  return null
}

export function search(query: string, limit = 60): Hit[] {
  const q = query.trim()
  if (!q) return []
  return index
    .search(q)
    .slice(0, limit)
    .map((r) => ({
      path: r.id as string,
      title: r.title as string,
      // Prefer the exact phrase, then whichever indexed terms actually matched.
      snippet: snippetFor(r.text as string, [q, ...r.terms, ...r.queryTerms]),
    }))
}
