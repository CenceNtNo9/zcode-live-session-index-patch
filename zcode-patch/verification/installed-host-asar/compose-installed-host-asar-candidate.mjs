import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const EXPECTED_ASAR_INPUTS = Object.freeze({
  archiveBytes: 326_915_059,
  archiveSha256: "D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C",
  candidateHostBytes: 1_499_553,
  candidateHostSha256: "54DEFA873C82EC6CDEF229760B57F5448EA08365C922ACD977F0C1E52C6B0EA2",
  candidateArchiveBytes: 328_414_612,
  candidateArchiveSha256: "6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD",
  originalHostBytes: 1_497_917,
  originalHostSha256: "A339D8142ED19ABFBAB75AF6F8464D98C95042CA87C0B129D2E6300F12D39899",
  entryCount: 30_165,
  outputDirectoryName: "installed-host-asar-review7",
  outputArchiveName: "app.installed-membership-review7.candidate.asar",
  reportName: "app.installed-membership-review7.report.json",
  companions: Object.freeze({
    sessionsIndexSchema: {
      path: "out\\host\\chunk-EBZ6RJTQ.js",
      bytes: 113_415,
      sha256: "5C8A292E35CE058943E65200AEAD91950F1D583DBE126634920D9E08FC2A9C2D",
    },
    taskIndexRepo: {
      path: "out\\host\\chunk-NKOHJ4QI.js",
      bytes: 175_375,
      sha256: "A43749E9D5CBB568DFB671C11868E98F406932114585EF3C6F6D5E67370A1EA2",
    },
    storageWorker: {
      path: "out\\host\\tasksStorageWorker.js",
      bytes: 616,
      sha256: "4E8B381A6DD55FFB2CDB8A8ADD70226FFB1B20BACB6DD71C6A9C1F2AE4055103",
    },
    buildMetadata: {
      path: "out\\metadata\\build-meta.json",
      bytes: 141,
      sha256: "00AA593036F74AEA69305C10AA662F19F18C53B87C1D432557EE0CA029E35974",
    },
  }),
});

