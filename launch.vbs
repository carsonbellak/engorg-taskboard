' Engineering Task Board launcher.
' Runs start.bat with a hidden window so no console/cmd window appears when the
' app opens. The Electron GUI still shows normally. To see the console output,
' use View > Show Console inside the app (opens DevTools).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Assistant"
' "0" = hidden window, False = don't wait for it to finish.
sh.Run "cmd /c C:\Assistant\start.bat", 0, False
