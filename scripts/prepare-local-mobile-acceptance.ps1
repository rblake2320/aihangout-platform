[CmdletBinding()]
param(
  [ValidatePattern('^[a-zA-Z]:\\')][string]$RunRoot = '',
  [ValidateRange(300, 1800)][int]$LifetimeSeconds = 900
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$sourceCommit = (git -C $repo rev-parse HEAD).Trim()
$clientCommit = 'b51768bc1e2a29487293e2db938bee25ec85142d'
$run = if ($RunRoot) { [IO.Path]::GetFullPath($RunRoot) } else { Join-Path $repo ('evidence\mobile-acceptance-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N')) }
if (Test-Path -LiteralPath $run) { throw "RunRoot already exists: $run" }
New-Item -ItemType Directory -Path $run | Out-Null

function Need([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { throw "Required path missing: $Path" }; return (Resolve-Path -LiteralPath $Path).Path }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false)) }
function Stop-OwnedWorker([int]$Pid, [string]$StatePath) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$Pid" -ErrorAction SilentlyContinue
  if ($null -eq $p) { return }
  if ($p.Name -ne 'node.exe' -or [string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine.IndexOf($StatePath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "Refusing to terminate unverified worker PID $Pid" }
  & "$env:SystemRoot\System32\taskkill.exe" /PID $Pid /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "taskkill failed: $LASTEXITCODE" }
}

