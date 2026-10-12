param(
  [string]$CodexHome = $env:CODEX_HOME
)

$ErrorActionPreference = 'Stop'
Get-Command node -ErrorAction Stop | Out-Null
Get-Command codex -ErrorAction Stop | Out-Null
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or ([version]$nodeVersion.TrimStart('v')).Major -lt 22) { throw 'Node.js 22 or newer is required.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json
$pluginCodexRoot = if ($CodexHome) { [System.IO.Path]::GetFullPath($CodexHome) } else { Join-Path $env:USERPROFILE '.codex' }
$cachedScript = Join-Path $pluginCodexRoot ('plugins\cache\local-idle-compact\idle-compact\' + $manifest.version + '\scripts\server.cjs')
# This desktop build doesn't expand PLUGIN_ROOT in MCP argv. Resolve the
# versioned installation path before Codex copies the manifest into its cache.
$mcpManifest = @{ mcpServers = @{ 'idle-compact' = @{ command = 'node'; args = @($cachedScript); env = @{ CODEX_HOME = $pluginCodexRoot } } } }
$mcpJson = $mcpManifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.mcp.json'), $mcpJson)
$previousCodexHome = $env:CODEX_HOME
try {
  $env:CODEX_HOME = $pluginCodexRoot
  & codex plugin marketplace add $PSScriptRoot --json
  if ($LASTEXITCODE -ne 0) { throw 'Could not register the local plugin marketplace.' }
  & codex plugin add idle-compact@local-idle-compact --json
  if ($LASTEXITCODE -ne 0) { throw 'Could not install idle-compact.' }
} finally {
  $env:CODEX_HOME = $previousCodexHome
}
Write-Host 'Installed. Enable the plugin in Codex and review/trust its lifecycle hooks when prompted.'
