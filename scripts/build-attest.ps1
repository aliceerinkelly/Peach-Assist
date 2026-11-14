param(
  [switch]$Record,     # write a fresh signed attestation from what is on disk now
  [switch]$Verify,     # verify signature, then compare disk against the attestation
  [switch]$SourceHash, # print only the aggregate source hash (used by the supervisor)
  [switch]$Report,     # print a paste-ready support report (version, hashes, mismatches)
  [switch]$Embed,      # bury dist-hash fragments in the configured pages
  [switch]$Corroborate, # read those fragments back and compare them to the stamp
  [switch]$InitKey,    # create the signing key without touching the attestation
  [switch]$Quiet
)

# Attestation with a signature, not just a hash file.
#
#   -Record  hashes the build inputs (src/*.ts, tsconfig, package files) and the
#            compiled output (dist/*.js), signs the result with HMAC-SHA256, writes
#            it to 7f3a9c2.oop and mirrors a copy to Drive.
#   -Verify  checks the signature FIRST, then compares hashes.
#            exit 0 = matches, 1 = differs, 2 = no attestation, 3 = cannot verify
#
# Why the signature matters: a hash file sitting in the project can be rewritten by
# anyone who can edit the project. The signing key does not live in the project -
# it is in %USERPROFILE%\.config\peachmessenger\attest.key, sealed with DPAPI for this
# Windows account. A copied, restored or zipped project therefore cannot produce a
# stamp that verifies, and a hand-edited 7f3a9c2.oop is caught even if the hashes
# inside it were updated to match the edit.
#
# Honest limit: a process running as this user can unseal the key, so this stops
# someone with a copy of the folder and catches casual edits - it is not a defence
# against an administrator on this machine.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$appDir    = Split-Path -Parent $PSScriptRoot
Set-Location $appDir

# The attestation and its key live OUTSIDE the project, in the user's own hidden
# folder. Restoring, copying or unzipping the project therefore cannot carry a
# stamp with it - a fresh copy has to earn its own. The project folder holds no
# record of the expected hashes at all, so editing files in it gets noticed.
$stampName = '7f3a9c2.oop'
$stateDir  = Join-Path $env:USERPROFILE '.config\peachmessenger'
$stampPath = Join-Path $stateDir $stampName
$keyPath   = Join-Path $stateDir 'attest.key'
$driveCopy = Join-Path 'G:\My Drive' $stampName

# Everything above is a default; attest.config.json overrides it when present.
$configPath = Join-Path $appDir 'attest.config.json'
$cfg = $null
if (Test-Path $configPath) {
  try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
if ($cfg) {
  if ($cfg.stampName) { $stampName = [string]$cfg.stampName }
  if ($cfg.stateDir)  { $stateDir  = [Environment]::ExpandEnvironmentVariables([string]$cfg.stateDir) }
  if ($cfg.mirror)    { $driveCopy = [Environment]::ExpandEnvironmentVariables([string]$cfg.mirror) }
  $stampPath = Join-Path $stateDir $stampName
  $keyPath   = Join-Path $stateDir 'attest.key'
}
$corr = if ($cfg) { $cfg.corroborate } else { $null }

function Say([string]$t) { if (-not $Quiet) { Write-Host $t } }

function Get-InputFiles {
  $files = @()
  $src = Join-Path $appDir 'src'
  if (Test-Path $src) { $files += Get-ChildItem $src -Recurse -File -Filter '*.ts' }
  foreach ($name in @('tsconfig.json', 'package.json', 'package-lock.json')) {
    $p = Join-Path $appDir $name
    if (Test-Path $p) { $files += Get-Item $p }
  }
  return $files | Sort-Object FullName
}

function Get-DistFiles {
  $dist = Join-Path $appDir 'dist'
  if (-not (Test-Path $dist)) { return @() }
  return Get-ChildItem $dist -Recurse -File -Filter '*.js' | Sort-Object FullName
}

function Format-Set($files) {
  $out = @()
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($appDir.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    $out += "$hash  $rel"
  }
  return $out
}

function Get-AppVersion {
  $pj = Join-Path $appDir 'package.json'
  if (Test-Path $pj) {
    try { return (Get-Content $pj -Raw | ConvertFrom-Json).version } catch { return 'unknown' }
  }
  return 'unknown'
}

function Get-ToolVersion {
  $tj = Join-Path $appDir 'node_modules\typescript\package.json'
  if (Test-Path $tj) {
    try { return (Get-Content $tj -Raw | ConvertFrom-Json).version } catch { return 'unknown' }
  }
  return 'not installed'
}

function Get-Aggregate($lines) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  return (([System.BitConverter]::ToString($sha.ComputeHash($bytes))) -replace '-', '').ToLower()
}

