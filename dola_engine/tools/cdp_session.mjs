// Configure downloads or close the recovered scene browser after its MP4 is complete.
import { existsSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import path from 'node:path';

const action = process.argv[2];
const manifestPath = path.join(import.meta.dirname, 'state', 'cdp_recovery', '29-1.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const port = Number(manifest.current_port);
if (!['set-download', 'close-after-verified'].includes(action) || !Number.isInteger(port)) {
  throw new Error('Usage: node cdp_session.mjs set-download|close-after-verified');
}

if (action === 'close-after-verified') {
  const output = path.join(manifest.download_dir, manifest.target_filename);
  if (!existsSync(output) || statSync(output).size < 1024 * 1024) {
    throw new Error(`Verified video file is missing or too small: ${output}`);
  }
  if (readdirSync(manifest.download_dir).some(name => name.endsWith('.crdownload'))) {
    throw new Error('A browser download is still in progress');
  }
  const fd = openSync(output, 'r');
  const head = Buffer.alloc(12);
  try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  if (head.toString('ascii', 4, 8) !== 'ftyp') {
    throw new Error('Output is not an MP4 container');
  }
}

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const send = (method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
  socket.addEventListener('message', function onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    socket.removeEventListener('message', onMessage);
    clearTimeout(timer);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  socket.send(JSON.stringify({ id: 1, method, params }));
});

if (action === 'set-download') {
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: manifest.download_dir, eventsEnabled: true,
  });
  socket.close();
  console.log(JSON.stringify({ port, download_dir: manifest.download_dir }, null, 2));
} else {
  await send('Browser.close', {}).catch(error => {
    // Chrome can close the debugging socket before acknowledging Browser.close.
    if (!/timed out|closed/i.test(error.message)) throw error;
  });
  socket.close();
  manifest.status = 'downloaded_closed';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ status: manifest.status, file: path.join(manifest.download_dir, manifest.target_filename) }, null, 2));
}
