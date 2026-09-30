"use strict";

// Process-local fail-closed boundary for the one-off isolated Host smoke.
// It deliberately records API names and counters only; never URLs, headers, or file paths.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const nativeFs = {
  appendFileSync: fs.appendFileSync.bind(fs),
  realpathSync: fs.realpathSync.native.bind(fs.realpathSync),
  statSync: fs.statSync.bind(fs),
};

const rootEnv = process.env.ZCODE_ISOLATED_ROOT;
const archiveEnv = process.env.ZCODE_ISOLATED_APP_ARCHIVE;
const runtimeEnv = process.env.ZCODE_ISOLATED_RUNTIME_ROOT;
if (!rootEnv || !archiveEnv || !runtimeEnv) throw new Error("isolated host guard is missing its required roots");
const root = path.resolve(rootEnv);
const archive = path.resolve(archiveEnv);
const runtimeRoot = path.resolve(runtimeEnv);
const guardLog = path.resolve(process.env.ZCODE_ISOLATED_GUARD_LOG || path.join(root, "guard-events.ndjson"));
if (!path.isAbsolute(root) || !path.isAbsolute(archive) || !path.isAbsolute(runtimeRoot)) {
  throw new Error("isolated host guard is missing its required roots");
}

const systemRoot = path.resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
const allowedReadRoots = [root, archive, `${archive}.unpacked`, runtimeRoot, systemRoot];
const counters = Object.create(null);
const fdRoots = new Map([[1, "stdio"], [2, "stdio"]]);
const maxEvents = 200;
let totalEvents = 0;
let nextUtilityForkAllowance = 0;
let electronProtected = false;
let workerProtected = false;
const guardMarker = Symbol.for("zcode.isolated.host-smoke.guard");

function normalized(value) {
  return path.resolve(value).replace(/^\\\\\?\\/, "").replaceAll("/", "\\").toLowerCase();
}

function isWithin(candidate, base) {
  const item = normalized(candidate);
  const rootPath = normalized(base).replace(/[\\]+$/, "");
  return item === rootPath || item.startsWith(`${rootPath}\\`);
}

function isAllowedReadLexical(candidate) {
  return allowedReadRoots.some((base) => isWithin(candidate, base));
}

