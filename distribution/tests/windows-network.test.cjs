const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { create, parseWindowsRoutes } = require('../../core/host-network.cjs');
const { inspectConsolePaths } = require('../../hardware/device-checks.cjs');
const interfaces = () => ({
  'Ethernet': [{ address: '192.168.1.10' }],
  '无线连接': [{ address: '192.168.2.10' }],
  'Tunnel': [{ address: '198.18.0.1' }],
  'Loopback': [{ address: '127.0.0.1' }],
});
const routes = `
Active Routes:
  0.0.0.0 0.0.0.0 198.18.0.2 198.18.0.1 0
  0.0.0.0 0.0.0.0 192.168.1.1 192.168.1.10 35
  192.168.1.0 255.255.255.0 On-link 192.168.1.10 291
  192.168.2.0 255.255.255.0 在链路上 192.168.2.10 400
  192.168.2.0 255.255.255.0 On-link 192.168.1.10 500
  127.0.0.0 255.0.0.0 On-link 127.0.0.1 331
Persistent Routes:
  0.0.0.0 0.0.0.0 192.168.9.1 Default
`;
test('Windows routes preserve localized adapter names and ignore persistent rows', () => {
  const rows = parseWindowsRoutes(routes, interfaces());
  assert.equal(rows.length, 6);
  assert.equal(rows[3].dev, '无线连接');
  assert.equal(rows[3].prefix, 24);
});
test('Windows routing prefers specific LAN routes over VPN default and uses the route metric', async () => {
  const calls = [];
  const host = create({ platform: 'win32', interfaces, run: async (...args) => {
    calls.push(args);
    return { stdout: routes };
  } });
  assert.equal((await host.routeTo('192.168.1.90')).dev, 'Ethernet');
  assert.equal((await host.routeTo('192.168.2.90')).dev, '无线连接');
  assert.equal((await host.defaultRoutes()).length, 2);
  assert.ok(calls.every(([file, args, options]) => path.win32.basename(file) === 'route.exe' && args.join(' ') === 'print -4' && options.windowsHide));
});
test('Windows wireless detection and ping use structured, locale-independent results', async () => {
  const calls = [];
  const host = create({ platform: 'win32', run: async (file, args, options) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    calls.push({ file, args, options, script });
    return { stdout: script.includes('GetAllNetworkInterfaces') ? '["无线连接"]' : '{"latencyMs":0}' };
  } });
  assert.deepEqual([...await host.wirelessNames()], ['无线连接']);
  assert.equal(await host.ping('127.0.0.1'), 0);
  assert.ok(calls.every(({ file, args, options }) => path.win32.basename(file) === 'powershell.exe' && args.includes('-EncodedCommand') && options.windowsHide));
  assert.ok(calls[1].script.includes(".Send('127.0.0.1', 1000)"));
  await assert.rejects(host.ping("127.0.0.1'; Stop-Process -Name x; '"), /IPv4/);
  await assert.rejects(host.routeTo('127.0.0.1 & calc.exe'), /IPv4/);
  assert.equal(calls.length, 2);
});
test('Linux route and source-bound ping arguments remain supported', async () => {
  const calls = [];
  const host = create({ platform: 'linux', run: async (file, args) => {
    calls.push([file, args]);
    return { stdout: file === 'ip' ? '[{"dev":"eth0"}]' : '64 bytes: time=0.83 ms' };
  } });
  assert.equal((await host.routeTo('192.168.1.90')).dev, 'eth0');
  assert.equal(await host.ping('192.168.1.90', '192.168.1.10'), 0.83);
  assert.deepEqual(calls[1], ['ping', ['-n', '-I', '192.168.1.10', '-c', '1', '-W', '1', '192.168.1.90']]);
});
test('console checks reject a different interface before pinging', async () => {
  let pinged = false;
  await assert.rejects(inspectConsolePaths({
    connections: { candidates: () => [{ address: '192.168.2.90', mode: 'wifi', automatic: false }] },
    settings: { consoleHost: '192.168.1.10' },
    hostInterface: 'Ethernet',
    hostNetwork: { routeTo: async () => ({ dev: '无线连接' }), ping: async () => { pinged = true; } },
  }), /different networks/);
  assert.equal(pinged, false);
});
test('automatic console connection remains pending without ping or route lookup', async () => {
  const result = await inspectConsolePaths({
    connections: { candidates: () => [{ address: '', mode: 'lan', automatic: true }] },
    settings: { consoleHost: '192.168.1.10' },
    hostInterface: 'Ethernet',
    hostNetwork: { routeTo: async () => assert.fail('No route lookup needed'), ping: async () => assert.fail('No ping needed') },
  });
  assert.equal(result.ready, true);
  assert.equal(result.pending, true);
});
test('Windows host network utilities run without CIM access and can ping loopback', { skip: process.platform !== 'win32' }, async () => {
  const host = create();
  assert.ok(await host.wirelessNames() instanceof Set);
  const route = await host.routeTo('127.0.0.1');
  assert.equal(route.source, '127.0.0.1');
  assert.ok(Object.hasOwn(os.networkInterfaces(), route.dev));
  assert.ok(await host.ping('127.0.0.1') >= 0);
});
test('Python SSH bridge uses native null device and preserves remote Linux commands without connecting', () => {
  const { spawnSync } = require('node:child_process');
  const python = require('../../core/host-tools.cjs').python();
  const bridge = path.resolve(__dirname, '../../hardware/transports/ssh-gadget/python-bridge.py');
  const program = `import io,json,os,runpy,subprocess,sys
captured={}
class FakeProcess:
 def __init__(self,command,**kwargs):
  captured['command']=command
  self.returncode=0
 def communicate(self,data): captured['program']=data.decode()
 def poll(self): return 0
subprocess.Popen=FakeProcess
bridge=sys.argv[1]
sys.argv=[bridge,'ssh','status']
sys.stdin=io.StringIO(json.dumps({'root':'.','armAddress':'192.168.1.90','folder':'/opt/iz2s/arm-input','files':{}}))
try: runpy.run_path(bridge,run_name='__main__')
except SystemExit as result: assert result.code==0
captured['null']=os.devnull
print(json.dumps(captured))
`;
  const result = spawnSync(python.file, [...python.args, '-c', program, bridge], {
    encoding: 'utf8', windowsHide: true, env: {
      ...process.env, PYTHONDONTWRITEBYTECODE: '1', IZ2S_SSH_BINARY: 'C:/Program Files/OpenSSH/ssh.exe',
      IZ2S_ARM_USER: 'root', IZ2S_SSH_KNOWN_HOSTS: 'C:/Example User/known_hosts',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  assert.equal(captured.command[0], 'C:/Program Files/OpenSSH/ssh.exe');
  assert.equal(captured.command[captured.command.indexOf('-F') + 1], captured.null);
  assert.ok(captured.command.includes('StrictHostKeyChecking=yes'));
  assert.ok(captured.command.includes('UserKnownHostsFile="C:/Example User/known_hosts"'));
  assert.deepEqual(captured.command.slice(-3), ['root@192.168.1.90', 'python3', '-']);
  assert.ok(captured.program.includes("command=['python3',str(folder/'agent.py'),action]"));
});
