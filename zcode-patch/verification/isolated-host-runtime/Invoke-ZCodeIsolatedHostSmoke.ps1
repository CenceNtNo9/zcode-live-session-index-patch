[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TempRoot,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstalledResources,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstalledExe,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AsarModule,
  [int]$TimeoutSeconds = 240,
  [ValidateSet('PreflightOnly', 'Host')][string]$Mode = 'PreflightOnly',
  [ValidateSet('Original', 'Candidate')][string]$Variant = 'Original',
  [string]$RunId,
  [string]$PreflightResultPath,
  [string]$ExpectedPreflightFingerprint
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'This isolated runner requires PowerShell 7' }
$ExpectedArchiveHash = 'D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C'
$ExpectedHostHash = 'A339D8142ED19ABFBAB75AF6F8464D98C95042CA87C0B129D2E6300F12D39899'
$ExpectedElectronZipHash = '93346B31DFCD779C4C4CDFDFB2E3F9642E7A9888E388A8971FF3E95DBF948887'
$ExpectedElectronExeHash = 'C3FF0B19217C3F3521BD392899CFFA65B0F0C0AAE500EE0291E85490A52327D4'
$ExpectedElectronVersion = '41.0.3'
$ExpectedZCodeVersion = '3.14.3.7762'
$ExpectedInstalledExeHash = 'A21B8D878F7B969C34AEE965A31070A7AE234866A46F953C8317C8C5A86CB6B0'
$ExpectedMachine = 0x8664

function Assert-ContainedPath([string]$Candidate, [string]$Base, [string]$Label) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\')
  if (-not $candidateFull.Equals($baseFull, [StringComparison]::OrdinalIgnoreCase) -and
      -not $candidateFull.StartsWith($baseFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its authorized root"
  }
  return $candidateFull
}

function Get-PeMachine([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset
    $signature = $reader.ReadBytes(4)
    if ([Text.Encoding]::ASCII.GetString($signature) -ne "PE`0`0") { throw 'Invalid PE signature' }
    return [int]$reader.ReadUInt16()
  } finally {
    $stream.Dispose()
  }
}

function Test-AsciiMarker([string]$Path, [string]$Marker) {
  $needle = [Text.Encoding]::ASCII.GetBytes($Marker)
  $stream = [IO.File]::OpenRead($Path)
  try {
    $chunk = [byte[]]::new(1048576)
    $carry = [byte[]]::new(0)
    while (($read = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
      $combined = [byte[]]::new($carry.Length + $read)
      [Buffer]::BlockCopy($carry, 0, $combined, 0, $carry.Length)
      [Buffer]::BlockCopy($chunk, 0, $combined, $carry.Length, $read)
      if ([Text.Encoding]::ASCII.GetString($combined).Contains($Marker)) { return $true }
      $keep = [Math]::Min($needle.Length - 1, $combined.Length)
      $carry = [byte[]]::new($keep)
      if ($keep -gt 0) { [Buffer]::BlockCopy($combined, $combined.Length - $keep, $carry, 0, $keep) }
    }
    return $false
  } finally {
    $stream.Dispose()
  }
}

function Get-TreeDigest([string]$Directory) {
  $base = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $items = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($base)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $current -Force) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Product resource tree contains a reparse point; refusing to follow it'
      }
      if ($entry.PSIsContainer) {
        $pending.Push($entry.FullName)
        continue
      }
      $relative = [IO.Path]::GetRelativePath($base, $entry.FullName).Replace('\', '/')
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.FullName).Hash.ToUpperInvariant()
      $items.Add("$relative|$($entry.Length)|$hash")
    }
  }
  $ordered = @($items | Sort-Object -CaseSensitive)
  $bytes = [Text.Encoding]::UTF8.GetBytes(($ordered -join "`n"))
  $sha = [Security.Cryptography.SHA256]::HashData($bytes)
  return [pscustomobject]@{
    Count = $ordered.Count
    Bytes = ($items | ForEach-Object { [long](($_ -split '\|')[1]) } | Measure-Object -Sum).Sum
    Sha256 = [Convert]::ToHexString($sha)
  }
}

function Test-UnderTempRoot([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $full.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or
    $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $volume = [IO.Path]::GetPathRoot($full)
  $current = $volume
  $relative = $full.Substring($volume.Length)
  foreach ($segment in ($relative -split '[\\/]')) {
    if (-not $segment) { continue }
    $current = Join-Path $current $segment
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A fixed smoke input or output path contains a reparse point'
      }
    }
  }
}

