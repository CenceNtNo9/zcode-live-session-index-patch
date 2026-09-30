import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , role, sourceRootArg, dbPathArg, workspaceAArg] = process.argv;
const sourceRoot = resolve(sourceRootArg ?? "");
const dbPath = resolve(dbPathArg ?? "");
const workspaceA = resolve(workspaceAArg ?? "");

if (!new Set(["watcher", "writer"]).has(role)) throw new Error("Invalid worker role");

function importSource(relativePath) {
  return import(pathToFileURL(resolve(sourceRoot, relativePath)).href);
}

const [{ SqliteSessionStore }, membership] = await Promise.all([
  importSource("apps/zcode-cli/packages/adapters/dist/storage/session-store/sqlite-session-store.js"),
  importSource("apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/task-list-session-membership.js"),
]);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const store = await SqliteSessionStore.openStartup({ dbPath });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let commandQueue = Promise.resolve();
let gateway;
let invalidationCount = 0;
let storeWatcherSubscribed = false;
let closed = false;

async function close() {
  if (closed) return;
  closed = true;
  gateway?.dispose();
  store.close();
  input.close();
  send({ type: "closed" });
}

async function handleCommand(message) {
  if (message?.type === "stop") {
    await close();
    return;
  }
  if (message?.type === "ping") {
    send({ type: "pong", requestId: message.requestId, pid: process.pid, role });
    return;
  }
  if (role !== "writer") throw new Error("Unsupported worker command");
  if (message?.type === "create") {
    const sessionId = String(message.sessionId);
    const workspaceId = resolve(String(message.workspaceId));
    await store.createSession({
      id: sessionId,
      projectID: "prototype-project",
      taskType: "interactive",
      slug: `prototype-${sessionId}`,
      directory: workspaceId,
      path: workspaceId,
      title: String(message.title),
      titleSource: "default",
      version: "0.16.9",
    });
    send({ type: "created", requestId: message.requestId, sessionId });
    return;
  }
  if (message?.type === "update-title") {
    const updated = await store.updateSession({
      id: String(message.sessionId),
      title: String(message.title),
      titleSource: "first_input",
      titleMessageID: "prototype-first-prompt-message",
    });
    send({
      type: "updated-title",
      requestId: message.requestId,
      sessionId: String(updated.id),
      title: updated.title,
      titleSource: updated.titleSource,
      timeUpdated: updated.time.updated,
    });
    return;
  }
  if (message?.type === "repeat-title") {
    const updated = await store.updateSession({
      id: String(message.sessionId),
      title: String(message.title),
      timeUpdated: Number(message.timeUpdated),
      titleMessageID: "prototype-first-prompt-message-replay",
    });
    send({
      type: "repeated-title",
      requestId: message.requestId,
      sessionId: String(updated.id),
      title: updated.title,
      titleSource: updated.titleSource,
      timeUpdated: updated.time.updated,
    });
    return;
  }
  throw new Error("Unsupported writer command");
}

input.on("line", (line) => {
  commandQueue = commandQueue
    .then(() => handleCommand(JSON.parse(line)))
    .catch((error) => {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
});

if (role === "watcher") {
  const { SessionsIndexProjection } = await importSource(
    "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/sessions-index-projection.js",
  );
  const liveSessionId = "synthetic-local-live-session";
  const liveProjection = new SessionsIndexProjection(workspaceA, "prototype-live-authority");
  liveProjection.seed({
    sessionId: liveSessionId,
    workspaceId: workspaceA,
    title: "Synthetic persisted baseline",
    titleSource: "first_input",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 10,
    createdAt: 10,
  });
  liveProjection.upsertFromConversation(
    {
      sessionId: liveSessionId,
      meta: { title: "Synthetic host live title", titleSource: "custom" },
      control: { phase: "running", sessionEnded: false },
      rows: { window: [] },
      workflowRuns: [],
      backgroundWorks: [],
      pendingInteractions: [],
    },
    { createdAt: 10, lastActivityAt: 20 },
  );
  const liveBeforeRefresh = liveProjection.getSnapshot().sessions[0];
  assert.ok(liveBeforeRefresh);
  assert.deepEqual(
    liveProjection.refreshStoredSummary({
      ...liveBeforeRefresh,
      title: "Synthetic stale external store title",
      titleSource: "first_input",
      phase: "completedSuccess",
      sessionEnded: true,
      lastActivityAt: 30,
    }),
    [],
    "external metadata must not replace an existing live conversation projection",
  );
  assert.deepEqual(liveProjection.getSnapshot().sessions[0], liveBeforeRefresh);

  const { ConversationV4Gateway } = await importSource(
    "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/v4-gateway.js",
  );
  gateway = new ConversationV4Gateway({
    sessionExists: () => false,
    emitWireFrame: (wire) => send({ type: "wire", wire }),
    executeCommand: async () => undefined,
    listWorkspaceSessionIds: () => [],
    getStoredSessionSummaries: async (workspaceId) => {
      const sessions = await store.listSessions({
        directory: workspaceId,
        includeArchived: false,
        limit: 200,
        taskTypes: [...membership.TASK_LIST_SESSION_TYPES],
        workspaceID: null,
      });
      return sessions.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource:
          session.titleSource === "custom"
            ? "custom"
            : session.titleSource === "default"
              ? "default"
              : "generated",
        phase: "completedSuccess",
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    },
    subscribeStoredSessionChanges: (onChange, onError) => {
      const unsubscribe = store.subscribeExternalSessionIndexInvalidation(() => {
        invalidationCount += 1;
        send({ type: "invalidation", count: invalidationCount });
        onChange();
      }, onError);
      storeWatcherSubscribed = true;
      return unsubscribe;
    },
    onError: (scope, error) =>
      send({ type: "gateway-error", scope, message: error instanceof Error ? error.message : String(error) }),
  });

  const dispatch = await gateway.subscribeSessionsIndex({
    topic: `sessions-index/${workspaceA}`,
    connectionId: "prototype-desktop-connection",
    clientMode: "desktop-continuous",
  });
  const initialSessions =
    dispatch.initialFrame?.payload.kind === "snapshot"
      ? dispatch.initialFrame.payload.snapshot.sessions.map((session) => session.sessionId)
      : [];
  send({
    type: "ready",
    initialSessions,
    pid: process.pid,
    storeWatcherSubscribed,
    localLiveProjectionProtected: true,
  });
} else {
  // Keep runtime B as a separate process with its own SQLite connection until the gate ends.
  send({ type: "ready", pid: process.pid });
}
