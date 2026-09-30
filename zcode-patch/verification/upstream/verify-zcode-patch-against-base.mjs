import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const baseSha = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const patchPath = fileURLToPath(new URL("../../zcode-v3.14.3-live-session-index.patch", import.meta.url));
const files = [
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-external-session-index-watcher.ts",
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts",
  "apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts",
  "apps/zcode-cli/specs/sessions-index-external-invalidation.md",
  "packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts",
  "packages/services/test/zcodeTaskIndexSyncerLiveMembership.test.ts",
];

const sourceRootArg = readOption("--source-root");
assert.ok(sourceRootArg, "missing --source-root");
const sourceRoot = resolve(sourceRootArg);
const currentHead = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
assert.equal(currentHead, baseSha, "source clone HEAD differs from the recorded official base");
const patchText = await readFile(patchPath, "utf8");
const patchWhitespaceLines = patchText
  .split(/\r?\n/)
  .filter((line) => /[\t ]+$/.test(line));
assert.equal(patchWhitespaceLines.length, 0, "patch artifact contains trailing whitespace");

let tempRoot;
let checkout;
let outcome;
let failure = null;
let stage = "temporary clone creation";
try {
  tempRoot = await mkdtemp(join(resolve(tmpdir()), "zcode-live-index-patch-check-"));
  assertSafeTempRoot(tempRoot);
  checkout = join(tempRoot, "checkout");
  assertWithin(tempRoot, checkout);

  const clone = spawnSync("git", ["clone", "--shared", "--no-checkout", sourceRoot, checkout], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (clone.status !== 0) throw new Error("git_clone_failed");
  runGit(checkout, ["checkout", "--detach", baseSha]);
  stage = "positive patch apply check";
  runGit(checkout, ["apply", "--unidiff-zero", "--check", patchPath]);
  stage = "positive patch apply";
  runGit(checkout, ["apply", "--unidiff-zero", patchPath]);
  stage = "applied tree whitespace check";
  runGit(checkout, ["diff", "--check"]);

  stage = "applied tree/source content comparison";
  for (const file of files) {
    const expected = await fingerprint(join(sourceRoot, file));
    const actual = await fingerprint(join(checkout, file));
    if (actual !== expected) {
      const error = new Error("applied patch content differs from source clone");
      error.safeCode = `applied_file_mismatch:${file}`;
      throw error;
    }
  }

  outcome = {
    result: "PASS",
    baseSha,
    sourceHead: currentHead,
    appliedFiles: files.length,
    pristineBaseApplyCheck: true,
    resultingContentMatchesPatchedClone: true,
    gitDiffCheck: true,
    patchWhitespaceLineCount: patchWhitespaceLines.length,
  };
} catch (error) {
  failure = { stage, code: safeFailureCode(error) };
} finally {
  if (tempRoot) {
    try {
      assertSafeTempRoot(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      failure ??= { stage: "temporary root cleanup", code: "temp_cleanup_failed" };
    }
  }
}

process.stdout.write(`${JSON.stringify(failure ? { result: "FAIL", ...failure } : outcome)}\n`);
if (failure) process.exitCode = 1;

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = new Error("git_command_failed");
    error.safeCode = result.error?.code === "ENOENT"
      ? "git_missing"
      : `git_${args.slice(0, 2).join("_")}_failed`;
    throw error;
  }
  return result;
}

async function fingerprint(path) {
  const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  return createHash("sha256").update(content, "utf8").digest("hex").toUpperCase();
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
  assert.ok(basename(resolvedPath).startsWith("zcode-live-index-patch-check-"));
}

function safeFailureCode(error) {
  if (error?.safeCode) return error.safeCode;
  if (error?.code === "ENOENT") return "required_path_missing";
  return "assertion_or_patch_check_failed";
}
