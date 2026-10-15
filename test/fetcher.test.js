'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchArticle, validateUrl, extractText, extractTitle, locateContent, repairContent } = require('../lib/fetcher');

const URL = 'https://mp.weixin.qq.com/s/example';
const HTML = `<!doctype html><html><head>
<meta content="测试 &amp; 标题" property="og:title">
<meta property='og:article:author' content='测试公众号'>
<script>const template = '<div id="js_content">假的正文</div>';</script>
</head><body><div id='js_content' style="visibility: hidden; opacity: 0;">
<p>第一段<strong>加粗</strong>，有 &lt;代码&gt;。</p><div><p>第二段<br>换行 😀 &#x1F600;</p></div>
<img data-src="https://example.com/image.png" src="placeholder">
<script>不要返回这段脚本</script><style>.hidden{display:none}</style>
</div><p>正文外的广告</p></body></html>`;
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reader-test-'));
const response = (html = HTML) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('接受微信短链接、长链接和标准 HTTPS 端口', () => {
  for (const url of [URL, 'https://mp.weixin.qq.com/s?__biz=abc&mid=123', 'https://mp.weixin.qq.com:443/s/a']) {
    assert.equal(validateUrl(url).ok, true);
  }
});

test('拒绝伪造域名、用户信息、额外端口、非 HTTPS、非文章页和错误类型', () => {
  for (const url of [null, 1, {}, '', 'abc', 'http://mp.weixin.qq.com/s/a',
    'https://notmp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com.evil.test/s/a',
    'https://sub.mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com./s/a',
    'https://mp.weixin.qq.com@evil.test/s/a', 'https://u:p@mp.weixin.qq.com/s/a',
    'https://mp.weixin.qq.com:8443/s/a', 'https://mp.weixin.qq.com/', 'file:///s/a']) {
    assert.equal(validateUrl(url).ok, false, String(url));
  }
});

test('提取真实正文、段落、实体和元信息，不混入脚本模板及正文外内容', () => {
  assert.equal(extractTitle(HTML), '测试 & 标题');
  const text = extractText(HTML);
  assert.match(text, /第一段加粗，有 <代码>。/);
  assert.match(text, /第二段\n换行 😀 😀/);
  assert.doesNotMatch(text, /假的正文|脚本|广告|display/);
  assert.equal(locateContent('<div data-id="js_content">假</div>'), null);
  assert.equal(locateContent('<div id="js_content"><p>不完整</p>'), null);
});

test('只解码一层实体，异常数字实体不会使读取崩溃', () => {
  assert.equal(extractText('<div id="js_content">&amp;lt; &#99999999;</div>'), '&lt; �');
});

test('修复图片和正文隐藏样式，保留正文外的原始脚本', () => {
  const result = repairContent(HTML);
  assert.equal(result.stats.images_repaired, 1);
  assert.match(result.html, /src="https:\/\/example.com\/image.png"/);
  assert.doesNotMatch(result.html, /src="placeholder"|visibility:\s*hidden|opacity:\s*0/);
  assert.match(result.html, /const template = '<div id="js_content">假的正文<\/div>'/);
  assert.match(result.html, /name="referrer" content="no-referrer"/);
});

test('成功时直接返回完整正文，TXT 与返回正文一致，重复下载不覆盖', async () => {
  const dir = tempDir();
  const options = { fetchImpl: async () => response() };
  const result = await fetchArticle(URL, dir, options);
  assert.equal(result.status, 'success');
  assert.equal(result.url, URL);
  assert.equal(result.account, '测试公众号');
  assert.equal(result.text_length, result.text.length);
  assert.equal(fs.readFileSync(result.text_file, 'utf8'), result.text);
  assert.match(fs.readFileSync(result.file, 'utf8'), /no-referrer/);
  const second = await fetchArticle(URL, dir, options);
  assert.notEqual(second.file, result.file);
  assert.equal(fs.readdirSync(dir).length, 4);
});

test('校验失败不会发起请求或创建保存目录', async () => {
  const dir = path.join(tempDir(), 'not-created');
  const fetchImpl = async () => { throw new Error('不应执行'); };
  assert.equal((await fetchArticle('https://notmp.weixin.qq.com/s/a', dir, { fetchImpl })).status, 'failed');
  assert.equal((await fetchArticle(URL, 'relative', { fetchImpl })).status, 'failed');
  assert.equal(fs.existsSync(dir), false);
});

test('只允许同域文章跳转；跨域、降级协议和非文章跳转在请求前被阻止', async () => {
  for (const destination of ['https://evil.test/', 'http://mp.weixin.qq.com/s/a', '/mp/verify', 'https://notmp.weixin.qq.com/s/a']) {
    let calls = 0;
    const result = await fetchArticle(URL, tempDir(), { fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: destination } });
    } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /已阻止跳转/);
  }
  const calls = [];
  const result = await fetchArticle(URL, tempDir(), { fetchImpl: async (url, options) => {
    calls.push(url.href);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/s/next' } }) : response();
  } });
  assert.equal(result.status, 'success');
  assert.equal(result.final_url, 'https://mp.weixin.qq.com/s/next');
  assert.equal(calls.length, 2);
});

test('限制跳转次数并处理缺少 Location 的响应', async () => {
  for (const headers of [{ location: '/s/loop' }, {}]) {
    let calls = 0;
    const result = await fetchArticle(URL, tempDir(), { fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers });
    } });
    assert.equal(result.status, 'failed');
    assert.ok(calls <= 4);
    assert.match(result.error, /跳转次数|Location/);
  }
});

test('HTTP 错误、网络超时、微信校验、空正文和失效页均明确失败', async () => {
  const cases = [
    [async () => new Response('错误', { status: 403 }), /HTTP 403/],
    [async () => { throw new Error('请求超时'); }, /请求超时/],
    [async () => response('当前环境异常<script>var id="js_content";</script>'), /环境校验/],
    [async () => response('<script>var id="js_content";</script>文章不存在'), /正文节点/],
    [async () => response('<div id="js_content"> <img src="a"> </div>'), /没有可提取的文字/],
    [async () => response('<div id="js_content"><p>缺少结束标签</p>'), /正文节点/],
  ];
  for (const [fetchImpl, message] of cases) {
    const dir = tempDir();
    const result = await fetchArticle(URL, dir, { fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.error, message);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('限制声明大小和实际流大小，防止无限下载', async () => {
  for (const fetchImpl of [
    async () => new Response('tiny', { headers: { 'content-length': '10485761' } }),
    async () => new Response(new Uint8Array(10485761)),
  ]) {
    const result = await fetchArticle(URL, tempDir(), { fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /10 MiB/);
  }
});

test('保存目录不可写时仍直接返回正文，并说明归档失败', async () => {
  const file = path.join(tempDir(), 'file');
  fs.writeFileSync(file, '占位文件');
  const result = await fetchArticle(URL, file, { fetchImpl: async () => response() });
  assert.equal(result.status, 'success');
  assert.match(result.text, /第一段/);
  assert.equal(result.file, null);
  assert.equal(result.saved_at, null);
  assert.match(result.archive_error, /保存失败/);
});


test('图片支持单引号属性，修复后仍正确转义 URL', () => {
  const result = repairContent(`<head></head><div id='js_content'><img src='old' data-src='https://example.com/i?a=1&amp;b=2'><p>正文</p></div>`);
  assert.equal(result.stats.images_repaired, 1);
  assert.match(result.html, /src="https:\/\/example.com\/i\?a=1&amp;b=2"/);
  assert.doesNotMatch(result.html, /src='old'|data-src/);
});
