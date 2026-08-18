param(
  [string]$EnginePath = ".\engines\Pikafish.2026-01-02\Windows\pikafish-bmi2.exe",
  [string]$ResultPath = ".\artifacts\field-validation\offline-pikafish.json"
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
$resolvedEngine = (Resolve-Path -LiteralPath $EnginePath).Path
$resolvedResult = [System.IO.Path]::GetFullPath($ResultPath)
$ruleName = "ChessMonitor-Pikafish-Offline-Field-Validation"
$status = [ordered]@{
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  enginePath = $resolvedEngine
  firewallRule = $ruleName
  firewallRuleCreated = $false
  testExitCode = $null
  testOutput = $null
  passed = $false
  firewallRuleRemoved = $false
  error = $null
}

try {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Outbound `
    -Program $resolvedEngine `
    -Action Block `
    -Profile Any | Out-Null
  $status.firewallRuleCreated = $true

  $applicationFilter = Get-NetFirewallRule -DisplayName $ruleName |
    Get-NetFirewallApplicationFilter
  if ($applicationFilter.Program -ne $resolvedEngine) {
    throw "Firewall rule does not target the expected Pikafish executable"
  }

  Write-Output "Outbound network blocked for: $resolvedEngine"
  $testOutput = (& rtk pnpm test -- --run electron/engine-manager.integration.test.ts 2>&1 | Out-String)
  $status.testOutput = $testOutput.Trim()
  Write-Output $testOutput
  $status.testExitCode = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) {
    throw "Offline Pikafish integration test failed with exit code $LASTEXITCODE"
  }
  $status.passed = $true
  Write-Output "Offline Pikafish integration test passed"
}
catch {
  $status.error = $_.Exception.Message
  throw
}
finally {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
  $status.firewallRuleRemoved = -not [bool](Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)
  $status.completedAt = (Get-Date).ToUniversalTime().ToString("o")
  $status | ConvertTo-Json | Set-Content -LiteralPath $resolvedResult -Encoding UTF8
  Write-Output "Temporary firewall rule removed"
}
