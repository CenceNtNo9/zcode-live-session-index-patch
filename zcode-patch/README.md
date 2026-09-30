# ZCode 3.14.3 live session index patch

[完整中文说明 / Chinese guide](README.zh-CN.md)

This package contains a portable Windows Apply/Rollback patch for one exact ZCode 3.14.3.7762 build, plus the source patch and independent verification tools. Copying the folder alone does not activate the patch: Apply must atomically replace the matching app.asar, then restart ZCode.

## Problems fixed and current limits

Store-backed summaries can reach the Host while their sessions have no active Desktop runtime record. This patch establishes missing task-index membership through the existing Repo, retains pending admission after post-seed grouping/read failures (including another read failure during retry), admits a first useful title arriving with terminal transition, and preserves local fields and deletion authority. Deployment adds exact-build gates, verified originals, idempotence and atomic recovery; the lint reproducer now propagates its actual exit code.

The source patch covers CLI SQLite external invalidation/v4 index propagation and the source Host syncer. Portable Apply replaces only the frozen Host entry in app.asar and preserves the installed EXE/CLI/unpacked resources; it does not build or install the source patch. The two Repo interfaces and pin-race behavior are independently tested, as described below and in the Chinese guide.

Only one frozen Windows x64 build is accepted. Real installation Apply/Rollback, GUI/provider behavior and complete end-to-end Desktop timing were not run; installation tests use copied Temp fixtures and provider-free synthetic events. An already-applied Review7 without a verified original backup cannot Rollback. The upstream lint baseline still reports four max-lines errors and seven spread/fallback warnings (exit 1): no known functional or obvious performance issue has been identified from those diagnostics, and broad core-file refactoring is deferred to later maintenance. This is not a claim of a clean lint run.

## Install in a matching Windows installation

1. Install **Node.js 24.14.0 or later** and ensure node.exe is on PATH. Portable Apply/Rollback uses only Node builtins and the built-in Windows PowerShell; it needs no npm install, source checkout or download.
2. Extract this ZIP so the folder sits directly under the installation root: `<ZCode root>/zcode-patch/Apply.cmd`, next to `ZCode.exe` and `resources/`. Paths containing spaces or Chinese characters are supported. Keep the complete folder layout.
3. Close this installation's Desktop and CLI processes. Double-click **Apply.cmd**. It refuses running processes and never kills them. A successful result says PASS Apply; restart the application afterward.
4. To restore the exact original archive, close the same processes and double-click **Rollback.cmd**.

A read-only preflight is available from any current directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<ZCode root>/zcode-patch/Invoke-ZCodePatch.ps1" -Mode Apply -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<ZCode root>/zcode-patch/Invoke-ZCodePatch.ps1" -Mode Rollback -CheckOnly
```

CheckOnly performs no filesystem writes. The cmd entries set execution policy only for their child PowerShell process. EXE/CLI, original or candidate ASAR, Host, companion entries and text payload have exact fingerprint gates; unknown builds stop. Local drive paths are required; links, junctions, reparse and device paths are refused. Only `resources/app.asar` is replaced; adjacent unpacked resources are preserved. Apply saves a verified original once at `resources/.zcode-patch-backup/original.asar`, never overwrites an existing backup, stages on the same volume, checks again before File.Replace, and verifies the final archive. A post-replacement failure restores the verified pre-operation archive; stages are removed. An interrupted run before cleanup may leave a stage or lock; inspect it before retrying, never treat it as the verified backup.

Apply and Rollback are idempotent. If this installation already contains the exact Review7 archive but lacks this package's original backup, Apply identifies it as already applied without creating a false original backup. Rollback (including its CheckOnly) refuses until a separately retained, verified D836 original is explicitly placed at the backup path above. The tool does not search historical or machine-specific backup locations. Never put the Review7 candidate at that path.

The package-local `.gitattributes` disables Git text/line-ending conversion for every shipped file (`* -text`). Package text uses LF; cmd entries use CRLF and have a local `whitespace=cr-at-eol` attribute so Git whitespace checks accept their required carriage returns. `package-files.sha256` and the portable payload gate verify raw bytes. Keep the published files unchanged: do not edit, reformat or convert the line endings/encoding of `portable/review7-spans.json` or other package files.

The runtime must still be tested after Apply; static fingerprints and isolated synthetic tests do not certify every provider or GUI path.

## Upstream and license

The upstream source repository is [zai-org/ZCode](https://github.com/zai-org/ZCode). The upstream source baseline is ZCode v3.14.3 at commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`. The package includes the zero-context source patch `zcode-v3.14.3-live-session-index.patch` and a verifier that checks it against that exact Git base. ZCode's upstream `Apache-2.0` license is included as `LICENSE-APACHE-2.0` and applies to the upstream patch and ZCode-derived patch material in the verification tools.

