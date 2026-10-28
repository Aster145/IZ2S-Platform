const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { python } = require('../../core/host-tools.cjs');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const fontDirectory = path.join(root, 'data/runtime/fonts');

async function temporary(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'IZ2S resources 中文 '));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}

async function runPython(args, extraEnv = {}) {
  const runtime = python();
  return run(runtime.file, [...runtime.args, ...args], {
    timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', HB_FONT: '', HB_FONT_DIR: '', ...extraEnv },
  });
}

test('both shells and File Exchange advertise Windows and retain Linux support', async () => {
  for (const file of ['shells/izlauncher/shell.json', 'shells/izpslauncher/shell.json', 'modules/iz-exchange/module.json']) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    for (const platform of ['win32-x64', 'linux-x64', 'linux-arm64'])
      assert.ok(manifest.platforms.includes(platform), file + ': ' + platform);
  }
});

test('shipped shaders and atlases load without a shader rebuild', async () => {
  const { readApp } = require('../../core/services/app-catalog.cjs');
  for (const id of ['izlauncher', 'izpslauncher']) {
    const app = await readApp(path.join(root, 'shells', id, 'app'), { validate: false });
    assert.equal(app.id, id);
    assert.equal((await require(`../../shells/${id}/server/font-data.cjs`).load()).length, 1024 * 2048);
    const type = await require(`../../shells/${id}/server/assets.cjs`).loadTypeAtlas();
    assert.ok(type.bytes.length > 0);
  }
  assert.equal((await readApp(path.join(root, 'modules/iz-exchange/switch'), { validate: false })).id, 'iz-exchange');
});

test('font resolver supports bundled fonts and explicit paths containing spaces', async (t) => {
  const folder = await temporary(t), custom = path.join(folder, 'custom font.ttf');
  const source = path.join(fontDirectory, 'DejaVuSans.ttf');
  await fs.copyFile(source, custom);
  await fs.copyFile(source, path.join(folder, 'DejaVuSans.ttf'));
  const code = "import sys,json;sys.path.insert(0,sys.argv[1]);from font_paths import font;print(json.dumps([font(),font('DejaVuSans-Bold.ttf')]))";
  const args = ['-c', code, path.join(root, 'core')];
  const bundled = JSON.parse((await runPython(args)).stdout);
  assert.equal(path.normalize(bundled[0]), source);
  assert.equal(path.normalize(bundled[1]), path.join(fontDirectory, 'DejaVuSans-Bold.ttf'));
  const explicit = JSON.parse((await runPython(args, { HB_FONT: custom })).stdout);
  assert.equal(path.normalize(explicit[0]), custom);
  const directory = JSON.parse((await runPython(args, { HB_FONT_DIR: folder })).stdout);
  assert.equal(path.normalize(directory[0]), path.join(folder, 'DejaVuSans.ttf'));
});

test('both shell runtime rasters render with Windows Python and UTF-8 catalog paths', async (t) => {
  const folder = await temporary(t);
  const icon = await fs.readFile(path.join(root, 'modules/iz-exchange/switch/assets/icon.png'));
  const catalog = { apps: [{ name: 'File Exchange 测试', description: '本地目录 / files', files: { icon: { bytes: icon } }, manifest: { transition: 'none' } }] };
  for (const id of ['izlauncher', 'izpslauncher']) {
    const bytes = await require(`../../shells/${id}/server/raster.cjs`).raster(catalog, folder, id);
    assert.equal(bytes.length, 32 * 131072);
    assert.ok(bytes.readUInt32LE(102420) > 0, id + ' hero width');
    assert.ok(bytes.subarray(106496, 118784).some(value => value !== 0), id + ' hero pixels');
    if (id === 'izpslauncher') assert.equal(bytes.readUInt32LE(102496), 0x50534356);
  }
});

test('IZPS activity renders a UTF-8 event into the fixed activity mailbox', async (t) => {
  const folder = await temporary(t);
  const event = { id: 'job-1', packageId: 'iz-exchange', name: 'File Exchange 测试', type: 'installed', version: '1.1.1', at: '2026-10-28T12:00:00Z' };
  const result = await require('../../shells/izpslauncher/server/activity.cjs').raster([event], [{ id: event.packageId, name: event.name }], folder);
  assert.equal(result.header.readUInt32LE(4), 1);
  assert.equal(result.text.length, 131072);
  assert.ok(result.text.some(value => value !== 0));
});

test('File Exchange assets regenerate using the portable font resolver', async (t) => {
  const folder = await temporary(t), moduleFolder = path.join(folder, 'modules/iz-exchange/switch');
  await fs.mkdir(path.join(moduleFolder, 'assets'), { recursive: true });
  await fs.mkdir(path.join(folder, 'core'));
  await fs.copyFile(path.join(root, 'core/font_paths.py'), path.join(folder, 'core/font_paths.py'));
  await fs.copyFile(path.join(root, 'modules/iz-exchange/switch/assets.py'), path.join(moduleFolder, 'assets.py'));
  await runPython([path.join(moduleFolder, 'assets.py')], { HB_FONT_DIR: fontDirectory });
  const data = await fs.readFile(path.join(moduleFolder, 'assets/data.bin'));
  assert.equal(data.readUInt32LE(0), 19);
  assert.ok(data.length > 128 * 84 / 4);
  assert.ok(data.subarray(-128 * 84 / 4).some(value => value !== 0));
  assert.equal((await fs.stat(path.join(moduleFolder, 'assets/state.bin'))).size, 1024);
});