function Assert-NoReparseTree([string]$Directory) {
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push([IO.Path]::GetFullPath($Directory))
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $current -Force) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A fixed smoke directory contains a reparse point'
      }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
    }
  }
}

$root = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if (-not (Test-UnderTempRoot $root $systemTemp)) { throw 'TempRoot is not below the system Temp directory' }
if ((Split-Path -Leaf $root) -notmatch '^zcode-isolated-host-runtime-[0-9a-f]{32}$') {
  throw 'TempRoot must be the unique zcode-isolated-host-runtime GUID directory'
}
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'The pre-created unique TempRoot is missing' }
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'TempRoot is a reparse point; refusing to use it'
}
if (-not $RunId) { $RunId = [Guid]::NewGuid().ToString('N') }
if ($RunId -notmatch '^[0-9a-fA-F]{32}$') { throw 'RunId must be a unique 32-character GUID without separators' }
$RunId = $RunId.ToLowerInvariant()
$runDir = Join-Path $root "runs\$RunId"
$preflightResult = Join-Path $runDir 'preflight-result.json'
$hostResult = Join-Path $runDir 'host-result.json'
if ($Mode -eq 'PreflightOnly' -and (Test-Path -LiteralPath $preflightResult)) {
  throw 'PreflightOnly requires a fresh RunId; refusing to reuse an earlier result'
}

$resources = [IO.Path]::GetFullPath($InstalledResources).TrimEnd('\')
$appArchive = Join-Path $resources 'app.asar'
if ($Variant -eq 'Candidate') {
  $appArchive = Join-Path $root 'candidate\app.asar'
  $ExpectedArchiveHash = '6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD'
  $ExpectedHostHash = '54DEFA873C82EC6CDEF229760B57F5448EA08365C922ACD977F0C1E52C6B0EA2'
}
$builtinConfigSource = Join-Path $resources 'config\provider\zcode-builtin.json'
$glmSource = Join-Path $resources 'glm'
$electronExePath = Join-Path $root 'electron-runtime\electron.exe'
$electronZipPath = Join-Path $root 'electron-v41.0.3-win32-x64.zip'
$runtimeRoot = Join-Path $root 'electron-runtime'
$runtimeResources = Join-Path $runtimeRoot 'resources'
$runtimeConfig = Join-Path $runtimeResources 'config\provider\zcode-builtin.json'
$runtimeGlm = Join-Path $runtimeResources 'glm'
$appStage = Join-Path $root 'app-stage'
$appArchivePath = Join-Path $root 'isolated-app.asar'
$rpcDir = Join-Path $root 'rpc'
$preparedPath = Join-Path $runDir 'prepared-integrity.json'
$guardPath = Join-Path $root 'network-guard.cjs'
$probePath = Join-Path $root 'probe-child.cjs'
$hostEntryPath = "$appArchive\out\host\index.js"
$preparePath = Join-Path $root 'prepare-isolated-app.cjs'
$asarModule = [IO.Path]::GetFullPath($AsarModule)
$scriptDir = $PSScriptRoot
$nodeExe = (Get-Command node -ErrorAction Stop).Source

foreach ($path in @($appArchive, $builtinConfigSource, $glmSource, $electronExePath, $electronZipPath, $asarModule, $nodeExe)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required static input is missing: $path" }
}
$asarManifest = Get-Content -LiteralPath (Join-Path $asarModule 'package.json') -Raw | ConvertFrom-Json
if ($asarManifest.version -ne '3.4.1') { throw 'The isolated runner requires @electron/asar 3.4.1' }
foreach ($path in @($root, $resources, $InstalledExe, $asarModule, $scriptDir)) { Assert-NoReparsePath $path }
Assert-NoReparseTree $root
Assert-NoReparseTree $glmSource
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $appArchive).Hash.ToUpperInvariant() -ne $ExpectedArchiveHash) {
  throw 'Selected app.asar does not match its frozen variant fingerprint'
}
$unpackedDigest = $null
if ($Variant -eq 'Candidate') {
  $unpackedSource = Join-Path $resources 'app.asar.unpacked'
  $unpackedCandidate = $appArchive + '.unpacked'
  Assert-NoReparsePath $unpackedSource
  Assert-NoReparseTree $unpackedSource
  $unpackedSourceDigest = Get-TreeDigest $unpackedSource
  $unpackedDigest = Get-TreeDigest $unpackedCandidate
  if ($unpackedDigest.Sha256 -ne $unpackedSourceDigest.Sha256 -or $unpackedDigest.Count -ne $unpackedSourceDigest.Count) {
    throw 'Candidate adjacent unpacked product dependencies differ from the verified installation'
  }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $electronZipPath).Hash.ToUpperInvariant() -ne $ExpectedElectronZipHash) {
  throw 'Official Electron release ZIP hash does not match the verified release digest'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $electronExePath).Hash.ToUpperInvariant() -ne $ExpectedElectronExeHash) {
  throw 'Extracted Electron executable does not match the verified local executable hash'
}

$zcodeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($InstalledExe).FileVersion
$zcodeMachine = Get-PeMachine $InstalledExe
$electronMachine = Get-PeMachine $electronExePath
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledExe).Hash -ne $ExpectedInstalledExeHash) {
  throw 'Installed ZCode executable fingerprint differs from the verified build'
}
if ($zcodeVersion -ne $ExpectedZCodeVersion -or $zcodeMachine -ne $ExpectedMachine) {
  throw 'Installed ZCode executable is not the verified x64 3.14.3.7762 build'
}
if ($electronMachine -ne $ExpectedMachine -or -not (Test-AsciiMarker $InstalledExe 'Electron/41.0.3')) {
  throw 'Installed executable does not statically identify Electron 41.0.3 x64'
}

foreach ($directory in @($root, $runDir, $runtimeResources, $appStage, $rpcDir, (Split-Path -Parent $runtimeConfig), (Join-Path $root 'work'), (Join-Path $root 'os-temp'), (Join-Path $root 'home'), (Join-Path $root 'data-home'), (Join-Path $root 'electron-userdata'), (Join-Path $root 'electron-session'), (Join-Path $root 'electron-cache'), (Join-Path $root 'electron-logs'), (Join-Path $root 'electron-appdata'), (Join-Path $root 'electron-localappdata'), (Join-Path $root 'programdata'), (Join-Path $root 'crash-dumps'))) {
  $safeDirectory = Assert-ContainedPath $directory $root 'directory'
  [void](New-Item -ItemType Directory -Force -Path $safeDirectory)
}

if (-not (Test-Path -LiteralPath $runtimeGlm -PathType Container)) {
  $safeGlm = Assert-ContainedPath $runtimeGlm $root 'runtime GLM resource directory'
  Copy-Item -LiteralPath $glmSource -Destination $safeGlm -Recurse
}
$sourceGlmDigest = Get-TreeDigest $glmSource
$runtimeGlmDigest = Get-TreeDigest $runtimeGlm
if ($sourceGlmDigest.Sha256 -ne $runtimeGlmDigest.Sha256 -or $sourceGlmDigest.Count -ne $runtimeGlmDigest.Count) {
  throw 'Staged GLM resource tree does not match the read-only installed product resource tree'
}

$safeConfig = Assert-ContainedPath $runtimeConfig $root 'runtime built-in provider config'
if (-not (Test-Path -LiteralPath $safeConfig -PathType Leaf)) {
  Copy-Item -LiteralPath $builtinConfigSource -Destination $safeConfig
}
$configSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $builtinConfigSource).Hash.ToUpperInvariant()
$configTempHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $safeConfig).Hash.ToUpperInvariant()
if ($configSourceHash -ne $configTempHash) { throw 'Staged product provider config hash differs from the installed static product resource' }

Copy-Item -LiteralPath (Join-Path $scriptDir 'network-guard.cjs') -Destination (Assert-ContainedPath $guardPath $root 'guard') -Force
Copy-Item -LiteralPath (Join-Path $scriptDir 'probe-child.cjs') -Destination (Assert-ContainedPath $probePath $root 'probe') -Force
Copy-Item -LiteralPath (Join-Path $scriptDir 'host-smoke-main.cjs') -Destination (Join-Path $appStage 'main.cjs') -Force
$packageJson = [ordered]@{ name = 'zcode-isolated-host-smoke'; version = '1.0.0'; main = 'main.cjs' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $appStage 'package.json'), $packageJson, [Text.UTF8Encoding]::new($false))

