import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXPECTED_BASELINE,
  assertNoReparsePath,
  assertTempRoot,
  assertWithin,
  locateUniqueFunctionDeclaration,
  locateUniqueMappedFunction,
  locateUniqueMembershipStateObject,
  patchHostBuffer,
} from "./patch-installed-host-membership.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeRoot = resolve(requiredArg(args, "runtime-root"));
  const inputRoot = resolve(requiredArg(args, "input-root"));
  const archivePath = resolve(requiredArg(args, "archive"));
  const baselinePath = resolve(requiredArg(args, "baseline-host"));
  const tempRoot = resolve(requiredArg(args, "temp-root"));
  const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  assert.equal(runtimeManifest.name, "zcode", "runtime root must be a ZCode source checkout");
  assert.equal(runtimeManifest.version, "3.14.3", "runtime root must match ZCode 3.14.3");
  assert.equal(runtimeManifest.license, "Apache-2.0", "runtime root license metadata differs from upstream");
  const typescriptManifest = JSON.parse(await readFile(join(runtimeRoot, "node_modules/typescript/package.json"), "utf8"));
  const asarManifest = JSON.parse(await readFile(join(runtimeRoot, "node_modules/@electron/asar/package.json"), "utf8"));
  assert.equal(typescriptManifest.version, "6.0.2", "TypeScript version differs from the verified toolchain");
  assert.equal(asarManifest.version, "3.4.1", "@electron/asar version differs from the verified toolchain");
  const artifactSuffix = args["artifact-suffix"] ? `-${args["artifact-suffix"]}` : "";
  assert.match(artifactSuffix, /^$|^-[a-z0-9-]+$/i, "invalid artifact suffix");
  assertWithin(inputRoot, archivePath, "baseline archive input");
  assertWithin(inputRoot, baselinePath, "baseline Host entry input");
  assertNoReparsePath(tempRoot, tempRoot);
  assertNoReparsePath(inputRoot, inputRoot);
  assertNoReparsePath(archivePath, inputRoot);
  assertNoReparsePath(baselinePath, inputRoot);
  assertTempRoot(tempRoot);
  assertNoReparsePath(tempRoot, tempRoot);

  const requireFromRuntime = createRequire(join(runtimeRoot, "package.json"));
  const tsApi = requireFromRuntime("typescript");
  const baselineBytes = await readFile(baselinePath);
  const expectedPatch = patchHostBuffer(baselineBytes, tsApi);
  const candidatePath = join(tempRoot, `host-index-installed-membership${artifactSuffix}.candidate.js`);
  assertWithin(tempRoot, candidatePath, "Host candidate output");
  assertNoReparsePath(candidatePath, tempRoot);
  const candidateBytes = await readFile(candidatePath);
  assert.ok(candidateBytes.equals(expectedPatch.candidateBytes), "saved candidate differs from the deterministic patch output");

  const reportPath = join(tempRoot, `host-index-installed-membership${artifactSuffix}.report.json`);
  assertWithin(tempRoot, reportPath, "patch report output");
  assertNoReparsePath(reportPath, tempRoot);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.archive.sha256, EXPECTED_BASELINE.archiveSha256);
  assert.equal(report.hostEntry.sha256, EXPECTED_BASELINE.hostSha256);
  assert.equal(report.rpcEvent.baselineCount, 1);
  assert.equal(report.rpcEvent.candidateCount, 1);
  assert.equal(report.rpcEvent.changedBytes, false);
  assert.equal(report.protocolEvidence.sessionsIndexSchema.sha256, "5C8A292E35CE058943E65200AEAD91950F1D583DBE126634920D9E08FC2A9C2D");
  assert.equal(report.taskIndexRepoEvidence.chunk.sha256, "A43749E9D5CBB568DFB671C11868E98F406932114585EF3C6F6D5E67370A1EA2");
  assert.match(report.taskIndexRepoEvidence.writeQueue, /serialize by workspace\/task key/);
  assert.match(report.taskIndexRepoEvidence.syncMerge, /preserves title when titleOverridden is set/);
  assert.match(report.taskIndexRepoEvidence.getTaskMeta, /TaskMeta fields.*does not copy SQL pinned\/archived\/deleted/);
  assert.match(report.taskIndexRepoEvidence.getTaskRow, /raw pinned, archived, and deleted SQL columns/);
  assert.match(report.taskIndexRepoEvidence.classBindingAndHostWiring, /be as q.*q as mc.*k=new mc.*taskIndexRepo:k/);
  assert.match(report.admissionScope.retry, /pending.*getTaskMeta read failure.*later qualifying summary/);
  assert.match(report.admissionScope.productTiming, /UNVERIFIED/);
  assert.equal(report.bootRuntime.result, "NOT_RUN");

  testFingerprintGate(baselineBytes, tsApi);
  testAmbiguousAnchors(tsApi);
  await testMissingRowAdmission(tsApi, candidateBytes);
  await testTerminalTransitionAdmissionWhenRuntimeReadUnavailable(tsApi, candidateBytes);
  await testTitleChangeAdmissionWhenRuntimeReadUnavailable(tsApi, candidateBytes);
  await testReadableRuntimeResyncIsRetained(tsApi, candidateBytes);
  await testExistingLocalRowIsUntouched(tsApi, candidateBytes);
  await testConcurrentSummaryFramesAreDeduplicated(tsApi, candidateBytes);
  await testConcurrentLocalUpdateBroadcastsFreshRow(tsApi, candidateBytes);
  await testConcurrentArchiveOrPinPreventsBroadcast(tsApi, candidateBytes);
  await testDeletedRowIsNotRevived(tsApi, candidateBytes);
  await testTransientSeedFailureRetriesOnNextSummary(tsApi, candidateBytes);
  await testPostSeedInitializationFailureResumesAdmission(tsApi, candidateBytes);
  await testLiveRuntimeStillUsesExistingOnlyResync(tsApi, candidateBytes);

  process.stdout.write(
    `${JSON.stringify({
      result: "PASS",
      checks: [
        "exact frozen baseline and deterministic candidate",
        "unknown baseline rejected by fingerprint gate",
        "ambiguous mapped-method and workspace-state anchors rejected",
        "store-backed live summary admits a missing task and broadcasts task_created",
        "terminal phase transition still admits when existing-only runtime read is unavailable and carries terminal unread metadata",
        "ended summary title change updates title and admits when existing-only runtime read is unavailable",
        "existing-only runtime read remains available for ended visible summaries and local metadata survives",
        "existing local row fields remain untouched",
        "overlapping summary frames share one in-flight seed/group/broadcast attempt",
        "concurrent local row update is re-read and broadcast fresh",
        "concurrent archive or pin state is re-read from raw numeric SQL row columns, local metadata survives, and row is not broadcast",
        "metadata-only getTaskMeta and raw getTaskRow shapes are distinct; deleted task remains deleted and is not broadcast",
        "transient seed failure retries on a same-title summary frame",
        "post-seed grouping and pending-read failures retain progress until a same-title retry broadcasts fresh metadata",
        "non-ended local live summary retains existing-only resync path",
        "installed session-index schema, TaskIndexRepo guards, and RPC marker fingerprints",
        "sessionEnded-only timing scope distinguishes static external CLI summaries from unverified runtime store-write, Desktop delivery, and GUI visibility timing",
      ],
      candidate: {
        path: candidatePath,
        bytes: candidateBytes.byteLength,
        sha256: hashBuffer(candidateBytes),
      },
      runtimeBoot: "not run: no verified per-process network egress deny for the installed Host background provider-runtime fetch",
    }, null, 2)}\n`,
  );
}

