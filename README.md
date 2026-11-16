# Notes

A local notes app with Slack-style formatting, Obsidian import, and fast full-text search.
Notes are plain files in a folder you choose — no database, no cloud.

## Running it

Double-click **Notes** on your Desktop (or Start Menu). That's it.

Behind the scenes a small local server (Node) starts and the app opens in its own
Microsoft Edge window. Closing the window stops the server automatically.

To run it from a terminal instead:

```bash
npm run app
```

## Using it

- **New note:** `Ctrl+N`. Rename by editing the title at the top.
- **Formatting (Slack-style, markers disappear):** `*bold*`, `_italic_`, `~strike~`, `` `code` ``.
  Toolbar and the usual shortcuts (`Ctrl+B`, `Ctrl+I`) also work.
- **Search inside notes:** `Ctrl+Shift+F`, or the search box. Click a result to jump to the match.
- **Quick open by name:** `Ctrl+P`.
- **Import an Obsidian vault:** the import button (top of the sidebar). Your original vault is never changed.
- **Folders, rename, delete:** right-click in the sidebar. Delete moves items to the Recycle Bin.

Everything saves automatically.

## If you ever want a real packaged .exe

This machine's security policy (Intune / Attack Surface Reduction) blocks locally built,
unsigned programs, which is why the app runs via Edge instead of a packaged installer.
Ask IT to exclude the project folder from the rule
"Block executable files from running unless they meet a prevalence, age, or trusted list criteria",
and the Tauri desktop build can be finished.

## Project layout

- `src/` — the interface (React + TipTap editor + MiniSearch)
- `server/` — the local server and file backend (Node, no build step)
- `dist/` — the built interface (regenerate with `npm run build`)
