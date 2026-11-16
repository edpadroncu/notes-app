// Local app server for the notes app.
// Serves the built interface over http://127.0.0.1 and runs the file backend,
// then opens it in a dedicated Microsoft Edge "app" window (no tabs, no address bar).
// Uses only Node and Edge — nothing that needs compiling — so it runs where
// packaged desktop apps are blocked by security policy.
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')
const { commands, safeJoin } = require('./backend.cjs')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
// A fixed loopback port used as a single-instance lock: whoever binds it owns the window.
const LOCK_PORT = 48271
const WHOAMI = 'notes-app'

const run = (file, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  )

// Tiny loopback HTTP helpers for talking to an already-running instance.
const httpGet = (port, p) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => (req.destroy(), resolve(null)))
  })
const httpPost = (port, p) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', timeout: 1500 },
      (res) => (res.resume(), res.on('end', () => resolve(true))),
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => (req.destroy(), resolve(false)))
    req.end()
  })

// PID of the Edge process that owns our app window, used to bring it to the front.
let appWindowPid = null
function focusWindow() {
  const ps =
    '$w=New-Object -ComObject WScript.Shell;$ok=$false;' +
    'if($env:APP_PID){try{$ok=$w.AppActivate([int]$env:APP_PID)}catch{}}' +
    "if(-not $ok){try{$w.AppActivate('Notes')|Out-Null}catch{}}"
  return run('powershell', ['-NoProfile', '-Command', ps], {
    env: { ...process.env, APP_PID: appWindowPid ? String(appWindowPid) : '' },
  }).catch(() => {})
}

// The app window handle, resolved once shortly after launch so the fast folder
// picker can be parented to it. This PowerShell is cheap (no WinForms) and one-off.
let appHwnd = 0
function resolveAppHwnd(attempt = 0) {
  if (!appWindowPid || appHwnd || attempt > 6) return
  run('powershell', [
    '-NoProfile',
    '-Command',
    '[int](Get-Process -Id $env:APP_PID -ErrorAction SilentlyContinue).MainWindowHandle',
  ], { env: { ...process.env, APP_PID: String(appWindowPid) } })
    .then((out) => {
      const h = parseInt(String(out).trim(), 10)
      if (h) appHwnd = h
      else setTimeout(() => resolveAppHwnd(attempt + 1), 1500)
    })
    .catch(() => setTimeout(() => resolveAppHwnd(attempt + 1), 1500))
}

