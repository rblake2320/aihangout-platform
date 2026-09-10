#!/usr/bin/env pwsh
# Deploy aihangout to staging (aihangout-staging.workers.dev)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/deploy-native.ps1"
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

Write-Host "`n[staging] Building..." -ForegroundColor Cyan
Invoke-DeploymentCommand npm @('run', 'build')

Write-Host "`n[staging] Dry-run check..." -ForegroundColor Cyan
Invoke-DeploymentCommand npx @('wrangler', 'deploy', '--env', 'staging', '--dry-run')

Write-Host "`n[staging] Deploying..." -ForegroundColor Cyan
Invoke-DeploymentCommand npx @('wrangler', 'deploy', '--env', 'staging')

Write-Host "`n[staging] Deploy complete." -ForegroundColor Green
Write-Host "URL: https://aihangout-staging.<your-subdomain>.workers.dev"
Write-Host "Verify: curl https://aihangout-staging.<your-subdomain>.workers.dev/api/health"
