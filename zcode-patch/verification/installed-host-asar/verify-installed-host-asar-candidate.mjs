import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXPECTED_ASAR_INPUTS,
  assertAbsent,
  assertArchiveFingerprint,
  assertCandidateHostFingerprint,
  assertNoReparsePath,
  assertRegularFile,
  assertTempRoot,
  assertWithin,
} from "./compose-installed-host-asar-candidate.mjs";

const hostEntryName = "out\\host\\index.js";
const integrityBlockSize = 4 * 1024 * 1024;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeRoot = resolve(requiredArg(args, "runtime-root"));
  const archivePath = resolve(requiredArg(args, "archive"));
  const candidateHostPath = resolve(requiredArg(args, "candidate-host"));
  const candidateArchivePath = resolve(requiredArg(args, "candidate-archive"));
  const reportPath = resolve(requiredArg(args, "report"));
  const tempRoot = resolve(requiredArg(args, "temp-root"));
  const inputRoot = resolve(requiredArg(args, "input-root"));
  const outputDirectory = join(tempRoot, EXPECTED_ASAR_INPUTS.outputDirectoryName);
  assertTempRoot(tempRoot);
  assertWithin(inputRoot, archivePath, "baseline archive input");
  assert.equal(candidateArchivePath.toLowerCase(), join(outputDirectory, EXPECTED_ASAR_INPUTS.outputArchiveName).toLowerCase());
  assert.equal(reportPath.toLowerCase(), join(outputDirectory, EXPECTED_ASAR_INPUTS.reportName).toLowerCase());
  assertWithin(tempRoot, candidateHostPath, "Host candidate");
  assertWithin(tempRoot, candidateArchivePath, "candidate ASAR output");
  assertWithin(tempRoot, reportPath, "candidate report output");

  assertNoReparsePath(inputRoot, inputRoot);
  assertNoReparsePath(archivePath, inputRoot);
  for (const path of [tempRoot, candidateHostPath, outputDirectory, candidateArchivePath, reportPath]) {
    assertNoReparsePath(path, tempRoot);
  }
  for (const [path, label] of [
    [archivePath, "frozen archive"],
    [candidateHostPath, "review7 Host candidate"],
    [candidateArchivePath, "candidate ASAR"],
    [reportPath, "candidate report"],
  ]) assertRegularFile(path, label);

  const requireFromRuntime = createRequire(join(runtimeRoot, "package.json"));
  const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  const asarManifest = JSON.parse(await readFile(join(runtimeRoot, "node_modules/@electron/asar/package.json"), "utf8"));
  assert.equal(runtimeManifest.name, "zcode", "runtime root must be a ZCode source checkout");
  assert.equal(runtimeManifest.version, "3.14.3", "runtime root must match ZCode 3.14.3");
  assert.equal(runtimeManifest.license, "Apache-2.0", "runtime root license metadata differs from upstream");
  assert.equal(asarManifest.version, "3.4.1", "@electron/asar version differs from the verified toolchain");
  const asar = requireFromRuntime("@electron/asar");
  const sourceArchiveStat = await stat(archivePath);
  const candidateArchiveStat = await stat(candidateArchivePath);
  const sourceArchiveSha256 = await hashFile(archivePath);
  assertArchiveFingerprint(sourceArchiveStat.size, sourceArchiveSha256);
  const candidateHostBytes = await readFile(candidateHostPath);
  assertCandidateHostFingerprint(candidateHostBytes);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.result, "PASS");
  assert.equal(report.sourceArchive.sha256, sourceArchiveSha256);
  assert.equal(report.inputHost.sha256, EXPECTED_ASAR_INPUTS.candidateHostSha256);
  assert.equal(report.outputArchive.path.toLowerCase(), candidateArchivePath.toLowerCase());
  assert.equal(report.outputArchive.bytes, candidateArchiveStat.size);
  assert.equal(report.runtime.result, "NOT_RUN");
  assert.match(report.unpackedDependencyHandling, /adjacent.*not use installed-user data/i);

  const sourceRawHeader = asar.getRawHeader(archivePath);
  const candidateRawHeader = asar.getRawHeader(candidateArchivePath);
  assert.equal(JSON.stringify(sourceRawHeader.header), sourceRawHeader.headerString, "source header is not canonical JSON");
  assert.equal(JSON.stringify(candidateRawHeader.header), candidateRawHeader.headerString, "candidate header is not canonical JSON");
  const sourceDataStart = 8 + sourceRawHeader.headerSize;
  const candidateDataStart = 8 + candidateRawHeader.headerSize;
  const sourceDataBytes = sourceArchiveStat.size - sourceDataStart;
  const expectedCandidateBytes = candidateDataStart + sourceDataBytes + candidateHostBytes.byteLength;
  assert.equal(candidateArchiveStat.size, expectedCandidateBytes, "candidate archive packed data layout changed");

  const sourceHostEntry = getHostEntry(sourceRawHeader.header);
  const candidateHostEntry = getHostEntry(candidateRawHeader.header);
  assert.equal(sourceHostEntry.unpacked, undefined, "source Host index is no longer packed");
  assert.equal(candidateHostEntry.unpacked, undefined, "candidate Host index is unexpectedly unpacked");
  assert.deepEqual(withoutHostEntry(candidateRawHeader.header), withoutHostEntry(sourceRawHeader.header), "non-Host header metadata changed");
  assert.equal(candidateHostEntry.size, candidateHostBytes.byteLength, "candidate Host header size changed");
  assert.equal(candidateHostEntry.offset, String(sourceDataBytes), "candidate Host was not appended after original packed payload");
  assert.deepEqual(candidateHostEntry.integrity, calculateIntegrity(candidateHostBytes), "candidate Host integrity record differs from input");
  assert.equal(report.changedHeaderEntry.path, "out/host/index.js");
  assert.equal(report.changedHeaderEntry.oldOffset, sourceHostEntry.offset);
  assert.equal(report.changedHeaderEntry.newOffset, candidateHostEntry.offset);

  const sourceEntries = asar.listPackage(archivePath);
  const candidateEntries = asar.listPackage(candidateArchivePath);
  assert.equal(sourceEntries.length, EXPECTED_ASAR_INPUTS.entryCount, "source ASAR entry count changed");
  assert.deepEqual(candidateEntries, sourceEntries, "candidate ASAR entry listing changed");
  assert.equal(report.sourceArchive.entryCount, sourceEntries.length);
  assert.equal(report.outputArchive.entryCount, candidateEntries.length);
  const candidateStat = asar.statFile(candidateArchivePath, hostEntryName);
  assert.equal(candidateStat.unpacked, undefined);
  const composedHostBytes = asar.extractFile(candidateArchivePath, hostEntryName);
  assert.deepEqual(composedHostBytes, candidateHostBytes, "candidate Host payload differs from review7 input");
  assertCandidateHostFingerprint(composedHostBytes);

  const sourceUnpacked = collectUnpackedReferences(sourceRawHeader.header);
  const candidateUnpacked = collectUnpackedReferences(candidateRawHeader.header);
  assert.deepEqual(candidateUnpacked, sourceUnpacked, "unpacked references changed");
  assert.equal(report.preservation.unpackedReferencesUnchanged, true);
  assert.equal(report.preservation.nonHostHeaderMetadataUnchanged, true);
  assert.equal(report.preservation.archiveEntryListingUnchanged, true);

  const companions = {};
  for (const [name, expected] of Object.entries(EXPECTED_ASAR_INPUTS.companions)) {
    const sourceBytes = asar.extractFile(archivePath, expected.path);
    const candidateBytes = asar.extractFile(candidateArchivePath, expected.path);
    assert.equal(sourceBytes.byteLength, expected.bytes, `${name} source size changed`);
    assert.equal(hashBuffer(sourceBytes), expected.sha256, `${name} source fingerprint changed`);
    assert.deepEqual(candidateBytes, sourceBytes, `${name} payload changed in candidate`);
    companions[name] = hashBuffer(candidateBytes);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.preservation.companions).map(([name, value]) => [name, value.sha256])),
    companions,
    "report companion fingerprints differ from independently extracted payloads",
  );

  const sourcePayloadPrefixSha256 = await hashRange(archivePath, sourceDataStart, sourceDataBytes);
  const candidatePayloadPrefixSha256 = await hashRange(candidateArchivePath, candidateDataStart, sourceDataBytes);
  assert.equal(candidatePayloadPrefixSha256, sourcePayloadPrefixSha256, "existing packed payload range changed");
  assert.equal(report.preservation.sourcePackedPayloadPrefixSha256, sourcePayloadPrefixSha256);
  assert.equal(report.preservation.candidatePackedPayloadPrefixSha256, candidatePayloadPrefixSha256);
  assert.equal(report.preservation.existingPackedPayloadBytesUnchanged, true);

  const candidateArchiveSha256 = await hashFile(candidateArchivePath);
  assert.equal(candidateArchiveStat.size, EXPECTED_ASAR_INPUTS.candidateArchiveBytes, "candidate ASAR byte length differs from the verified output");
  assert.equal(candidateArchiveSha256, EXPECTED_ASAR_INPUTS.candidateArchiveSha256, "candidate ASAR fingerprint differs from the verified output");
  assert.equal(candidateArchiveSha256, report.outputArchive.sha256, "candidate archive report hash mismatch");
  assert.equal(await hashFile(archivePath), sourceArchiveSha256, "frozen source archive changed during verification");
  assert.equal(await hashFile(candidateHostPath), EXPECTED_ASAR_INPUTS.candidateHostSha256, "review7 Host input changed during verification");
  const negativeGates = await runNegativeGateChecks(tempRoot, candidateHostPath, candidateArchivePath, archivePath);

  process.stdout.write(`${JSON.stringify({
    result: "PASS",
    sourceArchive: { path: archivePath, bytes: sourceArchiveStat.size, sha256: sourceArchiveSha256 },
    candidateArchive: { path: candidateArchivePath, bytes: candidateArchiveStat.size, sha256: candidateArchiveSha256 },
    hostEntry: { path: "out/host/index.js", bytes: composedHostBytes.byteLength, sha256: hashBuffer(composedHostBytes) },
    entryCount: candidateEntries.length,
    nonHostHeaderMetadataUnchanged: true,
    archiveEntryListingUnchanged: true,
    unpackedReferencesUnchanged: true,
    companions,
    existingPackedPayloadBytesUnchanged: true,
    negativeGates,
    runtime: "NOT_RUN",
  }, null, 2)}\n`);
}

