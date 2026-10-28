const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const adapter = require('../../hardware/transports/esp32s3-serial/index.cjs');
const settings = () => ({ esp32Port: 'COM15', esp32Baud: '115200', esp32KeyGapMs: '40', esp32UsbConfirmed: 'yes' });
const id = '12345678-1234-1234-1234-123456789abc';
const plan = { requestId: id, action: 'plan', steps: [], source: null, sourceAfter: 0 };

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iz2s-esp32-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, input: adapter.create({ root, configuration: { settings: settings() }, preparePlan: async () => plan, ...extra }) };
}
function fakeWorker({ waitForCancel = false } = {}) {
  const calls = [], writes = [];
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  function spawnImpl(...args) {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', 1); };
    child.stdin.on('data', (bytes) => {
      for (const line of bytes.toString().trim().split('\n')) {
        const body = JSON.parse(line); writes.push(body);
        if (body.action === 'plan') {
          started();
          if (!waitForCancel) setImmediate(() => {
            child.stdout.write(JSON.stringify({ done: { ok: true, completion: 'firmware-DONE' } }) + '\n');
            child.emit('close', 0);
          });
        } else if (body.action === 'cancel') setImmediate(() => {
          child.stdout.write(JSON.stringify({ done: { ok: false, stopped: true, error: 'Input job cancelled' } }) + '\n');
          child.emit('close', 1);
        });
      }
    });
    return child;
  }
  return { calls, writes, ready, spawnImpl };
}

test('ESP32 profile resolves all required fields without enabling unsupported hardware', () => {
  const profiles = require('../../profiles/index.cjs');
  const profile = profiles.resolve('pc-esp32s3', { profile: { esp32Port: 'COM15' } });
  assert.equal(profile.inputAdapter, 'esp32s3-serial');
  assert.equal(profile.settings.esp32UsbConfirmed, 'no');
  assert.equal(profile.settings.esp32Baud, '115200');
  assert.equal(profile.settings.esp32SwapCase, 'no');
  assert.equal(profiles.resolve('pc-esp32s3', { profile: { esp32SwapCase: 'yes' } }).settings.esp32SwapCase, 'yes');
  assert.throws(() => profiles.resolve('pc-esp32s3', { profile: { esp32SwapCase: 'invalid' } }), /swap letter case/);
  assert.equal(profiles.resolve('pc-cardputer-adv').selectable, false);
});
test('background inspection reuses its result and explicit refresh queries once', async (t) => {
  let queries = 0;
  const { input } = await fixture(t, { queryWorker: async () => { queries++; return { reachable: true, keyboard: false, usbReadySource: 'unconfirmed' }; } });
  await input.inspect(); await input.inspect(); await input.inspect();
  assert.equal(queries, 1);
  assert.equal((await input.inspect({ refresh: true })).keyboard, false);
  assert.equal(queries, 2);
});
test('worker completion is persisted and the same request is not replayed', async (t) => {
  const mock = fakeWorker();
  const { root, input } = await fixture(t, { spawnImpl: mock.spawnImpl });
  assert.equal((await input.performPlan({})).ok, true);
  await input.performPlan({});
  assert.equal(mock.calls.length, 1);
  const record = JSON.parse(await fs.readFile(path.join(root, 'data/state/esp32s3-input-jobs', id + '.json')));
  assert.equal(record.status, 'complete');
  const restarted = adapter.create({ root, configuration: { settings: settings() }, preparePlan: async () => plan, spawnImpl: mock.spawnImpl });
  await assert.rejects(restarted.performPlan({}), /not replayed/);
  assert.equal(mock.calls.length, 1);
});
test('active input owns one worker and halt requests CAN on that worker', async (t) => {
  const mock = fakeWorker({ waitForCancel: true });
  const { input } = await fixture(t, { spawnImpl: mock.spawnImpl, queryWorker: async () => assert.fail('Busy checks must not open COM') });
  const running = input.performPlan({});
  const rejected = assert.rejects(running, /cancelled/);
  await mock.ready;
  assert.equal((await input.inspect({ refresh: true })).keyboardBusy, true);
  assert.deepEqual(await input.halt(id), { stopped: true });
  await rejected;
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.writes.map((row) => row.action), ['plan', 'cancel']);
});
test('a cancelled not-yet-started job sends nothing', async (t) => {
  const mock = fakeWorker();
  const { input } = await fixture(t, { spawnImpl: mock.spawnImpl });
  await input.halt(id);
  await assert.rejects(input.performPlan({}), /cancelled/);
  assert.equal(mock.calls.length, 0);
});
test('a restarted adapter cannot confirm cancellation of another worker still running', async (t) => {
  const mock = fakeWorker({ waitForCancel: true });
  const { root, input } = await fixture(t, { spawnImpl: mock.spawnImpl });
  const running = input.performPlan({});
  const rejected = assert.rejects(running, /cancelled/);
  await mock.ready;
  const restarted = adapter.create({ root, configuration: { settings: settings() },
    preparePlan: async () => plan, spawnImpl: () => assert.fail('Recovery must not start another serial worker') });
  await assert.rejects(restarted.halt(id), /cancellation is unconfirmed/);
  const recordFile = path.join(root, 'data/state/esp32s3-input-jobs', id + '.json');
  assert.equal(JSON.parse(await fs.readFile(recordFile)).status, 'requested');
  await input.halt(id);
  await rejected;
  assert.deepEqual(await restarted.halt(id), { stopped: true });
  assert.equal(JSON.parse(await fs.readFile(recordFile)).status, 'cancelled');
});
test('persisted unknown failures remain unresolved; acknowledged results allow halt', async (t) => {
  const { root } = await fixture(t);
  const recordFile = path.join(root, 'data/state/esp32s3-input-jobs', id + '.json');
  await fs.mkdir(path.dirname(recordFile), { recursive: true });
  for (const status of ['requested', 'failed', 'unknown', 'complete', 'cancelled']) {
    const value = JSON.stringify({ id, status, error: 'original evidence' });
    await fs.writeFile(recordFile, value);
    const restarted = adapter.create({ root, configuration: { settings: settings() },
      spawnImpl: () => assert.fail('No hardware worker should be created') });
    if (['complete', 'cancelled'].includes(status))
      assert.deepEqual(await restarted.halt(id), { stopped: true });
    else await assert.rejects(restarted.halt(id), /cancellation is unconfirmed/);
    assert.equal(await fs.readFile(recordFile, 'utf8'), value);
  }
  await fs.writeFile(recordFile, '{interrupted');
  const restarted = adapter.create({ root, configuration: { settings: settings() } });
  await assert.rejects(restarted.halt(id), /cancellation is unconfirmed/);
  assert.equal(await fs.readFile(recordFile, 'utf8'), '{interrupted');
});
test('the serial protocol regression suite runs entirely on fake serial devices', () => {
  const python = require('../../core/host-tools.cjs').python();
  const result = spawnSync(python.file, [...python.args, path.join(__dirname, 'esp32s3-protocol.test.py')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 17 tests/);
});
