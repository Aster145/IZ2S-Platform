#!/usr/bin/env node
const fs = require('node:fs/promises'),
  path = require('node:path');
async function main() {
  process.env.IZ2S_ROOT = __dirname;
  process.env.IZ15_ROOT = __dirname;
  const root = __dirname,
    args = process.argv.slice(2),
    preview = args.includes('--preview'),
    noOpen = args.includes('--no-open'),
    restart = args.includes('--restart');
  if (args.includes('--stop')) {
    const stopped = await require('./core/session/panel-control.cjs').stopPanel(root, { preview });
    console.log(stopped ? 'IZ2S Platform stopped.' : 'No running IZ2S Platform panel in this folder.');
    return;
  }
  if (!process.env.HB_FONT)
    for (const font of [
      path.join(root, 'data/runtime/fonts/DejaVuSans.ttf'),
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
    ])
      if (
        await fs.stat(font).then(
          () => true,
          () => false,
        )
      ) {
        process.env.HB_FONT = font;
        break;
      }
  process.env.HB_BROWSER_PROFILE = path.join(root, 'data/state/browser-profile');
  const { readJson, saveJson } = require('./core/session/ledger.cjs'),
    settings = await readJson(path.join(root, 'panel/profile.json')),
    node = process.execPath;
  if (args.includes('--port')) {
    const port = Number(args[args.indexOf('--port') + 1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('--port requires a port from 1024 to 65535');
    settings.panelPort = port;
  }
  const stateFile = path.join(
      root,
      preview ? 'data/state/preview-window.json' : 'data/state/window.json',
    ),
    previous = await readJson(stateFile);
  let running = false;
  if (previous?.pid && previous.url)
    try {
      process.kill(previous.pid, 0);
      const url = new URL(previous.url),
        health = await fetch(url.origin + '/health', { signal: AbortSignal.timeout(1500) }).then(
          (r) => r.json(),
        );
      if (health.version !== 16 || health.pid !== previous.pid || health.preview !== preview)
        throw Error('Stale IZ2S Platform window');
      running = true;
    } catch {}
  if (running) {
    if (restart) {
      await require('./core/session/panel-control.cjs').stopPanel(root, { preview });
      const deadline = Date.now() + 20000;
      for (;;) {
        try { process.kill(previous.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= deadline) throw Error('Previous server is still stopping. Wait before restarting.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      if (!noOpen)
        require('./core/services/open-panel.cjs').openPanel(previous.url, {
          main: true,
          env: { ...process.env, HB_OPEN_PANEL: '1' },
        });
      console.log('IZ2S Platform is already running.');
      console.log(previous.url);
      return;
    }
  }
  if (restart && !preview && !running)
    await require('./core/session/panel-handover.cjs').handover({ root, port: settings.panelPort });
  if (!preview) {
    const publication = await require('./sdk/publish-modules.cjs').publish(root);
    await saveJson(path.join(root, 'data/state/module-publish.json'), publication);
    for (const error of publication.errors) console.error('Module source not published: ' + error.id + ': ' + error.error);
  }
  const manager = await require('./panel/controller.cjs').create({ root, settings, node, preview });
  let previousToken;
  try {
    const old = new URL(previous?.url);
    if (old.origin === 'http://127.0.0.1:' + settings.panelPort && /^#[a-f0-9]{48}$/.test(old.hash))
      previousToken = old.hash.slice(1);
  } catch {}
  const authFile=path.join(root,preview?'data/state/preview-auth.json':'data/state/panel-auth.json');
  const auth=await readJson(authFile,{});
  if(/^[a-f0-9]{48}$/.test(auth.token||''))previousToken=auth.token;
  previousToken ||= require('node:crypto').randomBytes(24).toString('hex');
  await saveJson(authFile,{token:previousToken});
  const window = await require('./panel/http.cjs').createWindowServer({
    root,
    manager,
    port: preview ? 0 : settings.panelPort,
    onShutdown: finish,
    ...(previousToken ? { token: previousToken } : {}),
  });
  await saveJson(stateFile, {
    pid: process.pid,
    url: window.url,
    preview,
    version: 16,
    started: new Date().toISOString(),
  });
  console.log('IZ2S Platform');
  console.log(window.url);
  if (!noOpen)
    require('./core/services/open-panel.cjs').openPanel(window.url, {
      main: true,
      env: { ...process.env, HB_OPEN_PANEL: '1' },
    });
  let stopping = false;
  async function finish() {
    if (stopping) return;
    stopping = true;
    window.setStopping(true);
    try {
      await window.drainMutations();
      await require('./core/host-modules.cjs').close();
      await manager.stop();
      const deadline = Date.now() + 30000;
      while (manager.ownsListener()) {
        if (Date.now() >= deadline) throw Error('Session cleanup is still pending. Use Disconnect safely or the red STOP button in the panel.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const status = await manager.snapshot();
      if (status.active) throw Error('The session has not finished stopping. Keep the panel open and resolve input cancellation or use the red STOP button.');
      if (status.emergencyInputPending) throw Error('Input cancellation is unconfirmed. Keep the panel open and check the input device.');
      await window.close();
      const current=await readJson(stateFile,{});
      if(current.pid===process.pid)await fs.rm(stateFile, { force: true });
    } catch (error) { stopping = false; window.setStopping(false); throw error; }
  }
  process.once('SIGINT', () => finish().catch(console.error));
  process.once('SIGTERM', () => finish().catch(console.error));
}
if (require.main === module)
  main().catch((e) => {
    console.error('IZ2S Platform: ' + e.message);
    process.exitCode = 1;
  });
module.exports = { main };
