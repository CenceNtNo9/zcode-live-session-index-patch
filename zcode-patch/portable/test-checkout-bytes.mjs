import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const inputs = {};
for (const name of ['original', 'exe', 'cli']) {
  const index = process.argv.indexOf('--' + name);
  assert.ok(index >= 0 && process.argv[index + 1], 'missing --' + name);
  inputs[name] = resolve(process.argv[index + 1]);
}
const root = await mkdtemp(join(tmpdir(), 'zcode-checkout-bytes-'));
const repository = join(root, 'repository');
const checkout = join(root, 'checkout');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path) {
  const h = createHash('sha256');
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest('hex').toUpperCase();
}
async function files(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) names.push(...await files(join(directory, entry.name), relative));
    else { assert.ok(entry.isFile(), 'package must contain regular files'); names.push(relative); }
  }
  return names.sort();
}
function git(directory, args) {
  const p = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout.trim();
}
function run(executable, args) {
  const p = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4e6 });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout;
}
try {
  await mkdir(repository);
  await cp(packageRoot, join(repository, 'zcode-patch'), { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'core.autocrlf', 'true']);
  git(repository, ['add', '--', 'zcode-patch']);
  git(repository, ['diff', '--cached', '--check']);
  for (const name of await files(packageRoot)) {
    const staged = spawnSync('git', ['-C', repository, 'show', ':zcode-patch/' + name], { windowsHide: true, maxBuffer: 4e6 });
    assert.equal(staged.status, 0, 'temporary index blob missing');
    assert.deepEqual(staged.stdout, await readFile(join(packageRoot, name)), 'temporary index changed bytes: ' + name);
  }
  git(repository, ['-c', 'user.name=Package regression fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Byte preservation fixture']);
  git(root, ['clone', '-c', 'core.autocrlf=true', repository, checkout]);
  assert.equal(git(checkout, ['config', '--get', 'core.autocrlf']), 'true');
  const fresh = join(checkout, 'zcode-patch');
  const names = await files(packageRoot);
  assert.deepEqual(await files(fresh), names);
  for (const name of names) {
    assert.deepEqual(await readFile(join(fresh, name)), await readFile(join(packageRoot, name)), 'checkout changed bytes: ' + name);
    assert.match(git(checkout, ['check-attr', 'text', '--', 'zcode-patch/' + name]), /: text: unset$/);
    const bytes = await readFile(join(fresh, name));
    const text = bytes.toString('utf8');
    if (name.endsWith('.cmd')) {
      assert.equal(text.replaceAll('\r\n', '').includes('\n'), false, 'cmd has LF-only line');
      assert.equal(text.replaceAll('\r\n', '').includes('\r'), false, 'cmd has stray CR');
      assert.match(git(checkout, ['check-attr', 'whitespace', '--', 'zcode-patch/' + name]), /: whitespace: cr-at-eol$/);
    } else assert.equal(text.includes('\r'), false, 'non-cmd package text must use LF');
  }
  const manifest = await readFile(join(fresh, 'package-files.sha256'), 'utf8');
  const lines = manifest.trimEnd().split('\n');
  assert.equal(lines.length, names.length - 1);
  const manifestNames = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, 'invalid hash manifest row');
    assert.ok(!match[2].includes('..') && !match[2].startsWith('/'), 'invalid manifest path');
    manifestNames.push(match[2]);
    assert.equal(hash(await readFile(join(fresh, match[2]))), match[1], 'fresh checkout manifest mismatch: ' + match[2]);
  }
  assert.deepEqual(manifestNames.sort(), names.filter(name => name !== 'package-files.sha256'));
  const resources = join(checkout, 'resources');
  await mkdir(join(resources, 'glm'), { recursive: true });
  await copyFile(inputs.original, join(resources, 'app.asar'));
  await copyFile(inputs.exe, join(checkout, 'ZCode.exe'));
  await copyFile(inputs.cli, join(resources, 'glm/zcode.cjs'));
  const before = (await readdir(resources)).sort();
  const check = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(fresh, 'Invoke-ZCodePatch.ps1'), '-Mode', 'Apply', '-CheckOnly']);
  assert.match(check, /PASS CheckOnly Apply; no writes/);
  assert.deepEqual((await readdir(resources)).sort(), before);
  assert.equal(await hashFile(join(resources, 'app.asar')), 'D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C');
  const candidate = join(resources, 'candidate.asar');
  const composed = run(process.execPath, [join(fresh, 'portable/archive.mjs'), 'compose', join(resources, 'app.asar'), candidate]);
  assert.match(composed, /PASS candidate/);
  assert.equal(await hashFile(candidate), '6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD');
  console.log(JSON.stringify({ result: 'PASS', coreAutocrlf: true, temporaryCachedDiffCheck: true, temporaryIndexRawBytesExact: true, packageLineEndingsExact: true, exactCheckoutFiles: names.length, manifestEntries: lines.length, portableCheckOnlyNoWrites: true, portableComposeReview7: true }));
} finally {
  assert.equal(dirname(root).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(root.startsWith(join(tmpdir(), 'zcode-checkout-bytes-')));
  await rm(root, { recursive: true, force: true });
}
