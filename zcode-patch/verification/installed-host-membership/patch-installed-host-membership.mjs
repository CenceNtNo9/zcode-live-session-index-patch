import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const EXPECTED_BASELINE = Object.freeze({
  hostBytes: 1_497_917,
  hostSha256: "A339D8142ED19ABFBAB75AF6F8464D98C95042CA87C0B129D2E6300F12D39899",
  archiveBytes: 326_915_059,
  archiveSha256: "D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C",
});

const EXPECTED_ENTRIES = Object.freeze({
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
});

const REQUIRED_RPC_EVENT = "onDynamicWorkspaceProviderRuntimeHeadersCancelled";
const REQUIRED_RPC_EVENT_COUNT = 1;

const ORIGINAL_PROCESS_SUMMARY =
  'function X(b,Q,te,de){if(b.summaries.set(te.sessionId,te),te.phase==="draft")return;let Ae=O(b.target,te.sessionId),Ie=Q===void 0||Q.phase==="draft";if(Q!==void 0&&!S2(Q.phase)&&S2(te.phase)){Y(Ae,te,{moveGroupedTaskToTop:Ie});return}if(Ie){F(Ae,"session.became-visible",{moveGroupedTaskToTop:!0});return}let mt=te.title.trim();mt&&(Q===void 0||Q.title!==te.title)&&re(Ae,mt)}';

const STORE_MEMBERSHIP_HELPER = `async function seedStoreBackedTaskMembership(b,Q,te){
let de=Q.title.trim();
if(!Q.sessionEnded||Q.titleSource==="default"||!de)return;
let xe=b.storeSummaryMemberships.get(Q.sessionId);
if(xe==="admitted"||xe==="inFlight")return;
let Ae=O(b.target,Q.sessionId),Ie={workspacePath:Ae.workspacePath,workspaceIdentity:Ae.workspaceIdentity,taskId:Ae.sessionId};
let Ce=!1;
b.storeSummaryMemberships.set(Q.sessionId,"inFlight");
try{
let Fe=await n.getTaskMeta(Ie);
if(xe!=="pending"&&Fe){b.storeSummaryMemberships.delete(Q.sessionId);return}
await n.seedTaskMetaIfMissing(kIe(b.target,Q));
Ce=!0;
await n.initializeGroupedTaskAtTop(Ie);
let Be=await n.getTaskMeta(Ie);
if(!Be){b.storeSummaryMemberships.set(Q.sessionId,"admitted");return}
let Ge=n.getTaskRow(Ie);
if(!Ge||Ge.deleted===1||Ge.archived===1||Ge.pinned===1){b.storeSummaryMemberships.set(Q.sessionId,"admitted");return}
let De=vIe(Q);
M(L(Ae),Be,"task_created",De?{unreadSignal:De}:void 0);
b.storeSummaryMemberships.set(Q.sessionId,"admitted");
}catch(Be){
if(b.storeSummaryMemberships.get(Q.sessionId)==="inFlight"){if(Ce||xe==="pending")b.storeSummaryMemberships.set(Q.sessionId,"pending");else b.storeSummaryMemberships.delete(Q.sessionId)}
Vn.warn(void 0,"store-backed sessions-index membership sync failed reason="+te+" taskId="+Ae.sessionId,Be);
}
}`;

const UPDATED_PROCESS_SUMMARY =
  'function X(b,Q,te,de){if(b.summaries.set(te.sessionId,te),te.phase==="draft")return;let Ae=O(b.target,te.sessionId),Ie=Q===void 0||Q.phase==="draft";if(Q!==void 0&&!S2(Q.phase)&&S2(te.phase)){Y(Ae,te,{moveGroupedTaskToTop:Ie});if(te.sessionEnded)void seedStoreBackedTaskMembership(b,te,"session.terminalTransition");return}if(Ie){F(Ae,"session.became-visible",{moveGroupedTaskToTop:!0});if(te.sessionEnded)void seedStoreBackedTaskMembership(b,te,"session.became-visible");return}let mt=te.title.trim();mt&&(Q===void 0||Q.title!==te.title)&&re(Ae,mt);te.sessionEnded&&te.titleSource!=="default"&&mt&&void seedStoreBackedTaskMembership(b,te,"session.summaryUpdated")}';

