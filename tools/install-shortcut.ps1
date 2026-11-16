# Creates a "Notes" shortcut on the Desktop and in the Start Menu.
# Double-clicking it runs Notes.vbs, which starts the app with no console window.
$proj = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $proj 'Notes.vbs'
$icon = Join-Path $proj 'Notes.ico'
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Notes.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Notes.lnk')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
  New-Item -ItemType Directory -Force (Split-Path $lnk) | Out-Null
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $proj
  $s.IconLocation = $icon
  $s.Description = 'Notes'
  $s.Save()
  Write-Host "created $lnk"
}
