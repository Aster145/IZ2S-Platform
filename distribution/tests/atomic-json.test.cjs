const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createWriter } = require('../../core/atomic-json.cjs');

async function fixture(t) {
  const base = path.resolve(process.env.IZ2S_TEST_WORK || os.tmpdir());
  await fs.mkdir(base, { recursive: true });
  const folder = await fs.mkdtemp(path.join(base, 'iz2s-atomic-json-'));
  assert.equal(path.dirname(folder), base);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return { folder, file: path.join(folder, 'state.json') };
}
const denied = (code = 'EPERM') => Object.assign(Error('injected file lock'), { code });
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const noTemps = async (folder) => assert.deepEqual((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp')), []);

test('Windows transient rename locks retry the same snapshot and then commit', async (t) => {
  const { folder, file } = await fixture(t);
  await fs.writeFile(file, '{"old":true}');
  const attempts = [], waits = []; let writes = 0;
  const write = createWriter({ platform: 'win32', retryDelays: [1, 2, 3], wait: async (ms) => { waits.push(ms); },
    fileSystem: { ...fs,
      async writeFile(...args) { writes++; return fs.writeFile(...args); },
      async rename(source, destination) {
        attempts.push(source);
        if (attempts.length <= 3) {
          assert.deepEqual(await read(file), { old: true });
          throw denied(['EPERM', 'EACCES', 'EBUSY'][attempts.length - 1]);
        }
        return fs.rename(source, destination);
      },
    },
  });
  await write(file, { status: 'running' });
  assert.equal(writes, 1);
  assert.equal(attempts.length, 4);
  assert.equal(new Set(attempts).size, 1);
  assert.deepEqual(waits, [1, 2, 3]);
  assert.deepEqual(await read(file), { status: 'running' });
  await noTemps(folder);
});
test('exhausted retries reject with the original error and preserve committed state', async (t) => {
  const { folder, file } = await fixture(t);
  const original = '{"recovery":"must remain"}\n';
  await fs.writeFile(file, original);
  const error = denied(); let renames = 0;
  const write = createWriter({ platform: 'win32', retryDelays: [1, 2], wait: async () => {},
    fileSystem: { ...fs, async rename() { renames++; throw error; } },
  });
  await assert.rejects(write(file, { recovery: 'not committed' }), (actual) => actual === error);
  assert.equal(renames, 3);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await noTemps(folder);
});
test('non-lock errors and Linux permission errors are not retried or hidden', async (t) => {
  const { folder, file } = await fixture(t);
  for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM']]) {
    let renames = 0;
    const error = denied(code);
    const write = createWriter({ platform, wait: async () => assert.fail('Unexpected retry'),
      fileSystem: { ...fs, async rename() { renames++; throw error; } },
    });
    await assert.rejects(write(file, { test: platform }), (actual) => actual === error);
    assert.equal(renames, 1);
  }
  await noTemps(folder);
});
test('same-target writes retain invocation order and capture mutable values immediately', async (t) => {
  const { folder, file } = await fixture(t);
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const snapshots = []; let renames = 0;
  const write = createWriter({
    fileSystem: { ...fs,
      async rename(source, destination) {
        renames++;
        snapshots.push(await read(source));
        if (renames === 1) { entered(); await held; }
        return fs.rename(source, destination);
      },
    },
  });
  const value = { sequence: 1, nested: { status: 'starting' } };
  const first = write(file, value);
  value.sequence = 2; value.nested.status = 'running';
  const second = write(file, value);
  value.sequence = 3; value.nested.status = 'stopping';
  await firstEntered;
  assert.equal(renames, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, [
    { sequence: 1, nested: { status: 'starting' } },
    { sequence: 2, nested: { status: 'running' } },
  ]);
  assert.deepEqual(await read(file), snapshots[1]);
  await noTemps(folder);
});
test('a locked destination does not block a different state file', async (t) => {
  const { folder, file } = await fixture(t);
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const other = path.join(folder, 'other.json');
  const write = createWriter({ fileSystem: { ...fs, async rename(source, destination) {
    if (destination === file) { entered(); await held; }
    return fs.rename(source, destination);
  } } });
  const first = write(file, { first: true });
  await firstEntered;
  await write(other, { second: true });
  assert.deepEqual(await read(other), { second: true });
  release();
  await first;
  await noTemps(folder);
});
test('a failed save does not poison later explicit writes to the same destination', async (t) => {
  const { folder, file } = await fixture(t);
  let failures = 1;
  const write = createWriter({ platform: 'win32', retryDelays: [], fileSystem: { ...fs,
    async rename(source, destination) { if (failures-- > 0) throw denied(); return fs.rename(source, destination); },
  } });
  await assert.rejects(write(file, { attempt: 1 }), { code: 'EPERM' });
  await write(file, { attempt: 2 });
  assert.deepEqual(await read(file), { attempt: 2 });
  await noTemps(folder);
});
test('important input recovery and ledger records still persist through the shared writer', async (t) => {
  const { folder } = await fixture(t);
  const ledger = require('../../core/session/ledger.cjs');
  const packages = require('../../core/packages/files.cjs');
  const recovery = path.join(folder, 'input-recovery.json');
  const id = '12345678-1234-1234-1234-123456789abc';
  await ledger.saveJson(recovery, { id, inputJob: id });
  assert.deepEqual(await ledger.readJson(recovery), { id, inputJob: id });
  const journal = ledger.createLedger(folder);
  await journal.write({ id, status: 'running' });
  assert.equal((await journal.read(id)).status, 'running');
  const packageState = path.join(folder, 'package.json');
  await packages.write(packageState, { status: 'installed' });
  assert.equal((await packages.read(packageState)).status, 'installed');
});
