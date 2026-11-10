import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32') { console.log('Native taskbar IPC check requires Windows'); process.exit(0); }
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = createHash('sha256');
for (const name of ['TaskbarProbe.cs','TaskbarHost.cs','TaskbarProbe.manifest']) hash.update(readFileSync(path.join(root,'src/taskbar',name)));
const executable = path.join(root,'resources/taskbar',`TaskbarProbe-${hash.digest('hex').slice(0,16)}.exe`);
// Creates a hidden child, exercises real native UTF-8 parsing/measurement, and
// exits without displaying a monitor or changing application settings.
const child = spawn(executable, ['--host',String(process.pid)], {windowsHide:true,stdio:['pipe','pipe','pipe']});
const timeout = setTimeout(() => child.kill(), 8000);
let ready = false, measured = false, errors = '';
child.stderr.setEncoding('utf8'); child.stderr.on('data',chunk=>errors+=chunk);
child.stdin.on('error',()=>{});
createInterface({input:child.stdout}).on('line',line=>{
  const message=JSON.parse(line);
  assert.notEqual(message.kind,'error',message.message ?? String(message.code));
  if(message.kind==='ready') {
    ready=true;
    child.stdin.write(JSON.stringify({kind:'content',dark:true,runs:[
      {text:'CPU —°C | 内存 34% | 显存 3.3 GB | 网络 ↑ 12.1 KB/s',color:'#ffffff',bold:true}
    ]})+'\n');
  }
  if(ready && message.kind==='size' && message.width>100) {
    measured=true; child.stdin.end(JSON.stringify({kind:'quit'})+'\n');
  }
});
try {
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,errors); assert.ok(ready); assert.ok(measured,'Unicode content must be parsed and measured');
  console.log('Native taskbar UTF-8 Chinese, em dash, temperature, GB, arrow, width and exit checks passed');
} finally {clearTimeout(timeout);if(child.exitCode===null)child.kill();}
