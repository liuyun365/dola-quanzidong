// Return the current MP4 URL from one verified completed Dola conversation.
const port = Number(process.argv[2]);
const expectedChat = process.argv[3];
if (!Number.isInteger(port) || !/^https:\/\/www\.dola\.com\/chat\/\d+$/.test(expectedChat)) throw new Error('Invalid args');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(x => x.type === 'page' && x.url === expectedChat);
if (!page) throw new Error('Expected conversation not open');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id;
  const listener = event => {const m=JSON.parse(event.data);if(m.id!==current)return;socket.removeEventListener('message',listener);m.error?reject(new Error(m.error.message)):resolve(m.result)};
  socket.addEventListener('message',listener);
  socket.send(JSON.stringify({id:current,method,params}));
});
const evaluate = async expression => (await send('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
try {
  const state = await evaluate(`({href:location.href,done:(document.body?.innerText||'').includes('你的视频生成好了'),cards:document.querySelectorAll('[class*="block-video-"]').length})`);
  if (state.href !== expectedChat || !state.done || state.cards !== 1) throw new Error('Completed scene not uniquely verified');
  await evaluate(`document.querySelector('[class*="block-video-"]')?.scrollIntoView({block:'center'})`);
  const rect = await evaluate(`document.querySelector('[class*="block-video-"]')?.getBoundingClientRect().toJSON()`);
  if (!rect) throw new Error('Video card missing');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.width/2,y:rect.y+rect.height/2});
  let videos = [];
  for (let i=0;i<30;i++) {
    videos = await evaluate(`[...document.querySelectorAll('video')].map(v=>v.currentSrc||v.src).filter(Boolean)`);
    if (videos?.length) break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if (videos?.length !== 1) throw new Error(`Expected one playable video, found ${videos?.length||0}`);
  const url = new URL(videos[0]);
  if (!url.hostname.endsWith('.dola.com') || url.searchParams.get('mime_type') !== 'video_mp4') throw new Error('Media URL is not a Dola MP4');
  console.log(JSON.stringify({chat_url:expectedChat,media_url:url.href}));
} finally {socket.close()}
