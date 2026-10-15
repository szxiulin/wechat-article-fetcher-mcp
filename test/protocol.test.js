'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

test('stdio 完整链路：握手、工具发现、直接正文、归档、参数错误及异常消息恢复', { timeout: 10000 }, async (t) => {
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.cjs'), path.join(root, 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  let id = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    assert.ok(resolve, 'stdout 只含预期的 JSON-RPC 响应');
    pending.delete(msg.id);
    resolve(msg);
  });
  function send(method, params) {
    const requestId = ++id;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  }
  const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await send('tools/list')).result.tools[0].name, 'fetch_wechat_article');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-protocol-test-'));
  const call = await send('tools/call', { name: 'fetch_wechat_article', arguments: { url: 'https://mp.weixin.qq.com/s/test', save_dir: dir } });
  assert.equal(call.result.isError, false);
  const article = JSON.parse(call.result.content[0].text);
  assert.deepEqual(call.result.structuredContent, article);
  assert.equal(article.text, '第一段正文。\n第二段正文。');
  assert.equal(fs.readFileSync(article.text_file, 'utf8'), article.text);
  for (const args of [{}, { url: 12 }, { url: 'x', save_dir: '../relative' }, { url: 'x', extra: true }]) {
    assert.equal((await send('tools/call', { name: 'fetch_wechat_article', arguments: args })).result.isError, true);
  }
  const bad = await send('tools/call', { name: 'fetch_wechat_article', arguments: { url: 'https://notmp.weixin.qq.com/s/test' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.structuredContent.error, /域名/);
  assert.equal((await send('unknown')).error.code, -32601);
  assert.equal((await send('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await send('initialize', { protocolVersion: 'made-up' })).result.protocolVersion, '2025-11-25');
  for (const [line, code] of [['{broken', -32700], ['null', -32600], ['[]', -32600]]) {
    const message = new Promise((resolve) => pending.set(null, resolve));
    child.stdin.write(line + '\n');
    assert.equal((await message).error.code, code);
  }
  assert.deepEqual((await send('ping')).result, {});
  assert.equal(stderr, '');
  child.stdin.end();
});
