# Build this repo into GIFA's app.asar and install it.
#
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Gifa "C:\path\to\GIFA"
#
# - Keeps the untouched original as resources\app.asar.bak (created on first run) and always
#   builds from that, so re-running never stacks patches.
# - Uses GIFA.exe's bundled Node (ELECTRON_RUN_AS_NODE) — no Node.js install needed.
# - GIFA must be closed (Windows locks app.asar while it runs).
param(
  [Parameter(Mandatory = $true)][string]$Gifa
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $Gifa 'GIFA.exe'
$asar = Join-Path $Gifa 'resources\app.asar'
$bak = Join-Path $Gifa 'resources\app.asar.bak'
$out = Join-Path $env:TEMP 'gifa-app.new.asar'

if (-not (Test-Path $exe)) { throw "GIFA.exe not found in $Gifa" }
if (Get-Process GIFA -ErrorAction SilentlyContinue) { throw 'GIFA is running. Quit it (close the launcher) first.' }
if (-not (Test-Path $bak)) { Copy-Item $asar $bak; Write-Host "Backed up original to $bak" }

$env:__COMPAT_LAYER = 'RunAsInvoker'   # GIFA.exe asks for admin; not needed just to run Node
$env:ELECTRON_RUN_AS_NODE = '1'

function Run-Node([string[]]$argv) {
  $p = Start-Process -FilePath $exe -ArgumentList ($argv | ForEach-Object { "`"$_`"" }) -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "step failed: $($argv -join ' ')" }
}

$env:ELECTRON_NO_ASAR = '1'            # read the .asar as a plain file while packing
Run-Node @((Join-Path $repo 'tools\pack-asar.js'), $bak, $repo, $out)
Remove-Item Env:ELECTRON_NO_ASAR
Run-Node @((Join-Path $repo 'tools\verify-asar.js'), $out, $repo)

Copy-Item $out $asar -Force
Write-Host "Installed. To undo: replace resources\app.asar with resources\app.asar.bak"
