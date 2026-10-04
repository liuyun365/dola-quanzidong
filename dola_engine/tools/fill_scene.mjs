// Fill one prepared scene in an already logged-in CDP browser. No send action.
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const scene = JSON.parse(readFileSync(process.argv[3], 'utf8'));
if (!Number.isInteger(port) || !Array.isArray(scene.assets)) {
  throw new Error('Usage: node fill_scene.mjs <port> <scene-manifest>');
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(item => item.type === 'page' && item.url.includes('dola.com'));
if (!page?.webSocketDebuggerUrl) throw new Error('Dola CDP page not found');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000);
  const onMessage = event => {
    const response = JSON.parse(event.data);
    if (response.id !== id) return;
    socket.removeEventListener('message', onMessage);
    clearTimeout(timer);
    response.error ? reject(new Error(response.error.message)) : resolve(response.result);
  };
  socket.addEventListener('message', onMessage);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => (await send('Runtime.evaluate', {
  expression, returnByValue: true,
})).result?.value;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mouseClick(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Control not visible');
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
}

try {
  let initial;
  for (let i = 0; i < 60; i++) {
    initial = await evaluate(`({href:location.href,username:(document.body?.innerText||'').match(/\\buser[A-Za-z0-9]{5,}\\b/)?.[0]||null,editor:document.querySelector('[contenteditable="true"]')?.innerText||'',imageCount:document.querySelectorAll('[data-testid="attachment-image-card"]').length})`);
    if (initial?.href?.startsWith('https://www.dola.com/chat/') && !initial.href.includes('from_logout') && initial.username) break;
    await sleep(500);
  }
  if (!initial?.href?.startsWith('https://www.dola.com/chat/') || initial.href.includes('from_logout') || !initial.username) {
    throw new Error('CDP browser is not logged in');
  }
  if (initial.editor.trim() || initial.imageCount) {
    throw new Error('Composer already contains content; refusing to overwrite or duplicate');
  }
  if (!await evaluate(`!!document.querySelector('[data-testid="skill_input_exit_button"]')`)) {
    let clicked = false;
    for (let i = 0; i < 80 && !clicked; i++) {
      clicked = await evaluate(`(()=>{const e=document.querySelector('[data-testid="skill_bar_button_17"]');if(!e)return false;e.click();return true})()`);
      if (!clicked) await sleep(500);
    }
    if (!clicked) throw new Error('Video mode button unavailable');
  }
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`!!document.querySelector('[data-testid="skill_input_exit_button"]')`)) break;
    await sleep(500);
  }
  let plugin = await evaluate(`document.documentElement.getAttribute('data-watermark-free-duration-30')`);
  if (plugin !== '1') {
    let clicked = false;
    for (let i = 0; i < 80 && !clicked; i++) {
      clicked = await evaluate(`(()=>{const e=document.getElementById('watermark-free-media-panel')?.shadowRoot?.querySelector('.duration-toggle');if(!e)return false;e.click();return true})()`);
      if (!clicked) await sleep(500);
    }
    if (!clicked) throw new Error('30-second plugin switch unavailable');
  }
  let modeReady = false;
  for (let i = 0; i < 80; i++) {
    const state = await evaluate(`({href:location.href,mode:[...document.querySelectorAll('[data-testid="skill_input_exit_button"]')].some(e=>e.innerText.includes('视频生成')),buttons:[...document.querySelectorAll('button')].map(e=>e.innerText.trim()),plugin:document.documentElement.getAttribute('data-watermark-free-duration-30')})`);
    if (state.href.includes('from_logout')) throw new Error('CDP account logged out while entering video mode');
    modeReady = state.mode && state.plugin === '1' &&
      state.buttons.some(text => /模型\s*2\.5/.test(text)) &&
      state.buttons.some(text => /^30s$/.test(text));
    if (modeReady) break;
    await sleep(500);
  }
  if (!modeReady) throw new Error('Video mode 2.5/30s/plugin did not become ready');

  const doc = await send('DOM.getDocument');
  const expected = scene.assets.map(asset => asset.path.replace(/^.*[\\/]/, ''));
  if (scene.assets.length) {
    const input = await send('DOM.querySelector', {
      nodeId: doc.root.nodeId, selector: '[data-testid="upload-file-input"]',
    });
    if (!input.nodeId) throw new Error('Image file input not found');
    await send('DOM.setFileInputFiles', {
      nodeId: input.nodeId, files: scene.assets.map(asset => asset.path),
    });
    let uploaded = false;
    for (let i = 0; i < 90; i++) {
      const state = await evaluate(`({names:[...document.querySelectorAll('[data-testid="attachment-image-card"] img')].map(img=>img.alt),progress:[...document.querySelectorAll('[data-testid="attachment-image-card"]')].map(e=>e.innerText)})`);
      uploaded = JSON.stringify(state.names) === JSON.stringify(expected) &&
        state.progress.every(value => !/\d+%/.test(value));
      if (uploaded) break;
      await sleep(1000);
    }
    if (!uploaded) throw new Error('Image upload incomplete or order differs');
  }
  await evaluate(`document.querySelector('[contenteditable="true"]')?.focus()`);
  await send('Input.insertText', { text: scene.prompt });
  const normalize = value => String(value || '').replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
  const actual = await evaluate(`document.querySelector('[contenteditable="true"]')?.innerText || ''`);
  if (normalize(actual) !== normalize(scene.prompt)) throw new Error('Prompt readback differs');
  console.log(JSON.stringify({ readyForPreflight: true, port, scene: scene.scene_no,
    images: expected, promptCharacters: normalize(actual).length }, null, 2));
} finally {
  socket.close();
}
