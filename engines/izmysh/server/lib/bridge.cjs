// Serialized loopback RPC for the connected console.
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Stage programs share one native connection through this local, serialized
// bridge. Its address and token exist only in the current launch directory.
function createDiagnostics(directory, {
  fileSystem = fs,
  retryDelays = [10, 25, 50],
  warn = (error) => console.warn('Bridge diagnostic update skipped: ' + error.message),
} = {}) {
  let warned = false;
  return async (row, statistics) => {
    if (!directory) return;
    let temporary;
    try {
      if (row.status === 'failed') {
        await fileSystem.writeFile(path.join(directory, 'bridge-failure.json'), JSON.stringify(row, null, 2));
        try {
          await fileSystem.writeFile(path.join(directory, 'bridge-first-failure.json'), JSON.stringify(row, null, 2), { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        await fileSystem.appendFile(path.join(directory, 'bridge-failures.jsonl'), JSON.stringify(row) + '\n');
      }
      const file = path.join(directory, 'bridge-progress.json');
      temporary = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      await fileSystem.writeFile(temporary, JSON.stringify({ ...row, statistics }, null, 2), { flag: 'wx', mode: 0o600 });
      // Windows readers/antivirus may briefly hold the destination without
      // delete sharing. Retry only the diagnostic rename, never native work.
      for (let attempt = 0; ; attempt++) {
        try {
          await fileSystem.rename(temporary, file);
          temporary = null;
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retryDelays.length) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        }
      }
    } catch (error) {
      // These files describe a native result; they must never determine it.
      // In particular, a failed final save must not turn a successful hardware
      // write into an RPC error, or hide the original native failure.
      if (!warned) {
        warned = true;
        try { warn(error); } catch {}
      }
    } finally {
      if (temporary) {
        try { await fileSystem.rm(temporary, { force: true }); } catch {}
      }
    }
  };
}

async function serve(native, directory, diagnosticOptions) {
  let closing = false, closePromise;
  const token = crypto.randomBytes(32).toString("hex");
  const queue = require('./request-queue.cjs').create();
  const statistics = {
    requests: 0,
    completed: 0,
    failed: 0,
    readBytes: 0,
    writtenBytes: 0,
    commands: {},
  };
  const diagnostics = createDiagnostics(directory, diagnosticOptions);
  const save = (row) => diagnostics(row, statistics);
  const enqueue = (task, info = { command: "keepalive" }) => {
    const queuedAt=performance.now();
    return queue.enqueue(async () => {
      const row = {
        ...info,
        queueWaitMs: performance.now()-queuedAt,
        started: new Date().toISOString(),
        status: "pending",
      };
      statistics.requests++;
      const count = (statistics.commands[row.command] ||= {
        count: 0,
        completed: 0,
        failed: 0,
        milliseconds: 0,
      });
      count.count++;
      const start = performance.now();
      await save(row);
      try {
        const result = await task();
        row.status = "returned";
        statistics.completed++;
        count.completed++;
        if (row.command === "read" || row.command === "read-many")
          statistics.readBytes += row.length;
        if (row.command === "write" || row.command === "write-call")
          statistics.writtenBytes += row.length;
        return result;
      } catch (error) {
        row.status = "failed";
        row.error = error.message;
        statistics.failed++;
        count.failed++;
        throw error;
      } finally {
        row.completed = new Date().toISOString();
        row.milliseconds = performance.now() - start;
        count.milliseconds += row.milliseconds;
        await save(row);
      }
    },{priority:info.priority||'normal'});
  };
  async function handle(request) {
    const { command } = request;
    if (command === "status")
      return {
        ready: !native.connection.error && !native.connection.suspended,
        suspended: !!native.connection.suspended,
        calls: native.calls,
      };
    if (command === "call") {
      const reply = await native.call(request.offset, ...request.args);
      return {
        result: reply.result.toString(),
        output: reply.output.toString("base64"),
      };
    }
    if (command === "verify-function") {
      if (
        typeof request.hex !== "string" ||
        !/^(?:[0-9a-f]{2}){4,256}$/i.test(request.hex)
      )
        throw Error("Expected original native instruction bytes");
      await native.verifyFunction(
        request.address,
        Buffer.from(request.hex, "hex"),
      );
      return { verified: true };
    }
    if (command === "call-address") {
      const reply = await native.callAddress(request.address, ...request.args);
      return {
        result: reply.result.toString(),
        output: reply.output.toString("base64"),
      };
    }
    if (command === "pair") {
      const reply = await native.exchange(request.calls);
      return {
        results: reply.results.map(String),
        output: reply.output.toString("base64"),
      };
    }
    if (command === "read")
      return {
        data: (await native.read(request.address, request.length)).toString(
          "base64",
        ),
      };
    if (command === "read-many")
      return {
        parts: (await native.readMany(request.spans)).map((b) =>
          b.toString("base64"),
        ),
      };
    if (command === "write") {
      await native.write(request.address, Buffer.from(request.data, "base64"));
      return { written: true };
    }
    if (command === "write-call") {
      const reply = await native.writeCall(
        request.address,
        Buffer.from(request.data, "base64"),
        request.functionAddress,
        request.args,
      );
      return { result: reply.result.toString(), written: true };
    }
    if (command === "query") return native.query(request.address);
    throw Error("Unknown bridge command");
  }
  const server = http.createServer(async (req, res) => {
    if (closing) {
      res.writeHead(503, { Connection: 'close' }).end();
      return;
    }
    if (
      req.method !== "POST" ||
      req.url !== "/" ||
      req.headers.authorization !== "Bearer " + token
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      const parts = [];
      let length = 0;
      for await (const part of req) {
        length += part.length;
        if (length > 2 * 1024 * 1024)
          throw Error("Bridge request is too large");
        parts.push(part);
      }
      const request = JSON.parse(Buffer.concat(parts));
      const info = { command: request.command };
      if(request.priority!==undefined){
        if(request.priority!=='audio'||!['call-address','write-call'].includes(request.command))throw Error('Invalid native request priority');
        info.priority='audio';
      }
      for (const key of ["address", "offset", "length"])
        if (request[key] !== undefined) info[key] = request[key];
      if (
        ["write", "write-call"].includes(request.command) &&
        typeof request.data === "string"
      )
        info.length = Buffer.byteLength(request.data, "base64");
      if (request.command === "read-many" && Array.isArray(request.spans))
        info.length = request.spans.reduce(
          (n, s) => n + (Number.isInteger(s?.length) ? s.length : 0),
          0,
        );
      if (closing) throw Error('Native bridge is stopping');
      const result = await (request.command === "status"
        ? handle(request)
        : enqueue(() => handle(request), info));
      res.setHeader("Content-Type", "application/json");
      if (closing) res.setHeader('Connection', 'close');
      res.end(
        JSON.stringify(result, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
    } catch (error) {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let activity;
  let lastActivity = 0;
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (closing || heartbeatPending) return;
    heartbeatPending = true;
    enqueue(async () => {
      if (native.connection.error) return;
      if (activity && Date.now() - lastActivity > 30000) {
        const reply = await native.call(activity.offset, activity.controller);
        if (reply.result) throw Error("Console activity report failed");
        lastActivity = Date.now();
      } else await native.call(0x5872f0, native.output, native.output, 0);
    })
      .catch((error) => native.connection.fail(error))
      .finally(() => {
        heartbeatPending = false;
      });
  }, 5000);
  heartbeat.unref();
  return {
    port: server.address().port,
    token,
    keepAwake(value) {
      activity = value;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(heartbeat);
      // Stop accepting work, but return all accepted RPC responses before the
      // native connection is retired. In-flight file writes must not be cut off.
      closePromise = (async () => {
        await new Promise((resolve) => server.close(resolve));
        await queue.idle();
      })();
      return closePromise;
    },
  };
}

module.exports = { serve, createDiagnostics };
