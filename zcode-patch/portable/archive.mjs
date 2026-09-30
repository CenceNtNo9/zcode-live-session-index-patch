import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { createReadStream, createWriteStream, lstatSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EXPECTED_ASAR_INPUTS as expected } from '../verification/installed-host-asar/compose-installed-host-asar-candidate.mjs';
const payloadHash = '6D5EDC47E5A814884C036DD01C9E786752B507DF38A32546C597722F9B2CE06A';
const sha = (b) => createHash('sha256').update(b).digest('hex').toUpperCase();
async function fileHash(p) { const h=createHash('sha256'); for await(const b of createReadStream(p))h.update(b);return h.digest('hex').toUpperCase(); }
function noLinks(p) {
  assert.match(p,/^[A-Za-z]:[\\/]/,'only absolute local drive paths supported');
  assert.ok(!p.startsWith('\\\\')&&!p.includes('\0'),'device/UNC path rejected');
  let q=resolve(p);while(true){try{assert.ok(!lstatSync(q).isSymbolicLink(),'link path rejected');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=dirname(q);if(parent===q)break;q=parent;}
}
async function parseArchive(p) {
  noLinks(p);const handle=await open(p,'r');
  try {
    const prefix=Buffer.alloc(16);await handle.read(prefix,0,16,0);
    assert.equal(prefix.readUInt32LE(0),4,'invalid ASAR size pickle');
    const headerSize=prefix.readUInt32LE(4), jsonSize=prefix.readUInt32LE(12);
    assert.ok(headerSize>8&&headerSize<32*1024*1024&&jsonSize>0&&jsonSize<=headerSize-8,'invalid ASAR header size');
    const json=Buffer.alloc(jsonSize);await handle.read(json,0,jsonSize,16);
    const header=JSON.parse(json.toString('utf8'));assert.equal(JSON.stringify(header),json.toString('utf8'),'noncanonical ASAR header');
    return {header,dataStart:8+headerSize,size:(await handle.stat()).size};
  } finally {await handle.close();}
}
function entry(h,p) {let e=h;for(const part of p.split(/[\\/]/)){e=e.files?.[part];assert.ok(e,'missing ASAR entry');}assert.ok(!e.unpacked&&!e.link&&Number.isSafeInteger(e.size),'entry must be packed');return e;}
async function extract(p,a,e) {const offset=Number(e.offset);assert.ok(Number.isSafeInteger(offset)&&offset>=0&&a.dataStart+offset+e.size<=a.size,'invalid ASAR span');const h=await open(p,'r');try{const b=Buffer.alloc(e.size);const {bytesRead}=await h.read(b,0,b.length,a.dataStart+offset);assert.equal(bytesRead,b.length);return b;}finally{await h.close();}}
function countEntries(h){let count=0;for(const e of Object.values(h.files??{})){count++;if(e.files)count+=countEntries(e);}return count;}
function integrity(b){const blocks=[];for(let i=0;i<b.length;i+=4194304)blocks.push(sha(b.subarray(i,i+4194304)).toLowerCase());return {algorithm:'SHA256',hash:sha(b).toLowerCase(),blockSize:4194304,blocks};}
export async function inspect(p) {
  const a=await parseArchive(p);const hash=await fileHash(p);
  const original=a.size===expected.archiveBytes&&hash===expected.archiveSha256;
  const candidate=a.size===expected.candidateArchiveBytes&&hash===expected.candidateArchiveSha256;
  assert.ok(original||candidate,'unknown archive fingerprint');
  const host=await extract(p,a,entry(a.header,'out/host/index.js'));
  assert.equal(host.length,original?expected.originalHostBytes:expected.candidateHostBytes);
  assert.equal(sha(host),original?expected.originalHostSha256:expected.candidateHostSha256,'Host fingerprint');
  assert.equal(countEntries(a.header),expected.entryCount,'ASAR entry count');
  for(const c of Object.values(expected.companions)){const bytes=await extract(p,a,entry(a.header,c.path));assert.equal(bytes.length,c.bytes);assert.equal(sha(bytes),c.sha256,'companion fingerprint');}
  return {...a,host,variant:original?'original':'candidate',hash};
}
export async function compose(p,out) {
  noLinks(out);assert.equal(parse(p).root.toLowerCase(),parse(out).root.toLowerCase(),'stage must be on input volume');
  const a=await inspect(p);assert.equal(a.variant,'original');
  const raw=await readFile(new URL('./review7-spans.json',import.meta.url));assert.equal(sha(raw),payloadHash,'span payload tampered');
  const spans=JSON.parse(raw);assert.equal(spans.length,2);let cursor=0;const chunks=[];
  for(const s of spans){assert.ok(Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.start>=cursor&&s.end>=s.start&&s.end<=a.host.length,'invalid patch span');assert.equal(sha(a.host.subarray(s.start,s.end)),s.originalSha256);chunks.push(a.host.subarray(cursor,s.start),Buffer.from(s.replacement));cursor=s.end;}
  chunks.push(a.host.subarray(cursor));const host=Buffer.concat(chunks);assert.equal(host.length,expected.candidateHostBytes);assert.equal(sha(host),expected.candidateHostSha256);
  const h=structuredClone(a.header),e=entry(h,'out/host/index.js');e.size=host.length;e.offset=String(a.size-a.dataStart);e.integrity=integrity(host);
  const json=Buffer.from(JSON.stringify(h)),aligned=(json.length+3)&~3;const header=Buffer.alloc(8+aligned);header.writeUInt32LE(4+aligned,0);header.writeInt32LE(json.length,4);json.copy(header,8);
  const size=Buffer.alloc(8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);
  async function* parts(){yield size;yield header;for await(const b of createReadStream(p,{start:a.dataStart}))yield b;yield host;}
  await pipeline(Readable.from(parts()),createWriteStream(out,{flags:'wx'}));
  assert.equal((await inspect(out)).variant,'candidate');assert.equal(await fileHash(p),expected.archiveSha256,'input changed during generation');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  const [mode,p,out]=process.argv.slice(2);assert.ok(mode==='inspect'||mode==='compose','mode must be inspect or compose');assert.ok(p,'missing archive');
  if(mode==='compose'){assert.ok(out,'missing output');await compose(p,out);console.log('PASS candidate');}
  else console.log('PASS '+(await inspect(p)).variant);
}