function nearestRealPath(candidate) {
  let probe = path.resolve(candidate);
  for (;;) {
    try {
      return nativeFs.realpathSync(probe);
    } catch (error) {
      if (error && error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

function audit(kind, api) {
  counters[kind] = (counters[kind] || 0) + 1;
  totalEvents += 1;
  const record = { kind, api, pid: process.pid, at: Date.now() };
  try {
    nativeFs.appendFileSync(guardLog, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } catch {
    // stderr remains a fallback if the isolated log directory cannot be used.
  }
  if (totalEvents <= maxEvents) {
    try {
      process.stderr.write(`[ZCODE_ISOLATION_GUARD] ${JSON.stringify(record)}\n`);
    } catch {
      // Keep denial behavior deterministic even if stderr is unavailable.
    }
  }
}

function blocked(kind, api) {
  audit(kind, api);
  const error = new Error(`isolated Host smoke blocked ${kind} via ${api}`);
  error.code = "ZCODE_ISOLATION_BLOCKED";
  return error;
}

function pathValue(value) {
  if (value instanceof URL) return require("node:url").fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  if (typeof value === "string") return value;
  throw blocked("invalid-path", "filesystem");
}

function resolveCandidate(value) {
  const input = pathValue(value);
  return path.resolve(input);
}

function assertReadAllowed(value, api = "filesystem") {
  const candidate = resolveCandidate(value);
  if (!isAllowedReadLexical(candidate)) throw blocked("read-outside-allowlist", api);
  const realParent = nearestRealPath(candidate);
  if (!isAllowedReadLexical(realParent)) throw blocked("read-through-link-outside-allowlist", api);
  return candidate;
}

function assertWriteAllowed(value, api = "filesystem") {
  const candidate = resolveCandidate(value);
  if (!isWithin(candidate, root)) throw blocked("write-outside-temp", api);
  const realParent = nearestRealPath(candidate);
  if (!isWithin(realParent, root)) throw blocked("write-through-link-outside-temp", api);
  return candidate;
}

function assertFdAllowed(fd, api) {
  if (!fdRoots.has(Number(fd))) throw blocked("write-untracked-fd", api);
}

function flagWrites(flags) {
  if (typeof flags === "number") {
    const c = fs.constants;
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0;
  }
  return typeof flags === "string" && /[wax+]/.test(flags);
}

function installPathGuard(target, method, kind, index = 0, extra = []) {
  if (typeof target[method] !== "function") return;
  const original = target[method];
  target[method] = function (...args) {
    try {
      if (kind === "write") assertWriteAllowed(args[index], method);
      else assertReadAllowed(args[index], method);
      for (const item of extra) {
        if (item.kind === "write") assertWriteAllowed(args[item.index], method);
        else assertReadAllowed(args[item.index], method);
      }
    } catch (error) {
      const callbackIndex = args.findLastIndex((item) => typeof item === "function");
      if (callbackIndex >= 0) {
        process.nextTick(args[callbackIndex], error);
        return undefined;
      }
      if (target === fs.promises) return Promise.reject(error);
      throw error;
    }
    return original.apply(this, args);
  };
}

function installOpenGuard(target, method, promised = false) {
  if (typeof target[method] !== "function") return;
  const original = target[method];
  target[method] = function (...args) {
    const writing = flagWrites(args[1]);
    try {
      if (writing) assertWriteAllowed(args[0], method);
      else assertReadAllowed(args[0], method);
    } catch (error) {
      const callbackIndex = args.findLastIndex((item) => typeof item === "function");
      if (callbackIndex >= 0) {
        process.nextTick(args[callbackIndex], error);
        return undefined;
      }
      if (promised) return Promise.reject(error);
      throw error;
    }
    if (promised) {
      return Promise.resolve(original.apply(this, args)).then((handle) => {
        fdRoots.set(Number(handle.fd), writing ? root : "read-only");
        const close = handle.close.bind(handle);
        handle.close = async (...closeArgs) => {
          const result = await close(...closeArgs);
          fdRoots.delete(Number(handle.fd));
          return result;
        };
        return handle;
      });
    }
    const callbackIndex = args.findLastIndex((item) => typeof item === "function");
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = (error, fd, ...rest) => {
        if (!error && typeof fd === "number") fdRoots.set(fd, writing ? root : "read-only");
        callback(error, fd, ...rest);
      };
    }
    const result = original.apply(this, args);
    if (method === "openSync" && typeof result === "number") fdRoots.set(result, writing ? root : "read-only");
    return result;
  };
}

function installFdGuard(target, method, operation = "write") {
  if (typeof target[method] !== "function") return;
  const original = target[method];
  target[method] = function (...args) {
    try {
      if (typeof args[0] === "number") {
        if (operation === "write") assertFdAllowed(args[0], method);
      } else if (operation === "write") {
        assertWriteAllowed(args[0], method);
      } else {
        assertReadAllowed(args[0], method);
      }
    } catch (error) {
      const callbackIndex = args.findLastIndex((item) => typeof item === "function");
      if (callbackIndex >= 0) {
        process.nextTick(args[callbackIndex], error);
        return undefined;
      }
      if (target === fs.promises) return Promise.reject(error);
      throw error;
    }
    return original.apply(this, args);
  };
}

for (const method of [
  "access", "accessSync", "exists", "existsSync", "stat", "statSync", "lstat", "lstatSync",
  "readFile", "readFileSync", "readdir", "readdirSync", "opendir", "opendirSync",
  "readlink", "readlinkSync", "realpath", "realpathSync", "statfs", "statfsSync", "glob", "globSync",
  "createReadStream", "watch", "watchFile",
]) installPathGuard(fs, method, "read");

for (const method of [
  "appendFile", "appendFileSync", "writeFile", "writeFileSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
  "rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "truncate", "truncateSync",
  "chmod", "chmodSync", "chown", "chownSync", "lchmod", "lchmodSync", "lchown", "lchownSync",
  "utimes", "utimesSync", "lutimes", "lutimesSync", "createWriteStream",
]) installPathGuard(fs, method, "write");

installPathGuard(fs, "copyFile", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "copyFileSync", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "cp", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "cpSync", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "rename", "write", 0, [{ kind: "write", index: 1 }]);
installPathGuard(fs, "renameSync", "write", 0, [{ kind: "write", index: 1 }]);
installPathGuard(fs, "link", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "linkSync", "write", 1, [{ kind: "read", index: 0 }]);
installPathGuard(fs, "symlink", "write", 1);
installPathGuard(fs, "symlinkSync", "write", 1);
installOpenGuard(fs, "open");
installOpenGuard(fs, "openSync");
installOpenGuard(fs.promises, "open", true);

for (const method of ["write", "writeSync", "writev", "writevSync", "ftruncate", "ftruncateSync", "fchmod", "fchmodSync", "fchown", "fchownSync", "futimes", "futimesSync"]) {
  installFdGuard(fs, method, "write");
}
for (const method of ["read", "readSync", "readv", "readvSync", "fstat", "fstatSync"]) {
  installFdGuard(fs, method, "read");
}
for (const method of ["close", "closeSync"]) {
  if (typeof fs[method] !== "function") continue;
  const original = fs[method];
  fs[method] = function (...args) {
    const fd = Number(args[0]);
    const callbackIndex = args.findLastIndex((item) => typeof item === "function");
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = (error, ...rest) => {
        if (!error) fdRoots.delete(fd);
        callback(error, ...rest);
      };
    }
    const result = original.apply(this, args);
    if (method === "closeSync") fdRoots.delete(fd);
    return result;
  };
}

for (const method of [
  "access", "lstat", "mkdir", "mkdtemp", "opendir", "readdir", "readFile", "readlink",
  "realpath", "statfs", "glob", "rm", "rmdir", "stat", "truncate", "unlink", "writeFile", "appendFile",
  "chmod", "chown", "lutimes", "utimes",
]) {
  const kind = ["access", "lstat", "opendir", "readdir", "readFile", "readlink", "realpath", "stat", "statfs", "glob"].includes(method) ? "read" : "write";
  installPathGuard(fs.promises, method, kind);
}
for (const [method, index, extra] of [
  ["copyFile", 1, [{ kind: "read", index: 0 }]],
  ["cp", 1, [{ kind: "read", index: 0 }]],
  ["rename", 0, [{ kind: "write", index: 1 }]],
  ["link", 1, [{ kind: "read", index: 0 }]],
  ["symlink", 1, []],
]) installPathGuard(fs.promises, method, "write", index, extra);

function deny(kind, api) {
  const wrapper = function isolatedBlockedApi() {
    throw blocked(kind, api);
  };
  Object.defineProperty(wrapper, guardMarker, { value: true });
  return wrapper;
}

function denyAsync(kind, api) {
  const wrapper = function isolatedBlockedAsyncApi() {
    return Promise.reject(blocked(kind, api));
  };
  Object.defineProperty(wrapper, guardMarker, { value: true });
  return wrapper;
}

function patchMethods(target, methodNames, kind = "network-blocked") {
  if (!target) return;
  for (const name of methodNames) {
    if (typeof target[name] !== "function") continue;
    const original = target[name];
    try {
      target[name] = deny(kind, name);
      if (target[name] === original) audit("protection-failed", name);
    } catch {
      audit("protection-failed", name);
    }
  }
}

function patchNetworkModule(mod, requestedName) {
  if (!mod) return mod;
  const name = requestedName.replace(/^node:/, "");
  if (name === "http" || name === "https") patchMethods(mod, ["request", "get"]);
  else if (name === "net") {
    patchMethods(mod, ["connect", "createConnection"]);
    if (mod.Socket?.prototype) patchMethods(mod.Socket.prototype, ["connect"]);
    if (mod.Server?.prototype) patchMethods(mod.Server.prototype, ["listen"]);
  } else if (name === "tls") {
    patchMethods(mod, ["connect"]);
    if (mod.Server?.prototype) patchMethods(mod.Server.prototype, ["listen"]);
  } else if (name === "dgram") patchMethods(mod, ["createSocket"]);
  else if (name === "http2") patchMethods(mod, ["connect", "createServer", "createSecureServer"]);
  else if (name === "dns" || name === "dns/promises") {
    patchMethods(mod, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]);
    if (mod.promises) patchMethods(mod.promises, Object.keys(mod.promises));
  }
  return mod;
}

const originalModuleLoad = Module._load;
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const resolved = originalResolveFilename.call(this, request, parent, isMain, options);
  if (typeof resolved === "string" && path.isAbsolute(resolved)) {
    assertReadAllowed(resolved, "module-resolution");
  }
  return resolved;
};

Module._load = function (request, parent, isMain) {
  const loaded = originalModuleLoad.call(this, request, parent, isMain);
  if (typeof request === "string" && /^(?:node:)?(?:http|https|net|tls|dgram|http2|dns|dns\/promises)$/.test(request)) {
    return patchNetworkModule(loaded, request);
  }
  if (request === "undici") return patchUndici(loaded);
  if (request === "ws") return patchWebSocketModule(loaded);
  if (request === "electron" || request === "electron/main") return protectElectron(loaded);
  if (request === "node:worker_threads" || request === "worker_threads") return protectWorkerThreads(loaded);
  return loaded;
};

function patchUndici(mod) {
  if (!mod || typeof mod !== "object") return mod;
  patchMethods(mod, ["fetch", "request", "stream", "pipeline", "connect", "upgrade", "buildConnector"]);
  for (const name of ["Agent", "Pool", "Client", "ProxyAgent", "EnvHttpProxyAgent", "BalancedPool", "WebSocket"]) {
    if (typeof mod[name] !== "function") continue;
    try {
      const guarded = new Proxy(mod[name], { construct() { throw blocked("network-blocked", `undici.${name}`); } });
      Object.defineProperty(guarded, guardMarker, { value: true });
      mod[name] = guarded;
    } catch {
      audit("protection-failed", `undici.${name}`);
    }
  }
  return mod;
}

function patchWebSocketModule(mod) {
  const Constructor = typeof mod === "function" ? mod : mod?.WebSocket || mod?.default;
  if (typeof Constructor !== "function") return mod;
  const guarded = new Proxy(Constructor, { construct() { throw blocked("network-blocked", "ws.WebSocket"); } });
  Object.defineProperty(guarded, guardMarker, { value: true });
  if (typeof mod === "function") return guarded;
  try {
    if (mod.WebSocket) mod.WebSocket = guarded;
    if (mod.default) mod.default = guarded;
  } catch {
    audit("protection-failed", "ws.WebSocket");
  }
  return mod;
}

function protectWorkerThreads(mod) {
  if (workerProtected || !mod?.Worker) return mod;
  const OriginalWorker = mod.Worker;
  class GuardedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const guardPath = path.resolve(process.env.ZCODE_ISOLATED_GUARD || __filename);
      const childOptions = {
        ...options,
        env: { ...process.env },
        execArgv: ["--require", guardPath],
      };
      super(filename, childOptions);
    }
  }
  Object.defineProperty(GuardedWorker, guardMarker, { value: true });
  try {
    mod.Worker = GuardedWorker;
    workerProtected = mod.Worker === GuardedWorker;
    if (!workerProtected) audit("protection-failed", "worker_threads.Worker");
  } catch {
    audit("protection-failed", "worker_threads.Worker");
  }
  return mod;
}

