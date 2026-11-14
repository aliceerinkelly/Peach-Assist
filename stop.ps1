# Stops the messenger server, and does not return until it has really stopped.
# Nothing else on the computer is touched.
$ErrorActionPreference = 'SilentlyContinue'

# The keep-alive would start the server straight back up, so it goes first.
Stop-ScheduledTask -TaskName 'Peach Messenger server' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine -like '*server-supervisor.ps1*') -or
  ($_.Name -eq 'wscript.exe' -and $_.CommandLine -and $_.CommandLine -like '*run-hidden.vbs*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

function ServerProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*dist*server.js*') }
}

$procs = @(ServerProcesses)

if ($procs.Count -eq 0) {
  Write-Host 'Messenger was not running.'
  exit 0
}

foreach ($p in $procs) {
  Write-Host ('Stopping process ' + $p.ProcessId + '...')
  Stop-Process -Id $p.ProcessId -Force
}

# Killing a process is not the same as it being gone: wait for the socket too.
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  if (-not (ServerProcesses)) { break }
}

$left = @(ServerProcesses)
if ($left.Count -gt 0) {
  Write-Host ('Messenger did NOT stop cleanly. Still running: ' + (($left | ForEach-Object { $_.ProcessId }) -join ', '))
  exit 1
}

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $busy = [bool](Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
  if (-not $busy) { break }
  Start-Sleep -Milliseconds 400
}

if ($busy) {
  Write-Host 'Processes are gone but port 3000 is still held by something else.'
  exit 1
}

Write-Host 'Messenger stopped, port 3000 released.'
exit 0
