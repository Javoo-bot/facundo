' Runs execute-card.mjs (one factory card) with no window and appends its output
' to %LOCALAPPDATA%\Facundo\factory-executor.log. Scheduled at 09:00 and 15:00
' as Windows task Facundo-Factory-Executor (PowerShell line in agents/factory/README.md).
' Pause it:   schtasks /Change /TN Facundo-Factory-Executor /DISABLE
' Resume it:  schtasks /Change /TN Facundo-Factory-Executor /ENABLE
' Remove it:  schtasks /Delete /TN Facundo-Factory-Executor /F
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Facundo"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\execute-card.mjs"
sh.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" """ & script & """ >> """ & logDir & "\factory-executor.log"" 2>&1""", 0, True