function protectElectron(electron) {
  if (electronProtected || !electron) return electron;
  patchMethods(electron.net, ["request", "fetch", "resolveHost"]);
  if (electron.shell) patchMethods(electron.shell, ["openExternal"]);
  if (electron.utilityProcess) {
    const originalFork = electron.utilityProcess.fork;
    if (typeof originalFork === "function") {
      const guardedFork = function (...args) {
        if (nextUtilityForkAllowance <= 0) throw blocked("child-process-blocked", "electron.utilityProcess.fork");
        nextUtilityForkAllowance -= 1;
        return originalFork.apply(this, args);
      };
      Object.defineProperty(guardedFork, guardMarker, { value: true });
      electron.utilityProcess.fork = guardedFork;
      if (electron.utilityProcess.fork !== guardedFork) audit("protection-failed", "electron.utilityProcess.fork");
    }
  }
  if (electron.BrowserWindow?.prototype) {
    patchMethods(electron.BrowserWindow.prototype, ["loadURL"]);
  }
  electronProtected = true;
  return electron;
}

const networkModules = ["http", "https", "net", "tls", "dgram", "http2", "dns", "dns/promises"];
for (const name of networkModules) {
  try { patchNetworkModule(require(`node:${name}`), `node:${name}`); } catch { /* unavailable module */ }
}
try {
  const childProcess = require("node:child_process");
  patchMethods(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] , "child-process-blocked");
} catch { /* unavailable module */ }
try {
  const workers = protectWorkerThreads(require("node:worker_threads"));
  void workers;
} catch { /* unavailable module */ }
try {
  const inspector = require("node:inspector");
  patchMethods(inspector, ["open", "url"] , "network-blocked");
} catch { /* unavailable module */ }