function testFingerprintGate(baselineBytes, tsApi) {
  const changed = Buffer.from(baselineBytes);
  changed[0] ^= 1;
  assert.throws(
    () => patchHostBuffer(changed, tsApi),
    /fingerprint changed/,
    "unknown base should fail before patching",
  );
}

function testAmbiguousAnchors(tsApi) {
  const duplicateMethod = tsApi.createSourceFile(
    "ambiguous-process-summary-fixture.js",
    'function a(){}i(a,"processSummary");function b(){}i(b,"processSummary");',
    tsApi.ScriptTarget.Latest,
    true,
    tsApi.ScriptKind.JS,
  );
  assert.throws(
    () => locateUniqueMappedFunction(tsApi, duplicateMethod, "processSummary"),
    /exactly one mapped processSummary anchor; found 2/,
  );

  const duplicateState = tsApi.createSourceFile(
    "ambiguous-workspace-state-fixture.js",
    "function f(){const a={summaries:new Map,seeded:!1};const b={summaries:new Map,seeded:!1};}",
    tsApi.ScriptTarget.Latest,
    true,
    tsApi.ScriptKind.JS,
  );
  assert.throws(
    () => locateUniqueMembershipStateObject(tsApi, duplicateState),
    /exactly one workspace state object anchor; found 2/,
  );

  assert.equal(typeof locateUniqueFunctionDeclaration, "function");
}

