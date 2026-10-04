// Isolated CDP browser session for a single Dola account. Reads credentials from
// stdin, so decrypted cookies never need to be written as a browser script file.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extension = path.join(here, 'extension');
const profileRoot = path.join(here, '..', 'state', 'profiles');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function input() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
  return response.json();
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }
  async send(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
  close() { this.socket.close(); }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return new CDP(socket);
}

async function main() {
  const request = await input();
  const account = request.account;
  if (!account?.email || !Array.isArray(account.cookies) || !account.cookies.length) {
    throw new Error('No account cookies supplied');
  }
  if (!existsSync(browserExecutable) || !existsSync(path.join(extension, 'manifest.json'))) {
    throw new Error('CDP browser or copied extension is missing');
  }
  const visible = request.visible === true;
  const name = request.profile_key || account.user_id || account.email.replace(/[^a-z0-9]/gi, '_');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Invalid profile key');
  const profile = path.join(profileRoot, `edge_${visible ? 'visible_' : ''}${name}`);
  if (existsSync(profile) && request.reuse_profile !== true) throw new Error(`Profile already exists: ${profile}`);
  mkdirSync(profile, { recursive: true });
  const port = await freePort();
  const child = spawn(browserExecutable, [
    ...(visible ? [] : ['--headless=new']),
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--proxy-server=${request.proxy}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-first-run', '--no-default-browser-check',
    request.chat_url?.startsWith('https://www.dola.com/chat/')
      ? request.chat_url : 'https://www.dola.com/chat/',
  ], { detached: true, stdio: 'ignore', windowsHide: !visible });
  child.unref();

  let page;
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      page = targets.find(item => item.type === 'page' && item.url.includes('dola.com'));
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(500);
  }
  if (!page?.webSocketDebuggerUrl) throw new Error(`CDP browser did not start on port ${port}`);
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await sleep(3000); // allow this fresh profile to initialize its own device state
    await cdp.send('Network.clearBrowserCookies');
    const cookies = account.cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      ...(cookie.expires ? { expires: cookie.expires } : {}),
    }));
    await cdp.send('Network.setCookies', { cookies });
    if (request.chat_url?.startsWith('https://www.dola.com/chat/')) {
      await cdp.send('Page.navigate', { url: request.chat_url });
    } else {
      await cdp.send('Page.reload', { ignoreCache: true });
    }
    // 轮询等待页面真正就绪（最长约 45s），避免固定 sleep 在代理/并发下不足
    // 导致"窗口没加载完被关闭"或把加载慢误判为"账号掉线/未登录"
    let view = {}, loginState = 'unconfirmed';
    for (let i = 0; i < 45; i++) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `({href:location.href,text:(document.body?.innerText||'').slice(0,3000),editor:!!document.querySelector('[contenteditable="true"]'),panel:!!document.getElementById('watermark-free-media-panel')})`,
        returnByValue: true,
      });
      view = result.result?.value || {};
      const logout = /from_logout/i.test(view.href || '');
      const chatReady = /^https:\/\/www\.dola\.com\/chat\//i.test(view.href || '') && !!view.editor && !logout;
      if (logout) { loginState = 'logged_out'; break; }              // 明确登出 → 真掉线
      if (chatReady) { loginState = 'ok'; break; }                    // 聊天编辑器出现 → 登录成功
      const loginPrompt = /(?:log in|sign in|登录|注册)/i.test(view.text || '');
      if (loginPrompt) { loginState = 'needs_review'; break; }        // 明确登录页/游客态
      await sleep(1000);
    }
    process.stdout.write(JSON.stringify({
      email: account.email, profile, port, pid: child.pid, visible,
      url: view.href, login_state: loginState,
      extension_loaded: Boolean(view.panel),
      page_text_sample: String(view.text || '').slice(0, 250),
    }) + '\n');
  } finally {
    cdp.close();
  }
}

main().catch(error => {
  process.stderr.write(`浏览器验证失败：${error.message}\n`);
  process.exitCode = 1;
});
