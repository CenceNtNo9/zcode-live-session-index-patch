import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const changedTypeScriptFiles = [
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-external-session-index-watcher.ts",
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts",
  "apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts",
];

const sourceRootArg = readOption("--source-root");
assert.ok(sourceRootArg, "missing --source-root");
const sourceRoot = resolve(sourceRootArg);
const originalConfigPath = join(sourceRoot, ".oxlintrc.json");
const oxlintPath = join(sourceRoot, "node_modules", "oxlint", "bin", "oxlint");
const originalConfig = await readFile(originalConfigPath, "utf8");
const ignoreEntry = /^([\t ]*)"apps\/zcode-cli",\r?\n/m;
assert.equal((originalConfig.match(/"apps\/zcode-cli"/g) ?? []).length, 1, "expected one CLI ignore entry");
assert.match(originalConfig, /"ignorePatterns"\s*:\s*\[/, "root lint config has no ignorePatterns");
const temporaryConfig = originalConfig.replace(ignoreEntry, "");
assert.notEqual(temporaryConfig, originalConfig, "CLI ignore entry was not removed");
assert.equal((temporaryConfig.match(/"apps\/zcode-cli"/g) ?? []).length, 0);
assert.equal(
  temporaryConfig,
  originalConfig.replace(ignoreEntry, ""),
  "temporary config contains changes beyond removing the CLI ignore entry",
);

for (const file of changedTypeScriptFiles) {
  assert.ok(!isAbsolute(file) && !file.split(/[\\/]/).includes(".."), "lint path must stay inside source root");
}

let testRoot;
let outcome;
try {
  testRoot = await mkdtemp(join(resolve(tmpdir()), "zcode-oxlint-cli-scope-"));
  assertSafeTempRoot(testRoot);
  const configPath = join(testRoot, "oxlint-cli-scope.oxlintrc.jsonc");
  assertWithin(testRoot, configPath);
  await writeFile(configPath, temporaryConfig, "utf8");

  const lint = spawnSync(
    process.execPath,
    [oxlintPath, "--config", configPath, "--disable-nested-config", "--format", "json", ...changedTypeScriptFiles],
    { cwd: sourceRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  let lintReport;
  try {
    lintReport = JSON.parse(lint.stdout ?? "");
  } catch {
    lintReport = null;
  }
  const diagnostics = Array.isArray(lintReport?.diagnostics)
    ? lintReport.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        filename: diagnostic.filename,
        line: diagnostic.labels?.[0]?.span?.line ?? null,
      }))
    : [];
  outcome = {
    result: lint.error ? "LINT_COULD_NOT_RUN" : "LINT_COMPLETED",
    configSource: ".oxlintrc.json",
    temporaryConfigOnlyRemovedIgnoreEntry: true,
    nestedConfigDisabled: true,
    oxlintVersion: await getOxlintVersion(oxlintPath, sourceRoot),
    filesRequested: changedTypeScriptFiles,
    filesReportedByOxlint: lintReport?.number_of_files ?? null,
    lintExitCode: lint.status,
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    diagnostics,
    lintStderr: (lint.stderr ?? "").trim(),
    failureCode: lint.error ? safeErrorCode(lint.error) : null,
  };
} finally {
  if (testRoot) {
    assertSafeTempRoot(testRoot);
    await rm(testRoot, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exitCode = outcome.result === "LINT_COMPLETED" ? (outcome.lintExitCode ?? 1) : 1;

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertWithin(root, candidatePath) {
  const rel = relative(resolve(root), resolve(candidatePath));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path_outside_fixture");
  }
}

function assertSafeTempRoot(path) {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  assert.equal(dirname(resolvedPath).toLowerCase(), resolvedTemp.toLowerCase());
  assert.ok(basename(resolvedPath).startsWith("zcode-oxlint-cli-scope-"));
}

function safeErrorCode(error) {
  if (error?.code === "ENOENT") return "oxlint_or_node_missing";
  return "oxlint_process_error";
}

async function getOxlintVersion(launcher, cwd) {
  const version = spawnSync(process.execPath, [launcher, "--version"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return version.status === 0 ? (version.stdout ?? "").trim() : "unavailable";
}
