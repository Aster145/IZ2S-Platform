const { spawnSync } = require('node:child_process');
const root = require('../core/root.cjs');
const hostTools = require('../core/host-tools.cjs');
let failed = false;
function check(name, ready, fix) {
  console.log((ready ? 'OK   ' : 'NEED ') + name + (ready ? '' : ' - ' + fix));
  if (!ready) failed = true;
}
function runs(file, args) {
  const result = spawnSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 8000 });
  return !result.error && result.status === 0;
}
check('Node.js 22+', Number(process.versions.node.split('.')[0]) >= 22, 'Install Node.js 22 or later');
check('Linux x64/ARM64 or Windows x64',
  (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)) ||
  (process.platform === 'win32' && process.arch === 'x64'), 'Use a supported host');
const python = hostTools.python();
check('Python + Pillow', runs(python.file, [...python.args, '-c', 'from PIL import Image']),
  process.platform === 'win32' ? 'Install Python 3 and run python -m pip install Pillow' : 'Install python3-pil');
check('Python + PySerial', runs(python.file, [...python.args, '-c', 'import serial; from serial.tools import list_ports']),
  'Run SETUP-WINDOWS.cmd or install pyserial for the selected Python');
if (process.argv.includes('--arm')) {
  check('OpenSSH client', runs(hostTools.ssh(), ['-V']),
    process.platform === 'win32' ? 'Install the Windows OpenSSH Client optional feature' : 'Install openssh-client');
} else {
  console.log('INFO OpenSSH client is only required for the PC + ARM PC configuration');
}
// Loading precompiled modules still validates their SPIR-V before execution.
const { tool } = require('../sdk/tools/toolchain.cjs');
check('SPIR-V validator', runs(tool('SPIRV_VAL', 'spirv-val'), ['--version']), 'Install spirv-tools or run SETUP-WINDOWS.cmd');
// The compiler is only needed when rebuilding shader sources.
if (process.argv.includes('--build-tools')) {
  check('GLSL compiler', runs(tool('GLSLANG', 'glslangValidator'), ['--version']), 'Install glslang-tools');
}
const catalog = require('../core/extensions.cjs').catalog(root);
check('Engine descriptors', catalog.engines.items.length > 0 && catalog.engines.errors.length === 0, 'Validate engines with sdk/check.cjs');
check('IZlauncher', catalog.shells.items.some((shell) => shell.id === 'izlauncher'), 'Install a shell');
if (failed) process.exitCode = 1;
