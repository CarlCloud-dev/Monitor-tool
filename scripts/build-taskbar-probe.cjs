const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const source = path.join(root, 'src', 'taskbar', 'TaskbarProbe.cs');
const hostSource = path.join(root, 'src', 'taskbar', 'TaskbarHost.cs');
const manifest = path.join(root, 'src', 'taskbar', 'TaskbarProbe.manifest');
const sourceHash = createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(hostSource)).update(fs.readFileSync(manifest)).digest('hex').slice(0, 16);
const output = path.join(root, 'resources', 'taskbar', `TaskbarProbe-${sourceHash}.exe`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name));
references.push('/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll');
if (!fs.existsSync(output)) {
  const temporary = path.join(path.dirname(output), `TaskbarProbe-build-${process.pid}.exe`);
  try {
    execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/win32manifest:' + manifest, '/out:' + temporary, ...references, source, hostSource], { stdio: 'inherit' });
    try { fs.renameSync(temporary, output); }
    catch (error) { if (!fs.existsSync(output)) throw error; }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const stage = path.join(root, 'resources', 'taskbar', 'pack');
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(output, path.join(stage, 'TaskbarProbe.exe'));