// Remember the open vault so the image endpoint can refuse paths outside it.
let vaultRoot = null
const underVault = (abs) => {
  if (!vaultRoot) return false
  const rel = path.relative(vaultRoot, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Commands that need the OS (dialogs, recycle bin, external links) rather than plain fs.
const osCommands = {
  async default_vault() {
    const dir = await osCommands.suggested_vault()
    await fsp.mkdir(dir, { recursive: true })
    return dir
  },

  // Same path as default_vault but without creating anything — for display on the welcome screen.
  async suggested_vault() {
    const docs = path.join(os.homedir(), 'Documents')
    const base = fs.existsSync(docs) ? docs : os.homedir()
    return path.join(base, 'Notes')
  },

  async pick_folder({ title }) {
    // Uses the Windows shell's folder browser via a tiny JScript run by cscript.
    // This starts far faster than PowerShell + WinForms. appHwnd (resolved once at
    // startup) parents the dialog to the app window so it opens in front.
    try {
      const out = await run('cscript', [
        '//nologo',
        '//E:jscript',
        path.join(__dirname, 'picker.js'),
        String(appHwnd || 0),
        title || 'Choose a folder',
      ])
      return out.trim() || null
    } catch {
      return null
    }
  },

  async delete_entry({ root, rel }) {
    return osCommands.delete_entries({ root, rels: [rel] })
  },

  // Recycle any number of items in ONE PowerShell call (PowerShell cold-start is slow here,
  // so a per-file call would make deleting many items take seconds each).
  async delete_entries({ root, rels }) {
    const targets = (rels || []).filter(Boolean).map((rel) => safeJoin(root, rel))
    if (!targets.length) return
    const ps =
      'Add-Type -AssemblyName Microsoft.VisualBasic;' +
      '($env:DEL_PATHS -split [char]10) | Where-Object { $_ } | ForEach-Object {' +
      "  if (Test-Path -LiteralPath $_ -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($_,'OnlyErrorDialogs','SendToRecycleBin') }" +
      "  elseif (Test-Path -LiteralPath $_) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_,'OnlyErrorDialogs','SendToRecycleBin') } }"
    await run('powershell', ['-NoProfile', '-Command', ps], {
      env: { ...process.env, DEL_PATHS: targets.join('\n') },
    })
  },

  async open_url({ url }) {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error('Only web and mail links can be opened')
    await run('powershell', ['-NoProfile', '-Command', 'Start-Process $env:OPEN_URL'], {
      env: { ...process.env, OPEN_URL: url },
    })
  },
}

async function dispatch(name, args) {
  if (name === 'list_vault' || name === 'read_all_notes') vaultRoot = args?.root ?? vaultRoot
  const fn = osCommands[name] ?? commands[name]
  if (!fn) throw new Error(`Unknown command: ${name}`)
  return fn(args ?? {})
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 50_000_000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

function sendFile(res, file) {
  const stream = fs.createReadStream(file)
  stream.on('open', () => {
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
    stream.pipe(res)
  })
  stream.on('error', () => {
    res.statusCode = 404
    res.end('Not found')
  })
}

let lastPing = Date.now()

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/whoami') {
      res.end(WHOAMI)
      return
    }
    if (url.pathname === '/focus') {
      res.end('ok')
      void focusWindow()
      return
    }
    if (url.pathname === '/api/ping') {
      lastPing = Date.now()
      res.end('ok')
      return
    }
    if (url.pathname === '/api/bye') {
      res.end('bye')
      setTimeout(() => process.exit(0), 200)
      return
    }
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      lastPing = Date.now()
      const { name, args } = JSON.parse((await readBody(req)) || '{}')
      try {
        const result = await dispatch(name, args)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ result: result ?? null }))
      } catch (e) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }))
      }
      return
    }
    if (url.pathname === '/vault-file') {
      const abs = path.normalize(url.searchParams.get('p') || '')
      if (!underVault(abs)) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }
      sendFile(res, abs)
      return
    }

    // Static interface files from dist/.
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (rel === '' || rel.endsWith('/')) rel = path.join(rel, 'index.html')
    const file = path.join(DIST, rel)
    if (!file.startsWith(DIST)) {
      res.statusCode = 403
      res.end('Forbidden')
      return
    }
    fs.existsSync(file) ? sendFile(res, file) : sendFile(res, path.join(DIST, 'index.html'))
  } catch (e) {
    res.statusCode = 500
    res.end(String(e))
  }
})

function findEdge() {
  const candidates = [
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || null
}

function launch(port) {
  const edge = findEdge()
  const appUrl = `http://127.0.0.1:${port}/`
  if (!edge) {
    console.error('Microsoft Edge was not found; opening in the default browser instead.')
    run('powershell', ['-NoProfile', '-Command', 'Start-Process $env:U'], {
      env: { ...process.env, U: appUrl },
    }).catch(() => {})
    return
  }
  const profile = path.join(os.homedir(), '.notes-app', 'edge-profile')
  const child = spawn(
    edge,
    [
      `--app=${appUrl}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1240,820',
    ],
    { detached: false, stdio: 'ignore' },
  )
  appWindowPid = child.pid
  // Resolve the window handle a moment later (once the window exists) for the picker.
  setTimeout(() => resolveAppHwnd(), 2500)
  // When the app window closes, Edge (with its own profile) exits — so do we.
  child.on('exit', () => process.exit(0))
}

if (process.env.NOTES_NO_LAUNCH) {
  // Test mode: just listen and print the port, don't open a window or watchdog.
  server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
    console.log('PORT=' + server.address().port)
  })
} else {
  // Single instance: bind the lock port. If it's already taken by another copy of
  // this app, tell that copy to focus its window and exit instead of opening a second.
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') {
      console.error(e)
      process.exit(1)
    }
    const who = await httpGet(LOCK_PORT, '/whoami')
    if (who && who.trim() === WHOAMI) {
      await httpPost(LOCK_PORT, '/focus')
      process.exit(0)
    }
    // The port is held by something unrelated — run on a random port, without the lock.
    server.listen(0, '127.0.0.1', () => launch(server.address().port))
  })
  server.listen(LOCK_PORT, '127.0.0.1', () => launch(LOCK_PORT))
  // Shutdown is driven by the Edge window closing (child 'exit' in launch) and by the
  // page's /api/bye on close. We intentionally do NOT shut down on a missed heartbeat:
  // while a native dialog (e.g. the folder picker) is open, the window is backgrounded
  // and the browser throttles its timers, so pings pause normally.
}
