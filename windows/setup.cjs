const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('SETUP-WINDOWS.cmd');
    console.log('Checks the bundled Windows runtime and prepares the optional ARM input-agent archive.');
    console.log('Keeps existing settings and does not install system software.');
    return;
  }
  if (args.length) throw Error('Unknown setup option: ' + args.join(' '));
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Use Windows x64 for this package.');
  const required = [
    'data/runtime/node/node.exe',
    'data/runtime/python/python.exe',
    'data/runtime/tools/spirv-val.exe',
    'data/runtime/fonts/DejaVuSans.ttf',
    'data/runtime/fonts/DejaVuSans-Bold.ttf',
    'data/runtime/fonts/DejaVuSansMono.ttf',
    'data/runtime/fonts/DejaVuSans-ExtraLight.ttf',
    'data/runtime/fonts/DejaVuSans-Oblique.ttf',
  ];
  const missing = [];
  for (const file of required)
    if (!await fs.stat(path.join(root, file)).then(stat => stat.isFile() && stat.size > 0, () => false)) missing.push(file);
  if (missing.length) throw Error('Incomplete Windows package. Extract the complete package again. Missing:\n' + missing.join('\n'));
  for (const [label, file, args] of [
    ['Node.js 22+', 'data/runtime/node/node.exe', ['-e', 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)']],
    ['Python + Pillow + pyserial', 'data/runtime/python/python.exe', ['-X', 'utf8', '-c', 'import sys; assert sys.version_info >= (3, 9); from PIL import Image; import serial']],
    ['SPIR-V validator', 'data/runtime/tools/spirv-val.exe', ['--version']],
  ]) {
    const result = spawnSync(path.join(root, file), args, { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (result.error || result.status !== 0) throw Error(label + ' is unavailable. Extract the complete Windows package again.\n' + (result.error?.message || result.stderr || result.stdout || ''));
    console.log('OK   ' + label);
  }
  console.log('OK   Bundled DejaVu fonts');
  const agentArchive = path.join(root, 'packages/iz2s-arm-input.tar.gz');
  if (!await fs.stat(agentArchive).then(stat => stat.isFile() && stat.size > 0, () => false)) {
    await require('../sdk/pack-agent.cjs').pack(root);
    console.log('OK   Prepared optional ARM input-agent archive');
  } else console.log('OK   Optional ARM input-agent archive already exists');
  console.log('\nReady. Run START-WINDOWS.cmd to open the control panel.');
  console.log('Run CHECK-WINDOWS.cmd for package and descriptor checks.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
