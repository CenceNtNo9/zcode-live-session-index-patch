"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const guard = require(process.env.ZCODE_ISOLATED_GUARD);

const root = path.resolve(process.env.ZCODE_ISOLATED_ROOT);
const mode = process.env.ZCODE_ISOLATED_MODE || "PreflightOnly";
const runId = process.env.ZCODE_ISOLATED_RUN_ID;
const runDir = path.join(root, "runs", runId || "missing-run-id");
const temp = path.join(root, "os-temp");
const home = path.join(root, "home");
const dataHome = path.join(root, "data-home");
const userData = path.join(root, "electron-userdata");
const sessionData = path.join(root, "electron-session");
const cache = path.join(root, "electron-cache");
const logs = path.join(root, "electron-logs");
const work = path.join(root, "work");
const preflightResultPath = process.env.ZCODE_ISOLATED_PREFLIGHT_RESULT;
const hostResultPath = process.env.ZCODE_ISOLATED_HOST_RESULT;
const rawHostLog = path.join(runDir, "host-streams.log");
const rpcModulePath = path.join(root, "rpc", "chunk-BMP2VTTL.js");
const hostEntry = process.env.ZCODE_ISOLATED_HOST_ENTRY;
const guardPath = process.env.ZCODE_ISOLATED_GUARD;
const denyFixture = process.env.ZCODE_ISOLATED_DENY_FIXTURE_FILE;
const fingerprint = process.env.ZCODE_ISOLATED_FINGERPRINT;
const eventName = "onDynamicWorkspaceProviderRuntimeHeadersCancelled";
const hostTimeoutMs = Number(process.env.ZCODE_ISOLATED_TIMEOUT_MS || "180000");
const stayAliveMs = 3000;
let hostCreated = false;
let rpcImported = false;

function safeAppend(file, content) {
  fs.appendFileSync(file, content);
}

