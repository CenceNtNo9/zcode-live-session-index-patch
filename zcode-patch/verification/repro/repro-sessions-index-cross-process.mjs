import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerScript = join(scriptDirectory, "repro-session-index-worker.mjs");
const sourceRoot = getSourceRoot(process.argv.slice(2));
const expectedCliVersion = "0.16.9";
const packageJson = JSON.parse(
  await readFile(join(sourceRoot, "apps/zcode-cli/package.json"), "utf8"),
);
assert.equal(packageJson.version, expectedCliVersion, "prototype source must match installed CLI 0.16.9");

const adapterEntry = join(
  sourceRoot,
  "apps/zcode-cli/packages/adapters/dist/storage/session-store/sqlite-session-store.js",
);
const gatewayEntry = join(
  sourceRoot,
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/v4-gateway.js",
);
const publisherEntry = join(
  sourceRoot,
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/sessions-index-publisher.js",
);
const watcherSource = join(
  sourceRoot,
  "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-external-session-index-watcher.ts",
);
const tsxLoader = join(sourceRoot, "node_modules/tsx/dist/loader.mjs");
for (const requiredPath of [adapterEntry, gatewayEntry, publisherEntry, watcherSource, tsxLoader]) {
  await readFile(requiredPath);
}

const tempBase = resolve(tmpdir());
const tempRoot = await mkdtemp(join(tempBase, "zcode-session-index-prototype-"));
assertSafeTempRoot(tempRoot);
const tempHome = join(tempRoot, "home");
const dbPath = join(tempRoot, "store.sqlite");
const workspaceA = join(tempRoot, "workspace-a");
const workspaceB = join(tempRoot, "workspace-b");
await Promise.all([mkdir(tempHome), mkdir(workspaceA), mkdir(workspaceB)]);

const childEnvironment = createIsolatedEnvironment(tempHome, tempRoot);
let stage = "starting runtime A";
const watcher = launchWorker("watcher", sourceRoot, dbPath, workspaceA, childEnvironment);
let writer;

