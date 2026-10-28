const fs = require('node:fs/promises');
const path = require('node:path');

async function stopPanel(root, { preview = false, timeout = 35000 } = {}) {
  const stateFile = path.join(root, 'data/state', preview ? 'preview-window.json' : 'window.json');
  let state;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const url = new URL(state.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !/^#[a-f0-9]{48}$/.test(url.hash)) throw Error('Invalid saved panel address');
  const health = await fetch(url.origin + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
  if (!health) return false;
  if (health.pid !== state.pid || health.version !== state.version || health.preview !== preview) throw Error('Saved panel does not match the running process');
  const response = await fetch(url.origin + '/api/shutdown', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin, 'x-iz-key': url.hash.slice(1) },
    body: '{}', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error('Panel cannot shut down gracefully. Use Disconnect safely in its window first.');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!current || current.pid !== state.pid) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('The panel is still cleaning up. Check its terminal before trying again.');
}
module.exports = { stopPanel };