const hostEntryName = "out\\host\\index.js";
const integrityBlockSize = 4 * 1024 * 1024;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeRoot = resolve(requiredArg(args, "runtime-root"));
  const archivePath = resolve(requiredArg(args, "archive"));
  const candidateHostPath = resolve(requiredArg(args, "candidate-host"));
  const tempRoot = resolve(requiredArg(args, "temp-root"));
  const inputRoot = resolve(requiredArg(args, "input-root"));
  assertTempRoot(tempRoot);
  assertWithin(inputRoot, archivePath, "baseline archive input");
  assertWithin(tempRoot, candidateHostPath, "Host candidate");
  assertNoReparsePath(tempRoot, tempRoot);
  assertNoReparsePath(inputRoot, inputRoot);
  assertNoReparsePath(archivePath, inputRoot);
  assertNoReparsePath(candidateHostPath, tempRoot);
  assertRegularFile(archivePath, "frozen archive");
  assertRegularFile(candidateHostPath, "review7 Host candidate");

  const outputDirectory = join(tempRoot, EXPECTED_ASAR_INPUTS.outputDirectoryName);
  const outputArchivePath = join(outputDirectory, EXPECTED_ASAR_INPUTS.outputArchiveName);
  const reportPath = join(outputDirectory, EXPECTED_ASAR_INPUTS.reportName);
  await assertAbsent(outputDirectory);

  const requireFromRuntime = createRequire(join(runtimeRoot, "package.json"));
  const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  const asarManifest = JSON.parse(await readFile(join(runtimeRoot, "node_modules/@electron/asar/package.json"), "utf8"));
  assert.equal(runtimeManifest.name, "zcode", "runtime root must be a ZCode source checkout");
  assert.equal(runtimeManifest.version, "3.14.3", "runtime root must match ZCode 3.14.3");
  assert.equal(runtimeManifest.license, "Apache-2.0", "runtime root license metadata differs from upstream");
  assert.equal(asarManifest.version, "3.4.1", "@electron/asar version differs from the verified toolchain");
  const asar = requireFromRuntime("@electron/asar");
  const archiveStat = await stat(archivePath);
  const sourceArchiveSha256 = await hashFile(archivePath);
  assertArchiveFingerprint(archiveStat.size, sourceArchiveSha256);

  const candidateHostBytes = await readFile(candidateHostPath);
  assertCandidateHostFingerprint(candidateHostBytes);
  const sourceHeader = asar.getRawHeader(archivePath);
  assert.equal(JSON.stringify(sourceHeader.header), sourceHeader.headerString, "frozen ASAR header is not canonical JSON");
  const originalHostEntry = getHostEntry(sourceHeader.header);
  assert.equal(originalHostEntry.unpacked, undefined, "frozen Host index is no longer a packed entry");
  const originalHostBytes = asar.extractFile(archivePath, hostEntryName);
  assert.equal(hashBuffer(originalHostBytes), EXPECTED_ASAR_INPUTS.originalHostSha256, "frozen Host entry fingerprint changed");
  assert.equal(originalHostBytes.byteLength, EXPECTED_ASAR_INPUTS.originalHostBytes, "frozen Host entry size changed");

  const companionEvidence = {};
  for (const [name, expected] of Object.entries(EXPECTED_ASAR_INPUTS.companions)) {
    const bytes = asar.extractFile(archivePath, expected.path);
    assert.equal(bytes.byteLength, expected.bytes, `${name} companion size changed`);
    assert.equal(hashBuffer(bytes), expected.sha256, `${name} companion fingerprint changed`);
    companionEvidence[name] = { path: expected.path.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: hashBuffer(bytes) };
  }

  const sourceEntries = asar.listPackage(archivePath);
  assert.equal(sourceEntries.length, EXPECTED_ASAR_INPUTS.entryCount, "frozen ASAR entry count changed");
  const sourceDataStart = 8 + sourceHeader.headerSize;
  const sourceDataBytes = archiveStat.size - sourceDataStart;
  assert.ok(sourceDataBytes > originalHostEntry.size, "frozen ASAR packed payload range is invalid");

  const candidateHeader = structuredClone(sourceHeader.header);
  const candidateHostEntry = getHostEntry(candidateHeader);
  candidateHostEntry.size = candidateHostBytes.byteLength;
  candidateHostEntry.offset = String(sourceDataBytes);
  candidateHostEntry.integrity = calculateIntegrity(candidateHostBytes);
  assert.deepEqual(withoutHostEntry(candidateHeader), withoutHostEntry(sourceHeader.header), "composer changed non-Host ASAR header metadata");

  const headerPickle = pickleString(JSON.stringify(candidateHeader));
  const sizePickle = pickleUInt32(headerPickle.byteLength);
  const candidateDataStart = 8 + headerPickle.byteLength;
  const expectedCandidateBytes = candidateDataStart + sourceDataBytes + candidateHostBytes.byteLength;
  await mkdir(outputDirectory);
  assertNoReparsePath(outputDirectory, tempRoot);
  assertWithin(tempRoot, outputArchivePath, "candidate ASAR output");
  assertWithin(tempRoot, reportPath, "candidate report output");
  await assertAbsent(outputArchivePath);
  await assertAbsent(reportPath);

  await pipeline(
    Readable.from(archiveAndHostEntry(archivePath, sourceDataStart, candidateHostBytes, sizePickle, headerPickle)),
    createWriteStream(outputArchivePath, { flags: "wx" }),
  );

  assertRegularFile(outputArchivePath, "candidate ASAR output");
  assertNoReparsePath(outputArchivePath, tempRoot);
  const candidateArchiveStat = await stat(outputArchivePath);
  assert.equal(candidateArchiveStat.size, expectedCandidateBytes, "candidate ASAR byte length mismatch");
  asar.uncacheAll();
  const composedHeader = asar.getRawHeader(outputArchivePath);
  assert.equal(composedHeader.headerSize, headerPickle.byteLength, "candidate ASAR header size mismatch");
  assert.equal(JSON.stringify(composedHeader.header), composedHeader.headerString, "candidate ASAR header is not canonical JSON");
  assert.deepEqual(withoutHostEntry(composedHeader.header), withoutHostEntry(sourceHeader.header), "candidate changed a non-Host header entry");
  assert.deepEqual(getHostEntry(composedHeader.header), candidateHostEntry, "candidate Host header entry differs from target");
  const candidateEntries = asar.listPackage(outputArchivePath);
  assert.deepEqual(candidateEntries, sourceEntries, "candidate ASAR entry listing changed");
  const candidateStat = asar.statFile(outputArchivePath, hostEntryName);
  assert.equal(candidateStat.unpacked, undefined, "candidate Host index unexpectedly became unpacked");
  const composedHostBytes = asar.extractFile(outputArchivePath, hostEntryName);
  assert.deepEqual(composedHostBytes, candidateHostBytes, "candidate Host payload differs from review7 input");
  assertCandidateHostFingerprint(composedHostBytes);

  const unpackedSource = collectUnpackedReferences(sourceHeader.header);
  const unpackedCandidate = collectUnpackedReferences(composedHeader.header);
  assert.deepEqual(unpackedCandidate, unpackedSource, "candidate ASAR unpacked references changed");
  for (const [name, expected] of Object.entries(EXPECTED_ASAR_INPUTS.companions)) {
    const sourceBytes = asar.extractFile(archivePath, expected.path);
    const candidateBytes = asar.extractFile(outputArchivePath, expected.path);
    assert.deepEqual(candidateBytes, sourceBytes, `${name} payload changed in candidate`);
  }

  const sourcePayloadPrefixSha256 = await hashRange(archivePath, sourceDataStart, sourceDataBytes);
  const candidatePayloadPrefixSha256 = await hashRange(outputArchivePath, candidateDataStart, sourceDataBytes);
  assert.equal(candidatePayloadPrefixSha256, sourcePayloadPrefixSha256, "existing packed payload prefix changed");
  const finalSourceArchiveSha256 = await hashFile(archivePath);
  assert.equal(finalSourceArchiveSha256, sourceArchiveSha256, "frozen source archive changed during composition");
  const finalCandidateHostSha256 = await hashFile(candidateHostPath);
  assert.equal(finalCandidateHostSha256, EXPECTED_ASAR_INPUTS.candidateHostSha256, "review7 Host input changed during composition");
  const outputArchiveSha256 = await hashFile(outputArchivePath);
  assert.equal(candidateArchiveStat.size, EXPECTED_ASAR_INPUTS.candidateArchiveBytes, "candidate ASAR byte length differs from the verified output");
  assert.equal(outputArchiveSha256, EXPECTED_ASAR_INPUTS.candidateArchiveSha256, "candidate ASAR fingerprint differs from the verified output");

  const report = {
    result: "PASS",
    purpose: "Frozen D836 app.asar plus the accepted review7 Host payload; no installation or runtime launch.",
    sourceArchive: {
      path: archivePath,
      bytes: archiveStat.size,
      sha256: sourceArchiveSha256,
      entryCount: sourceEntries.length,
    },
    sourceHostEntry: {
      path: "out/host/index.js",
      bytes: originalHostBytes.byteLength,
      sha256: EXPECTED_ASAR_INPUTS.originalHostSha256,
    },
    inputHost: {
      path: candidateHostPath,
      bytes: candidateHostBytes.byteLength,
      sha256: EXPECTED_ASAR_INPUTS.candidateHostSha256,
    },
    outputArchive: {
      path: outputArchivePath,
      bytes: candidateArchiveStat.size,
      sha256: outputArchiveSha256,
      entryCount: candidateEntries.length,
    },
    changedHeaderEntry: {
      path: "out/host/index.js",
      oldOffset: originalHostEntry.offset,
      newOffset: candidateHostEntry.offset,
      newBytes: candidateHostEntry.size,
      newIntegrity: candidateHostEntry.integrity,
    },
    preservation: {
      nonHostHeaderMetadataUnchanged: true,
      archiveEntryListingUnchanged: true,
      unpackedReferencesUnchanged: true,
      companions: companionEvidence,
      sourcePackedPayloadPrefixSha256: sourcePayloadPrefixSha256,
      candidatePackedPayloadPrefixSha256: candidatePayloadPrefixSha256,
      existingPackedPayloadBytesUnchanged: true,
    },
    unpackedDependencyHandling:
      "This output contains only app.asar. Its unpacked references are preserved, not copied. Any later isolated runtime must place the matching .asar.unpacked dependencies adjacent to this candidate archive; it must not use installed-user data or production install paths.",
    runtime: {
      result: "NOT_RUN",
      reason: "This stage only composes and statically verifies the archive; Host, provider, GUI, and installation were not launched.",
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function assertWithin(root, candidate, label = "path") {
  const rel = relative(resolve(root), resolve(candidate));
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label} escaped the authorized Temp root`);
}

export function assertTempRoot(tempRoot) {
  const relativePath = relative(resolve(tmpdir()), tempRoot);
  assert.ok(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
    "temporary root escaped the system Temp directory",
  );
  assert.match(
    basename(tempRoot),
    /^zcode-patch-package-[0-9a-f]{32}$/i,
    "temporary root must be the unique package Temp directory",
  );
}

export function assertCandidateHostFingerprint(bytes) {
  assert.equal(bytes.byteLength, EXPECTED_ASAR_INPUTS.candidateHostBytes, "review7 Host candidate size changed");
  assert.equal(hashBuffer(bytes), EXPECTED_ASAR_INPUTS.candidateHostSha256, "review7 Host candidate fingerprint changed");
}

export function assertArchiveFingerprint(byteLength, sha256) {
  assert.equal(byteLength, EXPECTED_ASAR_INPUTS.archiveBytes, "frozen app.asar byte length changed");
  assert.equal(sha256, EXPECTED_ASAR_INPUTS.archiveSha256, "frozen app.asar fingerprint changed");
}

export async function assertAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output: ${path}`);
}

