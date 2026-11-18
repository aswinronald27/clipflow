$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'OpenShorts.ps1'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$desktop = [Environment]::GetFolderPath('Desktop')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell

foreach ($action in @('Start', 'Stop')) {
    $shortcutPath = Join-Path $desktop "$action OpenShorts.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Action $action"
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = "$action the local OpenShorts services"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Write-Host "Created $shortcutPath"
}
