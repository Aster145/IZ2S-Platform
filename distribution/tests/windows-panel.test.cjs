const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..');
const { createWindowServer } = require('../../panel/http.cjs');
const { stopPanel } = require('../../core/session/panel-control.cjs');
const control = require('../../core/session/process-control.cjs');
const fixtureChildren = new Map();

async function fixture(t, prefix) {
  const base = path.resolve(process.env.IZ2S_TEST_WORK || os.tmpdir());
  await fs.mkdir(base, { recursive: true });
  const folder = await fs.mkdtemp(path.join(base, 'iz2s-panel-' + prefix + '-'));
  assert.equal(path.dirname(folder), base);
  fixtureChildren.set(folder, []);
  t.after(async () => {
    for (const child of fixtureChildren.get(folder)) {
      if (child.exitCode == null && child.signalCode == null) {
        const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
      }
    }
    fixtureChildren.delete(folder);
    await fs.rm(folder, { recursive: true, force: true });
  });
  return folder;
}
async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
async function waitFor(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error('Condition did not become ready before the deadline');
}
function launch(t, folder, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: folder, env: { ...process.env, ...env }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  child.output = () => output;
  assert.ok(fixtureChildren.has(folder), 'Child must belong to an isolated fixture');
  fixtureChildren.get(folder).push(child);
  return child;
}
async function panelState(folder) {
  return fs.readFile(path.join(folder, 'data/state/preview-window.json'), 'utf8')
    .then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
}
function post(url, endpoint, headers = {}) {
  const address = new URL(url);
  return fetch(address.origin + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  });
}
function authenticated(url) {
  const address = new URL(url);
  return { origin: address.origin, 'x-iz-key': address.hash.slice(1) };
}
async function clone(t) {
  const folder = await fixture(t, 'clone');
  await fs.cp(root, folder, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return !relative.split(path.sep).some((part) => ['.git', 'data', 'dist', 'node_modules'].includes(part));
    },
  });
  return folder;
}
async function mockStartup(t) {
  const folder = await fixture(t, 'shutdown');
  for (const relative of ['start.cjs', 'core/atomic-json.cjs', 'core/session/ledger.cjs', 'core/session/panel-control.cjs', 'panel/http.cjs']) {
    const file = path.join(folder, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(path.join(root, relative), file);
  }
  await save(path.join(folder, 'panel/profile.json'), { panelPort: 39517 });
  await fs.writeFile(path.join(folder, 'core/host-modules.cjs'), 'module.exports={async close(){},hardStop(){}};');
  await fs.writeFile(path.join(folder, 'panel/controller.cjs'), `
    const fs=require('node:fs'),path=require('node:path');
    exports.create=async({root,preview})=>{let active=null;return {preview,
      async begin(){fs.writeFileSync(path.join(root,'begin-entered'),'1');
        while(!fs.existsSync(path.join(root,'release-start')))await new Promise(r=>setTimeout(r,20));
        active={status:'running'};return {ok:true}},
      async stop(){fs.writeFileSync(path.join(root,'stop-called'),'1');active=null},
      ownsListener(){return process.env.TEST_PENDING_START==='1'?!!active
        :process.env.TEST_PENDING_INPUT!=='1'&&!fs.existsSync(path.join(root,'cleanup-done'))},
      async snapshot(){return process.env.TEST_PENDING_INPUT==='1'
        ? {active:{status:'stopping',inputActive:true,stopTimedOut:true},emergencyInputPending:false}
        : {active,emergencyInputPending:false}},
    }};
  `);
  return folder;
}

test('shutdown endpoint requires the saved token, matching origin, and local host', async (t) => {
  let calls = 0;
  const window = await createWindowServer({ root, manager: { preview: true }, port: 0,
    onShutdown: async () => { calls++; } });
  t.after(() => window.close());
  const valid = authenticated(window.url);
  assert.equal((await post(window.url, '/api/shutdown', { origin: valid.origin })).status, 403);
  assert.equal((await post(window.url, '/api/shutdown', { 'x-iz-key': valid['x-iz-key'] })).status, 403);
  assert.equal((await post(window.url, '/api/shutdown', { ...valid, origin: 'http://example.invalid' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = require('node:http').request(new URL('/api/shutdown', window.url), {
      method: 'POST', headers: { ...valid, host: 'example.invalid' },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal(calls, 0);
  assert.equal((await post(window.url, '/api/shutdown', valid)).status, 202);
  await waitFor(() => calls === 1);
});
test('stop helper refuses a saved panel record belonging to a different process', async (t) => {
  const folder = await fixture(t, 'owner'); let calls = 0;
  const window = await createWindowServer({ root, manager: { preview: true }, port: 0,
    onShutdown: async () => { calls++; } });
  t.after(() => window.close());
  await save(path.join(folder, 'data/state/preview-window.json'), {
    pid: process.pid + 1, version: 16, preview: true, url: window.url,
  });
  await assert.rejects(stopPanel(folder, { preview: true, timeout: 1000 }), /does not match/);
  assert.equal(calls, 0);
});
test('shutdown rejects a new start request while cleanup is pending', async (t) => {
  let release, begins = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const window = await createWindowServer({ root,
    manager: { preview: true, async begin() { begins++; return { ok: true }; } },
    port: 0, onShutdown: () => pending });
  t.after(() => { release(); return window.close(); });
  const headers = authenticated(window.url);
  assert.equal((await post(window.url, '/api/shutdown', headers)).status, 202);
  const response = await post(window.url, '/api/start', headers);
  assert.ok(response.status >= 400, 'Start must not enter a session during shutdown');
  assert.equal(begins, 0);
});
test('HTTP shutdown waits for an executing start and cancels queued starts', async (t) => {
  let release, began, begins = 0, shutdowns = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { began = resolve; });
  const window = await createWindowServer({ root,
    manager: { preview: true, async begin() { begins++; began(); await blocked; return { ok: true }; } },
    port: 0, onShutdown: async () => { shutdowns++; } });
  t.after(() => { release(); return window.close(); });
  const headers = authenticated(window.url);
  const first = post(window.url, '/api/start', headers);
  await entered;
  const queued = post(window.url, '/api/start', headers);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await post(window.url, '/api/shutdown', headers)).status, 202);
  assert.equal(shutdowns, 0);
  release();
  assert.equal((await first).status, 200);
  assert.ok((await queued).status >= 400);
  await waitFor(() => shutdowns === 1);
  assert.equal(begins, 1);
});
test('main shutdown keeps its state file and HTTP server until the owned session closes', async (t) => {
  const folder = await mockStartup(t);
  const child = launch(t, folder, ['start.cjs', '--preview', '--no-open']);
  const state = await waitFor(() => panelState(folder));
  assert.notEqual(new URL(state.url).port, '39517');
  let stopped = false;
  const stopping = stopPanel(folder, { preview: true, timeout: 5000 }).then((value) => { stopped = value; });
  await waitFor(() => fs.access(path.join(folder, 'stop-called')).then(() => true, () => false));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(stopped, false);
  assert.equal((await panelState(folder)).pid, child.pid);
  assert.equal((await fetch(new URL(state.url).origin + '/health')).status, 200);
  await fs.writeFile(path.join(folder, 'cleanup-done'), '1');
  await stopping;
  await waitFor(() => child.exitCode != null);
  assert.equal(child.exitCode, 0, child.output());
  assert.equal(await panelState(folder), null);
});
test('main shutdown retains the panel when input cancellation remains unconfirmed', async (t) => {
  const folder = await mockStartup(t);
  const child = launch(t, folder, ['start.cjs', '--preview', '--no-open'], { TEST_PENDING_INPUT: '1' });
  const state = await waitFor(() => panelState(folder));
  await post(state.url, '/api/shutdown', authenticated(state.url));
  await waitFor(() => fs.access(path.join(folder, 'stop-called')).then(() => true, () => false));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await panelState(folder))?.pid, child.pid, child.output());
  assert.equal(child.exitCode, null, child.output());
  assert.equal((await fetch(new URL(state.url).origin + '/health')).status, 200);
});
test('main signal shutdown waits for an executing start before stopping its session', async (t) => {
  const folder = await mockStartup(t);
  const child = launch(t, folder, control.nodeArgs(['start.cjs', '--preview', '--no-open']), {
    TEST_PENDING_START: '1',
  });
  const state = await waitFor(() => panelState(folder));
  const starting = post(state.url, '/api/start', authenticated(state.url));
  await waitFor(() => fs.access(path.join(folder, 'begin-entered')).then(() => true, () => false));
  await control.requestStop(child, { platform: 'win32' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(await fs.access(path.join(folder, 'stop-called')).then(() => true, () => false), false,
    'Stopping must wait until the in-flight begin has established its session');
  await fs.writeFile(path.join(folder, 'release-start'), '1');
  assert.equal((await starting).status, 200);
  await waitFor(() => child.exitCode != null);
  assert.equal(child.exitCode, 0, child.output());
  assert.equal(await panelState(folder), null);
});
test('actual preview starts on a temporary port, reuses the process, and stops cleanly', async (t) => {
  const folder = await clone(t);
  const first = launch(t, folder, ['start.cjs', '--preview', '--no-open']);
  const state = await waitFor(async () => {
    if (first.exitCode != null) throw Error(first.output());
    return panelState(folder);
  });
  assert.equal(new URL(state.url).hostname, '127.0.0.1');
  assert.notEqual(new URL(state.url).port, '39517');
  const second = launch(t, folder, ['start.cjs', '--preview', '--no-open']);
  await waitFor(() => second.exitCode != null);
  assert.equal(second.exitCode, 0, second.output());
  assert.match(second.output(), /already running/);
  assert.equal((await panelState(folder)).pid, first.pid);
  assert.equal(await stopPanel(folder, { preview: true, timeout: 10000 }), true);
  await waitFor(() => first.exitCode != null);
  assert.equal(first.exitCode, 0, first.output());
});
test('Windows engine plans materialize junctions and start the pinned server without symlink privilege', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const folder = await clone(t);
  const engines = require(path.join(folder, 'engines/index.cjs')).create(folder);
  const net = require('node:net');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1');
  await once(listener, 'listening'); const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const plan = await engines.select('izmysh').plan({
    runtime: 'original', host: '127.0.0.1', port, node: process.execPath,
  });
  const cache = path.join(folder, 'data/extensions', plan.extensionFingerprint);
  for (const name of ['core', 'sdk', 'modules', 'profiles', 'hardware', 'shells']) {
    assert.equal(await fs.realpath(path.join(cache, name)), await fs.realpath(path.join(folder, name)));
    assert.equal((await fs.lstat(path.join(cache, name))).isSymbolicLink(), true);
  }
  assert.ok(plan.args[0].startsWith(path.join(cache, 'engines/izmysh')));
  const child = launch(t, plan.cwd, control.nodeArgs(plan.args), plan.env);
  const output = await waitFor(() => child.output().includes('Run folder:') && child.output());
  const run = path.resolve(output.match(/Run folder: ([^\r\n]+)/)[1]);
  assert.equal(path.dirname(run), path.join(folder, 'data/sessions'));
  await control.stopChild(child, { platform: 'win32', timeoutMs: 3000 });
  assert.equal(child.exitCode, 0, child.output());
  const result = JSON.parse(await fs.readFile(path.join(run, 'result.json'), 'utf8'));
  assert.ok(result.completed);
  assert.equal(result.error, undefined);
});
