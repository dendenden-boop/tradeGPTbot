// Test-only Windows bridge. Production entrypoint has no IPC control channel.
if (process.env.NODE_ENV !== 'test' || !process.send) {
  throw new Error('Runtime test harness requires an isolated test child');
}
await import('../apps/api/dist/server.js');
process.on('message', (message) => {
  if (message === 'test-sigterm') {
    process.disconnect();
    process.emit('SIGTERM');
  }
});