function Get-Key {
  if (-not (Test-Path $keyPath)) { return $null }
  try {
    $sealed = [System.IO.File]::ReadAllBytes($keyPath)
    return [System.Security.Cryptography.ProtectedData]::Unprotect(
      $sealed, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } catch { return $null }
}

function New-Key {
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
  $key = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($key)
  $sealed = [System.Security.Cryptography.ProtectedData]::Protect(
    $key, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.IO.File]::WriteAllBytes($keyPath, $sealed)
  try { (Get-Item -LiteralPath $keyPath -Force).Attributes = 'Hidden' } catch { }
  return $key
}

function Get-Signature([string]$body, [byte[]]$key) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (, $key)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  return (([System.BitConverter]::ToString($hmac.ComputeHash($bytes))) -replace '-', '').ToLower()
}

function Build-Body {
  $inputs = @(Format-Set (Get-InputFiles))
  $dist   = @(Format-Set (Get-DistFiles))
  if ($inputs.Count -eq 0) { throw 'no build inputs found under src\; nothing to attest' }
  if ($dist.Count -eq 0)   { throw 'no compiled files in dist\; build before recording' }

  $nodeVer = 'unknown'
  $nodeExe = Join-Path $env:USERPROFILE 'tools\node-v22.11.0-win-x64\node.exe'
  if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
  try { $nodeVer = (& $nodeExe --version).Trim() } catch { }

  $lines = @()
  $lines += '# Peach Messenger build attestation'
  $lines += 'recorded:   ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $lines += 'node:       ' + $nodeVer
  $lines += 'typescript: ' + (Get-ToolVersion)
  $lines += 'version:    ' + (Get-AppVersion)
  $lines += 'machine:    ' + $env:COMPUTERNAME
  $lines += 'inputs:     ' + $inputs.Count + ' file(s)'
  $lines += 'dist:       ' + $dist.Count + ' file(s)'
  $lines += 'source-sha: ' + (Get-Aggregate $inputs)
  $lines += 'dist-sha:   ' + (Get-Aggregate $dist)
  $lines += ''
  $lines += '[inputs]'
  $lines += $inputs
  $lines += ''
  $lines += '[dist]'
  $lines += $dist
  # LF only: the signature is computed over exactly these bytes, so record and
  # verify must normalise line endings the same way.
  return ($lines -join "`n")
}

if ($InitKey) {
  if (Test-Path $keyPath) { Say 'signing key already exists'; exit 0 }
  New-Key | Out-Null
  Say ('signing key created: ' + $keyPath)
  exit 0
}

if ($SourceHash) {
  $inputs = @(Format-Set (Get-InputFiles))
  if ($inputs.Count -eq 0) { exit 2 }
  Write-Output (Get-Aggregate $inputs)
  exit 0
}

