const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isIPv4 } = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ipv4 = (address) => {
  if (!isIPv4(address)) throw Error('Use an IPv4 address');
  return address;
};
const number = (address) => address.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0);

// route.exe's active IPv4 rows use numeric columns in every display language.
// Ignore persistent routes: they have no local interface address column.
function parseWindowsRoutes(output, interfaces) {
  const routes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/);
    if (!match || ![match[1], match[2], match[4]].every(isIPv4)) continue;
    const [, destination, netmask, gateway, source, metric] = match;
    const dev = Object.entries(interfaces).find(([, addresses]) => addresses.some((row) => row.address === source))?.[0];
    const mask = number(netmask);
    // A valid subnet mask is a consecutive prefix of set bits.
    const inverse = (~mask) >>> 0;
    if ((inverse & (inverse + 1)) !== 0) continue;
    const prefix = mask.toString(2).replace(/0/g, '').length;
    routes.push({ destination, netmask, gateway, source, dev, metric: Number(metric), prefix });
  }
  return routes;
}

function create({ run = execute, platform = process.platform, interfaces = () => os.networkInterfaces() } = {}) {
  const windows = platform === 'win32';
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  async function powershell(script, timeout = 5000) {
    const prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ";
    const encoded = Buffer.from(prefix + script, 'utf16le').toString('base64');
    const { stdout } = await run(path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, windowsHide: true });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  }
  async function windowsRoutes() {
    const { stdout } = await run(path.win32.join(system32, 'route.exe'), ['print', '-4'], { timeout: 4000, windowsHide: true });
    return parseWindowsRoutes(stdout, interfaces());
  }
  return {
    async wirelessNames() {
      if (!windows) {
        const names = await Promise.all(Object.keys(interfaces()).map(async (name) =>
          await fs.stat('/sys/class/net/' + name + '/wireless').then(() => name, () => null)));
        return new Set(names.filter(Boolean));
      }
      const rows = await powershell("$names = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211 } | ForEach-Object { $_.Name }); ConvertTo-Json -InputObject $names -Compress");
      return new Set(rows);
    },
    async defaultRoutes() {
      if (windows) return (await windowsRoutes()).filter((route) => route.prefix === 0);
      return JSON.parse((await run('ip', ['-json', 'route', 'show', 'default'], { timeout: 1500 })).stdout);
    },
    async routeTo(address) {
      ipv4(address);
      if (!windows) return JSON.parse((await run('ip', ['-json', 'route', 'get', address], { timeout: 4000 })).stdout)[0];
      const target = number(address);
      return (await windowsRoutes())
        .filter((route) => (target & number(route.netmask)) === (number(route.destination) & number(route.netmask)))
        .sort((a, b) => b.prefix - a.prefix || a.metric - b.metric)[0];
    },
    async ping(address, source) {
      ipv4(address);
      if (source) ipv4(source);
      if (windows) {
        // .NET reports success and round-trip time independently of Windows locale.
        // routeTo verifies the selected interface before this unbound IPv4 ping.
        const reply = await powershell("$ping = New-Object System.Net.NetworkInformation.Ping; try { $reply = $ping.Send('" + address + "', 1000); if ($reply.Status -ne [System.Net.NetworkInformation.IPStatus]::Success) { throw ('Ping failed: ' + $reply.Status) }; @{ latencyMs = [double]$reply.RoundtripTime } | ConvertTo-Json -Compress } finally { $ping.Dispose() }");
        return Number.isFinite(reply.latencyMs) ? reply.latencyMs : null;
      }
      const { stdout } = await run('ping', ['-n', ...(source ? ['-I', source] : []), '-c', '1', '-W', '1', address], { timeout: 2500 });
      const latency = Number(stdout.match(/time[=<]([\d.]+)\s*ms/)?.[1]);
      return Number.isFinite(latency) ? latency : null;
    },
  };
}
module.exports = { create, parseWindowsRoutes };
