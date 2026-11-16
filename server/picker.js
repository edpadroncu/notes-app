// Folder picker via the Windows shell (run with: cscript //nologo //E:jscript picker.js <hwnd> <title>).
// Much faster to start than PowerShell + WinForms. Prints the chosen path to stdout, or nothing if cancelled.
var args = WScript.Arguments
var hwnd = args.length > 0 ? parseInt(args(0), 10) || 0 : 0
var title = args.length > 1 ? args(1) : 'Choose a folder'

// Options: BIF_RETURNONLYFSDIRS (1) | BIF_EDITBOX (0x10) | BIF_NEWDIALOGSTYLE (0x40).
var OPTIONS = 0x51

try {
  var shell = new ActiveXObject('Shell.Application')
  var folder = shell.BrowseForFolder(hwnd, title, OPTIONS)
  if (folder != null && folder.Self && folder.Self.Path) {
    WScript.StdOut.Write(folder.Self.Path)
  }
} catch (e) {
  // Leave stdout empty; the caller treats that as "cancelled".
}
