const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let selectedPython;

function python() {
  if (selectedPython) return selectedPython;
  const candidates = [
    ...(process.env.IZ2S_PYTHON ? [{ file: process.env.IZ2S_PYTHON, args: [] }] : []),
    ...(process.platform === 'win32' ? [
      { file: path.join(root, 'data/runtime/python/python.exe'), args: [] },
      { file: 'py', args: ['-3'] },
      { file: 'python', args: [] },
    ] : []),
    { file: 'python3', args: [] },
  ];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate.file) && !fs.existsSync(candidate.file)) continue;
    const args = [...candidate.args, '-X', 'utf8'];
    const result = spawnSync(candidate.file, [...args, '-c', 'import sys; assert sys.version_info >= (3, 9)'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    if (!result.error && result.status === 0) return selectedPython = { file: candidate.file, args };
  }
  throw Error('Python 3.9+ is missing. Run SETUP-WINDOWS.cmd or set IZ2S_PYTHON to python.exe.');
}

function ssh() {
  if (process.env.IZ2S_SSH_BINARY) return process.env.IZ2S_SSH_BINARY;
  if (process.platform === 'win32') {
    const native = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(native)) return native;
  }
  return 'ssh';
}

function powershell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

module.exports = { python, ssh, powershell };
