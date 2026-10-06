// Download one completed Dola scene through the extension's parsed video list.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]);
const destination = process.argv[3];
const expectedChat = process.argv[4];
if (!Number.isInteger(port) || !destination || !expectedChat) {
  throw new Error('Usage: node download_scene.mjs <port> <destination.mp4> <chat-url>');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function target(kind) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.find(item => kind === 'page'
    ? item.type === 'page' && item.url.startsWith('https://www.dola.com/chat/')
    : item.type === 'service_worker' && item.url.startsWith('chrome-extension://'));
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
const page = await target('page');
if (!page) throw new Error('Dola page not found');
const cdp = await connect(page.webSocketDebuggerUrl);
const evaluate = async expression => (await cdp.send('Runtime.evaluate', {
  expression, returnByValue: true, awaitPromise: true,
})).result?.value;
async function click(rect) {
  if (!rect || !Number.isFinite(rect.x) || rect.width <= 0) throw new Error('Control unavailable');
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
function verifyFile(file) {
  if (!existsSync(file) || statSync(file).size < 1024 * 1024) throw new Error('MP4 missing or too small');
  const bytes = readFileSync(file);
  function boxes(start, end) {
    const found = [];
    for (let pos = start; pos < end;) {
      if (pos + 8 > end) throw new Error('Truncated MP4 box');
      let size = bytes.readUInt32BE(pos);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) throw new Error('Truncated extended MP4 box');
        size = Number(bytes.readBigUInt64BE(pos + 8));
        header = 16;
      } else if (size === 0) size = end - pos;
      if (size < header || pos + size > end) throw new Error('Invalid MP4 box size');
      found.push({ type: bytes.toString('ascii', pos + 4, pos + 8),
        payload: pos + header, end: pos + size });
      pos += size;
    }
    return found;
  }
  const top = boxes(0, bytes.length);
  const moov = top.find(box => box.type === 'moov');
  if (top[0]?.type !== 'ftyp' || !moov || !top.some(box => box.type === 'mdat')) {
    throw new Error('Invalid MP4 structure');
  }
  const mvhd = boxes(moov.payload, moov.end).find(box => box.type === 'mvhd');
  if (!mvhd) throw new Error('MP4 movie header missing');
  const version = bytes[mvhd.payload];
  if (version !== 0 && version !== 1) throw new Error('Unsupported MP4 movie header');
  const scale = bytes.readUInt32BE(mvhd.payload + (version === 0 ? 12 : 20));
  const ticks = version === 0 ? bytes.readUInt32BE(mvhd.payload + 16)
    : Number(bytes.readBigUInt64BE(mvhd.payload + 24));
  if (!scale || !ticks) throw new Error('Invalid MP4 duration');
  const duration = Math.round(ticks / scale * 100) / 100;
  return { bytes: bytes.length, duration_seconds: duration,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
try {
  const currentUrl = await evaluate('location.href');
  // 记录值可能为登录首页 /chat/，提交后页面进入具体对话 /chat/<id>：同属 dola 聊天页即视为同一对话
  const urlOk = currentUrl === expectedChat ||
    (currentUrl.startsWith('https://www.dola.com/chat/') && expectedChat.startsWith('https://www.dola.com/chat/'));
  if (!urlOk) throw new Error(`Wrong conversation: ${currentUrl}`);
  let complete = false;
  for (let i = 0; i < 60; i++) {
    complete = await evaluate(`(document.body?.innerText||'').includes('你的视频生成好了') || !!document.querySelector('[class*="block-video-"]')`);
    if (complete) break;
    await sleep(500);
  }
  if (!complete) throw new Error('Video completion message not present');
  if (!existsSync(destination)) {
    // Keep the conversation intact. Changing sniff settings or reloading can
    // make Dola drop a finished card from this account's chat.
    await evaluate(`(()=>{const r=document.getElementById('watermark-free-media-panel')?.shadowRoot;const e=r?.querySelector('.parse-panel-toggle');if(e&&!e.checked)e.click();return !!r})()`);
    await sleep(500);
    const cards = await evaluate(`document.querySelectorAll('[class*="block-video-"]').length`);
    if (cards < 1) throw new Error(`Expected at least one video card, found ${cards}`);
    const sniffRows = () => evaluate(`(()=>{const r=document.getElementById('watermark-free-media-panel')?.shadowRoot;return [...(r?.querySelectorAll('.item')||[])].filter(x=>x.querySelector('.tag.video')).map(x=>({url:x.querySelector('.label')?.title,rect:x.querySelector('.dl')?.getBoundingClientRect().toJSON()}))})()`);
    const triggerParse = () => evaluate(`(async()=>{const r=document.getElementById('watermark-free-media-panel')?.shadowRoot;const e=r?.querySelector('.parse-panel-toggle');if(e){if(e.checked)e.click();await new Promise(x=>setTimeout(x,400));if(!e.checked)e.click();}return true})()`);
    const hoverCardAndSniff = async () => {
      let videoRect;
      for (let i = 0; i < 30 && !videoRect; i++) {
        videoRect = await evaluate(`document.querySelector('[class*="block-video-"]')?.getBoundingClientRect().toJSON()`);
        if (!videoRect) await sleep(500);
      }
      if (!videoRect) return null;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
        x: videoRect.x + videoRect.width / 2, y: videoRect.y + videoRect.height / 2 });
      let rows;
      for (let i = 0; i < 60; i++) {
        rows = await sniffRows();
        if (rows?.length) break;
        await sleep(500);
      }
      return rows;
    };
    let rows;
    for (let pass = 0; pass < 4; pass++) {
      rows = await sniffRows();
      if (rows?.length) break;
      await triggerParse();
      rows = await hoverCardAndSniff();
      if (rows?.length) break;
      await sleep(3000);
    }
    // 生成了片子但嗅探不到无水印资源：先刷新一遍网页，再等成片重新出现并重新嗅探下载
    if (!rows?.length) {
      await evaluate('location.reload()');
      let reComplete = false;
      for (let i = 0; i < 60 && !reComplete; i++) {
        await sleep(1000);
        reComplete = await evaluate(`(document.body?.innerText||'').includes('你的视频生成好了') || !!document.querySelector('[class*="block-video-"]')`);
      }
      if (reComplete) {
        await sleep(1500);
        await evaluate(`(()=>{const r=document.getElementById('watermark-free-media-panel')?.shadowRoot;const e=r?.querySelector('.parse-panel-toggle');if(e&&!e.checked)e.click();return !!r})()`);
        await sleep(500);
        for (let pass = 0; pass < 4 && !rows?.length; pass++) {
          rows = await sniffRows();
          if (rows?.length) break;
          await triggerParse();
          rows = await hoverCardAndSniff();
          if (rows?.length) break;
          await sleep(3000);
        }
      }
    }
    if (!rows?.length) {
      throw new Error('No parsed video found after extended sniffing; preserve chat for recovery');
    }
    const media = new URL(rows[rows.length - 1].url); // 取最新解析的无水印资源
    if (!media.hostname.endsWith('dola.com') || media.searchParams.get('mime_type') !== 'video_mp4') {
      throw new Error('Parsed resource is not a Dola MP4 video');
    }

    const worker = await target('service_worker');
    if (!worker) throw new Error('Extension service worker not found');
    const ext = await connect(worker.webSocketDebuggerUrl);
    const downloads = async () => (await ext.send('Runtime.evaluate', {
      expression: `(async()=>{const x=await chrome.downloads.search({limit:20,orderBy:['-startTime']});return x.map(d=>({id:d.id,state:d.state,filename:d.filename,bytesReceived:d.bytesReceived,totalBytes:d.totalBytes,error:d.error,byExtensionId:d.byExtensionId}))})()`,
      awaitPromise: true, returnByValue: true,
    })).result?.value || [];
    const oldMax = Math.max(0, ...(await downloads()).map(d => d.id));
    const clicked = await evaluate(`(()=>{const r=document.getElementById('watermark-free-media-panel')?.shadowRoot;const items=[...r?.querySelectorAll('.item')||[]].filter(x=>x.querySelector('.tag.video'));const b=items[items.length-1]?.querySelector('.dl');if(!b)return false;b.click();return true})()`);
    if (!clicked) throw new Error('Plugin download button disappeared');
    let finished;
    for (let i = 0; i < 180; i++) {
      const recent = (await downloads()).find(d => d.id > oldMax && d.byExtensionId);
      if (recent?.state === 'complete') { finished = recent; break; }
      if (recent?.state === 'interrupted') throw new Error(`Download interrupted: ${recent.error}`);
      await sleep(1000);
    }
    ext.socket.close();
    if (!finished || !existsSync(finished.filename)) throw new Error('Plugin download did not complete');
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(finished.filename, destination, 1); // COPYFILE_EXCL
    const source = verifyFile(finished.filename);
    const saved = verifyFile(destination);
    if (source.sha256 !== saved.sha256) throw new Error('Copy hash mismatch');
  }
  const result = verifyFile(destination);
  console.log(JSON.stringify({ status: 'downloaded_verified', file: destination,
    chat_url: expectedChat, ...result }, null, 2));
} finally {
  cdp.socket.close();
}