try {
  stage = "waiting for runtime A initial index snapshot";
  const watcherReady = await waitForMessage(watcher, (message) => message.type === "ready");
  assert.equal(watcherReady.pid, watcher.child.pid, "runtime A ready message must come from the live child");
  assert.equal(watcherReady.storeWatcherSubscribed, true, "runtime A must have its SQLite watcher subscribed");
  assert.equal(watcherReady.localLiveProjectionProtected, true, "store refresh must preserve A's live projection");
  assert.deepEqual(watcherReady.initialSessions, [], "runtime A starts with an empty workspace snapshot");
  await pingWorker(watcher, "a-ready-before-writer-start");
  assertNoGatewayErrors(watcher);
  assertWorkerAlive(watcher, "after index and SQLite watcher readiness");

  stage = "starting runtime B";
  writer = launchWorker("writer", sourceRoot, dbPath, workspaceA, childEnvironment);
  stage = "waiting for runtime B store";
  const writerReady = await waitForMessage(writer, (message) => message.type === "ready");
  assert.equal(writerReady.pid, writer.child.pid, "runtime B ready message must come from the live child");
  await pingWorker(watcher, "a-alive-before-first-store-write");
  await pingWorker(writer, "b-alive-before-first-store-write");

  const foreignId = "synthetic-foreign-workspace-session";
  const beforeForeignInvalidations = latestInvalidationCount(watcher);
  stage = "writing the foreign-workspace session";
  assertWorkerAlive(watcher, "immediately before foreign workspace write");
  await createSession(writer, workspaceB, foreignId, "Synthetic foreign workspace session", 1);
  stage = "waiting for foreign-workspace invalidation";
  await waitForInvalidation(watcher, beforeForeignInvalidations, writer);
  stage = "checking foreign-workspace isolation";
  await delay(250);
  assertNoGatewayErrors(watcher);
  assertWorkerAlive(watcher, "after foreign workspace invalidation");
  assert.equal(
    getUpserts(watcher, foreignId).length,
    0,
    "workspace B session must not leak into workspace A index",
  );
  assert.equal(getAllDeltas(watcher).length, 0, "foreign workspace commit must emit no workspace A delta");

  const targetId = "synthetic-live-workspace-session";
  const beforeTargetInvalidations = latestInvalidationCount(watcher);
  stage = "writing the workspace A session";
  await pingWorker(watcher, "a-alive-before-target-write");
  await createSession(writer, workspaceA, targetId, "New delegated task", 2);
  stage = "waiting for workspace A invalidation";
  await waitForInvalidation(watcher, beforeTargetInvalidations, writer);
  stage = "waiting for initial default-title V4 upsert";
  await waitForMessage(
    watcher,
    (message) => getUpsertsFromMessage(message, targetId).length > 0,
  );
  assert.equal(getUpserts(watcher, targetId).length, 1, "new session must first enter the subscribed index");
  assert.equal(getUpserts(watcher, targetId)[0].session.title, "New delegated task");
  assert.equal(getUpserts(watcher, targetId)[0].session.titleSource, "default");

  const beforeTitleInvalidations = latestInvalidationCount(watcher);
  stage = "writing first-input title metadata";
  await pingWorker(watcher, "a-alive-before-title-metadata-write");
  await updateTitleMetadata(
    writer,
    targetId,
    "DSP delegated · synthetic first prompt",
    3,
  );
  stage = "waiting for title metadata invalidation";
  await waitForInvalidation(watcher, beforeTitleInvalidations, writer);
  stage = "waiting for corrected V4 title upsert";
  await waitForMessage(
    watcher,
    (message) =>
      getUpsertsFromMessage(message, targetId).some(
        (delta) => delta.session.title === "DSP delegated · synthetic first prompt",
      ),
  );
  stage = "checking corrected title and effective updates";
  await delay(250);
  assertNoGatewayErrors(watcher);
  assertWorkerAlive(watcher, "after target session upsert");
  assert.equal(
    getUpserts(watcher, targetId).length,
    2,
    "session creation and its supported first-input title correction must each produce one logical upsert",
  );
  assert.equal(getUpserts(watcher, targetId)[1].session.title, "DSP delegated · synthetic first prompt");
  assert.equal(getUpserts(watcher, targetId)[1].session.titleSource, "generated");

  // Replaying a metadata-only field changes the SQLite row without changing SessionSummary.
  // The active data_version watcher must observe that commit, but the publisher must not emit
  // a semantically duplicate upsert.
  stage = "replaying unchanged title metadata";
  await pingWorker(watcher, "a-alive-before-duplicate-write");
  const finalTitle = "DSP delegated · synthetic first prompt";
  const beforeReplayInvalidations = latestInvalidationCount(watcher);
  await repeatTitleMetadata(writer, targetId, finalTitle, 4, getUpserts(watcher, targetId)[1].session.lastActivityAt);
  stage = "waiting for data_version to detect metadata-only replay";
  await waitForInvalidation(watcher, beforeReplayInvalidations, writer);
  stage = "checking metadata-only replay idempotence";
  await delay(250);
  assertNoGatewayErrors(watcher);
  assertWorkerAlive(watcher, "after duplicate write");
  assert.equal(
    latestInvalidationCount(watcher),
    beforeReplayInvalidations + 1,
    "one committed metadata-only replay must cause exactly one store invalidation",
  );
  assert.equal(getUpserts(watcher, targetId).length, 2, "repeated notifications/writes must not duplicate the upsert");
  assert.equal(
    getUpserts(watcher, targetId)[1].session.title,
    finalTitle,
    "store-only session summaries must converge to externally written title metadata",
  );

  console.log(
    JSON.stringify({
      result: "PASS",
      sourceVersion: packageJson.version,
      watcherMode: "independent-runtime-process",
      writerMode: "independent-runtime-process",
      desktopDeliveryProfile: "desktop-continuous",
      workspaceBLeakedIntoA: false,
      targetLogicalUpserts: getUpserts(watcher, targetId).length,
      targetUpsertSequence: getUpserts(watcher, targetId).map((delta) => ({
        title: delta.session.title,
        titleSource: delta.session.titleSource,
      })),
      localLiveProjectionProtected: watcherReady.localLiveProjectionProtected,
      metadataOnlyReplayDetected: true,
      duplicateUpserts: getUpserts(watcher, targetId).length - 2,
      targetId,
      externalInvalidations: latestInvalidationCount(watcher),
      providerCalls: 0,
      realUserStoreAccess: false,
      desktopUiTest: false,
    }),
  );
} finally {
  await stopWorker(writer);
  await stopWorker(watcher);
  assertSafeTempRoot(tempRoot);
  await rm(tempRoot, { recursive: true, force: true });
}

