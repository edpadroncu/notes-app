// Wrap a PNG in a single-image .ico (Windows accepts PNG-compressed icon entries).
const fs = require('node:fs')
const path = require('node:path')

const png = fs.readFileSync(path.join(__dirname, '..', 'server', 'icon.png'))
const w = png.readUInt32BE(16)
const h = png.readUInt32BE(20)
const dir = Buffer.alloc(6)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // type: icon
dir.writeUInt16LE(1, 4) // image count
const entry = Buffer.alloc(16)
entry.writeUInt8(w >= 256 ? 0 : w, 0)
entry.writeUInt8(h >= 256 ? 0 : h, 1)
entry.writeUInt8(0, 2) // colours in palette
entry.writeUInt8(0, 3) // reserved
entry.writeUInt16LE(1, 4) // colour planes
entry.writeUInt16LE(32, 6) // bits per pixel
entry.writeUInt32LE(png.length, 8) // size of image data
entry.writeUInt32LE(6 + 16, 12) // offset to image data
fs.writeFileSync(path.join(__dirname, '..', 'Notes.ico'), Buffer.concat([dir, entry, png]))
console.log('wrote Notes.ico')
