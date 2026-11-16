import { markInputRule } from '@tiptap/core'
import { fileUrl } from './api'
import Bold from '@tiptap/extension-bold'
import Image from '@tiptap/extension-image'
import Italic from '@tiptap/extension-italic'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Placeholder from '@tiptap/extension-placeholder'
import Strike from '@tiptap/extension-strike'
import { TableKit } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'

let vaultRoot = ''
export const setVaultRoot = (root: string) => {
  vaultRoot = root
}

/** Images are stored vault-relative; resolve them to a URL the webview can load. */
const resolveSrc = (src: string) =>
  !src || /^(https?:|data:|blob:|file:)/i.test(src) ? src : fileUrl(`${vaultRoot}/${src}`)

// Slack-style typing: the markers vanish as soon as the closing one is typed.
//   *bold*   _italic_   ~strike~   `code`
// The opening marker must start a word, so `snake_case` and `2 * 3` are left alone.
const slackRule = (ch: string) =>
  new RegExp(`(?:^|\\s)(${ch}([^${ch}\\s](?:[^${ch}]*[^${ch}\\s])?)${ch})$`)

const SlackBold = Bold.extend({
  addInputRules() {
    return [markInputRule({ find: slackRule('\\*'), type: this.type })]
  },
  addPasteRules() {
    return []
  },
})

const SlackItalic = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: slackRule('_'), type: this.type })]
  },
  addPasteRules() {
    return []
  },
})

const SlackStrike = Strike.extend({
  addInputRules() {
    return [markInputRule({ find: slackRule('~'), type: this.type })]
  },
  addPasteRules() {
    return []
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-s': () => this.editor.commands.toggleStrike(),
    }
  },
})

const VaultImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-src') || el.getAttribute('src'),
        renderHTML: (attrs: { src?: string }) => ({
          src: resolveSrc(attrs.src ?? ''),
          'data-src': attrs.src,
        }),
      },
    }
  },
})

export const extensions = [
  StarterKit.configure({
    bold: false,
    italic: false,
    strike: false,
    link: {
      openOnClick: false,
      autolink: true,
      protocols: ['note'],
      HTMLAttributes: { title: 'Ctrl+click to open' },
    },
  }),
  SlackBold,
  SlackItalic,
  SlackStrike,
  VaultImage,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Placeholder.configure({ placeholder: 'Start writing…' }),
]