$receipt = [ordered]@{
  gate = 'local-packaged-mobile-acceptance'; status = 'started'; run_root = $run
  started_utc = [DateTime]::UtcNow.ToString('o'); source_commit = $sourceCommit; client_commit = $clientCommit
  phone_actions = 0; production_requests = 0; automatic_mobile_post_requests = 0; automatic_mobile_post_replays = 0; account_registration_requests = 0
}
$worker = $null; $state = $null
try {
  if ((git -C $repo rev-parse HEAD).Trim() -ne $sourceCommit) { throw "worktree HEAD must equal $sourceCommit" }
  git -C $repo merge-base --is-ancestor $clientCommit $sourceCommit
  if ($LASTEXITCODE -ne 0) { throw "client composition $clientCommit is not in $sourceCommit" }
  $sdk = Need 'C:\Users\techai\android-surface-tools\sdk'; $jdk = Need 'C:\Users\techai\android-surface-tools\jdk'
  $gradle = Need "$repo\android-companion\gradlew.bat"; $apksigner = Need "$sdk\build-tools\34.0.0\apksigner.bat"
  $wrangler = Need "$env:APPDATA\npm\node_modules\wrangler\bin\wrangler.js"; Need "$repo\node_modules\.bin\esbuild.cmd" | Out-Null
  if (Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue) { throw 'port 8789 is already listening' }
  $env:JAVA_HOME = $jdk; $env:ANDROID_SDK_ROOT = $sdk; $env:PATH = "$jdk\bin;$env:PATH"
  Push-Location $repo
  try { & npm run build:worker; if ($LASTEXITCODE -ne 0) { throw "worker build failed: $LASTEXITCODE" } }
  finally { Pop-Location }
  Push-Location "$repo\android-companion"
  try { & $gradle ':app:assembleDebug' '-PaihangoutBaseUrl=http://127.0.0.1:8789' '--no-daemon' '--console=plain'; if ($LASTEXITCODE -ne 0) { throw "Gradle failed: $LASTEXITCODE" } }
  finally { Pop-Location }
  $apk = Need "$repo\android-companion\app\build\outputs\apk\debug\app-debug.apk"
  $package = New-Item -ItemType Directory -Path "$run\package"
  $apkPath = Join-Path $package 'aihangout-companion-debug.apk'; $workerPath = Join-Path $package 'worker.js'
  Copy-Item -LiteralPath $apk -Destination $apkPath; Copy-Item -LiteralPath "$repo\dist\worker.js" -Destination $workerPath
  $certOutput = & $apksigner verify --print-certs $apkPath 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'apksigner verification failed' }
  $match = [regex]::Match($certOutput, 'Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f:]{64,95})')
  if (-not $match.Success) { throw 'signer SHA-256 missing' }
  $cert = $match.Groups[1].Value.Replace(':','').ToLowerInvariant()
  $state = Join-Path $run 'state'; $runtime = Join-Path $run 'runtime.env'
  $jwt = [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 })) -replace '[^A-Za-z0-9]', 'x'
  [IO.File]::WriteAllText($runtime, "JWT_SECRET=$jwt`nMOBILE_APP_ID=com.aihangout.companion`nMOBILE_APP_CERT_SHA256=$cert`n", [Text.UTF8Encoding]::new($false))
  Push-Location $repo
  try {
    & node $wrangler d1 migrations apply aihangout-staging --env staging --local --persist-to $state
    if ($LASTEXITCODE -ne 0) { throw "local migrations failed: $LASTEXITCODE" }
    $out = Join-Path $run 'workerd.stdout.txt'; $err = Join-Path $run 'workerd.stderr.txt'
    $worker = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($wrangler,'dev','--env','staging','--local','--ip','127.0.0.1','--port','8789','--persist-to',$state,'--env-file',$runtime) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  } finally { Pop-Location }
  $until = [DateTime]::UtcNow.AddSeconds(25); $ready = $false
  while ([DateTime]::UtcNow -lt $until -and -not $worker.HasExited) {
    Start-Sleep -Milliseconds 400
    try { $ready = ((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8789/api/health' -TimeoutSec 1).StatusCode -eq 200) } catch {}
    if ($ready) { break }
  }
  if (-not $ready) { throw 'local workerd did not become healthy' }
  if ((Get-Content $err -Raw -ErrorAction SilentlyContinue) -match '\[rate-limit\] KV failure') { throw 'local KV binding failed' }
  $email = "local-mobile-$([guid]::NewGuid().ToString('N').Substring(0,16))@example.invalid"; $password = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 })); $username = "local_mobile_$([guid]::NewGuid().ToString('N').Substring(0,12))"
  $registered = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8789/api/auth/register' -ContentType 'application/json' -Body (@{ username=$username; email=$email; password=$password; aiAgentType='specialized' } | ConvertTo-Json -Compress)
  $receipt.account_registration_requests = 1
  if (-not $registered.success) { throw 'disposable local account registration refused' }
  $private = Join-Path $run 'operator-private.json'
  Write-Json $private ([ordered]@{ base_url='http://127.0.0.1:8789'; email=$email; password=$password; apk_path=$apkPath; package_name='com.aihangout.companion'; signing_cert_sha256=$cert; expires_utc=[DateTime]::UtcNow.AddSeconds($LifetimeSeconds).ToString('o') })
  $checks = @('device_selected','reverse_mapping','apk_identity','enrollment','owner_approval','action_result','no_replay','teardown') | ForEach-Object { [ordered]@{ check=$_; status='owner_pending' } }
  Write-Json "$run\owner-receipt-checklist.json" $checks
  $receipt.status='prepared'; $receipt.workerd_pid=$worker.Id; $receipt.apk_sha256=(Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLowerInvariant(); $receipt.backend_sha256=(Get-FileHash $workerPath -Algorithm SHA256).Hash.ToLowerInvariant(); $receipt.signing_cert_sha256=$cert; $receipt.private_operator_file=$private; $receipt.owner_receipt_checklist="$run\owner-receipt-checklist.json"; $receipt.lifetime_seconds=$LifetimeSeconds
  Write-Json "$run\receipt.json" $receipt
  Write-Output "PREPARED receipt=$run\receipt.json"
} catch {
  $receipt.status='failed'; $receipt.error=$_.Exception.Message; Write-Json "$run\receipt.json" $receipt; throw
} finally {
  if ($receipt.status -eq 'failed' -and $worker) { Stop-OwnedWorker -Pid $worker.Id -StatePath $state }
}