async function testMissingRowAdmission(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes, { runtimeReadAvailable: false });
  const summary = makeSummary("cli-new-task");
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();

  assert.ok(harness.repo.meta, "live store-backed summary did not create a task-index row");
  assert.equal(harness.repo.seedCalls, 1);
  assert.equal(harness.repo.initializeCalls, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].target.taskId, summary.sessionId);
  assert.equal(harness.events[0].meta.taskId, summary.sessionId);
  assert.equal(harness.events[0].reason, "task_created");
  assert.equal(harness.resyncCalls.length, 1, "ended visible summary must retain the original existing-only read path");
  assert.equal(harness.runtimeReadFailures, 1);
}

async function testTerminalTransitionAdmissionWhenRuntimeReadUnavailable(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes, { runtimeReadAvailable: false });
  const previous = {
    ...makeSummary("terminal-transition-task"),
    phase: "draft",
    sessionEnded: false,
  };
  const current = {
    ...previous,
    phase: "completedSuccess",
    sessionEnded: true,
    goalStatus: "verified",
    lastActivityAt: previous.lastActivityAt + 1,
  };

  harness.methods.processSummary(harness.state, previous, current, "online");
  await flushPromises();

  assert.equal(harness.repo.applyAgentPatchCalls, 1, "terminal status patch was skipped");
  assert.equal(harness.resyncCalls.length, 1, "terminal fallback did not retain the existing-only read path");
  assert.equal(harness.runtimeReadFailures, 1, "fixture did not exercise unavailable runtime read");
  assert.ok(harness.repo.meta, "terminal summary did not admit the missing task without runtime read");
  assert.equal(harness.repo.meta.status, "completed", "terminal status was lost during admission");
  assert.equal(harness.repo.seedCalls, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].reason, "task_created");
  assert.equal(harness.events[0].unreadSignal, "background_terminal");
  assert.deepEqual(harness.terminalEvents, ["turn.completed", "prompt_completed"]);

  const applyPatchQueued = harness.operationLog.indexOf("applyAgentPatch:queued");
  const seedQueued = harness.operationLog.indexOf("seedTaskMetaIfMissing:queued");
  const applyPatchWritten = harness.operationLog.indexOf("applyAgentPatch:write");
  const seedWritten = harness.operationLog.indexOf("seedTaskMetaIfMissing:write");
  assert.ok(applyPatchQueued >= 0 && seedQueued > applyPatchQueued, "seed write was queued before terminal patch");
  assert.ok(applyPatchWritten >= 0 && seedWritten > applyPatchWritten, "terminal patch write did not precede seed write");
}

async function testTitleChangeAdmissionWhenRuntimeReadUnavailable(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes, { runtimeReadAvailable: false });
  const previous = {
    ...makeSummary("title-change-task"),
    title: "Default title",
    titleSource: "default",
  };
  const current = {
    ...previous,
    title: "Named CLI task",
    titleSource: "custom",
    lastActivityAt: previous.lastActivityAt + 1,
  };

  harness.methods.processSummary(harness.state, previous, current, "online");
  await flushPromises();

  assert.equal(harness.repo.applyAgentPatchCalls, 1, "existing title update was skipped");
  assert.equal(harness.resyncCalls.length, 1, "title fallback did not retain the existing-only read path");
  assert.equal(harness.runtimeReadFailures, 1, "fixture did not exercise unavailable runtime read");
  assert.ok(harness.repo.meta, "ended titled summary did not admit the missing task");
  assert.equal(harness.repo.meta.title, "Named CLI task");
  assert.equal(harness.repo.meta.titleOverridden, true);
  assert.equal(harness.repo.seedCalls, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].reason, "task_created");
  assert.equal(harness.events[0].meta.title, "Named CLI task");

  const applyPatchQueued = harness.operationLog.indexOf("applyAgentPatch:queued");
  const seedQueued = harness.operationLog.indexOf("seedTaskMetaIfMissing:queued");
  assert.ok(applyPatchQueued >= 0 && seedQueued > applyPatchQueued, "seed write was queued before title patch");
}

