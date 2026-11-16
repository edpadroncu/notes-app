import type { Editor as TEditor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { extensions } from './extensions'

export type Jump = { term: string; n: number }

type Props = {
  doc: JSONContent
  jump: Jump | null
  /** Rendered above the text, inside the scroll area (the note title). */
  header: ReactNode
  onChange: (doc: JSONContent) => void
  onOpenLink: (href: string) => void
  askLink: (current: string) => Promise<string | null>
}

/** Select and scroll to the first occurrence of `term` in the document. */
function jumpTo(editor: TEditor, term: string) {
  const needle = term.toLowerCase()
  let range: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText) return !range
    const at = (node.text ?? '').toLowerCase().indexOf(needle)
    if (at >= 0) range = { from: pos + at, to: pos + at + needle.length }
    return false
  })
  if (range) editor.chain().focus().setTextSelection(range).scrollIntoView().run()
}

function Btn(p: { on?: boolean; title: string; run: () => void; children: ReactNode }) {
  return (
    <button
      className={'tb' + (p.on ? ' on' : '')}
      title={p.title}
      // Keep the text selection while clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={p.run}
    >
      {p.children}
    </button>
  )
}

export default function Editor({ doc, jump, header, onChange, onOpenLink, askLink }: Props) {
  const editor = useEditor({
    extensions,
    content: doc,
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true' },
      handleClick: (_view, _pos, event) => {
        const link = (event.target as HTMLElement).closest('a')
        const href = link?.getAttribute('href')
        if (!href || !(event.ctrlKey || event.metaKey)) return false
        onOpenLink(href)
        return true
      },
    },
  })

  useEffect(() => {
    if (editor && jump?.term) jumpTo(editor, jump.term)
  }, [editor, jump?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!editor) return null
  const c = () => editor.chain().focus()
  const is = (name: string, attrs?: Record<string, unknown>) => editor.isActive(name, attrs)

  const editLink = async () => {
    const url = await askLink(editor.getAttributes('link').href ?? '')
    if (url === null) return
    if (!url.trim()) c().extendMarkRange('link').unsetLink().run()
    else {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url.trim() : `https://${url.trim()}`
      c().extendMarkRange('link').setLink({ href }).run()
    }
  }

  return (
    <>
      <div className="toolbar">
        <Btn title="Bold (Ctrl+B)  *text*" on={is('bold')} run={() => c().toggleBold().run()}>
          <b>B</b>
        </Btn>
        <Btn title="Italic (Ctrl+I)  _text_" on={is('italic')} run={() => c().toggleItalic().run()}>
          <i>I</i>
        </Btn>
        <Btn title="Underline (Ctrl+U)" on={is('underline')} run={() => c().toggleUnderline().run()}>
          <u>U</u>
        </Btn>
        <Btn
          title="Strikethrough (Ctrl+Shift+X)  ~text~"
          on={is('strike')}
          run={() => c().toggleStrike().run()}
        >
          <s>S</s>
        </Btn>
        <span className="sep" />
        <Btn title="Link" on={is('link')} run={editLink}>
          🔗
        </Btn>
        <Btn title="Inline code (Ctrl+E)  `text`" on={is('code')} run={() => c().toggleCode().run()}>
          {'</>'}
        </Btn>
        <Btn title="Code block  ```" on={is('codeBlock')} run={() => c().toggleCodeBlock().run()}>
          {'{ }'}
        </Btn>
        <span className="sep" />
        <Btn title="Numbered list  1." on={is('orderedList')} run={() => c().toggleOrderedList().run()}>
          1.
        </Btn>
        <Btn title="Bulleted list  -" on={is('bulletList')} run={() => c().toggleBulletList().run()}>
          •
        </Btn>
        <Btn title="Checklist" on={is('taskList')} run={() => c().toggleTaskList().run()}>
          ☑
        </Btn>
        <Btn title="Quote  >" on={is('blockquote')} run={() => c().toggleBlockquote().run()}>
          ❝
        </Btn>
        <span className="sep" />
        {([1, 2, 3] as const).map((level) => (
          <Btn
            key={level}
            title={`Heading ${level}`}
            on={is('heading', { level })}
            run={() => c().toggleHeading({ level }).run()}
          >
            H{level}
          </Btn>
        ))}
      </div>
      <div className="editor-scroll" onClick={(e) => e.target === e.currentTarget && c().run()}>
        {header}
        <EditorContent editor={editor} />
      </div>
    </>
  )
}