`LICENSE-MIT` applies only to the original packaging and verification tooling and documentation in this package, copyright 2026 Contributors. Where a file contains both original tooling and ZCode-derived material, the Apache-2.0 terms also apply to the derived material.

## Contents

- `zcode-v3.14.3-live-session-index.patch` — upstream source changes for the CLI session index and its tests.
- `package-files.sha256` — SHA-256 for every other shipped file, using package-relative names.
- `Apply.cmd`, `Rollback.cmd`, `Invoke-ZCodePatch.ps1` and `portable/` — exact-build offline deployment and synthetic installation tests. The two-span payload is small text generated by the reviewed Host AST patcher, not a compiled Host binary.
- `verification/upstream/verify-zcode-patch-against-base.mjs` — checks the patch in a disposable clone under the system Temp directory and compares the result with a patched source checkout.
- `verification/repro/` — source-only lint and synthetic cross-process session-index checks. The cross-process fixture writes only synthetic data under Temp; it does not call a model or access real sessions.
- `verification/installed-host-membership/` — creates and tests the Review7 Host entry candidate from the exact frozen Host and archive fingerprints below.
- `verification/installed-host-asar/` — composes the candidate Host entry into a disposable ASAR and independently checks its archive layout, preserved entries, payload, and fingerprints.
- `verification/isolated-host-runtime/` — optional Windows smoke harness for a copied runtime under a unique Temp directory. Its API guards are process-local instrumentation, not an OS-level sandbox.

The archived baseline and all compiled Host/app binaries are intentionally omitted. The Review7 gates accept only these frozen artifacts:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Original `app.asar` | 326,915,059 | `D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C` |
| Original `out/host/index.js` | 1,497,917 | `A339D8142ED19ABFBAB75AF6F8464D98C95042CA87C0B129D2E6300F12D39899` |
| Review7 Host candidate | 1,499,553 | `54DEFA873C82EC6CDEF229760B57F5448EA08365C922ACD977F0C1E52C6B0EA2` |
| Composed candidate `app.asar` | 328,414,612 | `6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD` |

The Host tools also pin the session-index schema, TaskIndexRepo, worker, build metadata, entry count, and original packed-payload bytes. A different build stops at the fingerprint gates; this package does not claim compatibility with other ZCode releases or builds.

## Reproducing the source patch

Use a disposable ZCode source checkout with Node.js 24.14.0 or later, Git and pnpm 10.33.2. Obtain the official source and dependencies separately; portable deployment above does not require them. Apply the patch to the exact base:

```powershell
git clone https://github.com/zai-org/ZCode.git <zcode-source>
git -C <zcode-source> checkout --detach 29628c9acdb81b703bbd4080c207a0e7ce5e276e
git -C <zcode-source> apply --unidiff-zero --check <package>/zcode-v3.14.3-live-session-index.patch
git -C <zcode-source> apply --unidiff-zero <package>/zcode-v3.14.3-live-session-index.patch
node <package>/verification/upstream/verify-zcode-patch-against-base.mjs --source-root <zcode-source>
Set-Location <zcode-source>
pnpm install --frozen-lockfile
pnpm run build:bootstrap
pnpm --dir apps/zcode-cli build
node --import tsx --test packages/services/test/zcodeTaskIndexSyncerLiveMembership.test.ts
node node_modules/typescript/bin/tsc -b packages/shared packages/rpc packages/services --pretty false
```

The verifier requires the source checkout's `HEAD` to remain at the baseline commit and the patch changes to be present in its working tree. It creates a shared, detached clone in system Temp, applies the package patch there, compares all ten changed files, then removes the temporary clone. It does not add or remove a worktree in the supplied source checkout.