export function patchHostBuffer(hostBytes, tsApi) {
  const baseline = Buffer.from(hostBytes);
  assert.equal(
    baseline.byteLength,
    EXPECTED_BASELINE.hostBytes,
    "frozen Host baseline byte length changed",
  );
  assert.equal(
    hashBuffer(baseline),
    EXPECTED_BASELINE.hostSha256,
    "frozen Host baseline fingerprint changed",
  );

  const hostText = baseline.toString("utf8");
  assert.ok(Buffer.from(hostText, "utf8").equals(baseline), "Host baseline is not valid UTF-8 text");
  assert.equal(
    countOccurrences(hostText, REQUIRED_RPC_EVENT),
    REQUIRED_RPC_EVENT_COUNT,
    "installed RPC event contract anchor is missing or ambiguous",
  );

  const sourceFile = parseJavaScript(tsApi, "baseline-host-entry.js", hostText);
  const factory = locateUniqueMappedFunction(tsApi, sourceFile, "createZCodeTaskIndexSyncer");
  const processSummary = locateUniqueMappedFunction(tsApi, factory, "processSummary");
  assert.equal(
    textOf(hostText, sourceFile, processSummary),
    ORIGINAL_PROCESS_SUMMARY,
    "installed processSummary shape differs from the reviewed frozen baseline",
  );

  const initialSeeder = locateUniqueMappedFunction(
    tsApi,
    factory,
    "seedMissingRowsFromInitialSnapshot",
  );
  const initialSeederText = textOf(hostText, sourceFile, initialSeeder);
  assert.ok(
    initialSeederText.includes('filter(Ie=>Ie.phase!=="draft")')
      && initialSeederText.includes("n.seedTaskMetaIfMissing(kIe(b.target,Gt))"),
    "installed cold-start admission path no longer matches the reviewed baseline",
  );

  const membershipState = locateUniqueMembershipStateObject(tsApi, factory);
  assert.ok(
    !membershipState.properties.some((property) => propertyName(tsApi, property) === "storeSummaryMemberships"),
    "membership retry state already exists in the installed factory",
  );
  const seededProperty = membershipState.properties.find(
    (property) => propertyName(tsApi, property) === "seeded",
  );
  assert.ok(seededProperty, "installed workspace state has no seed marker insertion anchor");

  const changes = [
    {
      name: "workspace membership retry set",
      start: seededProperty.getStart(sourceFile),
      end: seededProperty.getStart(sourceFile),
      replacement: "storeSummaryMemberships:new Map,",
      rationale: "Track one in-flight/pending/admitted state per store-backed session so a post-seed failure can resume without treating its own row as pre-existing local membership.",
    },
    {
      name: "live summary membership admission",
      start: processSummary.getStart(sourceFile),
      end: processSummary.end,
      replacement: `${STORE_MEMBERSHIP_HELPER}\n${UPDATED_PROCESS_SUMMARY}`,
      rationale:
        "Use the installed sessionEnded/titleSource gate, resume post-seed failures through the existing insert-if-missing queue, preserve local eligibility guards, and broadcast fresh eligible metadata once.",
    },
  ].sort((left, right) => left.start - right.start);

  assert.ok(
    changes.every((change, index) => index === 0 || changes[index - 1].end <= change.start),
    "AST edit ranges overlap",
  );

  const candidateText = applyChanges(hostText, changes);
  const candidateBytes = Buffer.from(candidateText, "utf8");
  const candidateSourceFile = parseJavaScript(tsApi, "host-index-installed-membership.candidate.js", candidateText);
  const candidateFactory = locateUniqueMappedFunction(
    tsApi,
    candidateSourceFile,
    "createZCodeTaskIndexSyncer",
  );
  locateUniqueMappedFunction(tsApi, candidateFactory, "processSummary");
  locateUniqueFunctionDeclaration(tsApi, candidateFactory, "seedStoreBackedTaskMembership");
  const candidateState = locateUniqueMembershipStateObject(tsApi, candidateFactory);
  assert.ok(
    candidateState.properties.some(
      (property) => propertyName(tsApi, property) === "storeSummaryMemberships",
    ),
    "candidate retry-state insertion is missing",
  );
  assert.equal(
    countOccurrences(candidateText, REQUIRED_RPC_EVENT),
    REQUIRED_RPC_EVENT_COUNT,
    "candidate changed the installed RPC event contract",
  );

  const spans = verifyOnlyChangedSpans(hostText, candidateText, changes);
  return {
    candidateText,
    candidateBytes,
    changedSpans: spans,
    baseline: {
      bytes: baseline.byteLength,
      sha256: hashBuffer(baseline),
    },
    candidate: {
      bytes: candidateBytes.byteLength,
      sha256: hashBuffer(candidateBytes),
    },
    rpcEvent: {
      name: REQUIRED_RPC_EVENT,
      baselineCount: REQUIRED_RPC_EVENT_COUNT,
      candidateCount: countOccurrences(candidateText, REQUIRED_RPC_EVENT),
    },
  };
}

