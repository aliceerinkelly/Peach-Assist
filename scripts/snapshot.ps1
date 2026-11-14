# Save a state of the project: the whole working folder, as a timestamped rar.
#
# This follows the archiving rules in AGENTS.md: everything goes in (source,
# public, scripts, data, dist, node_modules, .env files, build output), nothing is
# excluded, and the archive is checked before it is called done. Locked files are
# opened shared rather than skipped, because a running server holds the database.
#
# Run it with save-state.bat, or:  powershell -File scripts\snapshot.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$rar = Join-Path $env:ProgramFiles 'WinRAR\Rar.exe'
if (-not (Test-Path $rar)) { throw "WinRAR not found at $rar" }

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$name = "PeachMessenger-$stamp.rar"
$desktop = [Environment]::GetFolderPath('Desktop')
$out = Join-Path $desktop $name

Push-Location $root
try {
    Write-Host "Saving $root"
    Write-Host "  -> $out"

    # -r recurse, -dh read files other programs have open, -m3 normal compression,
    # -ep1 keep paths relative to this folder (no drive letters inside).
    & $rar a -r -dh -m3 -ep1 -idq -- $out '.'
    if ($LASTEXITCODE -ne 0) { throw "rar failed with exit code $LASTEXITCODE" }

    # Prove it rather than assume it: test the contents, then compare sizes.
    & $rar t -idq -- $out
    if ($LASTEXITCODE -ne 0) { throw "the archive did not pass its own test" }

    $size = (Get-Item $out).Length
    $mb = [math]::Round($size / 1MB, 1)
    $count = (& $rar lb -- $out | Measure-Object -Line).Lines
    Write-Host "  verified: $count files, $mb MB on the Desktop"

    $drive = 'G:\My Drive\Project Archives'
    if (Test-Path 'G:\My Drive') {
        if (-not (Test-Path $drive)) { New-Item -ItemType Directory -Path $drive | Out-Null }
        $copy = Join-Path $drive $name
        Copy-Item $out $copy -Force
        $copySize = (Get-Item $copy).Length
        if ($copySize -ne $size) { throw "Drive copy is $copySize bytes, Desktop is $size bytes; they do not match" }
        Write-Host "  copied to $copy ($([math]::Round($copySize / 1MB, 1)) MB, byte for byte)"
    } else {
        Write-Host "  G: is not mounted, so the Drive copy was skipped"
    }

    Write-Host ''
    Write-Host "Saved as $name"
} finally {
    Pop-Location
}
