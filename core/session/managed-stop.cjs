// Preloaded in owned Node processes. Windows child.kill('SIGTERM') terminates
// immediately, so deliver a JS event over IPC to run the existing cleanup code.
let requested = false;
let delivered = false;
function deliver() {
  if (!requested || delivered || !process.listenerCount('SIGTERM')) return;
  delivered = true;
  process.emit('SIGTERM');
}
function request() {
  requested = true;
  deliver();
}
process.on('message', (message) => {
  if (message?.type === 'iz2s-stop') request();
});
process.on('disconnect', request);
// A stop can arrive while a stage is still initializing. Remember it until its
// cleanup handler is installed; finite preparation stages may finish normally.
process.on('newListener', (event) => {
  if (event === 'SIGTERM' && requested && !delivered) queueMicrotask(deliver);
});
// The control pipe must not keep a completed stage alive.
process.channel?.unref();
