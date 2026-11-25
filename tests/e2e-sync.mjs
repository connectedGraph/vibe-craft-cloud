/**
 * 端到端同步验证：真实 Chrome + 本地同步服务端（账号版）
 *
 * 前置：
 *   ADMIM_PASSWORD=testpass123 SYNC_TOKEN=test-token-123 node server/server.mjs (8792)
 *   chrome --headless=new --remote-debugging-port=9223
 *
 * 页面用 Bearer（SYNC_TOKEN）注入身份，绕过登录页；同步接口最终落在 admin 名下。
 */
import { writeFileSync } from 'node:fs';

const CDP = process.env.CDP_PORT || 9223;
const SERVER = process.env.SYNC_SERVER || 'http://127.0.0.1:8792';
const TOKEN = process.env.SYNC_TOKEN || 'test-token-123';
const APP = 'prompt-capsule';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

async function api(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('prompt-capsule')) || targets.find(t => t.type === 'page');
if (!page) throw new Error('未找到 prompt-capsule 页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let idSeq = 0;
const pending = new Map();
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  return new Promise(resolve => {
    const id = ++idSeq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function screenshot(path) {
  await send('Page.enable');
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  console.log('  screenshot ->', path);
}

// 用 Bearer 注入身份，绕过登录页（账号体系本身由 auth-e2e 单独验证）
await send('Network.enable');
await send('Network.setExtraHTTPHeaders', { headers: { Authorization: 'Bearer ' + TOKEN } });
const currentUrl = await evaluate('location.href');
if (!currentUrl.startsWith(SERVER)) {
  await send('Page.navigate', { url: SERVER + '/prompt-capsule/index.html' });
  await sleep(2500);
}

console.log('1) 页面加载');
for (let i = 0; i < 40; i++) {
  if (await evaluate('document.readyState') === 'complete') break;
  await sleep(250);
}
// 每次从干净状态开始
await evaluate('localStorage.clear(); location.reload(); true', false);
await sleep(1500);
for (let i = 0; i < 40; i++) {
  if (await evaluate('document.readyState') === 'complete') break;
  await sleep(250);
}
assert(await evaluate('typeof VibeSync === "object"'), 'VibeSync 已加载');
assert(await evaluate('typeof appState === "object" && Array.isArray(appState.docs)'), 'appState 已初始化');

const localCount = await evaluate('appState.docs.length');
const localIds = await evaluate('JSON.stringify(appState.docs.map(d => d.id))');
console.log('  本地文档数:', localCount);

console.log('2) 配置并首次同步');
await evaluate(`(async () => {
  VibeSync.configure({ server: ${JSON.stringify(SERVER)}, token: ${JSON.stringify(TOKEN)}, enabled: true });
  await VibeSync.syncNow();
  return true;
})()`);
const st1 = await evaluate('JSON.stringify(VibeSync.getStatus())');
console.log('  status:', st1);
const state1 = await api('GET', `/api/v1/sync/state?app=${APP}`);
assert(state1.count >= localCount, `服务端已收到本地文档（count=${state1.count}）`);

const pullInitial = await api('GET', `/api/v1/sync/pull?app=${APP}&since=0&limit=1000`);
const serverIds = new Set((pullInitial.changes || []).map(c => c.id));
for (const id of JSON.parse(localIds)) {
  assert(serverIds.has(id), `本地文档 ${id.slice(0, 8)}… 已上传`);
}

console.log('3) 模拟另一台设备写入');
const remoteId = 'remote-' + Date.now().toString(36);
const now = Date.now();
await api('POST', '/api/v1/sync/push', {
  app: APP,
  deviceId: 'dev_other',
  ops: [{
    collection: 'docs',
    id: remoteId,
    op: 'upsert',
    data: {
      id: remoteId,
      title: '来自另一台设备的文档',
      category: 'General',
      tags: ['remote'],
      question: '这是远端写入的测试文档。',
      answer: '同步成功后应该出现在左侧列表。',
      annotations: [],
      updatedAt: now,
    },
    updatedAt: now,
  }],
});

console.log('4) 拉取远端变更');
await evaluate('(async () => { await VibeSync.syncNow(); return true; })()');
await sleep(300);
const hasRemote = await evaluate(`appState.docs.some(d => d.id === ${JSON.stringify(remoteId)})`);
assert(hasRemote, '远端文档已合并到本地 appState');
const inDom = await evaluate(`document.body.innerText.includes('来自另一台设备的文档')`);
assert(inDom, '远端文档已渲染到页面');

console.log('5) 本地新建文档 → 推送');
const newTitle = '本地新建-' + Date.now().toString(36);
await evaluate(`(async () => {
  window.createNewDoc();
  const doc = appState.docs.find(d => d.id === appState.activeDocId);
  doc.title = ${JSON.stringify(newTitle)};
  doc.question = '本地生成的测试内容';
  doc.updatedAt = Date.now();
  window.persistState();
  window.renderDocList();
  await VibeSync.syncNow();
  return true;
})()`);
await sleep(300);
const pullAll = await api('GET', `/api/v1/sync/pull?app=${APP}&since=0&limit=1000`);
const pushed = (pullAll.changes || []).some(c => c.data && c.data.title === newTitle);
assert(pushed, '本地新文档已推送到服务端');

console.log('6) 状态与冲突检查');
const conflicts = await api('GET', `/api/v1/sync/state?app=${APP}`);
console.log('  服务端记录数:', conflicts.count);
const status = JSON.parse(await evaluate('JSON.stringify(VibeSync.getStatus())'));
assert(status.phase !== 'error', '同步状态无错误');

console.log('7) 冲突：本地与服务端同时修改同一文档');
const targetId = await evaluate('appState.docs[0].id');
// 先让页面本地改一版
await evaluate(`(() => {
  const doc = appState.docs.find(d => d.id === ${JSON.stringify(targetId)});
  doc.title = '本地版本';
  doc.updatedAt = Date.now();
  window.persistState();
  return true;
})()`);
// 服务端写入一个更新更晚的版本，模拟另一台设备
const futureTs = Date.now() + 5000;
await api('POST', '/api/v1/sync/push', {
  app: APP,
  deviceId: 'dev_other',
  ops: [{
    collection: 'docs',
    id: targetId,
    op: 'upsert',
    data: { id: targetId, title: '远端版本', category: 'General', tags: [], question: 'q', answer: 'a', annotations: [], updatedAt: futureTs },
    updatedAt: futureTs,
  }],
});
await evaluate('(async () => { await VibeSync.syncNow(); return true; })()');
await sleep(500);
const titles = await evaluate('JSON.stringify(appState.docs.map(d => d.title))');
console.log('  当前标题:', titles);
assert(JSON.parse(titles).includes('远端版本'), '冲突时采用服务端版本');
assert(JSON.parse(titles).some(t => t.includes('冲突副本')), '本地版本另存为冲突副本');

await screenshot('/tmp/vc-sync-result.png');

console.log('\n全部通过');
ws.close();
