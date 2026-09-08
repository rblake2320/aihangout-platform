#!/usr/bin/env pwsh
# Deploy aihangout to production (aihangout.ai)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/deploy-native.ps1"
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

# Checklist gate
Write-Host "`n[prod] Pre-deploy checklist:" -ForegroundColor Yellow
Write-Host "  [ ] JWT_SECRET set in Cloudflare Worker env vars (not wrangler.toml)"
Write-Host "  [ ] dry-run passes"
Write-Host "  [ ] verify-deployment.js passes locally"
Write-Host "  [ ] No hardcoded secrets in changed files"
$confirm = Read-Host "`nAll checks done? (yes/no)"
if ($confirm -ne 'yes') {
    Write-Host "Aborted." -ForegroundColor Red
    exit 1
}

Write-Host "`n[prod] Building..." -ForegroundColor Cyan
Invoke-DeploymentCommand npm @('run', 'build')

Write-Host "`n[prod] Dry-run check..." -ForegroundColor Cyan
Invoke-DeploymentCommand npx @('wrangler', 'deploy', '--env', 'production', '--dry-run')

Write-Host "`n[prod] Deploying to aihangout.ai..." -ForegroundColor Cyan
Invoke-DeploymentCommand npx @('wrangler', 'deploy', '--env', 'production')

Write-Host "`n[prod] Deploy complete." -ForegroundColor Green
Write-Host "Verify: node verify-deployment.js"
