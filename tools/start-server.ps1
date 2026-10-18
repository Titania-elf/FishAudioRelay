$ErrorActionPreference = 'Stop'
$workspacePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$relayNodePath = (Get-Command node).Source
$serverPath = Join-Path $workspacePath 'server.js'
Start-Process -FilePath $relayNodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $workspacePath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $workspacePath 'server.log') -RedirectStandardError (Join-Path $workspacePath 'server-error.log')
Write-Output 'Relay started at http://127.0.0.1:17863/'
