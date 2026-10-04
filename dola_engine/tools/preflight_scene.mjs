// Read-only content gate before submitting one storyboard scene.
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const scene = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(item => item.type === 'page' && item.url.includes('dola.com'));
if (!page?.webSocketDebuggerUrl) throw new Error('Dola page not found');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const state = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP timeout')), 30000);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message.result?.result?.value || {});
  });
  socket.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: {
      expression: `({
        href: location.href,
        text: document.querySelector('[contenteditable="true"]')?.innerText || '',
        imageNames: [...document.querySelectorAll('[data-testid="attachment-image-card"] img')].map(img => img.alt),
        mode: [...document.querySelectorAll('[data-testid="skill_input_exit_button"]')].some(e => e.innerText.includes('视频生成')),
        buttons: [...document.querySelectorAll('button')].map(e => e.innerText.trim()).filter(Boolean),
        plugin: document.documentElement.getAttribute('data-watermark-free-duration-30'),
        uploading: /\\d+%/.test([...document.querySelectorAll('[data-testid="attachment-image-card"]')].map(e=>e.innerText).join(' '))
      })`,
      returnByValue: true,
    },
  }));
});
socket.close();

const normalized = value => String(value || '').replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
const expectedNames = scene.assets.map(asset => asset.path.replace(/^.*[\\/]/, ''));
const checks = {
  accountPage: state.href?.startsWith('https://www.dola.com/chat/') && !state.href.includes('from_logout'),
  videoMode: state.mode,
  plugin30: state.plugin === '1',
  model25: state.buttons.some(text => /模型\s*2\.5/.test(text)),
  duration30: state.buttons.some(text => /^30s$/.test(text)),
  imageCount: state.imageNames.length === scene.assets.length,
  imageOrder: JSON.stringify(state.imageNames) === JSON.stringify(expectedNames),
  promptExact: normalized(state.text) === normalized(scene.prompt) && normalized(state.text).length > 0,
  uploadsFinished: !state.uploading,
};
const ready = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  ready, checks, scene: scene.scene_no,
  images: state.imageNames.length,
  promptCharacters: normalized(state.text).length,
}, null, 2));
if (!ready) process.exitCode = 1;