export function locateUniqueMappedFunction(tsApi, root, mappedName) {
  const mappedCalls = [];
  const visit = (node) => {
    if (
      tsApi.isCallExpression(node)
      && tsApi.isIdentifier(node.expression)
      && node.expression.text === "i"
      && node.arguments.length >= 2
      && tsApi.isIdentifier(node.arguments[0])
      && tsApi.isStringLiteralLike(node.arguments[1])
      && node.arguments[1].text === mappedName
    ) {
      mappedCalls.push(node);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(root);

  assert.equal(
    mappedCalls.length,
    1,
    `expected exactly one mapped ${mappedName} anchor; found ${mappedCalls.length}`,
  );
  let statementList = mappedCalls[0].parent;
  while (statementList && !tsApi.isBlock(statementList) && !tsApi.isSourceFile(statementList)) {
    statementList = statementList.parent;
  }
  assert.ok(statementList, `could not find lexical statement list for ${mappedName}`);
  const symbolName = mappedCalls[0].arguments[0].text;
  const matches = [...statementList.statements].filter(
    (statement) => tsApi.isFunctionDeclaration(statement) && statement.name?.text === symbolName,
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one function declaration for ${mappedName}; found ${matches.length}`,
  );
  return matches[0];
}

export function locateUniqueFunctionDeclaration(tsApi, root, functionName) {
  const matches = [];
  const visit = (node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name?.text === functionName) matches.push(node);
    tsApi.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${functionName} function anchor; found ${matches.length}`,
  );
  return matches[0];
}

export function locateUniqueMembershipStateObject(tsApi, root) {
  const matches = [];
  const visit = (node) => {
    if (tsApi.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter((property) =>
        ["summaries", "seeded"].includes(propertyName(tsApi, property)),
      );
      if (properties.length === 2) matches.push({ node, properties: [...node.properties] });
    }
    tsApi.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(
    matches.length,
    1,
    `expected exactly one workspace state object anchor; found ${matches.length}`,
  );
  return matches[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeRoot = resolve(requiredArg(args, "runtime-root"));
  const inputRoot = resolve(requiredArg(args, "input-root"));
  const archivePath = resolve(requiredArg(args, "archive"));
  const hostPath = resolve(requiredArg(args, "baseline-host"));
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
  assert.match(
    artifactSuffix,
    /^$|^-[a-z0-9-]+$/i,
    "artifact suffix must contain only letters, digits, and hyphens",
  );
  assertWithin(inputRoot, archivePath, "frozen app.asar input");
  assertWithin(inputRoot, hostPath, "frozen Host entry input");
  assertTempRoot(tempRoot);
  assertNoReparsePath(tempRoot, tempRoot);
  assertNoReparsePath(inputRoot, inputRoot);
  assertNoReparsePath(archivePath, inputRoot);
  assertNoReparsePath(hostPath, inputRoot);
  assertRegularFile(archivePath, "frozen app.asar");
  assertRegularFile(hostPath, "frozen Host entry");

  const candidatePath = join(tempRoot, `host-index-installed-membership${artifactSuffix}.candidate.js`);
  const reportPath = join(tempRoot, `host-index-installed-membership${artifactSuffix}.report.json`);
  await assertAbsent(candidatePath);
  await assertAbsent(reportPath);

  const requireFromRuntime = createRequire(join(runtimeRoot, "package.json"));
  const tsApi = requireFromRuntime("typescript");
  const asar = requireFromRuntime("@electron/asar");
  const archiveEvidence = await inspectArchive(asar, tsApi, archivePath, hostPath);
  const hostBytes = await readFile(hostPath);
  const patched = patchHostBuffer(hostBytes, tsApi);

  const report = {
    result: "PASS",
    purpose: "Frozen installed Host TaskIndexSyncer live-membership candidate; no ASAR was created or deployed.",
    archive: archiveEvidence.archive,
    hostEntry: archiveEvidence.hostEntry,
    protocolEvidence: archiveEvidence.protocolEvidence,
    taskIndexRepoEvidence: archiveEvidence.taskIndexRepoEvidence,
    admissionScope: {
      gate:
        "seed only when sessionEnded is true, titleSource is not default, and title is nonempty after trim",
      retry:
        "workspace-local Map tracks inFlight/pending/admitted: an already existing row before the first seed stays local and emits no task_created; a failure before a new seed clears that attempt; once pending, every recovery-stage failure (including getTaskMeta read failure before reseeding) retains pending so a later qualifying summary can resume idempotent seed/grouping and broadcast fresh eligible metadata once",
      whileNotEnded:
        "preserves the existing-only runtime resync path and does not seed from the store summary",
      productTiming:
        "UNVERIFIED at runtime: the installed CLI static producer maps stored session summaries to phase=completedSuccess and sessionEnded=true, including external-session-store invalidations, so this Host gate can admit while another process may still be executing. Actual store-write, Desktop upsert delivery, and GUI visibility timing have not been exercised; this candidate does not prove creation-time or during-execution visibility.",
    },
    rpcEvent: {
      ...patched.rpcEvent,
      changedBytes: false,
    },
    changedSpans: patched.changedSpans,
    unchangedBytesOutsideSpans:
      patched.baseline.bytes - patched.changedSpans.reduce((sum, span) => sum + span.oldByteLength, 0),
    candidate: {
      path: candidatePath,
      bytes: patched.candidate.bytes,
      sha256: patched.candidate.sha256,
    },
    bootRuntime: {
      result: "NOT_RUN",
      reason:
        "Host startup starts provider-runtime background release checks; this candidate was not launched because this harness has no verified per-process network egress deny.",
    },
  };

  await writeFile(candidatePath, patched.candidateBytes, { flag: "wx" });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ result: "PASS", candidatePath, reportPath, ...report.candidate }, null, 2)}\n`);
}

async function inspectArchive(asar, tsApi, archivePath, hostPath) {
  const archiveStat = await stat(archivePath);
  assert.equal(archiveStat.size, EXPECTED_BASELINE.archiveBytes, "frozen app.asar byte length changed");
  const archiveSha256 = await hashFile(archivePath);
  assert.equal(
    archiveSha256,
    EXPECTED_BASELINE.archiveSha256,
    "frozen app.asar fingerprint changed",
  );

  const hostBytes = await readFile(hostPath);
  const archiveHostBytes = asar.extractFile(archivePath, "out\\host\\index.js");
  assert.ok(archiveHostBytes.equals(hostBytes), "standalone frozen Host entry differs from app.asar entry");

  const entries = {};
  for (const [name, evidence] of Object.entries(EXPECTED_ENTRIES)) {
    const bytes = asar.extractFile(archivePath, evidence.path);
    assert.equal(bytes.byteLength, evidence.bytes, `${name} archive entry byte length changed`);
    assert.equal(hashBuffer(bytes), evidence.sha256, `${name} archive entry fingerprint changed`);
    entries[name] = { path: evidence.path.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: hashBuffer(bytes) };
  }

  const schemaText = asar.extractFile(archivePath, EXPECTED_ENTRIES.sessionsIndexSchema.path).toString("utf8");
  const sessionSummaryFields = [
    "Yo=e.object({sessionId:e.string(),workspaceId:e.string(),parentSessionId:e.string().optional(),title:e.string(),",
    "titleSource:ye.shape.titleSource.optional(),phase:he,sessionEnded:e.boolean(),hasBackgroundWork:e.boolean(),",
    "workflowActivity:Se.optional(),pendingInteraction:hr.optional(),pendingInteractionSummary:tt.optional(),",
    "goalStatus:Ce.shape.status.optional(),lastActivityAt:_,lastAssistantPreview:e.string().optional(),createdAt:_",
  ];
  let lastIndex = -1;
  for (const field of sessionSummaryFields) {
    const index = schemaText.indexOf(field);
    assert.ok(index > lastIndex, `installed sessions-index summary schema field order changed at ${field}`);
    lastIndex = index;
  }

  const repositoryText = asar.extractFile(archivePath, EXPECTED_ENTRIES.taskIndexRepo.path).toString("utf8");
  const repositoryMarkers = [
    "async seedTaskMetaIfMissing(e){return await this.ensureReady(),this.enqueueWrite(e,()=>{let t=this.getTaskRow(e);return t?G(t):this.writeRecord({meta:e,pinned:!1,archived:!1,deleted:!1,titleOverridden:e.titleOverridden??!1})})}",
    "enqueueWrite(e,t){let n=this.writeKey(e),o=(this.writeChains.get(n)??Promise.resolve()).catch(()=>{}).then(t),d=o.then(()=>{},()=>{});return this.writeChains.set(n,d),d.finally(()=>{this.writeChains.get(n)===d&&this.writeChains.delete(n)}),o}",
    "async applyAgentPatch(e){return await this.ensureReady(),this.enqueueWrite(e,()=>{let t=this.getTaskRow(e);if(!t||t.deleted===1)return null;",
    "async syncTaskMetaWithGroupedAdmission(e,t){return await this.ensureReady(),this.enqueueWrite(e.meta,()=>{let n=this.getDatabase();t&&n.exec(\"BEGIN IMMEDIATE\");try{let s=this.getTaskRow(e.meta),o=s?G(s):null,d=e.titleOverridden??s?.title_overridden===1,a=Math.max(e.meta.updatedAt,o?.updatedAt??0),c=bs(o,e.meta),u={...e.meta,title:d&&o?o.title:e.meta.title,titleOverridden:d,status:c?o?.status:e.meta.status,lastError:c?o?.lastError:e.meta.lastError,target:Object.prototype.hasOwnProperty.call(e.meta,\"target\")?e.meta.target:o?.target,migrationSource:e.meta.migrationSource??o?.migrationSource,cronAutomationId:e.meta.cronAutomationId??o?.cronAutomationId,offPeakTaskId:e.meta.offPeakTaskId??o?.offPeakTaskId,updatedAt:a,unreadAt:e.meta.unreadAt??o?.unreadAt},_=this.writeRecord({meta:u,pinned:e.pinned??s?.pinned===1,archived:e.archived??s?.archived===1,deleted:e.deleted??s?.deleted===1,titleOverridden:d,searchableText:e.searchableText});",
    "initializeGroupedTaskAtTopReady(e){let t=this.getTaskRow(e);if(!t||t.deleted===1||t.archived===1||t.pinned===1)return!1;",
    "async getTaskMeta(e){await this.ensureReady();let t=this.getTaskRow(e);return!t||t.deleted===1?null:G(t)}",
    "getTaskRow(e){return this.getDatabase().prepare(`SELECT\n          workspace_key,\n          workspace_path,\n          workspace_identity,\n          task_id,\n          title,\n          task_status,\n          provider,\n          mode,\n          model,\n          migration_source,\n          forked_from_task_id,\n          cron_automation_id,\n          off_peak_task_id,\n          created_at,\n          updated_at,\n          unread_at,\n          last_unread_at,\n          pinned,\n          archived,\n          deleted,\n          title_overridden,\n          searchable_text,\n          meta_json\n        FROM tasks\n        WHERE workspace_key = ? AND task_id = ?`).get(M(e),e.taskId)??null}",
    "function G(r){let e=Ns(r);try{let t=st.safeParse(JSON.parse(r.meta_json));if(t.success)return{...t.data,taskId:r.task_id,workspacePath:r.workspace_path,workspaceIdentity:e,unreadAt:r.unread_at??void 0,cronAutomationId:t.data.cronAutomationId??r.cron_automation_id??void 0,offPeakTaskId:t.data.offPeakTaskId??r.off_peak_task_id??void 0,titleOverridden:r.title_overridden===1};",
  ];
  for (const marker of repositoryMarkers) {
    assert.ok(repositoryText.includes(marker), "installed TaskIndexRepo admission/tombstone guard changed");
  }
  assert.ok(repositoryText.includes("var be=class{constructor(e,t=5e3){this.startupDbPath=e;this.startupBusyTimeoutMs=t}"), "raw-row class expression differs from the reviewed TaskIndexRepo shape");
  assert.ok(repositoryText.includes('be as q,'), "chunk-NKOHJ4QI.js no longer exports TaskIndexRepo as q");
  const hostText = hostBytes.toString("utf8");
  assert.ok(hostText.includes('q as mc') && hostText.includes('from"./chunk-NKOHJ4QI.js"'), "frozen Host no longer imports TaskIndexRepo q as mc from the reviewed chunk");
  assert.ok(hostText.includes("k=new mc") && hostText.includes("k2({agentService:Xe,taskIndexRepo:k})"), "frozen Host TaskIndexRepo construction-to-syncer wiring changed");

  const hostSourceFile = parseJavaScript(tsApi, hostPath, hostText);
  const syncerFactory = locateUniqueMappedFunction(
    tsApi,
    hostSourceFile,
    "createZCodeTaskIndexSyncer",
  );
  const applySessionsIndexFrame = locateUniqueMappedFunction(
    tsApi,
    syncerFactory,
    "applySessionsIndexFrame",
  );
  const frameApplicationText = textOf(hostText, hostSourceFile, applySessionsIndexFrame);
  assert.ok(
    frameApplicationText.includes('de.op==="session.upserted"')
      && frameApplicationText.includes("X(b,b.summaries.get(de.session.sessionId),de.session,te)"),
    "installed sessions-index upsert no longer passes its normalized summary directly to processSummary",
  );

  const hostEntries = (await asar.listPackage(archivePath))
    .filter((entry) => entry.startsWith("\\out\\host\\") && entry.endsWith(".js"))
    .map((entry) => entry.replace(/^\\/, ""));
  let eventCount = 0;
  for (const entry of hostEntries) {
    eventCount += countOccurrences(
      asar.extractFile(archivePath, entry).toString("utf8"),
      REQUIRED_RPC_EVENT,
    );
  }
  assert.equal(eventCount, REQUIRED_RPC_EVENT_COUNT, "frozen Host RPC event marker count changed");

  return {
    archive: {
      path: archivePath,
      bytes: archiveStat.size,
      sha256: archiveSha256,
    },
    hostEntry: {
      path: hostPath,
      bytes: hostBytes.byteLength,
      sha256: hashBuffer(hostBytes),
      archiveEntryMatches: true,
      hostJavascriptEntryCount: hostEntries.length,
      rpcEventTotalAcrossHostJavascript: eventCount,
    },
    protocolEvidence: {
      sessionsIndexSchema: entries.sessionsIndexSchema,
      sessionSummaryFields: [
        "sessionId",
        "workspaceId",
        "parentSessionId?",
        "title",
        "titleSource?",
        "phase",
        "sessionEnded",
        "hasBackgroundWork",
        "workflowActivity?",
        "pendingInteraction?",
        "pendingInteractionSummary?",
        "goalStatus?",
        "lastActivityAt",
        "lastAssistantPreview?",
        "createdAt",
      ],
      upsertDelivery:
        "applySessionsIndexFrame passes de.session directly to processSummary after reading de.session.sessionId from the installed sessions-index upsert.",
    },
    taskIndexRepoEvidence: {
      chunk: entries.taskIndexRepo,
      storageWorker: entries.storageWorker,
      classBindingAndHostWiring:
        'chunk-NKOHJ4QI.js defines `be` with static class name `TaskIndexRepo` and exports `be as q`; frozen Host imports `q as mc`, constructs `k=new mc`, then passes `taskIndexRepo:k` to the mapped TaskIndexSyncer factory.',
      seedTaskMetaIfMissing: "returns the existing row when present; writes baseline metadata only when no row exists",
      initializeGroupedTaskAtTop: "does not admit a missing/deleted/archived/pinned task row",
      getTaskMeta:
        "awaits ensureReady, reads getTaskRow, returns null for missing/deleted rows, otherwise applies G(row); G returns TaskMeta fields and does not copy SQL pinned/archived/deleted columns",
      getTaskRow:
        "synchronous internal method selects raw pinned, archived, and deleted SQL columns by workspace_key and task_id; used only after awaited getTaskMeta has established repository readiness, with numeric 0/1 flags checked immediately before broadcast",
      writeQueue:
        "applyAgentPatch, syncTaskMeta, and seedTaskMetaIfMissing serialize by workspace/task key; seeding rechecks getTaskRow inside that queue, so preceding terminal/title patches run before the seed write",
      syncMerge:
        "syncTaskMeta preserves title when titleOverridden is set, preserves status when the installed terminal-status merge predicate requires it, keeps unreadAt unless a write explicitly updates it, and defaults pin/archive/delete to existing values",
    },
  };
}

function parseJavaScript(tsApi, filename, text) {
  const sourceFile = tsApi.createSourceFile(
    filename,
    text,
    tsApi.ScriptTarget.Latest,
    true,
    tsApi.ScriptKind.JS,
  );
  assert.equal(
    sourceFile.parseDiagnostics.length,
    0,
    `${filename} failed TypeScript JavaScript syntax parsing: ${formatDiagnostics(tsApi, sourceFile.parseDiagnostics)}`,
  );
  return sourceFile;
}

function applyChanges(text, changes) {
  let candidate = text;
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    candidate = candidate.slice(0, change.start) + change.replacement + candidate.slice(change.end);
  }
  return candidate;
}

function verifyOnlyChangedSpans(original, candidate, changes) {
  const spans = [];
  let originalCursor = 0;
  let candidateCursor = 0;

  for (const change of changes) {
    const unchanged = original.slice(originalCursor, change.start);
    assert.equal(
      candidate.slice(candidateCursor, candidateCursor + unchanged.length),
      unchanged,
      `candidate changed bytes before ${change.name}`,
    );
    candidateCursor += unchanged.length;

    const candidateStart = candidateCursor;
    assert.equal(
      candidate.slice(candidateStart, candidateStart + change.replacement.length),
      change.replacement,
      `candidate changed span differs from requested AST edit: ${change.name}`,
    );
    candidateCursor += change.replacement.length;

    const oldText = original.slice(change.start, change.end);
    const newText = change.replacement;
    spans.push({
      name: change.name,
      rationale: change.rationale,
      oldByteStart: utf8Offset(original, change.start),
      oldByteEnd: utf8Offset(original, change.end),
      oldByteLength: Buffer.byteLength(oldText, "utf8"),
      oldSha256: hashBuffer(Buffer.from(oldText, "utf8")),
      oldText,
      candidateByteStart: utf8Offset(candidate, candidateStart),
      candidateByteEnd: utf8Offset(candidate, candidateCursor),
      candidateByteLength: Buffer.byteLength(newText, "utf8"),
      candidateSha256: hashBuffer(Buffer.from(newText, "utf8")),
      candidateText: newText,
    });
    originalCursor = change.end;
  }

  assert.equal(candidate.slice(candidateCursor), original.slice(originalCursor), "candidate changed trailing bytes outside spans");
  assert.equal(
    Buffer.from(candidate.slice(candidateCursor), "utf8").compare(
      Buffer.from(original.slice(originalCursor), "utf8"),
    ),
    0,
    "candidate trailing bytes differ outside spans",
  );
  return spans;
}

function propertyName(tsApi, property) {
  if (!property.name) return "";
  if (tsApi.isIdentifier(property.name) || tsApi.isStringLiteralLike(property.name)) return property.name.text;
  return property.name.getText();
}

function textOf(text, sourceFile, node) {
  return text.slice(node.getStart(sourceFile), node.end);
}

function utf8Offset(text, codeUnitOffset) {
  return Buffer.byteLength(text.slice(0, codeUnitOffset), "utf8");
}

function countOccurrences(text, needle) {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function hashBuffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

function formatDiagnostics(tsApi, diagnostics) {
  return diagnostics
    .map((diagnostic) => tsApi.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("; ");
}

export function assertWithin(root, candidate, label = "path") {
  const rel = relative(resolve(root), resolve(candidate));
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label} escaped its authorized root`);
}

export function assertNoReparsePath(path, root) {
  const rootPath = resolve(root);
  let current = resolve(path);
  const relativePath = relative(rootPath, current);
  assert.ok(
    current.toLowerCase() === rootPath.toLowerCase()
      || (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)),
    "input path escaped its authorized root",
  );
  while (true) {
    const info = lstatSync(current);
    assert.ok(!info.isSymbolicLink(), `input path contains a reparse point: ${current}`);
    const parent = resolve(current, "..");
    if (parent.toLowerCase() === current.toLowerCase()) return;
    current = parent;
  }
}

export function assertRegularFile(path, label = "input") {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-reparse file`);
}

export function assertTempRoot(tempRoot) {
  const relativePath = relative(resolve(tmpdir()), tempRoot);
  assert.ok(
    relativePath
      && relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath),
    "temporary root escaped the system Temp directory",
  );
  assert.match(
    basename(tempRoot),
    /^zcode-patch-package-[0-9a-f]{32}$/i,
    "temporary root must be the unique task-owned system Temp directory",
  );
}

async function assertAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output: ${path}`);
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