$prepareScript = @'
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require(process.argv[2]);
const archive = process.argv[3];
const root = process.argv[4];
const appStage = process.argv[5];
const appAsar = process.argv[6];
const expectedArchiveHash = process.argv[7];
const expectedHostHash = process.argv[8];
const runDir = process.argv[9];
const expectedAppVersion = "3.14.3";
const expectedArchiveDigest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex").toUpperCase();
if (expectedArchiveDigest !== expectedArchiveHash) throw new Error("archive hash mismatch");
const entries = asar.listPackage(archive);
const hostEntry = entries.find((item) => item.replaceAll("/", "\\").endsWith("out\\host\\index.js"));
const rpcEntry = entries.find((item) => item.includes("chunk-BMP2VTTL.js"));
const helperEntry = entries.find((item) => item.includes("chunk-HH7N2YVI.js"));
const packageEntry = entries.find((item) => item.replaceAll("/", "\\") === "\\package.json");
if (!hostEntry || !rpcEntry || !helperEntry || !packageEntry) throw new Error("required archive entry missing");
const host = asar.extractFile(archive, hostEntry.replace(/^[/\\]/, ""));
const rpc = asar.extractFile(archive, rpcEntry.replace(/^[/\\]/, ""));
const helper = asar.extractFile(archive, helperEntry.replace(/^[/\\]/, ""));
const packageJson = JSON.parse(asar.extractFile(archive, packageEntry.replace(/^[/\\]/, "").replace(/^\\/, "")).toString("utf8"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
if (sha(host) !== expectedHostHash) throw new Error("verified original Host entry hash mismatch");
if (packageJson.version !== expectedAppVersion) throw new Error("installed product package version mismatch");
const rpcText = rpc.toString("utf8");
if (!rpcText.includes('import{a as i,e as c,g as l}from"./chunk-HH7N2YVI.js"')) throw new Error("RPC dependency shape mismatch");
if (!rpcText.includes("export{f as a,u as b,N as c,F as d,A as e,G as f};") ||
    !rpcText.includes("SocketProtocol") || !rpcText.includes("MessagePortProtocol") || !rpcText.includes("ChannelClient")) {
  throw new Error("installed RPC export mapping or protocol class markers mismatch");
}
const helperText = helper.toString("utf8");
if (/^\s*import(?:\s|[{'"*])/m.test(helperText)) throw new Error("installed RPC helper unexpectedly has an external import");
const rpcDir = path.join(root, "rpc");
fs.mkdirSync(rpcDir, { recursive: true });
fs.writeFileSync(path.join(rpcDir, "chunk-BMP2VTTL.js"), rpc);
fs.writeFileSync(path.join(rpcDir, "package.json"), JSON.stringify({ type: "module" }));
fs.writeFileSync(path.join(rpcDir, "chunk-HH7N2YVI.js"), helper);
asar.createPackage(appStage, appAsar).then(() => {
  const metadata = {
    archiveSha256: expectedArchiveDigest,
    hostEntry,
    hostEntryBytes: host.length,
    hostEntrySha256: sha(host),
    rpcEntry,
    rpcEntryBytes: rpc.length,
    rpcEntrySha256: sha(rpc),
    helperEntry,
    helperEntryBytes: helper.length,
    helperEntrySha256: sha(helper),
    rpcExportMapping: { c: "SocketProtocol", d: "MessagePortProtocol", e: "ChannelClient" },
    appPackage: { name: packageJson.name, version: packageJson.version, main: packageJson.main },
    isolatedAppAsarSha256: sha(fs.readFileSync(appAsar)),
  };
  fs.writeFileSync(path.join(runDir, "prepared-integrity.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ hostEntry: metadata.hostEntry, hostEntrySha256: metadata.hostEntrySha256, rpcEntry: metadata.rpcEntry, appVersion: packageJson.version, prepared: true }) + "\n");
}).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
'@
[IO.File]::WriteAllText($preparePath, $prepareScript, [Text.UTF8Encoding]::new($false))

$helperArgs = @($asarModule, $appArchive, $root, $appStage, $appArchivePath, $ExpectedArchiveHash, $ExpectedHostHash, $runDir)
$prepareOutput = & $nodeExe $preparePath @helperArgs
if ($LASTEXITCODE -ne 0) { throw 'Static app.asar extraction and harness packaging failed' }
$prepared = Get-Content -LiteralPath $preparedPath -Raw | ConvertFrom-Json
if ($prepared.hostEntrySha256 -ne $ExpectedHostHash -or $prepared.appPackage.version -ne '3.14.3') {
  throw 'Prepared original Host metadata failed its hash/version gate'
}

foreach ($path in @($root, $resources, $InstalledExe, $asarModule, $scriptDir)) { Assert-NoReparsePath $path }
Assert-NoReparseTree $runtimeRoot
$scriptHashes = [ordered]@{}
foreach ($name in @('network-guard.cjs', 'host-smoke-main.cjs', 'probe-child.cjs', 'Invoke-ZCodeIsolatedHostSmoke.ps1')) {
  $scriptHashes[$name] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $scriptDir $name)).Hash
}
$fingerprintInput = [ordered]@{
  root = $root; archive = $ExpectedArchiveHash; host = $ExpectedHostHash
  electronZip = $ExpectedElectronZipHash; electronExe = $ExpectedElectronExeHash
  rpc = $prepared.rpcEntrySha256; rpcHelper = $prepared.helperEntrySha256
  harness = $prepared.isolatedAppAsarSha256; scripts = $scriptHashes
  glm = $runtimeGlmDigest.Sha256; builtinConfig = $configSourceHash
  variant = $Variant; unpacked = $unpackedDigest
} | ConvertTo-Json -Depth 8 -Compress
$fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fingerprintInput)))
$resultPath = if ($Mode -eq 'PreflightOnly') { $preflightResult } else { $hostResult }
if (Test-Path -LiteralPath $resultPath) { throw 'Refusing to overwrite a previous phase result' }
if ($Mode -eq 'Host') {
  if (-not $PreflightResultPath -or -not $ExpectedPreflightFingerprint -or
      -not ([IO.Path]::GetFullPath($PreflightResultPath)).Equals($preflightResult, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Host requires the exact preceding preflight result path and fingerprint'
  }
  Assert-NoReparsePath $preflightResult
  $previous = Get-Content -LiteralPath $preflightResult -Raw | ConvertFrom-Json
  if ($previous.status -ne 'pass' -or $previous.phase -ne 'preflight' -or $previous.runId -ne $RunId -or
      $previous.fingerprint -ne $fingerprint -or $ExpectedPreflightFingerprint -ne $fingerprint -or
      $previous.hostCreated -ne $false -or $previous.rpcImported -ne $false) {
    throw 'Host requires a passing preflight from the same run and unchanged inputs'
  }
}
$denyRoot = Join-Path $systemTemp ('zcode-isolated-host-deny-' + $RunId)
Assert-NoReparsePath $denyRoot
if (Test-Path -LiteralPath $denyRoot) { throw 'Synthetic denied fixture directory already exists' }
$denyFile = Join-Path $denyRoot 'synthetic.txt'
$denyText = 'Synthetic isolated Host boundary fixture ' + $RunId

$systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
if (-not $systemRoot) { $systemRoot = $env:SystemRoot }
$envMap = [ordered]@{
  SystemRoot = $systemRoot
  WINDIR = $systemRoot
  SystemDrive = [IO.Path]::GetPathRoot($systemRoot).TrimEnd('\')
  PATH = "$runtimeRoot;$systemRoot\System32"
  TEMP = (Join-Path $root 'os-temp')
  TMP = (Join-Path $root 'os-temp')
  HOME = (Join-Path $root 'home')
  USERPROFILE = (Join-Path $root 'home')
  HOMEDRIVE = [IO.Path]::GetPathRoot($root).TrimEnd('\')
  HOMEPATH = '\' + $root.Substring(([IO.Path]::GetPathRoot($root)).Length) + '\home'
  APPDATA = (Join-Path $root 'electron-appdata')
  LOCALAPPDATA = (Join-Path $root 'electron-localappdata')
  PROGRAMDATA = (Join-Path $root 'programdata')
  XDG_CONFIG_HOME = (Join-Path $root 'config')
  XDG_CACHE_HOME = (Join-Path $root 'cache')
  XDG_DATA_HOME = (Join-Path $root 'data-home')
  NODE_ENV = 'production'
  ZCODE_ENV = 'production'
  ZCODE_DATA_BASE_DIR = (Join-Path $root 'data-home')
  ZCODE_DESKTOP_HOME_DIR = (Join-Path $root 'home')
  ZCODE_DESKTOP_USER_DATA_DIR = (Join-Path $root 'electron-userdata')
  ZCODE_DESKTOP_SESSION_DATA_DIR = (Join-Path $root 'electron-session')
  ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = '0'
  ZCODE_DESKTOP_APPLICATION_NAME = 'ZCode Isolated Host Smoke'
  ZCODE_ISOLATED_ROOT = $root
  ZCODE_ISOLATED_APP_ARCHIVE = $appArchive
  ZCODE_ISOLATED_RUNTIME_ROOT = $runtimeRoot
  ZCODE_ISOLATED_GUARD = $guardPath
  ZCODE_ISOLATED_GUARD_LOG = (Join-Path $runDir ($Mode + '-guard-events.ndjson'))
  ZCODE_ISOLATED_HOST_ENTRY = $hostEntryPath
  ZCODE_ISOLATED_BUILTIN_CONFIG = $runtimeConfig
  ZCODE_ISOLATED_EXPECTED_ELECTRON = $ExpectedElectronVersion
  ZCODE_ISOLATED_TIMEOUT_MS = [string]($TimeoutSeconds * 1000)
  ZCODE_ISOLATED_MODE = $Mode
  ZCODE_ISOLATED_RUN_ID = $RunId
  ZCODE_ISOLATED_FINGERPRINT = $fingerprint
  ZCODE_ISOLATED_PREFLIGHT_RESULT = $preflightResult
  ZCODE_ISOLATED_HOST_RESULT = $hostResult
  ZCODE_ISOLATED_DENY_FIXTURE_FILE = $denyFile
}
if ($Mode -eq 'Host') { $envMap['ELECTRON_FORCE_IS_PACKAGED'] = '1' }

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $electronExePath
$startInfo.WorkingDirectory = Join-Path $root 'work'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.EnvironmentVariables.Clear()
foreach ($entry in $envMap.GetEnumerator()) { $startInfo.EnvironmentVariables[$entry.Key] = [string]$entry.Value }
$arguments = @(
  $appArchivePath,
  "--user-data-dir=$(Join-Path $root 'electron-userdata')",
  "--disk-cache-dir=$(Join-Path $root 'electron-cache')",
  '--disable-gpu',
  '--disable-crash-reporter'
)
foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$started = $false
New-Item -ItemType Directory -Path $denyRoot | Out-Null
[IO.File]::WriteAllText($denyFile, $denyText, [Text.UTF8Encoding]::new($false))
try {
if (-not $process.Start()) { throw 'Isolated Electron runtime failed to start' }
$started = $true
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
  try { $process.Kill($true) } catch { }
  throw "Isolated Electron smoke exceeded $TimeoutSeconds seconds; process tree was terminated"
}
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
$stdoutPath = Join-Path $runDir ($Mode + '-stdout.log')
$stderrPath = Join-Path $runDir ($Mode + '-stderr.log')
[IO.File]::WriteAllText($stdoutPath, $stdout, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($stderrPath, $stderr, [Text.UTF8Encoding]::new($false))

if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
  throw 'Isolated smoke produced no result record; inspect only its Temp-local stderr log'
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ($result.runId -ne $RunId -or $result.fingerprint -ne $fingerprint -or
    $result.phase -ne $(if ($Mode -eq 'PreflightOnly') { 'preflight' } else { 'host' })) {
  throw 'Phase result does not belong to this exact invocation'
}
if ($process.ExitCode -ne 0 -or $result.status -ne 'pass') {
  $safeError = if ($result.error) { $result.error } else { 'isolated Host smoke failed a readiness gate' }
  throw "Isolated Host smoke failed (exit $($process.ExitCode)): $safeError"
}

$output = [ordered]@{
  status = $result.status
  mode = $Mode
  variant = $Variant
  runId = $RunId
  fingerprint = $fingerprint
  resultPath = $resultPath
  installedZCodeVersion = $zcodeVersion
  installedMachine = ('0x{0:X4}' -f $zcodeMachine)
  staticElectronMarker = '41.0.3'
  officialElectronZipSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $electronZipPath).Hash.ToUpperInvariant()
  isolatedElectronExeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $electronExePath).Hash.ToUpperInvariant()
  appArchiveSha256 = $ExpectedArchiveHash
  hostEntrySha256 = $prepared.hostEntrySha256
  glmTreeCount = $runtimeGlmDigest.Count
  glmTreeSha256 = $runtimeGlmDigest.Sha256
  host = $result.host
  guardEvents = $(if ($Mode -eq 'Host') { $result.guardEventsAfterPreflight } else { $result.guardEvents })
  assertions = $result.assertions
  evidenceRoot = $root
  unpackedDependencies = $unpackedDigest
}
$output | ConvertTo-Json -Depth 8
} finally {
  if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  Assert-NoReparsePath $denyRoot
  if (-not ([IO.File]::ReadAllText($denyFile)).Equals($denyText)) { throw 'Synthetic forbidden fixture was unexpectedly modified' }
  Remove-Item -LiteralPath $denyFile
  Remove-Item -LiteralPath $denyRoot
  $process.Dispose()
}