if ($Report) {
  # Everything support needs in one paste. Deliberately contains no secrets: no
  # key material, no paths that matter, just what this build is and how it differs
  # from the recorded one.
  $inputs = @(Format-Set (Get-InputFiles))
  $dist   = @(Format-Set (Get-DistFiles))
  $nodeExe = Join-Path $env:USERPROFILE 'tools\node-v22.11.0-win-x64\node.exe'
  if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
  $nodeVer = 'unknown'; try { $nodeVer = (& $nodeExe --version).Trim() } catch { }

  $stampState = 'absent'
  if (Test-Path $stampPath) { $stampState = 'present' }

  Write-Output '--- Peach Messenger support report ---'
  Write-Output ('version:    ' + (Get-AppVersion))
  Write-Output ('node:       ' + $nodeVer)
  Write-Output ('typescript: ' + (Get-ToolVersion))
  Write-Output ('machine:    ' + $env:COMPUTERNAME)
  Write-Output ('attestation:' + ' ' + $stampState)
  Write-Output ('source-sha: ' + (Get-Aggregate $inputs))
  Write-Output ('dist-sha:   ' + (Get-Aggregate $dist))
  Write-Output ('inputs:     ' + $inputs.Count + ' file(s)')
  Write-Output ('dist:       ' + $dist.Count + ' file(s)')

  if (Test-Path $stampPath) {
    $stored = (Get-Content -LiteralPath $stampPath -Raw) -replace "`r`n", "`n"
    $wasDist   = @(($stored -split "`n") | Where-Object { $_ -match '^[0-9a-f]{64}  dist/' })
    $wasInputs = @(($stored -split "`n") | Where-Object { $_ -match '^[0-9a-f]{64}  (src|tsconfig|package)' })
    $gone    = @($wasDist | Where-Object { $dist -notcontains $_ })
    $arrived = @($dist   | Where-Object { $wasDist -notcontains $_ })
    if ($gone.Count -eq 0 -and $arrived.Count -eq 0) {
      Write-Output 'build:      matches the recorded attestation'
    } else {
      Write-Output 'build:      DOES NOT MATCH the recorded attestation'
      foreach ($g in $gone)    { Write-Output ('  expected but different: ' + ($g -split '  ')[1]) }
      foreach ($a in $arrived) { Write-Output ('  present but not expected: ' + ($a -split '  ')[1]) }
    }
    $sig = ($stored -split "`n") | Where-Object { $_ -match '^signature:' } | Select-Object -Last 1
    Write-Output ('signature:  ' + $(if ($sig) { 'present' } else { 'MISSING' }))
  }
  Write-Output '--- end of report ---'
  exit 0
}

if ($Record) {
  $hadKey = Test-Path $keyPath
  $hadStamp = Test-Path $stampPath
  $key = Get-Key
  if (-not $key) {
    $key = New-Key
    if ($hadStamp) {
      Say 'WARNING: the signing key was missing while an attestation existed.'
      Say 'WARNING: a new key has been created, so past attestations can no longer be trusted.'
    } else {
      Say ('signing key created: ' + $keyPath)
    }
  }

  $body = Build-Body
  $sig = Get-Signature $body $key
  $text = $body + "`n" + 'signature:  ' + $sig

  Set-Content -LiteralPath $stampPath -Value $text -Encoding UTF8 -NoNewline
  try { (Get-Item -LiteralPath $stampPath -Force).Attributes = 'Hidden' } catch { }

  if (Test-Path 'G:\My Drive') {
    try {
      Set-Content -LiteralPath $driveCopy -Value $text -Encoding UTF8 -NoNewline
      Say ('mirror written: ' + $driveCopy)
    } catch { Say 'could not write the Drive mirror (continuing)' }
  }

  Say 'attestation recorded:'
  Say ('  ' + $stampPath)
  ($body -split "`n" | Where-Object { $_ -match '^(recorded|node|typescript|machine|inputs|dist|source-sha|dist-sha):' }) |
    ForEach-Object { Say ('  ' + $_) }
  Say ('  signature:  ' + $sig.Substring(0, 16) + '...')
  exit 0
}

