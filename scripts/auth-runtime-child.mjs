// Windows-only test signal bridge around the actual compiled production entrypoint.
// There is no auth bypass or IPC control channel in the application itself.
if (process.env.NODE_ENV !== 'test' || !process.send)
  throw new Error('Isolated auth test child required');
await import('../apps/api/dist/server.js');
process.on('message', (message) => {
  if (message === 'test-sigterm') {
    process.disconnect();
    process.emit('SIGTERM');
  }
});
