[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunRoot)
$ErrorActionPreference='Stop'
$receiptPath = Join-Path ([IO.Path]::GetFullPath($RunRoot)) 'receipt.json'
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($receipt.gate -ne 'local-packaged-mobile-acceptance' -or -not $receipt.workerd_pid) { throw 'not a prepared local mobile acceptance receipt' }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($receipt.workerd_pid)" -ErrorAction SilentlyContinue
$state = Join-Path $receipt.run_root 'state'
if ($p -and ($p.Name -ne 'node.exe' -or $p.CommandLine.IndexOf($state,[StringComparison]::OrdinalIgnoreCase) -lt 0)) { throw 'refusing to terminate unverified process' }
if ($p) { & "$env:SystemRoot\System32\taskkill.exe" /PID $receipt.workerd_pid /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw "taskkill failed: $LASTEXITCODE" } }
if (Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue) { throw 'port 8789 still listening' }
$receipt.status='stopped'
# ConvertFrom-Json returns a fixed property set under StrictMode.  Add the
# durable completion field explicitly instead of assigning an absent property.
$receipt | Add-Member -NotePropertyName stopped_utc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Output "STOPPED receipt=$receiptPath"
