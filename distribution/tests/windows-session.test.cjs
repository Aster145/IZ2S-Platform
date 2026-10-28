const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const control = require('../../core/session/process-control.cjs');
const root = path.resolve(__dirname, '../..');

async function directory(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'iz2s-win-session-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
function untilOutput(child, text) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(Error('Missing child output: ' + text + '\n' + output)), 5000);
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', read);
      child.off('close', closed);
      if (error) reject(error); else resolve(output);
    }
    function read(bytes) {
      output += bytes;
      if (output.includes(text)) finish();
    }
    function closed(code) { finish(Error('Child exited before ready: ' + code + '\n' + output)); }
    child.stdout.on('data', read);
    child.once('close', closed);
  });
}
function launch(t, args, env = {}) {
  const child = spawn(process.execPath, control.nodeArgs(args), {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', (bytes) => { errors += bytes; });
  child.errors = () => errors;
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const done = once(child, 'close');
      child.kill('SIGKILL');
      await done;
    }
  });
  return child;
}
test('Windows IPC stop executes asynchronous cleanup before child exit', async (t) => {
  const folder = await directory(t), file = path.join(folder, 'closed.txt');
  const child = launch(t, ['-e', `
    const fs=require('node:fs/promises');const timer=setInterval(()=>{},1000);
    process.on('SIGTERM',async()=>{await new Promise(r=>setTimeout(r,40));
      await fs.writeFile(process.env.RESULT,'cleaned');clearInterval(timer);});
    console.log('ready');
  `], { RESULT: file });
  await untilOutput(child, 'ready');
  await control.stopChild(child, { platform: 'win32', timeoutMs: 3000 });
  assert.equal(child.exitCode, 0, child.errors());
  assert.equal(await fs.readFile(file, 'utf8'), 'cleaned');
});
test('IPC stop arriving before cleanup handler is registered is retained', async (t) => {
  const child = launch(t, ['-e', `
    const timer=setInterval(()=>{},1000);console.log('initializing');
    setTimeout(()=>process.on('SIGTERM',()=>{console.log('cleaned');clearInterval(timer);}),150);
  `]);
  await untilOutput(child, 'initializing');
  const cleaned = untilOutput(child, 'cleaned');
  await control.stopChild(child, { platform: 'win32', timeoutMs: 3000 });
  await cleaned;
  assert.equal(child.exitCode, 0, child.errors());
});
test('parent IPC disconnect also asks child to clean up', async (t) => {
  const folder = await directory(t), file = path.join(folder, 'orphan.txt');
  const child = launch(t, ['-e', `
    const timer=setInterval(()=>{},1000);
    process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.env.RESULT,'closed');clearInterval(timer);});
    console.log('ready');
  `], { RESULT: file });
  await untilOutput(child, 'ready');
  const closed = once(child, 'exit');
  child.disconnect();
  await closed;
  assert.equal(await fs.readFile(file, 'utf8'), 'closed');
});
test('managed IPC does not keep completed finite stages alive', async (t) => {
  const child = launch(t, ['-e', "console.log('finished')"]);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, child.errors());
});
test('Windows normal stop never falls back to a destructive signal', async () => {
  let killed = false;
  await assert.rejects(control.requestStop({ connected: false, kill() { killed = true; } }, {
    platform: 'win32',
  }), /stop channel is unavailable/);
  assert.equal(killed, false);
  await control.requestStop({ kill(signal) { assert.equal(signal, 'SIGTERM'); killed = true; } }, {
    platform: 'linux',
  });
  assert.equal(killed, true);
});
test('services clean up in FTP, audio, graphics, native host order', async () => {
  const order = [];
  const children = new Set([
    { script: 'engines/host.cjs' },
    { script: 'shells/izlauncher/server/frame-loop.cjs' },
    { script: 'core/console/audio/game-audio.cjs' },
    { script: 'core/console/host/ftp-service.cjs' },
  ]);
  await control.stopStages(children, 'engines/host.cjs', async (child) => {
    order.push(child.script);
    children.delete(child);
  });
  assert.deepEqual(order, [
    'core/console/host/ftp-service.cjs', 'core/console/audio/game-audio.cjs',
    'shells/izlauncher/server/frame-loop.cjs', 'engines/host.cjs',
  ]);
});
test('cleanup timeout leaves the native host available instead of advancing', async () => {
  const ftp = new EventEmitter();
  ftp.script = 'core/console/host/ftp-service.cjs';
  ftp.connected = true;
  ftp.send = (_message, callback) => callback();
  const host = { script: 'engines/host.cjs' }, stopped = [];
  await assert.rejects(control.stopStages(new Set([host, ftp]), host.script, async (child) => {
    stopped.push(child.script);
    await control.stopChild(child, { platform: 'win32', timeoutMs: 20 });
  }), /RPC was kept available/);
  assert.deepEqual(stopped, [ftp.script]);
});
test('emergency Windows STOP targets only the owned PID and its descendants', async () => {
  const child = { pid: 12345 };
  await control.forceStop(child, {
    platform: 'win32',
    launch(command, args, options) {
      assert.equal(command, 'taskkill.exe');
      assert.deepEqual(args, ['/PID', '12345', '/T', '/F']);
      assert.equal(options.windowsHide, true);
      const result = new EventEmitter(); result.stderr = new EventEmitter();
      queueMicrotask(() => result.emit('close', 0));
      return result;
    },
  });
  await assert.rejects(control.forceStop({ pid: 0 }, { platform: 'win32' }), /owned session PID/);
});
test('RPC shutdown drains an accepted request before closing its HTTP connection', async () => {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const bridge = await require('../../engines/izmysh/server/lib/bridge.cjs').serve({
    connection: {}, calls: 0,
    async read() { enter(); await pending; return Buffer.from('done'); },
  });
  const response = new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: bridge.port, method: 'POST', path: '/',
      headers: { authorization: 'Bearer ' + bridge.token },
    }, (res) => {
      let text = ''; res.on('data', (data) => { text += data; });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ command: 'read', address: 4096, length: 4 }));
  });
  await entered;
  const closing = bridge.close();
  assert.equal(bridge.close(), closing);
  let closed = false; closing.then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed, false);
  release();
  assert.deepEqual(await response, { status: 200, value: { data: Buffer.from('done').toString('base64') } });
  await closing;
});
test('standalone engine pairing wait can be cancelled through Windows IPC', async (t) => {
  const folder = await directory(t);
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening'); const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = launch(t, ['engines/izmysh/server/host.cjs', '127.0.0.1'], {
    IZ_SESSION_DIR: folder, HB_PORT: String(port),
  });
  await untilOutput(child, 'Run folder:');
  await control.stopChild(child, { platform: 'win32', timeoutMs: 3000 });
  assert.equal(child.exitCode, 0, child.errors());
  const [run] = await fs.readdir(folder);
  const result = JSON.parse(await fs.readFile(path.join(folder, run, 'result.json'), 'utf8'));
  assert.ok(result.completed);
  assert.equal(result.error, undefined);
  const probe = net.createServer(); probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolve) => probe.close(resolve));
});
test('launcher runner forwards Windows stop to its native host during pairing', async (t) => {
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening'); const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = launch(t, ['core/session/console-runner.cjs', '127.0.0.1'], {
    HB_PORT: String(port), IZ15_LOADER: 'izmysh', IZ2S_SHELL: 'izlauncher',
  });
  const output = await untilOutput(child, 'Run folder:');
  const folder = path.resolve(output.match(/Run folder: ([^\r\n]+)/)[1]);
  assert.equal(path.dirname(folder), path.join(root, 'data/sessions'));
  assert.match(path.basename(folder), /^launcher-[A-Za-z0-9]+$/);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await control.stopChild(child, { platform: 'win32', timeoutMs: 3000 });
  assert.equal(child.exitCode, 0, child.errors());
  const result = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
  assert.equal(result.loader, 'izmysh');
  assert.ok(result.completed);
  assert.equal(result.error, undefined);
  const probe = net.createServer(); probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolve) => probe.close(resolve));
});
