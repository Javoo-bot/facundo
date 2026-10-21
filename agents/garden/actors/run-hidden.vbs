' Runs run.mjs with no window and appends its output to %LOCALAPPDATA%\Facundo\garden-actors.log.
' Scheduled every 10 minutes by:
'   schtasks /Create /TN Facundo-Garden-Actors /SC MINUTE /MO 10 /F /TR "wscript.exe //B \"<this file>\""
' Stop it:    schtasks /Change /TN Facundo-Garden-Actors /DISABLE
' Remove it:  schtasks /Delete /TN Facundo-Garden-Actors /F
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Facundo"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\run.mjs"
sh.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" """ & script & """ >> """ & logDir & "\garden-actors.log"" 2>&1""", 0, True
