# kitshn join for Windows (K-625): installs the kitshn daemon for this user, joins the machine with a one-time
# code, and starts the daemon at logon through Task Scheduler (K-622). "Add machine" on the map prints the command:
#
#   & ([scriptblock]::Create((irm https://kit.example.com/join/windows.ps1))) <code> https://kit.example.com
#
# Optional: $env:KITSHN_DAEMON (a local kitshn.exe instead of the release download).
param([string]$Code, [string]$Server)
$ErrorActionPreference = 'Stop'
if (-not $Code -or -not $Server) { throw 'usage: & ([scriptblock]::Create((irm <kitshn address>/join/windows.ps1))) <code> <kitshn address>' }
# K-622: the daemon runs as this user. Tasks that an administrator window makes carry an access list that the user's
# normal token cannot use, so the daemon would be denied. An elevated window stops here, before anything changes.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'kitshn: run this in a normal PowerShell window, not as administrator.'
}
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw "kitshn: no Windows daemon for the CPU $($env:PROCESSOR_ARCHITECTURE) (K-620)." }

$bin = Join-Path $env:LOCALAPPDATA 'Programs\kitshn'
New-Item -ItemType Directory -Force $bin | Out-Null
$next = Join-Path $bin 'kitshn.new.exe'
if ($env:KITSHN_DAEMON) {
  Copy-Item $env:KITSHN_DAEMON $next -Force
} else {
  # K-617: the release that this kitshn names, checked against its SHA256SUMS before it is unpacked.
  $version = (Invoke-RestMethod "$Server/join/version").ToString().Trim()
  if ($version -notmatch '^[0-9a-f]{12}$') { throw "kitshn: $Server names no release ($version), so there is no daemon to download." }
  $base = "https://github.com/Yarden-zamir/kitshn/releases/download/edge-$version"
  $file = 'kitshn-windows-x64.exe.gz'
  $packed = Join-Path $bin $file
  Write-Host "Downloading the kitshn daemon of release $version"
  Invoke-WebRequest "$base/$file" -OutFile $packed -UseBasicParsing
  # GitHub serves SHA256SUMS as application/octet-stream, so .Content would be bytes, not text, in PowerShell 5.1
  # and 7. The file is read as UTF-8 text instead; Trim drops the CR of a CRLF line.
  $sumsFile = Join-Path $bin 'SHA256SUMS'
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sumsFile -UseBasicParsing
  $sums = [IO.File]::ReadAllText($sumsFile, [Text.Encoding]::UTF8)
  Remove-Item $sumsFile -Force
  $expected = $null
  foreach ($line in $sums.Split("`n")) {
    $parts = $line.Trim() -split '\s+\*?'
    if ($parts.Count -eq 2 -and $parts[1] -eq $file) { $expected = $parts[0].ToLower(); break }
  }
  $actual = (Get-FileHash $packed -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    Remove-Item $packed -Force
    $named = if ($expected) { $expected } else { 'no line for this file' }
    throw "kitshn: $file of release $version has the SHA-256 $actual, but its SHA256SUMS says $named."
  }
  $in = [IO.File]::OpenRead($packed)
  $out = [IO.File]::Create($next)
  try { (New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)).CopyTo($out) }
  finally { $out.Close(); $in.Close() }
  Remove-Item $packed -Force
}
$exe = Join-Path $bin 'kitshn.exe'
# A running daemon keeps its .exe open; Windows renames it but does not overwrite it (K-620).
# The name of each old copy is its own, so an old copy that still runs never blocks this; the daemon deletes them.
if (Test-Path $exe) { Move-Item $exe (Join-Path $bin "kitshn.old-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).exe") }
Move-Item $next $exe -Force

& $exe join $Code --server $Server
if ($LASTEXITCODE -ne 0) { throw 'kitshn: the join failed.' }
& $exe service install
if ($LASTEXITCODE -ne 0) { throw 'kitshn: the daemon task could not start.' }
# K-618: the skill for coding agents on this machine. A failure here stops no join.
& $exe skill install
if ($LASTEXITCODE -ne 0) { Write-Warning "kitshn: the skill was not installed; run $exe skill install later." }
# The user Path gets the folder; only windows that open after this see it.
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$path;$bin", 'User') }
Write-Host "Done. kitshn is at $exe"
Write-Host "In this window, run it by that full path. A new PowerShell window also knows the short name kitshn."
Write-Host "To remove kitshn from this machine: kitshn service uninstall"