function getSourceRoot(args) {
  const index = args.indexOf("--source-root");
  const value = index >= 0 ? args[index + 1] : process.env.ZCODE_SOURCE_ROOT;
  if (!value) {
    throw new Error(
      "Pass --source-root <official ZCode clone> (v3.14.3, CLI 0.16.9) with the source patch applied and built.",
    );
  }
  return resolve(value);
}

function assertSafeTempRoot(path) {
  const resolvedPath = resolve(path);
  const allowedPrefix = `${tempBase}${sep}`.toLowerCase();
  if (
    !resolvedPath.toLowerCase().startsWith(allowedPrefix) ||
    !basename(resolvedPath).startsWith("zcode-session-index-prototype-")
  ) {
    throw new Error(`Refusing to use or remove a path outside the dedicated temp root: ${resolvedPath}`);
  }
}

function createIsolatedEnvironment(home, temp) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "Path", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.USERPROFILE = home;
  env.HOME = home;
  env.TEMP = temp;
  env.TMP = temp;
  return env;
}

function launchWorker(role, root, databasePath, workspace, env) {
  const loaderUrl = pathToFileURL(tsxLoader).href;
  const child = spawn(
    process.execPath,
    ["--import", loaderUrl, workerScript, role, root, databasePath, workspace],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = { child, messages: [], waiters: [], stderr: "", exited: null };
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rejectWaiters(state, new Error(`${role} worker emitted non-JSON output: ${line}`));
        continue;
      }
      dispatchMessage(state, message);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-5000);
  });
  child.on("exit", (code, signal) => {
    state.exited = { code, signal };
    if (code !== 0) {
      rejectWaiters(
        state,
        new Error(`${role} worker exited (${code ?? signal})\n${state.stderr}`),
      );
    }
  });
  return state;
}

function dispatchMessage(state, message) {
  if (message.type === "error") {
    state.messages.push(message);
    rejectWaiters(state, new Error(`Worker failed: ${message.message}\n${state.stderr}`));
    return;
  }
  state.messages.push(message);
  const index = state.waiters.findIndex((waiter) => waiter.predicate(message));
  if (index < 0) return;
  const [waiter] = state.waiters.splice(index, 1);
  clearTimeout(waiter.timer);
  waiter.resolve(message);
}

