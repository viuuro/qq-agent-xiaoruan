// 先运行 npm install --prefix app；使用隔离源码副本和本地模拟 OneBot，无需真实 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const sourceApp = fileURLToPath(new URL('../app/', import.meta.url));
const { WebSocketServer } = createRequire(path.join(sourceApp, 'package.json'))('ws');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-headless-smoke-'));
const isolatedApp = path.join(tempRoot, 'app');
const dataDir = path.join(tempRoot, 'data');
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const mock = http.createServer((req, res) => {
  const data = req.url === '/get_login_info'
    ? { user_id: 10001, nickname: 'smoke-test' } : [];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
});
const websocket = new WebSocketServer({ server: mock });
let app;
let passed = false;
const deadline = setTimeout(() => {
  console.error('[FAIL] headless smoke timed out');
  process.exit(1);
}, 30000);
deadline.unref();

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

try {
  await fs.mkdir(isolatedApp);
  for (const name of ['src', 'ui', 'assets', 'package.json']) {
    await fs.cp(path.join(sourceApp, name), path.join(isolatedApp, name), { recursive: true });
  }
  await fs.symlink(path.join(sourceApp, 'node_modules'), path.join(isolatedApp, 'node_modules'), 'dir');
  await fs.mkdir(dataDir);
  const mockPort = await listen(mock);
  const probe = http.createServer();
  const consolePort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    server: { port: consolePort, token: 'local-smoke-token' },
    extensions: { hotReload: false },
    snowluma: {
      autoLaunch: false, dir: path.join(tempRoot, 'snowluma'),
      wsUrl: `ws://127.0.0.1:${mockPort}`, httpUrl: `http://127.0.0.1:${mockPort}`,
      accessToken: '', httpAccessToken: ''
    },
    proactive: { enabled: false },
    memberNotes: { '10001': 'remove', '10002': 'keep' }
  }));
  process.env.QQ_AGENT_DATA_DIR = dataDir;
  process.env.QQ_AGENT_BIND_HOST = '127.0.0.1';
  delete process.env.QQ_AGENT_DEV;
  delete process.env.QQ_AGENT_PROFILE;
  delete process.env.QQ_AGENT_COMMUNITY_KEY;
  const allowedOrigins = new Set([`http://127.0.0.1:${mockPort}`]);
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!allowedOrigins.has(url.origin)) return Promise.reject(new Error('smoke: external fetch blocked'));
    return originalFetch(input, options);
  };
  const { createApp } = await import(pathToFileURL(path.join(isolatedApp, 'src/app.js')));
  app = createApp();
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  allowedOrigins.add(base);
  for (let i = 0; i < 100 && !app.onebot.selfInfo; i++) await delay(20);
  assert.equal(app.onebot.connected, true);
  assert.equal(String(app.onebot.selfInfo?.user_id), '10001');
  const headers = { 'x-console-token': 'local-smoke-token', origin: base };
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const statusResponse = await fetch(`${base}/api/status`, { headers });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.onebot.connected, true);
  assert.equal(status.dataDir, dataDir);
  const skillsResponse = await fetch(`${base}/api/skills`, { headers });
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json();
  assert.equal(skills.summary.broken, 0);
  const home = await fetch(`${base}/`, { headers });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<html/i);
  const saved = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ memberNotes: { __replace__: { '10002': 'keep' } } })
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).config.memberNotes, { '10002': 'keep' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')).memberNotes,
    { '10002': 'keep' });
  passed = true;
} finally {
  await app?.stop();
  for (const client of websocket.clients) client.terminate();
  await new Promise((resolve) => websocket.close(resolve));
  await new Promise((resolve) => mock.close(resolve));
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
  await fs.rm(tempRoot, { recursive: true, force: true });
  clearTimeout(deadline);
}
if (passed) {
  console.log('[OK] headless smoke: mock OneBot, HTTP, auth, skills, member-note deletion and shutdown');
  // 应用的后台遥测/价格定时器属于进程级资源；所有服务与临时目录已清理。
  process.exit(0);
}