The source membership tests exercise the real public TaskIndexRepo and a provider-free v4 producer: retry after seed, grouping and repeated reads, terminal first title, local fields, pin and tombstone races, and idempotence. The source repo keeps getTaskRow private; this patch calls public methods only. A newly inserted row pinned during admission remains visible via its public task list and emits task_created once; the compiled Review7 helper retains its separate frozen-build eligibility behavior.

The optional CLI checks require the relevant ZCode dependencies and built CLI output:

```powershell
node <package>/verification/repro/repro-oxlint-cli-scope.mjs --source-root <zcode-source>
node <package>/verification/repro/repro-sessions-index-cross-process.mjs --source-root <zcode-source>
```

On the exact v3.14.3 checkout used to prepare this package, the lint command completed analysis with exit code 1: it reported four `max-lines` errors and seven warnings about unnecessary spreads/fallbacks. The wrapper propagates the lint subprocess exit code (1), including those findings; this package does not change those upstream lint findings.

The cross-process fixture expects the v3.14.3 / CLI 0.16.9 source layout and built `dist` files. It uses two local synthetic processes and temporary SQLite data only.

## Reproducing the Review7 Host candidate

The Host patcher needs the exact original `app.asar`, a standalone extraction of its `out/host/index.js`, and the ZCode v3.14.3 source checkout containing the verified `typescript` 6.0.2 and `@electron/asar` 3.4.1 dependencies. Pass the archive and Host entry through an explicit read-only `--input-root`; keep them outside the installed application directory. Every generated candidate and report is confined to a new unique system Temp directory.

Example PowerShell setup (replace the two input copies with files from the exact baseline build):

```powershell
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("zcode-patch-package-" + [Guid]::NewGuid().ToString("N"))
$InputRoot = "<read-only-folder-with-frozen-baseline-files>"
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
$Archive = Join-Path $InputRoot "app.asar"
$BaselineHost = Join-Path $InputRoot "host-index-original.js"
```

Set `$InputRoot` to a read-only directory containing the original archive and its extracted Host entry. The scripts require explicit paths, check that both inputs remain inside `$InputRoot` without reparse points, and verify exact byte lengths, SHA-256 values, and equality between the Host file and archived Host entry. Candidate files, ASAR outputs, and reports are created only under `$TempRoot`.

```powershell
node <package>/verification/installed-host-membership/patch-installed-host-membership.mjs `
  --runtime-root <zcode-source> --input-root $InputRoot --archive $Archive `
  --baseline-host $BaselineHost --temp-root $TempRoot
node <package>/verification/installed-host-membership/test-installed-host-membership.mjs `
  --runtime-root <zcode-source> --input-root $InputRoot --archive $Archive `
  --baseline-host $BaselineHost --temp-root $TempRoot
```

Then compose and independently verify the ASAR candidate:

```powershell
$CandidateHost = Join-Path $TempRoot "host-index-installed-membership.candidate.js"
$OutputDir = Join-Path $TempRoot "installed-host-asar-review7"
$CandidateArchive = Join-Path $OutputDir "app.installed-membership-review7.candidate.asar"
$Report = Join-Path $OutputDir "app.installed-membership-review7.report.json"
node <package>/verification/installed-host-asar/compose-installed-host-asar-candidate.mjs `
  --runtime-root <zcode-source> --input-root $InputRoot --archive $Archive `
  --candidate-host $CandidateHost --temp-root $TempRoot
node <package>/verification/installed-host-asar/verify-installed-host-asar-candidate.mjs `
  --runtime-root <zcode-source> --input-root $InputRoot --archive $Archive `
  --candidate-host $CandidateHost --candidate-archive $CandidateArchive `
  --report $Report --temp-root $TempRoot
