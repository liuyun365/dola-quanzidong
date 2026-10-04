// Submit exactly one prepared scene after a fresh content gate.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]);
const manifestPath = process.argv[3];
const scene = JSON.parse(readFileSync(manifestPath, 'utf8'));
const preflight = spawnSync(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'preflight_scene.mjs'),
  String(port), manifestPath,
], { encoding: 'utf8' });
if (preflight.status !== 0) {
  throw new Error(`发送前门禁未通过：${preflight.stdout || preflight.stderr}`);
}
const gate = JSON.parse(preflight.stdout);
if (!gate.ready) {
  const fails = Object.entries(gate.checks || {})
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .join(',');
  throw new Error(`发送前门禁未通过[${fails}]：${(gate.images||'?')}图/${(gate.promptCharacters||'?')}字`);
}

const marker = manifestPath.replace(/\.json$/i, '.submission.json');
if (existsSync(marker)) throw new Error(`本镜已有提交记录，拒绝重复发送：${marker}`);
closeSync(openSync(marker, 'wx'));
const record = { scene: scene.scene_no, status: 'prepared_to_send', started_at: new Date().toISOString(), gate };
writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(item => item.type === 'page' && item.url.includes('dola.com'));
if (!page?.webSocketDebuggerUrl) throw new Error('Dola page not found');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 60000);
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

try {
  const position = await send('Runtime.evaluate', {
    expression: `(()=>{const e=document.querySelector('[data-testid="chat_input_send_button"]');if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    returnByValue: true,
  });
  const point = position.result?.value;
  if (!point) throw new Error('发送按钮不可用');
  record.status = 'clicking_send';
  writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  record.status = 'sent_waiting_acceptance';
  record.clicked_at = new Date().toISOString();
  writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 5000));
  const observation = await send('Runtime.evaluate', {
    expression: `({href:location.href,text:(document.body?.innerText||'').slice(-3000)})`,
    returnByValue: true,
  });
  record.observation = observation.result?.value || {};
  writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');
  console.log(JSON.stringify({ marker, status: record.status, observation: record.observation }, null, 2));
} catch (error) {
  record.status = record.status === 'clicking_send' ? 'outcome_unknown' : 'failed_before_click';
  record.error = error.message;
  writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');
  throw error;
} finally {
  socket.close();
}
