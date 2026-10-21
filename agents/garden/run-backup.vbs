' Runs backup-dispatch.mjs with no window, appending to %LOCALAPPDATA%\Facundo\garden-backup.log.
' Scheduled daily at 07:30 local by:
'   schtasks /Create /TN Facundo-Garden-Backup /SC DAILY /ST 07:30 /F /TR "wscript.exe //B \"<this file>\""
' Stop it:    schtasks /Change /TN Facundo-Garden-Backup /DISABLE
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Facundo"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\backup-dispatch.mjs"
sh.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" """ & script & """ >> """ & logDir & "\garden-backup.log"" 2>&1""", 0, True