if ($Verify) {
  if (-not (Test-Path $stampPath)) {
    Say ('NOT ATTESTED: no ' + $stampName + ' present')
    exit 2
  }

  $stored = (Get-Content -LiteralPath $stampPath -Raw) -replace "`r`n", "`n"
  $lines = $stored -split "`n"
  $sigLine = $lines | Where-Object { $_ -match '^signature:\s*[0-9a-f]{64}\s*$' } | Select-Object -Last 1
  if (-not $sigLine) {
    Say 'UNVERIFIABLE: the attestation carries no signature'
    exit 3
  }
  $storedSig = ($sigLine -replace '^signature:\s*', '').Trim()
  $body = (($lines | Where-Object { $_ -notmatch '^signature:' }) -join "`n").TrimEnd()

  $key = Get-Key
  if (-not $key) {
    Say 'UNVERIFIABLE: signing key not available on this account'
    exit 3
  }
  if ((Get-Signature $body $key) -ne $storedSig) {
    Say 'SIGNATURE INVALID: the attestation itself was altered or was made with another key'
    exit 1
  }

  $storedNorm = $stored
  function Get-Recorded([string]$section) {
    $all = $storedNorm -split "`n"
    $start = [array]::IndexOf($all, "[$section]")
    if ($start -lt 0) { return @() }
    $out = @()
    for ($i = $start + 1; $i -lt $all.Count; $i++) {
      $l = $all[$i].Trim()
      if ($l -eq '') { continue }
      if ($l.StartsWith('[') -or $l.StartsWith('signature:')) { break }
      $out += $l
    }
    return $out
  }

  $ok = $true
  $sets = @(
    @{ name = 'inputs'; now = @(Format-Set (Get-InputFiles)) },
    @{ name = 'dist';   now = @(Format-Set (Get-DistFiles)) }
  )
  foreach ($set in $sets) {
    $was = @(Get-Recorded $set.name)
    $now = @($set.now)
    $gone    = @($was | Where-Object { $now -notcontains $_ })
    $arrived = @($now | Where-Object { $was -notcontains $_ })

    if ($gone.Count -eq 0 -and $arrived.Count -eq 0) {
      Say ($set.name.PadRight(7) + ' unchanged (' + $now.Count + ' files)')
    } else {
      $ok = $false
      Say ($set.name.PadRight(7) + ' CHANGED')
      foreach ($m in $gone)    { Say ('  no longer matches: ' + ($m -split '  ')[1]) }
      foreach ($e in $arrived) { Say ('  new or altered:    ' + ($e -split '  ')[1]) }
    }
  }

  if ($ok) { Say 'attestation OK: signature valid, disk matches what was recorded'; exit 0 }
  Say 'attestation MISMATCH: disk does not match the recorded build'
  exit 1
}

# ---------- buried fragments (corroboration) ----------
# The dist hash is split into pieces and parked in HTML comments on a few pages.
# Read it out and you learn a hash you could already get from /__build, so nothing
# secret is published. Its worth is that it travels with the app and does not look
# like a manifest. Tripwire only - see attest.config.json.

function ConvertTo-Frag([string]$text, [string]$seed) {
  $b = [System.Text.Encoding]::UTF8.GetBytes($text)
  $s = [System.Text.Encoding]::UTF8.GetBytes($seed)
  $o = New-Object byte[] $b.Length
  for ($i = 0; $i -lt $b.Length; $i++) { $o[$i] = $b[$i] -bxor $s[$i % $s.Length] }
  return [Convert]::ToBase64String($o)
}

function ConvertFrom-Frag([string]$b64, [string]$seed) {
  $b = [Convert]::FromBase64String($b64)
  $s = [System.Text.Encoding]::UTF8.GetBytes($seed)
  $o = New-Object byte[] $b.Length
  for ($i = 0; $i -lt $b.Length; $i++) { $o[$i] = $b[$i] -bxor $s[$i % $s.Length] }
  return [System.Text.Encoding]::UTF8.GetString($o)
}

function Get-Pages {
  $list = @()
  foreach ($p in @($corr.pages)) { $list += (Join-Path $appDir ([string]$p)) }
  return $list
}

