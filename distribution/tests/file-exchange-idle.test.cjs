const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../../modules/iz-exchange/server/runtime.cjs');
const L = require('../../modules/iz-exchange/server/layout.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iz2s-exchange-idle-'));
  const writes = [], listings = [], request = Buffer.alloc(16), pumpWaiters = [];
  let clock = 1000, writeGate = null, pumpError = '', runtime;
  const state = {
    running: false, address: '192.0.2.10', port: 0, clients: 0,
    transferring: false, received: 0, sent: 0, files: 0,
    error: '', activity: 'Stopped',
  };
  const rpc = {
    a: { session: 'offline-file-exchange-idle' },
    async read(address, bytes) {
      assert.equal(address, L.OFFSET);
      assert.equal(bytes, 16);
      return Buffer.from(request);
    },
    async write(address, bytes) {
      assert.equal(address, L.OFFSET + 64);
      assert.equal(bytes.length, L.BYTES - 64);
      writes.push(Buffer.from(bytes));
      if (writeGate) {
        const gate = writeGate;
        writeGate = null;
        gate.entered();
        await gate.wait;
      }
    },
  };
  const server = {
    state,
    async start(port) { Object.assign(state, { running: true, port, activity: 'Listening' }); },
    async stop() { Object.assign(state, { running: false, activity: 'Stopped' }); },
    async pump() {
      for (const resolve of pumpWaiters.splice(0)) resolve();
      if (pumpError) throw Error(pumpError);
    },
  };
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      await fs.rm(path.join(directory, 'file-exchange.json'), { force: true });
      await fs.rmdir(directory);
    }
  });
  runtime = await create({
    rpc, mapped: 0, directory, now: () => clock,
    native: { storage: { async list(target) {
      listings.push(target);
      return target === '/' ? [{ name: 'save', type: 'dir', size: 0 }] : [];
    } } },
    createServer: () => server,
  });
  return {
    runtime, state, writes, listings,
    advance(milliseconds) { clock += milliseconds; },
    request(sequence, operation, argument = 0) {
      request.writeUInt32LE(sequence, 0);
      request.writeUInt32LE(operation, 4);
      request.writeUInt32LE(argument, 8);
    },
    pumpError(message) { pumpError = message; },
    async nextPump() {
      await new Promise(resolve => pumpWaiters.push(resolve));
      await new Promise(setImmediate);
    },
    holdNextWrite() {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      writeGate = { entered, wait };
      return { started, release };
    },
    async report() { return JSON.parse(await fs.readFile(path.join(directory, 'file-exchange.json'), 'utf8')); },
  };
}

test('File Exchange idle status never requests periodic GPU boundaries', async t => {
  const f = await fixture(t);
  for (const delay of [0, 400, 400, 1200, 60000]) {
    f.advance(delay);
    assert.equal(await f.runtime.pending(), false);
  }
  assert.equal(f.writes.length, 1);
});

test('File Exchange publishes actual FTP changes and stable errors only once', async t => {
  const f = await fixture(t);
  f.state.clients = 1;
  f.advance(399);
  assert.equal(await f.runtime.pending(), false);
  f.advance(1);
  assert.equal(await f.runtime.pending(), true);
  await f.runtime.afterBatch();
  assert.equal(await f.runtime.pending(), false);

  for (const change of [
    { transferring: true }, { sent: 17 }, { received: 9 }, { files: 1 },
    { activity: 'Transfer complete' }, { transferring: false }, { clients: 0 },
    { address: '192.0.2.11' }, { port: 2122 }, { running: false },
    { error: 'Example FTP failure' },
  ]) {
    Object.assign(f.state, change);
    f.advance(400);
    assert.equal(await f.runtime.pending(), true, JSON.stringify(change));
    await f.runtime.afterBatch();
    f.advance(1200);
    assert.equal(await f.runtime.pending(), false, JSON.stringify(change));
  }
  f.pumpError('Example pump failure');
  await f.nextPump();
  assert.equal(await f.runtime.pending(), true);
  await f.runtime.afterBatch();
  const published = f.writes.length;
  await f.nextPump();
  f.advance(1200);
  assert.equal(await f.runtime.pending(), false);
  assert.equal(f.writes.length, published);
});

test('File Exchange acknowledges a user request immediately without replay', async t => {
  const f = await fixture(t);
  f.request(7, 2);
  assert.equal(await f.runtime.pending(), true);
  await f.runtime.afterBatch();
  assert.deepEqual(f.listings, ['/', '/save']);
  assert.equal(f.writes.at(-1).readUInt32LE(68 - 64), 7);
  assert.equal(await f.runtime.pending(), false);
  f.advance(1000);
  assert.equal(await f.runtime.pending(), false);
  assert.equal(f.writes.length, 2);
});

test('File Exchange retains a status change arriving during a mailbox write', async t => {
  const f = await fixture(t);
  f.state.clients = 1;
  f.advance(400);
  assert.equal(await f.runtime.pending(), true);
  const gate = f.holdNextWrite();
  const publishing = f.runtime.afterBatch();
  await gate.started;
  f.state.clients = 2;
  gate.release();
  await publishing;
  assert.equal(f.writes.at(-1).readUInt32LE(3592 - 64), 1);
  assert.equal((await f.report()).ftp.clients, 1);
  assert.equal(await f.runtime.pending(), false);
  f.advance(400);
  assert.equal(await f.runtime.pending(), true);
  await f.runtime.afterBatch();
  assert.equal(f.writes.at(-1).readUInt32LE(3592 - 64), 2);
  assert.equal(await f.runtime.pending(), false);
});