export function assertRegularFile(path, label = "input") {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-reparse file`);
}

export function assertNoReparsePath(path, root) {
  const rootPath = resolve(root);
  let current = resolve(path);
  const rootLower = rootPath.toLowerCase();
  assert.ok(
    current.toLowerCase() === rootLower || current.toLowerCase().startsWith(`${rootLower}${sep}`),
    "Temp path escaped the authorized root",
  );
  while (true) {
    const info = lstatSync(current);
    assert.ok(!info.isSymbolicLink(), `Temp path contains a reparse point: ${current}`);
    const parent = dirname(current);
    if (parent.toLowerCase() === current.toLowerCase()) return;
    current = parent;
  }
}

function getHostEntry(header) {
  const entry = header?.files?.out?.files?.host?.files?.["index.js"];
  assert.ok(entry && typeof entry === "object", "expected packed out/host/index.js ASAR entry");
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

function pickleString(value) {
  const string = Buffer.from(value, "utf8");
  const alignedStringBytes = (string.byteLength + 3) & ~3;
  const buffer = Buffer.alloc(8 + alignedStringBytes);
  buffer.writeUInt32LE(4 + alignedStringBytes, 0);
  buffer.writeInt32LE(string.byteLength, 4);
  string.copy(buffer, 8);
  return buffer;
}

function pickleUInt32(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(value, 4);
  return buffer;
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

async function* archiveAndHostEntry(sourcePath, dataStart, hostBytes, sizePickle, headerPickle) {
  yield sizePickle;
  yield headerPickle;
  for await (const chunk of createReadStream(sourcePath, { start: dataStart })) yield chunk;
  yield hostBytes;
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
  assert.ok(length > 0, "packed payload prefix must be nonempty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start, end: start + length - 1 })) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
