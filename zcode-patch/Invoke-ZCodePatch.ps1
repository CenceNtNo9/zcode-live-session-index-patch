[CmdletBinding()]
param([ValidateSet('Apply','Rollback')][string]$Mode = 'Apply', [switch]$CheckOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
function File-Hash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$OriginalHash = 'D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C'
$CandidateHash = '6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD'
function Assert-Path([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.StartsWith('\\') -or $Path.Contains([char]0)) { throw 'Noncanonical/device/UNC path refused' }
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = [IO.Path]::GetPathRoot($full)
  foreach ($part in $full.Substring($cursor.Length).Split('\')) {
    if ($part) { $cursor = Join-Path $cursor $part }
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Link/junction/reparse path refused' }
  }
  return $full
}
function Assert-Hash([string]$Path, [string]$Hash, [long]$Bytes = -1) {
  [void](Assert-Path $Path)
  if (-not [IO.File]::Exists($Path)) { throw 'Required regular file missing' }
  if ($Bytes -ge 0 -and (Get-Item -LiteralPath $Path).Length -ne $Bytes) { throw 'Unexpected byte length' }
  if ((File-Hash $Path) -ne $Hash) { throw 'Unexpected fingerprint; no changes made' }
}
$package = Assert-Path $PSScriptRoot
if ((Split-Path -Leaf $package) -ne 'zcode-patch') { throw 'Place zcode-patch directly inside the ZCode installation root' }
$root = Assert-Path (Split-Path -Parent $package)
$resources = Assert-Path (Join-Path $root 'resources')
$archive = Assert-Path (Join-Path $resources 'app.asar')
$exe = Assert-Path (Join-Path $root 'ZCode.exe')
$cli = Assert-Path (Join-Path $resources 'glm\zcode.cjs')
$backupDir = Assert-Path (Join-Path $resources '.zcode-patch-backup')
$backup = Assert-Path (Join-Path $backupDir 'original.asar')
$script = Assert-Path (Join-Path $package 'portable\archive.mjs')
$payload = Assert-Path (Join-Path $package 'portable\review7-spans.json')
[void](Assert-Path (Join-Path $package 'verification\installed-host-asar\compose-installed-host-asar-candidate.mjs'))
function Assert-Stopped {
  foreach ($p in Get-CimInstance Win32_Process -ErrorAction Stop) {
    if ($p.ProcessId -eq $PID) { continue }
    $inside = $p.ExecutablePath -and ($p.ExecutablePath -ieq $exe -or $p.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase))
    $cliInside = $p.Name -match '^(node|zcode|electron)(\.exe)?$' -and $p.CommandLine -and
      ($p.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $p.CommandLine.IndexOf($root.Replace('\','/'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($inside -or $cliInside) { throw 'This installation desktop/CLI is running; close it before retrying (nothing was killed)' }
  }
}
function Run-Node([string[]]$Arguments) {
  & $node @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Archive/Host/companion gate failed' }
}
Assert-Hash $exe 'A21B8D878F7B969C34AEE965A31070A7AE234866A46F953C8317C8C5A86CB6B0'
Assert-Hash $cli 'DDAD7BD6AE4A2239FDAB8E54484E803AFCE8D3DDCFA94C23BB32DDAB11147175'
Assert-Hash $payload '6D5EDC47E5A814884C036DD01C9E786752B507DF38A32546C597722F9B2CE06A'
Assert-Stopped
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$version = & $node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'24.14.0') { throw 'Node.js 24.14.0 or later is required (no download is performed)' }
Run-Node @($script,'inspect',$archive)
$currentHash = (File-Hash $archive)
if ($currentHash -ne $OriginalHash -and $currentHash -ne $CandidateHash) { throw 'Unknown archive' }
if (Test-Path -LiteralPath $backup) { Assert-Hash $backup $OriginalHash 326915059 }
if ($currentHash -eq $CandidateHash -and -not [IO.File]::Exists($backup)) {
  if ($Mode -eq 'Rollback') { throw 'Rollback requires a verified original D836 backup at resources\.zcode-patch-backup\original.asar' }
  Write-Output 'Review7 already applied; no original backup found; Rollback unavailable'
}
if ($CheckOnly) { Write-Output ('PASS CheckOnly ' + $Mode + '; no writes'); return }
$desired = if ($Mode -eq 'Apply') { $CandidateHash } else { $OriginalHash }
if ($currentHash -eq $desired) { Write-Output ('PASS ' + $Mode + ' already satisfied'); return }
$stage = Assert-Path (Join-Path $resources ('.zcode-patch-stage-' + [Guid]::NewGuid().ToString('N') + '.asar'))
$recovery = Assert-Path (Join-Path $resources ('.zcode-patch-recovery-' + [Guid]::NewGuid().ToString('N') + '.asar'))
$lock = Assert-Path (Join-Path $resources '.zcode-patch.lock')
$lockStream = $null
$replaced = $false
try {
  $lockStream = [IO.FileStream]::new($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
  if (-not [IO.File]::Exists($backup)) {
    if ($currentHash -ne $OriginalHash) { throw 'Cannot create original backup from nonoriginal archive' }
    [void][IO.Directory]::CreateDirectory($backupDir)
    [void](Assert-Path $backupDir)
    [IO.File]::Copy($archive,$backup,$false)
  }
  Assert-Hash $backup $OriginalHash 326915059
  [IO.File]::Copy($archive,$recovery,$false)
  Assert-Hash $recovery $currentHash
  if ($Mode -eq 'Apply') { Run-Node @($script,'compose',$backup,$stage) }
  else { [IO.File]::Copy($backup,$stage,$false); Run-Node @($script,'inspect',$stage) }
  Assert-Hash $stage $desired
  Assert-Stopped
  [void](Assert-Path $archive); [void](Assert-Path $stage); [void](Assert-Path $backup); [void](Assert-Path $recovery)
  Assert-Hash $archive $currentHash
  Assert-Hash $backup $OriginalHash 326915059
  [IO.File]::Replace($stage,$archive,[NullString]::Value)
  $replaced = $true
  Assert-Hash $archive $desired
  Run-Node @($script,'inspect',$archive)
  Write-Output ('PASS ' + $Mode + '; verified atomic replacement; backup retained')
} catch {
  if ($replaced) {
    Assert-Hash $recovery $currentHash
    [void](Assert-Path $archive)
    [IO.File]::Replace($recovery,$archive,[NullString]::Value)
    Assert-Hash $archive $currentHash
  }
  throw
} finally {
  foreach ($p in @($stage,$recovery)) { if ([IO.File]::Exists($p)) { [void](Assert-Path $p); [IO.File]::Delete($p) } }
  if ($lockStream) { $lockStream.Dispose() }
}
