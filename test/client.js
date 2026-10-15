#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');

const url = process.argv[2];
if (!url) {
  console.error('用法：npm run smoke -- "https://mp.weixin.qq.com/s/文章标识"');
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reader-smoke-'));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（40 秒）`));
    }, 40000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function failPending(error) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
}
child.on('error', failPending);
child.on('exit', () => failPending(new Error('MCP 服务已退出')));
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    const item = pending.get(msg.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error.message));
    else item.resolve(msg.result);
  } catch (error) { failPending(error); }
});

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wechat-reader-smoke', version: '1.0.0' },
  });
  console.log('握手成功：', init.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  if (!list.tools.some((tool) => tool.name === 'fetch_wechat_article')) throw new Error('未发现阅读工具');
  const result = await rpc('tools/call', { name: 'fetch_wechat_article', arguments: { url, save_dir: dir } });
  const data = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(data.error);
  if (!data.text || data.text.length !== data.text_length) throw new Error('直接返回的正文不完整');
  if (JSON.stringify(result.structuredContent) !== JSON.stringify(data)) throw new Error('结构化结果与文本结果不一致');
  if (!data.file || !data.text_file || fs.readFileSync(data.text_file, 'utf8') !== data.text) throw new Error(data.archive_error || '本地归档校验失败');
  if (!fs.readFileSync(data.file, 'utf8').includes('js_content')) throw new Error('HTML 归档缺少正文节点');
  console.log(JSON.stringify({ 标题: data.title, 公众号: data.account, 正文字数: data.text_length,
    HTML: data.file, TXT: data.text_file, 结果: '握手、工具发现、正文直接返回和本地归档均通过' }, null, 2));
})().catch((error) => {
  console.error('验证失败：' + error.message);
  process.exitCode = 1;
}).finally(() => {
  failPending(new Error('测试已结束'));
  child.stdin.end();
  child.kill();
});
