const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createWriter({
  fileSystem = fs,
  platform = process.platform,
  retryDelays = [10, 25, 50, 100, 200, 400],
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const pending = new Map();
  return function writeJson(file, value) {
    // Capture the requested state now; callers may mutate the object while an
    // earlier write waits for a Windows reader to release the destination.
    let bytes;
    try { bytes = JSON.stringify(value, null, 2) + '\n'; }
    catch (error) { return Promise.reject(error); }
    const absolute = path.resolve(file);
    const key = platform === 'win32' ? absolute.toLowerCase() : absolute;
    const task = (pending.get(key) || Promise.resolve()).then(async () => {
      await fileSystem.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const temporary = absolute + '.' + crypto.randomUUID() + '.tmp';
      let committed = false;
      try {
        await fileSystem.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try {
            await fileSystem.rename(temporary, absolute);
            committed = true;
            return;
          } catch (error) {
            if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retryDelays.length)
              throw error;
            // Retry this already-written file only. Never rerun a caller's
            // operation or delete/truncate the previous committed state.
            await wait(retryDelays[attempt]);
          }
        }
      } finally {
        if (!committed) {
          try { await fileSystem.rm(temporary, { force: true }); } catch {}
        }
      }
    });
    // Writes to this destination retain call order. A failed write still
    // rejects its caller, but must not poison a later explicit save attempt.
    const tail = task.catch(() => {});
    pending.set(key, tail);
    tail.then(() => { if (pending.get(key) === tail) pending.delete(key); });
    return task;
  };
}

const writeJson = createWriter();
module.exports = { writeJson, createWriter };