async function testReadableRuntimeResyncIsRetained(tsApi, candidateBytes) {
  const summary = makeSummary("readable-runtime-task");
  const runtimeMeta = {
    ...makeSummaryMeta(summary.sessionId),
    title: summary.title,
    titleOverridden: true,
    model: "runtime-local-model",
    mode: "plan",
    provider: "local-provider",
    status: "running",
    updatedAt: summary.lastActivityAt + 10,
  };
  const harness = createProductionHarness(tsApi, candidateBytes, {
    runtimeReadAvailable: true,
    runtimeReadMeta: runtimeMeta,
  });

  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();

  assert.equal(harness.resyncCalls.length, 1, "existing-only runtime read path was removed");
  assert.equal(harness.runtimeReadFailures, 0);
  assert.equal(harness.repo.meta.model, "runtime-local-model");
  assert.equal(harness.repo.meta.mode, "plan");
  assert.equal(harness.repo.meta.provider, "local-provider");
  assert.equal(harness.repo.meta.title, summary.title);
  assert.equal(harness.repo.meta.titleOverridden, true);
  assert.ok(harness.events.some((event) => event.meta.model === "runtime-local-model"), "broadcast did not use current local metadata");
}

async function testExistingLocalRowIsUntouched(tsApi, candidateBytes) {
  const localMetadata = {
    ...makeSummaryMeta("existing-local-task"),
    title: "Locally edited title",
    titleOverridden: true,
    model: "local-model-selection",
    mode: "plan",
  };
  const localRowState = { pinned: 1, archived: 0, deleted: 0 };
  const harness = createProductionHarness(tsApi, candidateBytes, {
    metadata: localMetadata,
    rowState: localRowState,
  });
  const before = structuredClone(localMetadata);
  const summary = makeSummary("existing-local-task");
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();
  harness.methods.processSummary(
    harness.state,
    summary,
    { ...summary, lastActivityAt: summary.lastActivityAt + 1 },
    "online",
  );
  await flushPromises();

  assert.deepEqual(harness.repo.meta, before, "existing local metadata changed");
  assert.deepEqual(harness.repo.rowState, localRowState, "existing SQL row state changed");
  assertMetadataOnly(harness.repo.meta);
  assert.equal(harness.repo.seedCalls, 0, "existing local row must not be seeded over");
  assert.equal(harness.repo.initializeCalls, 0, "existing local row is already authoritative");
  assert.equal(harness.events.length, 0, "existing local membership must not get a duplicate task_created broadcast");
  assert.equal(harness.state.storeSummaryMemberships.has(summary.sessionId), false, "pre-existing local row must not create an admission retry state");
}

async function testConcurrentLocalUpdateBroadcastsFreshRow(tsApi, candidateBytes) {
  let concurrentEditApplied = false;
  const harness = createProductionHarness(tsApi, candidateBytes, {
    onInitializeGroupedTaskAtTop(row, repo) {
      void repo.updateTaskState({ taskId: row.taskId }, {
        title: "Concurrent local title",
        titleOverridden: true,
        model: "concurrent-local-model",
        mode: "plan",
        status: "running",
      });
      concurrentEditApplied = true;
    },
  });
  const summary = makeSummary("concurrent-local-task");
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();

  assert.equal(concurrentEditApplied, true);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].meta.model, "concurrent-local-model");
  assert.equal(harness.events[0].meta.title, "Concurrent local title");
  assert.equal(harness.events[0].meta.titleOverridden, true);
  assert.equal(harness.events[0].meta.status, "running");
}

async function testConcurrentSummaryFramesAreDeduplicated(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes);
  const summary = makeSummary("overlapping-summary-task");
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  harness.methods.processSummary(
    harness.state,
    summary,
    { ...summary, lastActivityAt: summary.lastActivityAt + 1 },
    "online",
  );
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 1, "overlapping frames seeded the same task more than once");
  assert.equal(harness.repo.initializeCalls, 1, "overlapping frames initialized grouped membership more than once");
  assert.equal(harness.events.length, 1, "overlapping frames emitted duplicate task_created events");
  assert.equal(harness.state.storeSummaryMemberships.get(summary.sessionId), "admitted");
}

