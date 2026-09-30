import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const option=n=>process.argv[process.argv.indexOf('--'+n)+1];
for(const name of ['original','exe','cli'])assert.ok(process.argv.includes('--'+name),'missing --'+name);
const original=resolve(option('original')),exe=resolve(option('exe')),cli=resolve(option('cli'));
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const root=await mkdtemp(join(tmpdir(),'zcode-portable-self-test-'));
const install=join(root,'安装 test root'),resources=join(install,'resources'),pack=join(install,'zcode-patch');
await mkdir(join(resources,'glm'),{recursive:true});await mkdir(join(resources,'app.asar.unpacked'));
await cp(packageRoot,pack,{recursive:true});await copyFile(original,join(resources,'app.asar'));await copyFile(exe,join(install,'ZCode.exe'));await copyFile(cli,join(resources,'glm/zcode.cjs'));
await writeFile(join(resources,'app.asar.unpacked/sentinel'),'unpacked stays untouched\n');
const archive=join(resources,'app.asar'),backup=join(resources,'.zcode-patch-backup/original.asar');
const originalHash='D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C',candidateHash='6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD';
const results=[];
async function hash(p){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex').toUpperCase();}
function run(mode,check=false,expected=true,customScript,environment){
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',customScript??join(pack,'Invoke-ZCodePatch.ps1'),'-Mode',mode];if(check)args.push('-CheckOnly');
 const p=spawnSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:2e6,env:environment??process.env});
 assert.equal(p.status===0,expected,'operation result: '+p.stdout+' '+p.stderr);return p;
}
async function unchanged(){assert.equal(await hash(archive),originalHash);assert.equal(await readFile(join(resources,'app.asar.unpacked/sentinel'),'utf8'),'unpacked stays untouched\n');}
try {
 const before=(await readdir(resources)).sort();run('Apply',true);run('Rollback',true);assert.deepEqual((await readdir(resources)).sort(),before);await unchanged();results.push('CheckOnly no writes');
 await rename(archive,archive+'.good');await writeFile(archive,'unknown');run('Apply',false,false);await rm(archive);await rename(archive+'.good',archive);await unchanged();results.push('unknown archive refused');
 const spans=join(pack,'portable/review7-spans.json'),saved=await readFile(spans);await writeFile(spans,'[]');run('Apply',false,false);await writeFile(spans,saved);await unchanged();results.push('tampered spans refused');
 const linked=join(root,'linked root');const {symlink}=await import('node:fs/promises');await symlink(install,linked,'junction');run('Apply',true,false,join(linked,'zcode-patch/Invoke-ZCodePatch.ps1'));await rm(linked);results.push('junction root refused');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',join(resources,'glm/zcode.cjs')],{windowsHide:true,stdio:'ignore'});
 try{await new Promise(r=>setTimeout(r,600));run('Apply',false,false);}finally{child.kill();await new Promise(r=>child.once('exit',r));}await unchanged();results.push('running installation CLI refused without kill');
 run('Apply');assert.equal(await hash(archive),candidateHash);assert.equal(await hash(backup),originalHash);run('Apply');run('Rollback',true);results.push('Apply exact Review7 and idempotence');
 const backupSaved=backup+'.good';await rename(backup,backupSaved);run('Apply');run('Apply',true);run('Rollback',false,false);assert.equal(await hash(archive),candidateHash);results.push('preapplied without original backup identified; Rollback refused');await writeFile(backup,'tampered');run('Rollback',false,false);assert.equal(await hash(archive),candidateHash);await rm(backup);await rename(backupSaved,backup);results.push('tampered backup refused');
 run('Rollback');await unchanged();run('Rollback');results.push('Rollback atomic original and idempotence');
 const lockReady=join(root,'locked.ready');
 const locker=spawn('powershell.exe',['-NoProfile','-Command',`$f=[IO.File]::Open('${archive.replaceAll("'","''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[IO.File]::WriteAllText('${lockReady.replaceAll("'","''")}','ready');Start-Sleep -Seconds 120;$f.Dispose()`],{windowsHide:true,stdio:'ignore'});
 try{for(let i=0;i<100;i++){try{await readFile(lockReady);break;}catch{await new Promise(r=>setTimeout(r,100));}}run('Apply',false,false);await unchanged();}finally{locker.kill();await new Promise(r=>locker.once('exit',r));}
 assert.ok(!(await readdir(resources)).some(n=>n.startsWith('.zcode-patch-stage-')||n.startsWith('.zcode-patch-recovery-')||n==='.zcode-patch.lock'));results.push('atomic replacement failure retains original and cleans stage');


 // Mock only the Node executable lookup in this one disposable installation run.
 // It corrupts the newly replaced candidate just before the final real Node gate,
 // so recovery is exercised without adding a failure hook to production tooling.
 const faultDir=join(root,'fault-node'),faultScript=join(root,'fault.ps1');await mkdir(faultDir);
 await writeFile(faultScript,'\ufeff'+`param([string]$Archive);if((Get-Item -LiteralPath $Archive).Length -eq 328414612){$f=[IO.File]::Open($Archive,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);try{$f.Position=$f.Length-1;$v=$f.ReadByte();$f.Position=$f.Length-1;$f.WriteByte(($v -bxor 1));$f.Flush()}finally{$f.Dispose()}}`);
 await writeFile(join(faultDir,'node.cmd'),`@echo off\r\nif "%~2"=="inspect" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${faultScript}" "%~3"\r\n"${process.execPath}" %*\r\nexit /b %errorlevel%\r\n`,'ascii');
 run('Apply',false,false,undefined,{...process.env,PATH:faultDir+';'+process.env.PATH});await unchanged();
 assert.ok(!(await readdir(resources)).some(n=>n.startsWith('.zcode-patch-stage-')||n.startsWith('.zcode-patch-recovery-')||n==='.zcode-patch.lock'));
 results.push('post-replacement final-gate failure atomically restores original');
 // Double-click entries remain independent of the invoking current directory; feed one newline for pause.
 for(const name of ['Apply','Rollback']){const p=spawnSync('cmd.exe',['/d','/s','/c',`""${join(pack,name+'.cmd')}""`],{cwd:root,input:'\n',encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:180000});assert.equal(p.status,0,p.stdout+' '+p.stderr);}
 await unchanged();results.push('CMD entries space/Chinese root and unrelated cwd');
 console.log(JSON.stringify({result:'PASS',checks:results}));
} finally {
 assert.ok(root.startsWith(join(tmpdir(),'zcode-portable-self-test-')));await rm(root,{recursive:true,force:true});
}