async function runNegativeGateChecks(tempRoot, candidateHostPath, candidateArchivePath, archivePath) {
  assert.throws(
    () => assertArchiveFingerprint(EXPECTED_ASAR_INPUTS.archiveBytes, "0".repeat(64)),
    /frozen app.asar fingerprint changed/,
    "wrong frozen archive hash must be rejected",
  );
  const wrongHost = await readFile(candidateHostPath);
  wrongHost[0] ^= 1;
  assert.throws(() => assertCandidateHostFingerprint(wrongHost), /fingerprint changed/, "wrong Host hash must be rejected");
  assert.throws(
    () => assertWithin(tempRoot, resolve(tempRoot, "..", "escaped.asar"), "test output"),
    /escaped the authorized Temp root/,
    "output escaping the unique Temp root must be rejected",
  );
  await assert.rejects(assertAbsent(candidateArchivePath), /refusing to overwrite existing output/);
  await assert.rejects(assertAbsent(archivePath), /refusing to overwrite existing output/);
  return {
    wrongFrozenArchiveHashRejected: true,
    wrongHostHashRejected: true,
    tempEscapeRejected: true,
    existingCandidateOutputRejected: true,
    existingSourceArchiveOverwriteRejected: true,
  };
}

function getHostEntry(header) {
  const entry = header?.files?.out?.files?.host?.files?.["index.js"];
  assert.ok(entry && typeof entry === "object", "expected out/host/index.js ASAR entry");
  return entry;
}

function withoutHostEntry(header) {
  const copy = structuredClone(header);
  delete copy.files.out.files.host.files["index.js"];
  return copy;
}

function collectUnpackedReferences(header) {
  const references = [];
  function visit(files, prefix) {
    for (const [name, entry] of Object.entries(files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry?.unpacked !== undefined) references.push({ path, unpacked: entry.unpacked });
      if (entry?.files) visit(entry.files, path);
    }
  }
  visit(header?.files, "");
  return references.sort((left, right) => left.path.localeCompare(right.path));
}

function calculateIntegrity(content) {
  const blocks = [];
  for (let offset = 0; offset < content.byteLength; offset += integrityBlockSize) {
    blocks.push(createHash("sha256").update(content.subarray(offset, offset + integrityBlockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: createHash("sha256").update(content).digest("hex"),
    blockSize: integrityBlockSize,
    blocks,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("arguments must be --name value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

function requiredArg(options, name) {
  assert.ok(options[name], `missing --${name}`);
  return options[name];
}

function hashBuffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

async function hashRange(path, start, length) {
  assert.ok(length > 0, "packed payload range must be nonempty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start, end: start + length - 1 })) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
