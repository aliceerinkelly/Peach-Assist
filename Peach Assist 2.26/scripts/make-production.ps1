# Build a production model from the running folder.
#
# A state save (save-state.bat) keeps everything, including this machine's
# database, certificates and credentials. This is the other thing: the same code
# with none of this machine's history in it, so it can be handed to someone else
# or used as the base of a release.
#
# Left out, deliberately:
#   data\      this machine's database, uploads and DDNS settings
#   certs\     certificate private keys
#   logs\      server logs
#   .env*      secrets
#   *.log, *.rar, *.apk
#   android build outputs and caches (they are rebuilt, and they are huge)
#
# The result boots into first-run setup: no accounts, no messages, no keys.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$rar = Join-Path $env:ProgramFiles 'WinRAR\Rar.exe'
if (-not (Test-Path $rar)) { throw "WinRAR not found at $rar" }

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$name = "PeachMessenger-production-$stamp.rar"
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) $name

Push-Location $root
try {
    Write-Host "Building a production model from $root"
    Write-Host "  -> $out"

    # Every switch before --, because anything after -- is read as a filename.
    # Getting that wrong silently ignored all the exclusions once already, and the
    # check below is what caught it.
    # The Android assets carry a copy of the working folder. Its data directory
    # held this machine's database, a server log and a backups folder -- found in
    # a shipped APK, which is exactly the kind of thing this script exists to stop.
    & $rar a -r -dh -m3 -ep1 -idq `
        -x"data\*" -x"certs\*" -x"logs\*" -x"*.log" -x".env" -x".env.*" `
        -x"*.rar" -x"*.apk" -x".git\*" `
        -x"android\app\src\main\assets\nodejs-project\data\*" `
        -x"android\app\build\*" -x"android\build\*" -x"android\.gradle\*" -x"android\app\.cxx\*" `
        -- $out '.'
    if ($LASTEXITCODE -ne 0) { throw "rar failed with exit code $LASTEXITCODE" }

    & $rar t -idq -- $out
    if ($LASTEXITCODE -ne 0) { throw "the archive did not pass its own test" }

    $size = (Get-Item $out).Length
    $count = (& $rar lb -- $out | Measure-Object -Line).Lines
    Write-Host "  $count files, $([math]::Round($size / 1MB, 1)) MB"

    # Say plainly what did not go in, rather than leaving it to be discovered.
    # Matched wherever they appear: a database under android assets is no less
    # this machine's database than one under data\.
    $present = & $rar lb -- $out
    $rules = @(
        @{ pattern = 'app\.db(-wal|-shm)?$'; label = 'a database' },
        @{ pattern = '\\certs\\|^certs\\'; label = 'certificates' },
        @{ pattern = '(\.env|\.env\.[^\\]+)$'; label = '.env' },
        @{ pattern = 'server\.log$'; label = 'a server log' }
    )
    foreach ($rule in $rules) {
        $hit = $present | Where-Object { $_ -match $rule.pattern } | Select-Object -First 1
        if ($hit) { throw "the archive still contains $($rule.label): $hit - refusing to call this clean" }
    }
    Write-Host "  checked: no database, no certificates, no .env, no server log"

    $drive = 'G:\My Drive\Project Archives'
    if (Test-Path 'G:\My Drive') {
        if (-not (Test-Path $drive)) { New-Item -ItemType Directory -Path $drive | Out-Null }
        $copy = Join-Path $drive $name
        Copy-Item $out $copy -Force
        if ((Get-Item $copy).Length -ne $size) { throw "the Drive copy does not match the Desktop copy" }
        Write-Host "  copied to $copy"
    } else {
        Write-Host "  G: is not mounted, so the Drive copy was skipped"
    }

    Write-Host ''
    Write-Host "Production model saved as $name"
} finally {
    Pop-Location
}
