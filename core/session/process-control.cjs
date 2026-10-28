const path = require('node:path');
const { spawn } = require('node:child_process');

const preload = path.join(__dirname, 'managed-stop.cjs');
function nodeArgs(args) {
  return ['--require', preload, ...args];
}
function exited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}
function requestStop(child, { platform = process.platform } = {}) {
  if (exited(child)) return Promise.resolve();
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  if (!child.connected || typeof child.send !== 'function')
    return Promise.reject(Error('The session stop channel is unavailable. Use the red STOP button.'));
  return new Promise((resolve, reject) => {
    child.send({ type: 'iz2s-stop' }, (error) => {
      if (error && !exited(child)) reject(error);
      else resolve();
    });
  });
}
async function stopChild(child, { timeoutMs = 15000, ...options } = {}) {
  if (exited(child)) return;
  let timer, onClose;
  const done = new Promise((resolve, reject) => {
    onClose = resolve;
    child.once('close', onClose);
    timer = setTimeout(() => reject(Error(
      'Cleanup did not finish for ' + (child.script || 'the session') +
      '. RPC was kept available; use the red STOP button if necessary.',
    )), timeoutMs);
  });
  done.catch(() => {});
  try {
    await requestStop(child, options);
    await done;
  } finally {
    clearTimeout(timer);
    child.removeListener('close', onClose);
    done.catch(() => {});
  }
}
async function stopStages(children, hostScript, end = stopChild) {
  // FTP must close files before native RPC is stopped. Audio and graphics also
  // need RPC to release their console resources. Never advance after a timeout.
  const rank = (child) => child.script === 'core/console/host/ftp-service.cjs' ? 0
    : /[\\/]game-audio\.cjs$/.test(child.script) ? 1
    : child.script === hostScript ? 3 : 2;
  for (const level of [0, 1, 2, 3])
    await Promise.all([...children].filter((child) => rank(child) === level).map((child) => end(child)));
}
function forceStop(child, { platform = process.platform, launch = spawn } = {}) {
  if (exited(child)) return Promise.resolve();
  if (!Number.isInteger(child.pid) || child.pid <= 1)
    return Promise.reject(Error('Invalid owned session PID'));
  if (platform !== 'win32') {
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  // Only the owned child's PID is accepted, never an image name or desktop PID.
  return new Promise((resolve, reject) => {
    const task = launch('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    task.stderr.on('data', (bytes) => { errorText = (errorText + bytes).slice(-2000); });
    task.once('error', reject);
    task.once('close', (code) => {
      if (code === 0 || exited(child)) resolve();
      else reject(Error('Unable to stop the owned session tree: ' + errorText.trim()));
    });
  });
}
module.exports = { nodeArgs, requestStop, stopChild, stopStages, forceStop };