```

Both ASAR tools require the unique `zcode-patch-package-<32 hex characters>` Temp root and keep generated files below it. The frozen archive is a read-only input under `$InputRoot`; the candidate Host input must already be under `$TempRoot`. Neither tool replaces or modifies an installed app.

## Optional isolated runtime smoke

This requires PowerShell 7, Node.js, exact x64 product resources/EXE, @electron/asar 3.4.1 and the official Electron 41.0.3 Windows x64 ZIP. Supply local paths explicitly; no automatic download occurs. Electron ZIP SHA-256 must be 93346B31DFCD779C4C4CDFDFB2E3F9642E7A9888E388A8971FF3E95DBF948887. The runner's JavaScript guards are process-local instrumentation, not an OS-level sandbox; native/OS network paths are not guaranteed blocked.

Run these preparation and preflight/Host commands in PowerShell 7 after candidate composition above. AsarModule must be its physical package directory (resolve links before passing it). ProductResources and ProductExe may point to a verified installation copy; the runner treats them as inputs.

```powershell
$Package = "<package>"
$ProductResources = "<verified-copy>/resources"
$ProductExe = "<verified-copy>/ZCode.exe"
$AsarModule = "<physical-@electron/asar-3.4.1-directory>"
$ElectronZip = "<local-folder>/electron-v41.0.3-win32-x64.zip"
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("zcode-isolated-host-runtime-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
Copy-Item -LiteralPath $ElectronZip -Destination (Join-Path $SmokeRoot 'electron-v41.0.3-win32-x64.zip')
Expand-Archive -LiteralPath (Join-Path $SmokeRoot 'electron-v41.0.3-win32-x64.zip') -DestinationPath (Join-Path $SmokeRoot 'electron-runtime')
New-Item -ItemType Directory -Path (Join-Path $SmokeRoot 'candidate') | Out-Null
Copy-Item -LiteralPath $CandidateArchive -Destination (Join-Path $SmokeRoot 'candidate/app.asar')
Copy-Item -LiteralPath (Join-Path $ProductResources 'app.asar.unpacked') -Destination (Join-Path $SmokeRoot 'candidate/app.asar.unpacked') -Recurse
$RunId = [Guid]::NewGuid().ToString('N')
$Common = @{ TempRoot=$SmokeRoot; InstalledResources=$ProductResources; InstalledExe=$ProductExe; AsarModule=$AsarModule; Variant='Candidate'; RunId=$RunId }
& (Join-Path $Package 'verification/isolated-host-runtime/Invoke-ZCodeIsolatedHostSmoke.ps1') @Common -Mode PreflightOnly
$PreflightResult = Join-Path $SmokeRoot ("runs/" + $RunId + "/preflight-result.json")
$Preflight = Get-Content -LiteralPath $PreflightResult -Raw | ConvertFrom-Json
if ($Preflight.status -ne 'pass') { throw 'Preflight failed' }
& (Join-Path $Package 'verification/isolated-host-runtime/Invoke-ZCodeIsolatedHostSmoke.ps1') @Common -Mode Host -PreflightResultPath $PreflightResult -ExpectedPreflightFingerprint $Preflight.fingerprint
```

The Host command must reuse the same RunId, exact preflight result path and fingerprint. Changing input content invalidates it. For Original, select Variant='Original' and a fresh RunId; candidate preparation then is not used.

## Verification boundaries

No ASAR/EXE, full compiled Host, user data, deployment log or machine-specific historical failed 0111/FCAF deployment tool is shipped. Review7 has fixed gates for the exact build only; apply does not generalize to another build bearing the same version number. The source-only patch and frozen compiled patch are two independently checked deliverables.

To exercise deployment on a disposable installation (it never applies to the supplied EXE/CLI locations):

```powershell
node <package>/portable/test-portable.mjs --original <frozen-original-app.asar> --exe <matching-ZCode.exe> --cli <matching-resources/glm/zcode.cjs>
node <package>/portable/test-checkout-bytes.mjs --original <frozen-original-app.asar> --exe <matching-ZCode.exe> --cli <matching-resources/glm/zcode.cjs>
```

The test copies all inputs into a new system Temp installation with Chinese and space characters, checks no-write preflight, unknown hashes, tampered spans/backup, preapplied archives without backups, process and junction refusal, Apply/Rollback hashes and idempotence, locked-target atomic failure cleanup, recovery after an injected post-replacement fingerprint failure, and cmd entries invoked from an unrelated current directory. It deletes its own unique Temp root afterward.

The checkout-bytes test requires Git for its temporary repository only. It commits the package in system Temp, clones with `core.autocrlf=true`, checks the temporary staged diff and raw index blobs, compares every file byte/line ending and SHA manifest entry after checkout, then checks portable preflight and exact Review7 composition from the fresh checkout. It changes no Git settings or commits in the supplied source/package repository.

## Basic file checks

```powershell
Get-ChildItem <package> -Recurse -File -Include *.mjs,*.cjs | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($_.Name)" }
}
Get-ChildItem <package> -Recurse -File -Filter *.ps1 | ForEach-Object {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw "PowerShell syntax check failed: $($_.Name)" }
}
```
