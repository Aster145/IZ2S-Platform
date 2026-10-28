const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { serve } = require('../../engines/izmysh/server/lib/bridge.cjs');
const denied = () => Object.assign(Error('injected Windows file sharing violation'), { code: 'EPERM' });

async function fixture(t, fileSystem, write = async () => {}) {
  const base = path.resolve(process.env.IZ2S_TEST_WORK || os.tmpdir());
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'iz2s-bridge-diagnostics-'));
  const warnings = [], calls = [];
  const native = {
    connection: { fail: () => assert.fail('Diagnostic errors must not break the native connection') },
    async write(address, bytes) { calls.push({ address, bytes }); return write(address, bytes); },
  };
  const bridge = await serve(native, directory, { fileSystem, retryDelays: [1, 1, 1], warn: (error) => warnings.push(error) });
  t.after(async () => {
    await bridge.close();
    assert.equal(path.dirname(directory), base);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, bridge, warnings, calls };
}
function request(bridge, address = 4096) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/', method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + bridge.token, connection: 'close' } }, (response) => {
      let body = ''; response.on('data', (bytes) => { body += bytes; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ command: 'write', address, data: Buffer.from('one hardware write').toString('base64') }));
  });
}
test('failed pending diagnostic save cannot prevent or replay the native command', async (t) => {
  const io = { ...fs, async writeFile(file, body, options) {
    if (file.endsWith('.tmp') && JSON.parse(body).status === 'pending') throw denied();
    return fs.writeFile(file, body, options);
  } };
  const { bridge, calls, warnings, directory } = await fixture(t, io);
  assert.deepEqual(await request(bridge), { status: 200, body: { written: true } });
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'bridge-progress.json'))).status, 'returned');
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
});
test('permanent final rename failure preserves a successful RPC result without replay', async (t) => {
  const statuses = new Map(); let finalRenames = 0;
  const io = { ...fs, async writeFile(file, body, options) {
    if (file.endsWith('.tmp')) statuses.set(file, JSON.parse(body).status);
    return fs.writeFile(file, body, options);
  }, async rename(source, destination) {
    if (statuses.get(source) === 'returned') { finalRenames++; throw denied(); }
    return fs.rename(source, destination);
  } };
  const { bridge, calls, warnings, directory } = await fixture(t, io);
  assert.deepEqual(await request(bridge), { status: 200, body: { written: true } });
  assert.equal(calls.length, 1);
  assert.equal(finalRenames, 4, 'Retries apply to the file rename only');
  assert.equal(warnings.length, 1);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
});
test('diagnostic failure cannot replace an original native failure', async (t) => {
  const io = { ...fs, async writeFile(file, body, options) {
    if (path.basename(file) === 'bridge-failure.json') throw denied();
    return fs.writeFile(file, body, options);
  } };
  const { bridge, calls, warnings } = await fixture(t, io, async () => { throw Error('Original native reply was lost; do not replay'); });
  assert.deepEqual(await request(bridge), {
    status: 400, body: { error: 'Original native reply was lost; do not replay' },
  });
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
});
test('temporary Windows rename locks are retried and publish the original result', async (t) => {
  let renames = 0;
  const io = { ...fs, async rename(source, destination) {
    renames++;
    if (renames <= 2) throw denied();
    return fs.rename(source, destination);
  } };
  const { bridge, calls, warnings, directory } = await fixture(t, io);
  assert.equal((await request(bridge)).status, 200);
  assert.equal(renames, 4);
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 0);
  const progress = JSON.parse(await fs.readFile(path.join(directory, 'bridge-progress.json')));
  assert.equal(progress.status, 'returned');
  assert.equal(progress.statistics.completed, 1);
  assert.equal(progress.statistics.failed, 0);
});
test('concurrent RPC requests use distinct diagnostic temporary files and one native queue', async (t) => {
  const temporary = []; let running = 0, maximum = 0;
  const io = { ...fs, async writeFile(file, body, options) {
    if (file.endsWith('.tmp')) temporary.push(file);
    return fs.writeFile(file, body, options);
  } };
  const { bridge, calls, directory } = await fixture(t, io, async () => {
    running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => request(bridge, 4096 + index)));
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls.map((call) => call.address)).size, 8);
  assert.equal(maximum, 1);
  assert.equal(temporary.length, 16);
  assert.equal(new Set(temporary).size, temporary.length);
  assert.ok(temporary.every((file) => path.basename(file) !== 'bridge-progress.json.tmp'));
  const progress = JSON.parse(await fs.readFile(path.join(directory, 'bridge-progress.json')));
  assert.equal(progress.statistics.completed, 8);
  assert.equal(progress.statistics.failed, 0);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
});
test('even failed diagnostic temp cleanup cannot change a successful native result', async (t) => {
  const io = { ...fs, async rename() { throw denied(); }, async rm() { throw denied(); } };
  const { bridge, calls, warnings } = await fixture(t, io);
  assert.deepEqual(await request(bridge), { status: 200, body: { written: true } });
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1, 'Repeated diagnostic failures produce only one warning');
});
