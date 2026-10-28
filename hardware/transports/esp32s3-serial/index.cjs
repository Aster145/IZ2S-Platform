const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const hostTools = require('../../../core/host-tools.cjs');
const common = require('../common.cjs');
const ID = /^[a-f\d-]{36}$/;
const worker = path.join(__dirname, 'worker.py');
const env = () => ({ ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' });

async function query(action, settings = {}) {
  const python = hostTools.python();
  return JSON.parse(await common.invoke(python.file, [...python.args, worker], {
    input: { action, settings }, env: env(), timeout: 15000,
  }));
}

// Enumerates metadata only: no serial port is opened and no PING is sent.
async function listPorts(_root) {
  return query('ports');
}

function create({ root, configuration, preparePlan = (value) => common.plan(root, value),
  spawnImpl = spawn, queryWorker = query }) {
  const settings = configuration.settings;
  const jobs = new Map(), cancelled = new Set();
  let active = null, cachedStatus = null, inspecting = null;
  const folder = path.join(root, 'data/state/esp32s3-input-jobs');
  const record = (id) => path.join(folder, id + '.json');
  function configured() {
    const missing = require('../../devices/esp32s3-textkeyboard/settings.cjs').validate(settings);
    if (missing.length) throw Error(missing.join(' '));
  }
  async function inspect({ refresh = false } = {}) {
    if (active) return {
      ...cachedStatus, reachable: true, moduleReady: true, keyboard: settings.esp32UsbConfirmed === 'yes',
      keyboardBusy: true, service: 'esp32s3-serial', detail: 'ESP32-S3 input job is running',
      usbReadySource: settings.esp32UsbConfirmed === 'yes' ? 'user-confirmed' : 'unconfirmed',
    };
    if (inspecting) return inspecting;
    if (cachedStatus && !refresh) return cachedStatus;
    inspecting = (async () => {
      try {
        configured();
        cachedStatus = await queryWorker('inspect', settings);
      } catch (error) {
        cachedStatus = {
          reachable: false, moduleReady: false, keyboard: false, keyboardBusy: false,
          setupRequired: true, service: 'esp32s3-serial', error: error.message,
          detail: error.message, usbDetail: 'Serial connection is unavailable; close other senders using this port',
        };
      }
      return cachedStatus;
    })();
    try { return await inspecting; } finally { inspecting = null; }
  }

  function startWorker(job, plan, onEvent) {
    const python = hostTools.python();
    const child = spawnImpl(python.file, [...python.args, worker], {
      env: env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    job.child = child;
    return new Promise((resolve, reject) => {
      let pending = '', errors = '', done = false, killTimer;
      const deadline = setTimeout(() => {
        job.timedOut = true;
        child.stdin.write(JSON.stringify({ action: 'cancel' }) + '\n');
        killTimer = setTimeout(() => child.kill(), 10000);
      }, 7300000);
      function finish(error, result) {
        if (done) return;
        done = true;
        clearTimeout(deadline); clearTimeout(killTimer);
        error ? reject(error) : resolve(result);
      }
      child.stdout.on('data', (bytes) => {
        pending += bytes;
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (value.done) job.result = value.done;
            else onEvent(value);
          } catch (error) {
            errors = error.message;
            child.stdin.write(JSON.stringify({ action: 'cancel' }) + '\n');
          }
        }
      });
      child.stderr.on('data', (bytes) => { errors = (errors + bytes).slice(-8000); });
      child.stdin.on('error', () => {});
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code === 0 && job.result?.ok && !job.timedOut) finish(null, job.result);
        else finish(Object.assign(Error(job.result?.error || errors.trim() || 'ESP32-S3 input completion is unconfirmed; commands were not retried'),
          { stopped: job.result?.stopped === true }));
      });
      child.stdin.write(JSON.stringify({ action: 'plan', settings, plan }) + '\n');
      if (job.cancelRequested) child.stdin.write(JSON.stringify({ action: 'cancel' }) + '\n');
    });
  }

  async function performPlan(value, onEvent = () => {}) {
    const plan = await preparePlan(value);
    if (!ID.test(plan.requestId || '')) throw Error('Invalid input job identifier');
    if (cancelled.has(plan.requestId)) throw Error('Input job was cancelled; commands were not sent');
    if (jobs.has(plan.requestId)) return jobs.get(plan.requestId).promise;
    configured();
    if (settings.esp32UsbConfirmed !== 'yes') throw Error('Confirm the ESP32-S3 USB/OTG data cable is connected to Switch');
    if (active) throw Error('An ESP32-S3 input job is already running');
    // Wait for an explicit status check to release its serial handle.
    if (inspecting) await inspecting;
    if (active) throw Error('An ESP32-S3 input job is already running');
    const job = { id: plan.requestId, result: null, cancelRequested: false, child: null };
    active = job;
    job.promise = (async () => {
      let status = 'failed';
      try {
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(record(job.id), JSON.stringify({ id: job.id, status: 'requested' }), { flag: 'wx' })
          .catch((error) => { if (error.code === 'EEXIST') throw Error('This input job already exists; commands were not replayed'); throw error; });
        job.ownsRecord = true;
        if (cancelled.has(job.id)) throw Error('Input job was cancelled; commands were not sent');
        const result = await startWorker(job, plan, onEvent);
        status = 'complete';
        return result;
      } catch (error) {
        status = error.stopped || cancelled.has(job.id) && !job.child ? 'cancelled' : 'failed';
        job.error = error.message;
        throw error;
      } finally {
        if (active === job) active = null;
        cachedStatus = null;
        if (job.ownsRecord) await fs.writeFile(record(job.id), JSON.stringify({ id: job.id, status, ...(job.error ? { error: job.error } : {}) }));
      }
    })();
    jobs.set(job.id, job);
    return job.promise;
  }

  async function halt(id) {
    if (!ID.test(id || '')) throw Error('Invalid input job identifier');
    cancelled.add(id);
    const job = jobs.get(id);
    if (job?.child && active !== job && !job.result?.ok && !job.result?.stopped)
      throw Error('ESP32-S3 cancellation is unconfirmed');
    if (job && active === job) {
      job.cancelRequested = true;
      job.child?.stdin.write(JSON.stringify({ action: 'cancel' }) + '\n');
      let timer;
      try {
        await Promise.race([
          job.promise.catch(() => {}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('ESP32-S3 cancellation is unconfirmed')), 15000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (job.child && !job.result?.stopped && !job.result?.ok)
        throw Error('ESP32-S3 cancellation is unconfirmed');
    } else {
      // A completed worker can still be persisting its result. Read that result
      // only after its owner has finished writing it.
      if (job) await job.promise.catch(() => {});
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(record(id), JSON.stringify({ id, status: 'cancelled' }), { flag: 'wx' })
        .catch(async (error) => {
          if (error.code !== 'EEXIST') throw error;
          // A new host process cannot confirm what an old serial worker or the
          // firmware is doing. Preserve its unresolved record and the panel's
          // input-recovery state instead of reporting a successful cancellation.
          const prior = await fs.readFile(record(id), 'utf8').then(JSON.parse).catch(() => null);
          if (prior?.id !== id || !['complete', 'cancelled'].includes(prior.status))
            throw Error('ESP32-S3 cancellation is unconfirmed: the previous input job has no completion acknowledgement');
        });
    }
    return { stopped: true };
  }
  return { adapter: 'esp32s3-serial', inspect, performPlan, halt,
    async perform() { throw Error('Input actions must be supplied as an engine-provided typed plan'); } };
}
module.exports = { create, listPorts };
