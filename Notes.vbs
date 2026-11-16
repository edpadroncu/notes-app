' Launches the Notes app with no console window.
' Starts the local Node server, which opens the app in an Edge window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "node server\server.cjs", 0, False