globalThis.fetch = denyAsync("network-blocked", "global.fetch");
for (const globalName of ["WebSocket", "EventSource"]) {
  if (typeof globalThis[globalName] === "function") {
    try { globalThis[globalName] = new Proxy(globalThis[globalName], { construct() { throw blocked("network-blocked", `global.${globalName}`); } }); }
    catch { audit("protection-failed", `global.${globalName}`); }
  }
}

try {
  const os = require("node:os");
  const isolatedHome = path.join(root, "home");
  os.homedir = () => isolatedHome;
  if (typeof os.userInfo === "function") {
    const originalUserInfo = os.userInfo.bind(os);
    os.userInfo = (options) => ({ ...originalUserInfo(options), username: "isolated-host-smoke", homedir: isolatedHome, shell: "" });
  }
} catch { /* os APIs may be immutable on future runtimes */ }

try {
  const originalChdir = process.chdir.bind(process);
  process.chdir = (dir) => {
    const candidate = path.resolve(String(dir));
    if (!isWithin(candidate, root)) throw blocked("chdir-outside-temp", "process.chdir");
    return originalChdir(candidate);
  };
} catch { audit("protection-failed", "process.chdir"); }

try { require("node:module").syncBuiltinESMExports(); } catch { /* supported on current Node */ }

function allowUtilityFork() {
  nextUtilityForkAllowance += 1;
}

function snapshot() {
  return {
    counters: { ...counters },
    electronProtected,
    workerProtected,
    totalEvents,
  };
}

function isGuardedApi(value) {
  return Boolean(value && value[guardMarker] === true);
}

globalThis.__ZCODE_ISOLATION_GUARD__ = { assertReadAllowed, assertWriteAllowed, allowUtilityFork, isGuardedApi, snapshot };
module.exports = globalThis.__ZCODE_ISOLATION_GUARD__;
