// Shared shader build entry point. All paths are explicit; no shell interpolation.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { tool } = require('./tools/toolchain.cjs');
const { python } = require('../core/host-tools.cjs');
async function headers(directory) {
  await fs.mkdir(directory, { recursive: true });
  for (const [source, target] of [
    ['state.glsl', 'abi.glsl'],
    ['hb.glsl', 'hb.glsl'],
    ['draw.glsl', 'draw.glsl'],
  ])
    await fs.copyFile(path.join(__dirname, 'include', source), path.join(directory, target));
}
function compile(source, output) {
  execFileSync(
    tool('GLSLANG', 'glslangValidator'),
    ['-V', '-Os', '-g0', '--target-env', 'vulkan1.0', source, '-o', output],
    { stdio: 'inherit', windowsHide: true },
  );
  execFileSync(tool('SPIRV_VAL', 'spirv-val'), ['--target-env', 'vulkan1.0', output], {
    stdio: 'inherit', windowsHide: true,
  });
}
async function buildApp(directory) {
  directory = path.resolve(directory);
  await headers(path.join(directory, 'shaders'));
  for (const stage of ['vert', 'frag', 'comp'])
    compile(
      path.join(directory, 'shaders/app.' + stage),
      path.join(directory, 'app.' + stage + '.spv'),
    );
}
async function buildLauncher(directory) {
  directory = path.resolve(directory);
  const shaders = path.join(directory, 'shaders'), runtime = python();
  await headers(shaders);
  execFileSync(runtime.file, [...runtime.args, path.join(directory, 'launcher-text.py')], {
    stdio: 'inherit', windowsHide: true,
  });
  for (const stage of ['vert', 'frag', 'comp'])
    compile(path.join(shaders, 'launcher.' + stage), path.join(shaders, 'launcher.' + stage + '.spv'));
}
module.exports = { headers, compile, buildApp, buildLauncher };
if (require.main === module)
  buildApp(process.argv[2] || '.').catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
