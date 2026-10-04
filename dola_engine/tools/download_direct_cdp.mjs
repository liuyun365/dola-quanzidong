// Fallback when the extension panel cannot parse a completed Dola video.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]);
const destination = process.argv[3];
const expectedChat = process.argv[4];
if (!Number.isInteger(port) || !destination || !/^https:\/\/www\.dola\.com\/chat\/\d+$/.test(expectedChat)) {
  throw new Error('Usage: node download_direct_cdp.mjs <port> <destination.mp4> <chat-url>');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(x => x.type === 'page' && x.url === expectedChat);
if (!page) throw new Error('Expected Dola conversation not open');
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
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
function verify(file) {
  if (!existsSync(file) || statSync(file).size < 1024 * 1024) throw new Error('MP4 missing or too small');
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 4, 8) !== 'ftyp' || bytes.indexOf('moov') < 0 || bytes.indexOf('mdat') < 0) {
    throw new Error('Invalid MP4 structure');
  }
  const mvhd = bytes.indexOf('mvhd');
  let duration = null;
  if (mvhd >= 0) {
    const v = bytes[mvhd + 4];
    const scale = bytes.readUInt32BE(mvhd + (v === 0 ? 16 : 24));
    const ticks = v === 0 ? bytes.readUInt32BE(mvhd + 20) : Number(bytes.readBigUInt64BE(mvhd + 28));
    if (scale) duration = Math.round(ticks / scale * 100) / 100;
  }
  return { bytes: bytes.length, duration_seconds: duration,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
const tab = await connect(page.webSocketDebuggerUrl);
const browser = await connect(version.webSocketDebuggerUrl);
try {
  await tab.send('Runtime.evaluate', { expression: `document.querySelector('[class*="block-video-"]')?.scrollIntoView({block:'center'})` });
  await sleep(300);
  const rect = (await tab.send('Runtime.evaluate', {
    expression: `document.querySelector('[class*="block-video-"]')?.getBoundingClientRect().toJSON()`,
    returnByValue: true,
  })).result?.value;
  if (!rect) throw new Error('Completed video card missing');
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  await sleep(1200);
  const state = (await tab.send('Runtime.evaluate', { expression: `(()=>{const card=document.querySelector('[class*="block-video-"]');return {href:location.href,
    done:(document.body?.innerText||'').includes('你的视频生成好了'),
    cards:document.querySelectorAll('[class*="block-video-"]').length,
    videos:[...document.querySelectorAll('video')].map(v=>v.currentSrc||v.src)}})()`,
    returnByValue: true })).result?.value;
  if (state.href !== expectedChat || !state.done || state.cards !== 1 || state.videos.length !== 1) {
    throw new Error(`Completed scene and unique video card not verified: href=${state.href} done=${state.done} cards=${state.cards} videos=${state.videos.length}`);
  }
  const media = new URL(state.videos[0]);
  if (!media.hostname.endsWith('.dola.com') || media.searchParams.get('mime_type') !== 'video_mp4') {
    throw new Error('Card media is not a Dola MP4');
  }
  if (existsSync(destination)) {
    console.log(JSON.stringify({ status: 'downloaded_verified', file: destination,
      chat_url: expectedChat, method: 'existing', ...verify(destination) }));
  } else {
    const downloadDir = path.join(path.dirname(destination), '.cdp_downloads');
    mkdirSync(downloadDir, { recursive: true });
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true,
    });
    let guid = null, finished = false, failed = null;
    browser.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Browser.downloadWillBegin' && message.params?.url === media.href) {
        guid = message.params.guid;
      }
      if (message.method === 'Browser.downloadProgress' && message.params?.guid === guid) {
        if (message.params.state === 'completed') finished = true;
        if (message.params.state === 'canceled') failed = 'Browser download canceled';
      }
    });
    await tab.send('Runtime.evaluate', {
      expression: `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(media.href)};a.download='';a.target='_blank';document.body.append(a);a.click();a.remove();return true})()`,
      returnByValue: true,
    });
    for (let i = 0; i < 180 && !finished && !failed; i++) await sleep(1000);
    if (failed || !finished || !guid) throw new Error(failed || 'Browser direct download did not complete');
    const source = path.join(downloadDir, guid);
    const sourceInfo = verify(source);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination, 1);
    const saved = verify(destination);
    if (sourceInfo.sha256 !== saved.sha256) throw new Error('Copy hash mismatch');
    console.log(JSON.stringify({ status: 'downloaded_verified', file: destination,
      chat_url: expectedChat, method: 'browser_direct', ...saved }));
  }
} finally {
  tab.socket.close();
  browser.socket.close();
}