async function testConcurrentArchiveOrPinPreventsBroadcast(tsApi, candidateBytes) {
  for (const flag of ["archived", "pinned"]) {
    const harness = createProductionHarness(tsApi, candidateBytes, {
      onInitializeGroupedTaskAtTop(row, repo) {
        void repo.updateTaskState({ taskId: row.taskId }, {
          [flag]: true,
          title: `Concurrent local ${flag} title`,
          titleOverridden: true,
          model: `local-${flag}-model`,
        });
      },
    });
    const summary = makeSummary(`concurrent-${flag}-task`);
    harness.methods.processSummary(harness.state, undefined, summary, "online");
    await flushPromises();

    assert.equal(harness.repo.rowState[flag], 1, `concurrent ${flag} update was lost in raw SQL row state`);
    assert.equal(harness.events.length, 0, `concurrent ${flag} row was broadcast as live membership`);
    const taskId = `concurrent-${flag}-task`;
    const rawRow = harness.repo.getTaskRow({ taskId });
    assert.equal(rawRow[flag], 1, `getTaskRow did not expose concurrent ${flag} SQL status`);
    const currentMetadata = await harness.repo.getTaskMeta({ taskId });
    assertMetadataOnly(currentMetadata);
    assert.equal(currentMetadata.title, `Concurrent local ${flag} title`, "local title was overwritten during status re-read");
    assert.equal(currentMetadata.titleOverridden, true, "local title override flag was overwritten during status re-read");
    assert.equal(currentMetadata.model, `local-${flag}-model`, "local model was overwritten during status re-read");
  }
}

async function testDeletedRowIsNotRevived(tsApi, candidateBytes) {
  const deletedMetadata = makeSummaryMeta("deleted-local-task");
  const deletedRowState = { deleted: 1, pinned: 0, archived: 0 };
  const harness = createProductionHarness(tsApi, candidateBytes, {
    metadata: deletedMetadata,
    rowState: deletedRowState,
  });
  const beforeMetadata = structuredClone(deletedMetadata);
  harness.methods.processSummary(harness.state, undefined, makeSummary("deleted-local-task"), "online");
  await flushPromises();

  assert.equal(harness.repo.rowState.deleted, 1, "deleted row was revived");
  assert.deepEqual(harness.repo.meta, beforeMetadata, "deleted row metadata was overwritten");
  assert.equal(await harness.repo.getTaskMeta({ taskId: "deleted-local-task" }), null, "deleted row must remain absent from getTaskMeta");
  assert.equal(harness.repo.getTaskRow({ taskId: "deleted-local-task" }).deleted, 1, "raw row deleted flag was not preserved");
  assert.equal(harness.repo.seedCalls, 1, "insert-if-missing must be exercised for the tombstone case");
  assert.equal(harness.events.length, 0, "deleted row must not be rebroadcast");
}

async function testTransientSeedFailureRetriesOnNextSummary(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes, { seedFailures: 1 });
  const firstSummary = makeSummary("retryable-task");
  harness.methods.processSummary(harness.state, undefined, firstSummary, "online");
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 1);
  assert.equal(harness.state.storeSummaryMemberships.has(firstSummary.sessionId), false);
  assert.equal(harness.events.length, 0);

  const nextSummary = { ...firstSummary, lastActivityAt: firstSummary.lastActivityAt + 1 };
  harness.methods.processSummary(harness.state, firstSummary, nextSummary, "online");
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 2, "next same-title summary did not retry the failed insert");
  assert.ok(harness.repo.meta, "retry did not admit the missing row");
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].reason, "task_created");
}

async function testPostSeedInitializationFailureResumesAdmission(tsApi, candidateBytes) {
  const summary = makeSummary("post-seed-resume-task");
  const harness = createProductionHarness(tsApi, candidateBytes, { initializeFailures: 1 });
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();

  assert.ok(harness.repo.meta, "seed should create metadata before the injected grouping failure");
  assert.equal(harness.repo.seedCalls, 1);
  assert.equal(harness.repo.initializeCalls, 1);
  assert.equal(harness.events.length, 0, "failed grouping must not broadcast task_created");
  assert.equal(harness.state.storeSummaryMemberships.get(summary.sessionId), "pending");

  await harness.repo.updateTaskState({ taskId: summary.sessionId }, {
    title: "Local edit while admission is pending",
    titleOverridden: true,
    model: "local-model-during-retry",
  });
  harness.repo.failNextGetTaskMeta();
  const failedResumeSummary = { ...summary, lastActivityAt: summary.lastActivityAt + 1 };
  harness.methods.processSummary(harness.state, summary, failedResumeSummary, "online");
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 1, "failed pending metadata read must not reseed");
  assert.equal(harness.repo.initializeCalls, 1, "failed pending metadata read must not regroup");
  assert.equal(harness.events.length, 0, "failed pending metadata read must not broadcast");
  assert.equal(harness.state.storeSummaryMemberships.get(summary.sessionId), "pending", "pending state was lost on a transient metadata read failure");

  const retrySummary = { ...summary, lastActivityAt: summary.lastActivityAt + 2 };
  harness.methods.processSummary(harness.state, failedResumeSummary, retrySummary, "online");
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 2, "pending attempt should repeat the idempotent insert-if-missing call");
  assert.equal(harness.repo.initializeCalls, 2, "pending attempt did not retry grouped admission");
  assert.equal(harness.events.length, 1, "successful retry should emit exactly one task_created event");
  assert.equal(harness.events[0].reason, "task_created");
  assert.equal(harness.events[0].meta.title, "Local edit while admission is pending");
  assert.equal(harness.events[0].meta.titleOverridden, true);
  assert.equal(harness.events[0].meta.model, "local-model-during-retry");
  assert.equal(harness.state.storeSummaryMemberships.get(summary.sessionId), "admitted");
}