function safeWriteResult(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function callbackResult(start) {
  return new Promise((resolve, reject) => {
    start((error, value) => error ? reject(error) : resolve(value));
  });
}

function assertTempPath(candidate, label) {
  const resolved = path.resolve(candidate);
  if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`) && resolved.toLowerCase() !== root.toLowerCase()) {
    throw new Error(`${label} is outside the isolated Temp root`);
  }
  guard.assertReadAllowed(resolved, label);
}

function assertInvocationPaths() {
  const paths = [process.execPath, process.resourcesPath, electronAppPath(), process.cwd()];
  for (const argument of process.argv) {
    const value = argument.startsWith("--") && argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
    if (path.isAbsolute(value)) paths.push(value);
  }
  for (const candidate of paths) {
    if (!path.resolve(candidate).toLowerCase().startsWith(root.toLowerCase())) {
      throw new Error("an absolute Electron executable, resource, app, cwd, or argv path escaped the isolated Temp root");
    }
  }
}

function electronAppPath() {
  return require("electron").app.getAppPath();
}

function waitForEvent(emitter, event, ms, label) {
  return timeout(new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      emitter.removeListener(event, onEvent);
      emitter.removeListener("error", onError);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
  }), ms, label);
}

function checkTempPath(candidate, label) {
  try {
    guard.assertWriteAllowed(candidate, label);
  } catch {
    throw new Error(`${label} is outside the isolated Temp root`);
  }
}

function collectLogFiles(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectLogFiles(full, output);
    else if (entry.isFile() && /\.(?:log|txt)$/i.test(entry.name)) output.push(full);
  }
  return output;
}

function findRpcErrors(files) {
  let count = 0;
  const patterns = [/event not found/i, /unknown\s+channel/i, /unknownchannel/i];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      const matches = content.match(new RegExp(pattern.source, "gi"));
      if (matches) count += matches.length;
    }
  }
  return count;
}

function parseGuardLog() {
  const file = process.env.ZCODE_ISOLATED_GUARD_LOG;
  const counts = Object.create(null);
  if (!fs.existsSync(file)) return counts;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      counts[item.kind] = (counts[item.kind] || 0) + 1;
    } catch {
      counts.invalidRecords = (counts.invalidRecords || 0) + 1;
    }
  }
  return counts;
}

async function runNetworkGuardPreflight(electron) {
  const net = require("node:net");
  const http = require("node:http");
  const https = require("node:https");
  const tls = require("node:tls");
  const dns = require("node:dns");
  const dnsPromises = require("node:dns/promises");
  const dgram = require("node:dgram");
  const http2 = require("node:http2");
  const childProcess = require("node:child_process");
  const { createRequire } = require("node:module");
  const hostRequire = createRequire(hostEntry);
  const undici = hostRequire("undici");
  const ws = hostRequire("ws");
  const assertions = [];

  if ((guard.snapshot().counters["protection-failed"] || 0) !== 0) {
    throw new Error("one or more process network protections could not be installed");
  }
  const requiredGuards = [
    [globalThis.fetch, "global.fetch"],
    [net.connect, "node.net.connect"],
    [net.Socket.prototype.connect, "node.net.Socket.connect"],
    [http.request, "node.http.request"],
    [http.get, "node.http.get"],
    [https.request, "node.https.request"],
    [https.get, "node.https.get"],
    [tls.connect, "node.tls.connect"],
    [dns.lookup, "node.dns.lookup"],
    [dnsPromises.lookup, "node.dns.promises.lookup"],
    [dgram.createSocket, "node.dgram.createSocket"],
    [childProcess.spawn, "node.child_process.spawn"],
    [childProcess.spawnSync, "node.child_process.spawnSync"],
    [childProcess.exec, "node.child_process.exec"],
    [childProcess.execFile, "node.child_process.execFile"],
    [http2.connect, "node.http2.connect"],
    [electron.net?.request, "electron.net.request"],
    [electron.net?.fetch, "electron.net.fetch"],
    [undici.fetch, "installed undici.fetch"],
    [undici.request, "installed undici.request"],
    [ws, "installed ws constructor"],
    [electron.utilityProcess?.fork, "electron.utilityProcess.fork"],
  ];
  for (const [api, label] of requiredGuards) {
    if (!guard.isGuardedApi(api)) throw new Error(`isolation preflight found an unguarded API: ${label}`);
  }

  const expectBlocked = async (label, action) => {
    let blocked = false;
    try {
      await action();
    } catch (error) {
      blocked = error?.code === "ZCODE_ISOLATION_BLOCKED";
    }
    if (!blocked) throw new Error(`isolation preflight did not block ${label}`);
    assertions.push(label);
  };

  await expectBlocked("global.fetch", () => globalThis.fetch("not a URL"));
  await expectBlocked("node.net.connect", () => net.connect(0, "127.0.0.1"));
  await expectBlocked("node.http.request", () => http.request({ host: "127.0.0.1", port: 0 }));
  await expectBlocked("node.https.request", () => https.request({ host: "127.0.0.1", port: 0 }));
  await expectBlocked("node.tls.connect", () => tls.connect({ host: "127.0.0.1", port: 0 }));
  await expectBlocked("node.dns.lookup", () => dns.lookup("isolation.invalid"));
  await expectBlocked("node.dns.promises.lookup", () => dnsPromises.lookup("isolation.invalid"));
  await expectBlocked("node.dgram.createSocket", () => dgram.createSocket("udp4"));
  await expectBlocked("node.http2.connect", () => http2.connect("http://127.0.0.1:0"));
  await expectBlocked("installed undici.fetch", () => undici.fetch("not a URL"));
  await expectBlocked("installed undici.request", () => undici.request("not a URL"));
  await expectBlocked("installed ws constructor", () => Reflect.construct(ws, ["not a URL"]));
  await expectBlocked("electron.net.request", () => electron.net.request({ url: "not a URL" }));
  assertions.push("child_process spawn/exec APIs are guarded; no external program was invoked");

  const fixture = path.resolve(denyFixture || "");
  if (!denyFixture || fixture.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    throw new Error("the synthetic denied-read fixture is missing or not outside the unique Temp root");
  }
  const localFsFixture = path.join(work, "guard-fs-allowed.tmp");
  assertTempPath(localFsFixture, "in-Temp filesystem fixture");
  const fsAssertions = [];
  try {
    fs.writeFileSync(localFsFixture, "sync-ok", "utf8");
    if (fs.readFileSync(localFsFixture, "utf8") !== "sync-ok") throw new Error("in-Temp sync filesystem probe mismatch");
    fsAssertions.push("sync read/write allowed under Temp");

    await callbackResult((done) => fs.writeFile(localFsFixture, "callback-ok", "utf8", done));
    const callbackRead = await callbackResult((done) => fs.readFile(localFsFixture, "utf8", done));
    if (callbackRead !== "callback-ok") throw new Error("in-Temp callback filesystem probe mismatch");
    fsAssertions.push("callback read/write allowed under Temp");

    await fs.promises.writeFile(localFsFixture, "promise-ok", "utf8");
    const promiseRead = await fs.promises.readFile(localFsFixture, "utf8");
    if (promiseRead !== "promise-ok") throw new Error("in-Temp promise filesystem probe mismatch");
    fsAssertions.push("promise read/write allowed under Temp");
  } finally {
    try { fs.rmSync(localFsFixture, { force: true }); } catch { /* cleanup remains inside Temp */ }
  }

  const expectFsBlocked = async (label, action) => {
    let blocked = false;
    try { await action(); }
    catch (error) { blocked = error?.code === "ZCODE_ISOLATION_BLOCKED"; }
    if (!blocked) throw new Error(`filesystem guard did not reject synthetic outside-Temp ${label}`);
    fsAssertions.push(`${label} rejected before filesystem access`);
  };
  const fixtureUrl = pathToFileURL(fixture);
  for (const [suffix, candidate] of [["path", fixture], ["file URL", fixtureUrl]]) {
    expectSyncFsBlocked(`sync read (${suffix})`, () => fs.readFileSync(candidate));
    await expectFsBlocked(`callback read (${suffix})`, () => callbackResult((done) => fs.readFile(candidate, done)));
    await expectFsBlocked(`promise read (${suffix})`, () => fs.promises.readFile(candidate));
    expectSyncFsBlocked(`sync write (${suffix})`, () => fs.writeFileSync(candidate, "must-not-write"));
    await expectFsBlocked(`callback write (${suffix})`, () => callbackResult((done) => fs.writeFile(candidate, "must-not-write", done)));
    await expectFsBlocked(`promise write (${suffix})`, () => fs.promises.writeFile(candidate, "must-not-write"));
  }

  function expectSyncFsBlocked(label, action) {
    let blocked = false;
    try { action(); }
    catch (error) { blocked = error?.code === "ZCODE_ISOLATION_BLOCKED"; }
    if (!blocked) throw new Error(`filesystem guard did not reject synthetic outside-Temp ${label}`);
    fsAssertions.push(`${label} rejected before filesystem access`);
  }
  assertions.push(...fsAssertions);

  const { Worker } = require("node:worker_threads");
  let worker;
  let workerExited = false;
  let workerExitResolve;
  const workerExit = new Promise((resolve) => { workerExitResolve = resolve; });
  try {
    worker = new Worker(`
      require(process.env.ZCODE_ISOLATED_GUARD);
      const { parentPort } = require('node:worker_threads');
      let networkBlocked = false;
      let outsideReadBlocked = false;
      try { require('node:net').connect(0, '127.0.0.1'); }
      catch (error) { networkBlocked = error.code === 'ZCODE_ISOLATION_BLOCKED'; }
      try { require('node:fs').readFileSync(process.env.ZCODE_ISOLATED_DENY_FIXTURE_FILE); }
      catch (error) { outsideReadBlocked = error.code === 'ZCODE_ISOLATION_BLOCKED'; }
      parentPort.postMessage({ networkBlocked, outsideReadBlocked });
      parentPort.close();
    `, { eval: true });
    worker.once("exit", (code) => {
      workerExited = true;
      workerExitResolve(code);
    });
    const workerMessage = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const [workerResult, workerExitCode] = await timeout(Promise.all([workerMessage, workerExit]), 15000, "Worker guard preflight");
    if (workerExitCode !== 0 || workerResult?.networkBlocked !== true || workerResult?.outsideReadBlocked !== true) {
      throw new Error("Worker did not inherit network and filesystem guards");
    }
    assertions.push("worker_threads Worker inherited network and filesystem guards and exited cleanly");
  } finally {
    if (worker && !workerExited) {
      try { await timeout(worker.terminate(), 5000, "Worker emergency termination"); } catch { /* record through exit state below */ }
      if (!workerExited) {
        try { await timeout(workerExit, 5000, "Worker exit after termination"); } catch { /* no Worker may remain in the smoke process */ }
      }
    }
  }

  let probeChild;
  let probeExited = false;
  let probeExitResolve;
  const probeExit = new Promise((resolve) => { probeExitResolve = resolve; });
  try {
    guard.allowUtilityFork();
    probeChild = electron.utilityProcess.fork(
      path.join(root, "probe-child.cjs"),
      [],
      {
        cwd: work,
        env: { ...process.env },
        execArgv: ["--require", guardPath],
        serviceName: "ZCode isolated guard probe",
        stdio: "pipe",
      },
    );
    probeChild.once("exit", (code) => {
      probeExited = true;
      probeExitResolve(code);
    });
    const probeMessage = new Promise((resolve, reject) => {
      probeChild.once("message", resolve);
      probeChild.once("error", reject);
    });
    const [probeResult, probeExitCode] = await timeout(Promise.all([probeMessage, probeExit]), 15000, "utilityProcess guard preflight");
    if (probeExitCode !== 0) throw new Error(`guard probe utility process exited with ${probeExitCode}`);
    if (probeResult?.type !== "guard-probe" || probeResult?.networkBlocked !== true || probeResult?.outsideReadBlocked !== true) {
      throw new Error("network or filesystem guard was not inherited by utilityProcess");
    }
    assertions.push("utilityProcess inherited network and filesystem guards and exited cleanly");
  } finally {
    if (probeChild && !probeExited) {
      try { probeChild.kill(); } catch { /* process may already be gone */ }
      if (!probeExited) {
        try { await timeout(probeExit, 5000, "utilityProcess exit after termination"); } catch { /* failure is reported below */ }
      }
      if (!probeExited) throw new Error("utilityProcess guard probe could not be terminated and reaped");
    }
  }

  const guardEvents = parseGuardLog();
  if ((guardEvents["protection-failed"] || 0) !== 0) {
    throw new Error("one or more process network protections could not be installed");
  }
  if (!guard.snapshot().electronProtected || !guard.snapshot().workerProtected) {
    throw new Error("Electron or Worker guard hook is not active");
  }
  return { assertions, guardEvents, networkRequestsIssued: 0, childCommandsInvoked: 0 };
}

function wrapElectronPort(port) {
  return {
    addEventListener(_type, listener) { port.on("message", listener); },
    removeEventListener(_type, listener) { port.off("message", listener); },
    postMessage(data) { port.postMessage(data); },
    start() { port.start(); },
    close() { port.close(); },
  };
}

async function main() {
  checkTempPath(root, "smoke root");
  checkTempPath(runDir, "run directory");
  if (mode === "Host") checkTempPath(rawHostLog, "Host log");
  if (!runId || !/^[0-9a-f]{32}$/i.test(runId)) throw new Error("isolated smoke run ID is missing or invalid");
  if (!fingerprint || !/^[0-9a-f]{64}$/i.test(fingerprint)) throw new Error("isolated smoke fingerprint is missing or invalid");
  if (mode === "PreflightOnly") checkTempPath(preflightResultPath, "preflight result");
  if (mode === "Host") checkTempPath(hostResultPath, "Host result");
  process.chdir(work);

  const electron = require("electron");
  const actualElectron = process.versions.electron;
  const expectedElectron = process.env.ZCODE_ISOLATED_EXPECTED_ELECTRON;
  if (actualElectron !== expectedElectron) throw new Error("isolated Electron runtime version mismatch");
  if (process.arch !== "x64") throw new Error("isolated Electron runtime is not x64");
  if (!path.resolve(process.resourcesPath).toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
    throw new Error("Electron resourcesPath is outside the isolated Temp root");
  }
  if (mode === "PreflightOnly" && (electron.app.isPackaged || process.env.ELECTRON_FORCE_IS_PACKAGED)) {
    throw new Error("PreflightOnly must run without the packaged-mode simulation");
  }
  if (mode === "Host" && (!electron.app.isPackaged || process.env.ELECTRON_FORCE_IS_PACKAGED !== "1")) {
    throw new Error("Host stage requires the documented packaged-mode environment simulation");
  }

  electron.app.disableHardwareAcceleration();
  electron.app.setName("ZCode Isolated Host Smoke");
  const appPaths = {
    home,
    appData: path.join(root, "electron-appdata"),
    userData,
    sessionData,
    temp,
    crashDumps: path.join(root, "crash-dumps"),
    logs,
  };
  for (const value of Object.values(appPaths)) checkTempPath(value, "Electron path");
  for (const [name, value] of Object.entries(appPaths)) {
    try {
      electron.app.setPath(name, value);
    } catch (error) {
      const actual = electron.app.getPath(name);
      if (!actual || !actual.toLowerCase().startsWith(root.toLowerCase())) {
        throw new Error(`Electron path ${name} could not be redirected to Temp`);
      }
    }
  }

  const pathProbe = {
    packaged: electron.app.isPackaged,
    packagedModeSimulation: mode === "Host" ? "ELECTRON_FORCE_IS_PACKAGED=1" : null,
    appPath: electron.app.getAppPath(),
    resourcesPath: process.resourcesPath,
    versions: { electron: actualElectron, node: process.versions.node, chrome: process.versions.chrome },
    appPaths: Object.fromEntries(Object.keys(appPaths).map((name) => [name, electron.app.getPath(name)])),
    cwd: process.cwd(),
  };
  for (const value of [pathProbe.appPath, ...Object.values(pathProbe.appPaths), pathProbe.cwd]) {
    if (!path.resolve(value).toLowerCase().startsWith(root.toLowerCase())) {
      throw new Error("an Electron data or work path escaped the isolated Temp root");
    }
  }

  assertInvocationPaths();
  await electron.app.whenReady();
  const preflight = await runNetworkGuardPreflight(electron);
  if (electron.BrowserWindow.getAllWindows().length !== 0) throw new Error("unexpected BrowserWindow created during preflight");

  if (mode === "PreflightOnly") {
    const result = {
      phase: "preflight",
      status: "pass",
      runId,
      fingerprint,
      tempRoot: root,
      runtime: pathProbe.versions,
      pathProbe,
      assertions: preflight.assertions,
      guardEvents: parseGuardLog(),
      hostCreated: false,
      rpcImported: false,
      networkRequestsIssued: 0,
      externalProgramsInvoked: 0,
      packagedModeSimulation: null,
    };
    safeWriteResult(preflightResultPath, result);
    return result;
  }

  if (mode !== "Host") throw new Error(`unsupported isolated smoke mode: ${mode}`);
  assertTempPath(preflightResultPath, "matching preflight result");
  const priorPreflight = JSON.parse(fs.readFileSync(preflightResultPath, "utf8"));
  if (priorPreflight.phase !== "preflight" || priorPreflight.status !== "pass" ||
      priorPreflight.runId !== runId || priorPreflight.fingerprint !== fingerprint ||
      priorPreflight.tempRoot?.toLowerCase() !== root.toLowerCase() ||
      priorPreflight.hostCreated !== false || priorPreflight.rpcImported !== false) {
    throw new Error("Host mode has no matching passing PreflightOnly record for this run and fingerprint");
  }

  const rpc = await import(pathToFileURL(rpcModulePath).href);
  rpcImported = true;
  const ChannelClient = rpc.e;
  const MessagePortProtocol = rpc.d;
  if (typeof ChannelClient !== "function" || typeof MessagePortProtocol !== "function") {
    throw new Error("installed RPC chunk exports were not resolved");
  }

  const { port1, port2 } = new electron.MessageChannelMain();
  const protocol = new MessagePortProtocol(wrapElectronPort(port1));
  const client = new ChannelClient(protocol);
  let initialized = false;
  let resolveInitialized;
  const initializedPromise = new Promise((resolve) => { resolveInitialized = resolve; });
  const initSubscription = client.onDidInitialize(() => {
    initialized = true;
    resolveInitialized();
  });

  const childEnvironment = { ...process.env };
  delete childEnvironment.ZCODE_ISOLATED_ALLOW_FORK;
  const child = (() => {
    guard.allowUtilityFork();
    return electron.utilityProcess.fork(hostEntry, [], {
      cwd: work,
      env: childEnvironment,
      execArgv: ["--require", guardPath],
      serviceName: "ZCode isolated Host smoke",
      stdio: "pipe",
    });
  })();
  hostCreated = true;

  let childExit;
  let resolveChildExit;
  childExit = new Promise((resolve) => { resolveChildExit = resolve; });
  child.once("exit", (code) => resolveChildExit({ code }));
  child.stdout?.on("data", (chunk) => safeAppend(rawHostLog, `[stdout] ${chunk.toString("utf8")}`));
  child.stderr?.on("data", (chunk) => safeAppend(rawHostLog, `[stderr] ${chunk.toString("utf8")}`));

  const dbStates = [];
  child.on("message", (message) => {
    if (message?.type === "database-startup-state") {
      dbStates.push({
        phase: message.state?.phase,
        failedPhase: message.state?.failedPhase,
        errorCode: message.state?.errorCode,
      });
    }
  });

  let subscription;
  let disposed = false;
  let hostExit = null;
  let rpcErrorCount = 0;
  let networkEventsAtExit = {};
  try {
    child.postMessage({
      type: "init-local",
      databaseStartupId: `isolated-smoke-${process.pid}-${Date.now()}`,
      agentSpawnFallbackCwd: work,
      zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_ISOLATED_BUILTIN_CONFIG,
    }, [port2]);

    await timeout(Promise.all([
      initializedPromise,
      new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          const latest = dbStates.at(-1);
          if (latest?.phase === "ready") { clearInterval(poll); resolve(latest); }
          else if (latest?.phase === "failed") { clearInterval(poll); reject(new Error(`Host database startup failed in ${latest.failedPhase || "unknown"} (${latest.errorCode || "no-code"})`)); }
          else if (child.pid == null) { clearInterval(poll); reject(new Error("Host exited before database startup became ready")); }
        }, 50);
      }),
    ]), hostTimeoutMs, "Host init-local and RPC initialization");

    const event = client.getChannel("zcode-agent").listen(eventName, { workspacePath: work });
    subscription = event(() => {});
    await delay(stayAliveMs);
    if (child.pid == null) throw new Error("Host exited after RPC event subscription");
    if (electron.BrowserWindow.getAllWindows().length !== 0) throw new Error("unexpected BrowserWindow created during Host startup");

    safeAppend(rawHostLog, "\n[smoke] controlled dispose requested\n");
    child.postMessage({ type: "dispose" });
    hostExit = await timeout(childExit, 30000, "controlled Host dispose");
    disposed = hostExit.code === 0;
    if (!disposed) throw new Error(`Host controlled dispose exited with ${hostExit.code}`);
  } catch (error) {
    if (child.pid != null) {
      try { child.postMessage({ type: "dispose" }); } catch { /* preserve original failure */ }
      try { hostExit = await timeout(childExit, 8000, "Host cleanup after failure"); } catch {
        try { child.kill(); } catch { /* process is already gone */ }
      }
    }
    throw error;
  } finally {
    try { subscription?.dispose(); } catch { /* cleanup only */ }
    try { initSubscription.dispose(); } catch { /* cleanup only */ }
    try { client.dispose(); } catch { /* cleanup only */ }
    try { protocol.disconnect(); } catch { /* cleanup only */ }
    try { port1.close(); } catch { /* cleanup only */ }
    networkEventsAtExit = parseGuardLog();
    const hostLogFiles = [rawHostLog, ...collectLogFiles(dataHome)];
    rpcErrorCount = findRpcErrors(hostLogFiles);
  }

  const result = {
    phase: "host",
    status: rpcErrorCount === 0 ? "pass" : "fail",
    runId,
    fingerprint,
    tempRoot: root,
    runtime: pathProbe.versions,
    pathProbe,
    preflight,
    host: {
      entry: hostEntry,
      pid: child.pid,
      databaseStartupReady: dbStates.some((state) => state.phase === "ready"),
      rpcInitialized: initialized,
      subscribedEvent: eventName,
      channel: "zcode-agent",
      remainedAliveAfterSubscription: hostExit == null || hostExit.code === 0,
      controlledDispose: disposed,
      exitCode: hostExit?.code ?? null,
      rpcErrorCount,
      startupStates: dbStates,
    },
    guardEventsAfterPreflight: networkEventsAtExit,
    userDataBoundary: {
      root,
      appData: electron.app.getPath("appData"),
      userData: electron.app.getPath("userData"),
      sessionData: electron.app.getPath("sessionData"),
      dataHome,
      cwd: process.cwd(),
    },
    hostLogPath: rawHostLog,
    hostCreated,
    rpcImported,
    networkRequestsIssued: 0,
    externalProgramsInvoked: 0,
    packagedModeSimulation: "ELECTRON_FORCE_IS_PACKAGED=1",
  };
  safeWriteResult(hostResultPath, result);
  if (rpcErrorCount !== 0) throw new Error("RPC subscription produced EventNotFound or UnknownChannel diagnostics");
  if (!disposed || !initialized || !result.host.databaseStartupReady) throw new Error("Host smoke did not satisfy all readiness gates");
  return result;
}

let exitCode = 0;
main().then((result) => {
  process.stdout.write(`${JSON.stringify({ status: result.status, runtime: result.runtime, host: result.host, guardEventsAfterPreflight: result.guardEventsAfterPreflight })}\n`);
}).catch((error) => {
  exitCode = 1;
  const result = {
    phase: mode === "PreflightOnly" ? "preflight" : "host",
    status: "fail",
    runId,
    fingerprint,
    tempRoot: root,
    error: error?.message || "isolated Host smoke failed",
    guardEvents: parseGuardLog(),
    hostLogPath: rawHostLog,
    hostCreated,
    rpcImported,
    networkRequestsIssued: 0,
    externalProgramsInvoked: 0,
    packagedModeSimulation: mode === "Host" ? "ELECTRON_FORCE_IS_PACKAGED=1" : null,
  };
  const resultPath = mode === "PreflightOnly" ? preflightResultPath : hostResultPath;
  try { safeWriteResult(resultPath, result); } catch { /* keep failure output available */ }
  process.stderr.write(`${JSON.stringify(result)}\n`);
}).finally(() => {
  setTimeout(() => {
    process.exitCode = exitCode;
    require("electron").app.quit();
  }, 100);
});
