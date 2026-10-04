// Close any CDP browser unconditionally (used as fallback when a scene
// failed before a clean verified download or an explicit platform rejection).
const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('Usage: node close_any.mjs <port>');
let socket;
try {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise(resolve => setTimeout(resolve, 400));
  socket.close();
  console.log(JSON.stringify({ status: 'closed_any', port }));
} catch (error) {
  console.log(JSON.stringify({ status: 'close_failed', port, error: String(error).slice(0, 120) }));
  process.exit(0);
}
