// Close only the CDP browser for a verified downloaded scene.
import { existsSync, readFileSync, statSync } from 'node:fs';

const port = Number(process.argv[2]);
const expectedChat = process.argv[3];
const videoFile = process.argv[4];
if (!Number.isInteger(port) || !expectedChat || !videoFile) {
  throw new Error('Usage: node close_scene_cdp.mjs <port> <chat-url> <video.mp4>');
}
if (!existsSync(videoFile) || statSync(videoFile).size < 1024 * 1024 ||
    readFileSync(videoFile).toString('ascii', 4, 8) !== 'ftyp') {
  throw new Error('Verified MP4 is missing');
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// chat_url 记录为通用前缀（https://www.dola.com/chat/），实际窗口 URL 带具体对话 ID，故用前缀匹配。
if (!targets.some(t => t.type === 'page' && t.url.startsWith(expectedChat))) {
  throw new Error('CDP browser is not on the expected conversation');
}
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
await new Promise(resolve => setTimeout(resolve, 300));
socket.close();
console.log(JSON.stringify({ status: 'closed', port }));
