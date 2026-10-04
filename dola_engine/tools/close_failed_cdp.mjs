// Close a CDP browser only after a visible platform rejection for its scene.
const port = Number(process.argv[2]);
const chatUrl = process.argv[3];
const kind = process.argv[4];
const phrase = kind === 'face' ? '未认证人脸暂不支持' :
  kind === 'copyright' ? '生成的视频可能涉及版权限制' :
  kind === 'copyright_audio' ? '生成的音频可能涉及版权限制' :
  kind === 'generation_failed' ? '视频生成失败，生成额度未扣除' :
  kind === 'service' ? '出了点问题，请稍后重试' : null;
if (!Number.isInteger(port) || !chatUrl || !phrase) {
  throw new Error('Usage: node close_failed_cdp.mjs <port> <chat-url> face|copyright|copyright_audio|generation_failed|service');
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(x => x.type === 'page' && x.url === chatUrl);
if (!page?.webSocketDebuggerUrl) throw new Error('Expected chat not open');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
const state = await new Promise((resolve, reject) => {
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    message.error ? reject(new Error(message.error.message)) : resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression: `({text:document.body?.innerText||'',videoCards:document.querySelectorAll('[class*="block-video-"]').length})`,
      returnByValue: true } }));
});
socket.close();
if (!state.text.includes(phrase) || state.videoCards) throw new Error('Platform rejection not verified');
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => browser.addEventListener('open', resolve, { once: true }));
browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
await new Promise(resolve => setTimeout(resolve, 300));
browser.close();
console.log(JSON.stringify({ status: 'closed_after_rejection', port, kind }));