async function testLiveRuntimeStillUsesExistingOnlyResync(tsApi, candidateBytes) {
  const harness = createProductionHarness(tsApi, candidateBytes);
  const summary = { ...makeSummary("local-live-task"), sessionEnded: false };
  harness.methods.processSummary(harness.state, undefined, summary, "online");
  await flushPromises();

  assert.equal(harness.repo.seedCalls, 0, "active local runtime must not use store-backed seed path");
  assert.equal(harness.resyncCalls.length, 1, "active local runtime lost its existing-only resync");
  assert.equal(harness.events.length, 0);
}

function createProductionHarness(tsApi, candidateBytes, options = {}) {
  const text = candidateBytes.toString("utf8");
  const sourceFile = tsApi.createSourceFile(
    "host-index-installed-membership.candidate.js",
    text,
    tsApi.ScriptTarget.Latest,
    true,
    tsApi.ScriptKind.JS,
  );
  assert.equal(sourceFile.parseDiagnostics.length, 0);
  const factory = locateUniqueMappedFunction(tsApi, sourceFile, "createZCodeTaskIndexSyncer");
  const processSummary = locateUniqueMappedFunction(tsApi, factory, "processSummary");
  const seedMembership = locateUniqueFunctionDeclaration(
    tsApi,
    factory,
    "seedStoreBackedTaskMembership",
  );
  const sessionTargetFrom = locateUniqueMappedFunction(tsApi, factory, "sessionTargetFrom");
  const broadcastTargetFrom = locateUniqueMappedFunction(tsApi, factory, "broadcastTargetFrom");
  const buildBaselineMeta = locateUniqueMappedFunction(
    tsApi,
    sourceFile,
    "buildBaselineMetaFromSummary",
  );
  const taskStatusFromSummaryPhase = locateUniqueMappedFunction(
    tsApi,
    sourceFile,
    "taskStatusFromSummaryPhase",
  );
  const isTerminalPhase = locateUniqueMappedFunction(tsApi, sourceFile, "isTerminalPhase");
  const emitTerminalAndReady = locateUniqueMappedFunction(tsApi, factory, "emitTerminalAndReady");
  const applyTerminalTransition = locateUniqueMappedFunction(tsApi, factory, "applyTerminalTransition");
  const applyTitleChange = locateUniqueMappedFunction(tsApi, factory, "applyTitleChange");
  const unreadSignalFromSummary = locateUniqueFunctionDeclaration(tsApi, sourceFile, "vIe");

  const events = [];
  const warnings = [];
  const resyncCalls = [];
  const terminalEvents = [];
  const operationLog = [];
  const writeChains = new Map();
  let repoReady = false;
  let meta = options.metadata ? structuredClone(options.metadata) : null;
  let rowState = meta
    ? { pinned: 0, archived: 0, deleted: 0, ...structuredClone(options.rowState ?? {}) }
    : null;
  assertMetadataOnly(meta);
  let seedFailures = options.seedFailures ?? 0;
  let initializeFailures = options.initializeFailures ?? 0;
  let getTaskMetaFailures = options.getTaskMetaFailures ?? 0;

  function getRawRow() {
    return meta && rowState ? { ...structuredClone(meta), ...structuredClone(rowState) } : null;
  }

  function setMeta(value) {
    assertMetadataOnly(value);
    meta = structuredClone(value);
  }

  function getMeta() {
    return meta;
  }

  function setStateFromPatch(patch) {
    for (const field of ["pinned", "archived", "deleted"]) {
      if (Object.hasOwn(patch, field)) rowState[field] = patch[field] === true || patch[field] === 1 ? 1 : 0;
    }
  }

  function enqueueWrite(name, taskId, callback) {
    const key = `workspace-fixture\0${taskId}`;
    operationLog.push(`${name}:queued`);
    const operation = (writeChains.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        operationLog.push(`${name}:write`);
        return callback();
      });
    const settled = operation.then(() => {}, () => {});
    writeChains.set(key, settled);
    settled.finally(() => {
      if (writeChains.get(key) === settled) writeChains.delete(key);
    });
    return operation;
  }

  const repo = {
    get meta() {
      return meta;
    },
    get rowState() {
      return rowState;
    },
    failNextGetTaskMeta() {
      getTaskMetaFailures += 1;
    },
    applyAgentPatchCalls: 0,
    seedCalls: 0,
    initializeCalls: 0,
    async getTaskMeta(target) {
      await Promise.resolve();
      repoReady = true;
      operationLog.push("getTaskMeta:read");
      assert.equal(target.taskId, options.expectedTaskId ?? target.taskId);
      if (getTaskMetaFailures > 0) {
        getTaskMetaFailures -= 1;
        throw new Error("fixture transient getTaskMeta failure");
      }
      assertMetadataOnly(meta);
      return !meta || rowState.deleted === 1 ? null : structuredClone(meta);
    },
    getTaskRow(target) {
      assert.equal(repoReady, true, "getTaskRow must follow an awaited repository readiness path");
      assert.equal(target.taskId, options.expectedTaskId ?? target.taskId);
      return getRawRow();
    },
    async seedTaskMetaIfMissing(meta) {
      this.seedCalls += 1;
      await Promise.resolve();
      return enqueueWrite("seedTaskMetaIfMissing", meta.taskId, () => {
        if (seedFailures > 0) {
          seedFailures -= 1;
          throw new Error("fixture transient insert failure");
        }
        if (!getRawRow()) {
          const newMetadata = structuredClone(meta);
          assertMetadataOnly(newMetadata);
          setMeta(newMetadata);
          rowState = { pinned: 0, archived: 0, deleted: 0 };
        }
        return getRawRow();
      });
    },
    async initializeGroupedTaskAtTop(target) {
      this.initializeCalls += 1;
      await Promise.resolve();
      repoReady = true;
      return enqueueWrite("initializeGroupedTaskAtTop", target.taskId, () => {
        const rawRow = getRawRow();
        if (!rawRow || rawRow.deleted === 1 || rawRow.archived === 1 || rawRow.pinned === 1) return false;
        if (initializeFailures > 0) {
          initializeFailures -= 1;
          throw new Error("fixture transient grouped initialization failure");
        }
        options.onInitializeGroupedTaskAtTop?.(rawRow, this, target);
        return true;
      });
    },
    async applyAgentPatch(target) {
      this.applyAgentPatchCalls += 1;
      await Promise.resolve();
      return enqueueWrite("applyAgentPatch", target.taskId, () => {
        if (!meta || rowState.deleted === 1) return null;
        const patch = target.patch;
        const titleOverridden = meta.titleOverridden === true;
        meta = {
          ...meta,
          title: !titleOverridden && patch.title ? patch.title : meta.title,
          titleOverridden,
          updatedAt: patch.updatedAt ?? meta.updatedAt,
          status: patch.status ?? meta.status,
          lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : meta.lastError,
        };
        assertMetadataOnly(meta);
        return structuredClone(meta);
      });
    },
    async syncTaskMeta(meta) {
      await Promise.resolve();
      return enqueueWrite("syncTaskMeta", meta.taskId, () => {
        assertMetadataOnly(meta);
        if (!getRawRow()) {
          setMeta(meta);
          rowState = { pinned: 0, archived: 0, deleted: 0 };
        } else {
          const currentMeta = getMeta();
          const titleOverridden = meta.titleOverridden ?? currentMeta.titleOverridden ?? false;
          setMeta({
            ...currentMeta,
            ...structuredClone(meta),
            title: titleOverridden ? currentMeta.title : meta.title,
            titleOverridden,
            model: meta.model ?? currentMeta.model,
            mode: meta.mode ?? currentMeta.mode,
            provider: meta.provider ?? currentMeta.provider,
            status: meta.status ?? currentMeta.status,
            unreadAt: meta.unreadAt ?? currentMeta.unreadAt,
          });
        }
        return getRawRow();
      });
    },
    async updateTaskState(target, patch) {
      await Promise.resolve();
      return enqueueWrite("updateTaskState", target.taskId, () => {
        if (!meta || rowState.deleted === 1) throw new Error(`fixture task missing: ${target.taskId}`);
        const metadataPatch = Object.fromEntries(
          Object.entries(patch).filter(([key]) => !["pinned", "archived", "deleted"].includes(key)),
        );
        meta = { ...meta, ...structuredClone(metadataPatch) };
        setStateFromPatch(patch);
        assertMetadataOnly(meta);
        return getRawRow();
      });
    },
  };
  const workspaceTarget = {
    workspacePath: "C:\\fixture\\workspace",
    workspaceIdentity: "workspace-fixture",
  };
  const state = {
    target: workspaceTarget,
    summaries: new Map(),
    storeSummaryMemberships: new Map(),
  };

  async function resyncTaskIndexRowFromAgent(...args) {
    resyncCalls.push(structuredClone(args));
    await Promise.resolve();
    if (options.runtimeReadAvailable !== true) {
      if (options.runtimeReadAvailable === false) {
        runtimeReadFailures += 1;
        warnings.push(["existing-only runtime read unavailable", args]);
      }
      return;
    }
    if (options.runtimeReadMeta) {
      const meta = await repo.syncTaskMeta(options.runtimeReadMeta);
      events.push({
        target: {
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          taskId: meta.taskId,
        },
        meta: structuredClone(meta),
        reason: args[2]?.broadcastReason ?? "task_status_changed",
        ...(args[2]?.unreadSignal ? { unreadSignal: args[2].unreadSignal } : {}),
      });
    } else if (options.onResync) {
      await options.onResync(...args, repo);
    }
  }

  let runtimeReadFailures = 0;
  function emitWorkspaceTaskListChanged(target, meta, reason, extra) {
    events.push({
      target: structuredClone(target),
      meta: meta ? structuredClone(meta) : undefined,
      reason,
      ...(extra?.unreadSignal ? { unreadSignal: extra.unreadSignal } : {}),
    });
  }
  const eventBus = {
    fire(event) {
      terminalEvents.push(event.kind ?? event.reason);
    },
  };
  const functionText = (node) => text.slice(node.getStart(sourceFile), node.end);
  const body = [
    functionText(sessionTargetFrom),
    functionText(broadcastTargetFrom),
    functionText(taskStatusFromSummaryPhase),
    functionText(isTerminalPhase),
    functionText(buildBaselineMeta),
    functionText(unreadSignalFromSummary),
    functionText(emitTerminalAndReady),
    functionText(seedMembership),
    functionText(applyTerminalTransition),
    functionText(applyTitleChange),
    functionText(processSummary),
    "return { processSummary: X, seedStoreBackedTaskMembership };",
  ].join("\n");
  const instantiate = new Function(
    "n",
    "M",
    "Vn",
    "F",
    "an",
    "s",
    "a",
    body,
  );
  const methods = instantiate(
    repo,
    emitWorkspaceTaskListChanged,
    {
      warn(...args) {
        warnings.push(args);
      },
      debug() {},
    },
    resyncTaskIndexRowFromAgent,
    (taskId) => `fixture-trace-${taskId}`,
    eventBus,
    eventBus,
  );
  return {
    methods,
    repo,
    state,
    events,
    warnings,
    resyncCalls,
    terminalEvents,
    operationLog,
    get runtimeReadFailures() {
      return runtimeReadFailures;
    },
  };
}

function makeSummary(sessionId) {
  return {
    sessionId,
    workspaceId: "workspace-fixture",
    title: `External CLI ${sessionId}`,
    titleSource: "custom",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    goalStatus: "verified",
    lastActivityAt: 100,
    createdAt: 10,
  };
}

function makeSummaryMeta(taskId) {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `Task ${taskId}`,
    workspacePath: "C:\\fixture\\workspace",
    workspaceIdentity: "workspace-fixture",
    createdAt: 10,
    updatedAt: 100,
    mode: "default",
    provider: "glm",
    status: "completed",
  };
}

function assertMetadataOnly(value) {
  if (value === null || value === undefined) return;
  for (const field of ["pinned", "archived", "deleted"]) {
    assert.equal(
      Object.hasOwn(value, field),
      false,
      `getTaskMeta fixture leaked SQL row-state column ${field}`,
    );
  }
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

function hashBuffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("arguments must be --name value pairs");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function requiredArg(options, name) {
  assert.ok(options[name], `missing --${name}`);
  return options[name];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
