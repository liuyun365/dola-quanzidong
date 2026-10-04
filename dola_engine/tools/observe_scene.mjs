// Read the visible Dola scene outcome without sending anything.
const port = Number(process.argv[2]);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(item => item.type === 'page' && item.url.includes('dola.com'));
if (!page?.webSocketDebuggerUrl) throw new Error('Dola page not found');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
socket.addEventListener('message', event => {
  const response = JSON.parse(event.data);
  if (response.id !== 1) return;
  if (response.error) throw new Error(response.error.message);
  const value = response.result?.result?.value || {};
  console.log(JSON.stringify(value));
  socket.close();
});
socket.send(JSON.stringify({
  id: 1, method: 'Runtime.evaluate',
  params: {
    expression: `({href:location.href,tail:(document.body?.innerText||'').slice(-900),videoCards:document.querySelectorAll('[class*="block-video-"]').length})`,
    returnByValue: true,
  },
}));
