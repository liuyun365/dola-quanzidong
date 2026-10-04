// Download the original (watermarked) Dola video card as a fallback when
// the watermark-free parse fails. Called by engine when a card exists but
// download_scene.mjs could not resolve a clean MP4.
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]);
const destination = process.argv[3];
if (!Number.isInteger(port) || !destination) {
  throw new Error('Usage: node download_original.mjs <port> <destination.mp4>');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function target() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.find(item => item.type === 'page' && item.url.startsWith('https://www.dola.com/chat/'));
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
    const handler = event => {
      const message = JSON.parse(event.data);
      if (message.id !== current) return;
      socket.removeEventListener('message', handler);
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    };
    socket.addEventListener('message', handler);
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  return { socket, send };
}
const page = await target();
if (!page) throw new Error('Dola page not found');
const cdp = await connect(page.webSocketDebuggerUrl);
const evaluate = async expression => (await cdp.send('Runtime.evaluate', {
  expression, returnByValue: true, awaitPromise: true,
})).result?.value;

// Locate the original video source inside the finished card (watermarked master).
let src = await evaluate(`(()=>{
  const card = document.querySelector('[class*="block-video-"]');
  const v = card?.querySelector('video') || document.querySelector('video');
  const s = v && (v.currentSrc || v.getAttribute('src') || '');
  return s || '';
})()`);
if (!src) throw new Error('No original video source found in card');

let buf = null;
if (src.startsWith('http')) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`original download HTTP ${res.status}`);
  buf = Buffer.from(await res.arrayBuffer());
} else if (src.startsWith('blob:')) {
  // Blob URL: read through the page and return base64 (chunked to avoid eval size limits).
  const b64 = await evaluate(`(async()=>{
    const r = await fetch(${JSON.stringify(src)});
    const b = new Uint8Array(await r.arrayBuffer());
    const CH = 0x8000; let s = '';
    for (let i = 0; i < b.length; i += CH) {
      s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + CH, b.length)));
    }
    return { b64: btoa(s), len: b.length };
  })()`);
  if (!b64 || !b64.len) throw new Error('Original blob read returned empty');
  buf = Buffer.from(b64.b64, 'base64');
} else {
  throw new Error(`Unsupported original source scheme: ${src.slice(0, 12)}`);
}
if (!buf || buf.length < 1024 * 1024) throw new Error('Original download missing or too small');

// Light structural check (ftyp + mdat) so a truncated fetch is not silently kept.
function boxes(start, end) {
  const found = [];
  for (let pos = start; pos < end;) {
    if (pos + 8 > end) throw new Error('Truncated MP4 box');
    let size = buf.readUInt32BE(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new Error('Truncated extended MP4 box');
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new Error('Invalid MP4 box size');
    found.push({ type: buf.toString('ascii', pos + 4, pos + 8) });
    pos += size;
  }
  return found;
}
const top = boxes(0, buf.length);
if (top[0]?.type !== 'ftyp' || !top.some(box => box.type === 'mdat')) {
  throw new Error('Original resource is not a valid MP4');
}
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, buf, { flag: 'wx' });
console.log(JSON.stringify({ status: 'downloaded_original', file: destination,
  bytes: buf.length, source: src.startsWith('http') ? src.slice(0, 60) : 'blob' }, null, 2));
cdp.socket.close();