function rejectWaiters(state, error) {
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function waitForMessage(state, predicate, timeoutMs = 8000) {
  const index = state.messages.findIndex(predicate);
  if (index >= 0) return Promise.resolve(state.messages[index]);
  if (state.exited) {
    return Promise.reject(new Error(`Worker exited before expected message\n${state.stderr}`));
  }
  return new Promise((resolveMessage, rejectMessage) => {
    const waiter = {
      predicate,
      resolve: resolveMessage,
      reject: rejectMessage,
      timer: setTimeout(() => {
        state.waiters = state.waiters.filter((item) => item !== waiter);
        rejectMessage(
          new Error(
            `Timed out during ${stage} waiting for worker output; seen=${state.messages.map((message) => message.type).join(",")}\n${state.stderr}`,
          ),
        );
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

async function createSession(writer, workspaceId, sessionId, title, requestNumber) {
  const requestId = `request-${requestNumber}`;
  writer.child.stdin.write(
    `${JSON.stringify({ type: "create", requestId, workspaceId, sessionId, title })}\n`,
  );
  await waitForMessage(
    writer,
    (message) => message.type === "created" && message.requestId === requestId,
  );
}

async function updateTitleMetadata(writer, sessionId, title, requestNumber) {
  const requestId = `request-${requestNumber}`;
  writer.child.stdin.write(
    `${JSON.stringify({ type: "update-title", requestId, sessionId, title })}\n`,
  );
  const result = await waitForMessage(
    writer,
    (message) => message.type === "updated-title" && message.requestId === requestId,
  );
  assert.equal(result.title, title);
  assert.equal(result.titleSource, "first_input");
}

async function repeatTitleMetadata(writer, sessionId, title, requestNumber, timeUpdated) {
  const requestId = `request-${requestNumber}`;
  writer.child.stdin.write(
    `${JSON.stringify({ type: "repeat-title", requestId, sessionId, title, timeUpdated })}\n`,
  );
  const result = await waitForMessage(
    writer,
    (message) => message.type === "repeated-title" && message.requestId === requestId,
  );
  assert.equal(result.title, title);
  assert.equal(result.titleSource, "first_input");
}

async function pingWorker(state, requestId) {
  assertWorkerAlive(state, `before ping ${requestId}`);
  state.child.stdin.write(`${JSON.stringify({ type: "ping", requestId })}\n`);
  const pong = await waitForMessage(
    state,
    (message) => message.type === "pong" && message.requestId === requestId,
  );
  assert.equal(pong.pid, state.child.pid, `ping ${requestId} must be answered by the same process`);
  assertWorkerAlive(state, `after ping ${requestId}`);
}

function assertWorkerAlive(state, context) {
  assert.ok(state, `${context}: worker exists`);
  assert.equal(state.exited, null, `${context}: worker process must remain alive`);
  assert.equal(state.child.exitCode, null, `${context}: child exit code must remain unset`);
  assert.equal(state.child.signalCode, null, `${context}: child signal code must remain unset`);
}

async function waitForInvalidation(watcher, previousCount, writer) {
  try {
    await waitForMessage(
      watcher,
      (message) => message.type === "invalidation" && message.count > previousCount,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nA=${JSON.stringify(watcher.messages)}\nB=${JSON.stringify(writer.messages)}`,
    );
  }
}

function latestInvalidationCount(state) {
  return state.messages
    .filter((message) => message.type === "invalidation")
    .reduce((latest, message) => Math.max(latest, message.count), 0);
}

function getAllDeltas(state) {
  return state.messages.flatMap((message) => {
    if (message.type !== "wire") return [];
    const wire = message.wire;
    if (wire.kind !== "complete") return [];
    return wire.frame?.payload?.kind === "deltas" ? wire.frame.payload.deltas : [];
  });
}

function getUpserts(state, sessionId) {
  return getAllDeltas(state).filter(
    (delta) => delta.op === "session.upserted" && delta.session.sessionId === sessionId,
  );
}

function getUpsertsFromMessage(message, sessionId) {
  if (message.type !== "wire" || message.wire.kind !== "complete") return [];
  const payload = message.wire.frame?.payload;
  if (payload?.kind !== "deltas") return [];
  return payload.deltas.filter(
    (delta) => delta.op === "session.upserted" && delta.session.sessionId === sessionId,
  );
}

function assertNoGatewayErrors(state) {
  const errors = state.messages.filter((message) => message.type === "gateway-error");
  assert.deepEqual(errors, [], `gateway should not report refresh errors: ${JSON.stringify(errors)}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function stopWorker(state) {
  if (!state || state.exited) return;
  state.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
  try {
    await waitForMessage(state, (message) => message.type === "closed", 3000);
  } catch {
    state.child.kill();
  }
  if (!state.exited) {
    await Promise.race([
      new Promise((resolveExit) => state.child.once("exit", resolveExit)),
      delay(3000).then(() => state.child.kill()),
    ]);
  }
}