if ($Embed) {
  if (-not $corr -or -not $corr.enabled) { Say 'corroboration is not enabled in attest.config.json'; exit 3 }
  if (-not (Test-Path $stampPath)) { Say 'no attestation to embed from'; exit 2 }

  $text = Get-Content -LiteralPath $stampPath -Raw
  $m = [regex]::Match($text, 'dist-sha:\s*([0-9a-f]{64})')
  if (-not $m.Success) { Say 'the attestation carries no dist-sha'; exit 2 }
  $distSha = $m.Groups[1].Value

  $pages = @(Get-Pages)
  if ($pages.Count -eq 0) { Say 'no pages configured'; exit 3 }
  $blob = ConvertTo-Frag $distSha ([string]$corr.seed)
  $per  = [math]::Ceiling($blob.Length / $pages.Count)
  $marker = [string]$corr.marker
  $pattern = '<!--\s*' + [regex]::Escape($marker) + '\s*:\s*\d+\s*/\s*\d+\s+[A-Za-z0-9+/=]+\s*-->'

  for ($i = 0; $i -lt $pages.Count; $i++) {
    $path = $pages[$i]
    if (-not (Test-Path $path)) { Say ('  missing page: ' + $path); continue }
    $start = $i * $per
    $len = [math]::Min($per, $blob.Length - $start)
    if ($len -le 0) { continue }
    $chunk = $blob.Substring($start, $len)
    $frag = '<!-- ' + $marker + ':' + ($i + 1) + '/' + $pages.Count + ' ' + $chunk + ' -->'

    $page = Get-Content -LiteralPath $path -Raw
    $page = [regex]::Replace($page, $pattern, '')          # replace any previous copy
    $page = $page.TrimEnd()
    if ($page -match '</body>') {
      $page = $page -replace '</body>', ($frag + "`r`n</body>")
    } else {
      $page = $page + "`r`n" + $frag
    }
    Set-Content -LiteralPath $path -Value $page -Encoding UTF8 -NoNewline
    Say ('  embedded fragment ' + ($i + 1) + '/' + $pages.Count + ' in ' + ([string]$corr.pages[$i]))
  }
  exit 0
}

if ($Corroborate) {
  if (-not $corr -or -not $corr.enabled) { Say 'corroboration is not enabled'; exit 3 }
  $marker = [string]$corr.marker
  $pattern = '<!--\s*' + [regex]::Escape($marker) + '\s*:\s*(\d+)\s*/\s*(\d+)\s+([A-Za-z0-9+/=]+)\s*-->'

  $found = @()
  foreach ($path in @(Get-Pages)) {
    if (-not (Test-Path $path)) { continue }
    $page = Get-Content -LiteralPath $path -Raw
    foreach ($m in [regex]::Matches($page, $pattern)) {
      $found += [pscustomobject]@{ idx = [int]$m.Groups[1].Value; total = [int]$m.Groups[2].Value; data = $m.Groups[3].Value }
    }
  }

  $expected = 0
  if (Test-Path $stampPath) {
    $text = Get-Content -LiteralPath $stampPath -Raw
    $dm = [regex]::Match($text, 'dist-sha:\s*([0-9a-f]{64})')
    if ($dm.Success) { $expected = $dm.Groups[1].Value }
  }

  Say ('fragments found: ' + $found.Count)
  if ($found.Count -eq 0) { Say 'no buried fragments - nothing to corroborate'; exit 2 }

  $ordered = $found | Sort-Object idx
  $blob = ($ordered | ForEach-Object { $_.data }) -join ''
  try { $rebuilt = ConvertFrom-Frag $blob ([string]$corr.seed) }
  catch { Say 'fragments could not be decoded'; exit 1 }

  if ($expected -and $rebuilt -eq $expected) {
    Say ('corroborated: fragments agree with the attestation (' + $rebuilt.Substring(0, 12) + '...)')
    exit 0
  }
  Say 'MISMATCH: the buried fragments do not match the attestation'
  Say ('  fragments say: ' + $rebuilt.Substring(0, [math]::Min(16, $rebuilt.Length)) + '...')
  Say ('  attestation:   ' + $expected.Substring(0, [math]::Min(16, $expected.Length)) + '...')
  exit 1
}

Say 'usage: build-attest.ps1 -Record | -Verify | -SourceHash | -InitKey | -Report | -Embed | -Corroborate'
exit 3
