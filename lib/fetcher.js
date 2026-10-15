'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WECHAT_HOST = 'mp.weixin.qq.com';
const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 只接受微信文章地址；每一次 HTTP 跳转都重新校验。 */
function validateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'url 必须是非空字符串' };
  }
  let url;
  try { url = new URL(rawUrl.trim()); }
  catch { return { ok: false, reason: 'URL 格式非法' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: '仅支持 HTTPS 链接' };
  if (url.hostname !== WECHAT_HOST) return { ok: false, reason: '仅支持 mp.weixin.qq.com 域名' };
  if (url.username || url.password || url.port) return { ok: false, reason: '链接不能包含用户名、密码或非标准端口' };
  if (url.pathname !== '/s' && !url.pathname.startsWith('/s/')) {
    return { ok: false, reason: '仅支持微信公众号 /s 文章链接' };
  }
  url.hash = '';
  return { ok: true, url };
}

function decodeCodePoint(value) {
  return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : '\uFFFD';
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('\\s' + escaped + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3]) : null;
}

// 屏蔽脚本、样式和注释，保留字符串下标，避免把脚本中的模板误当成正文。
function maskNonContent(html) {
  return html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (value) => ' '.repeat(value.length));
}

/** 解码常见 HTML 实体 + 数字实体 */
function decodeEntities(s) {
  const named = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&ensp;': ' ',
    '&emsp;': ' ', '&mdash;': '—', '&ldquo;': '“', '&rdquo;': '”',
  };
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|ensp|emsp|mdash|ldquo|rdquo);/g, (m) => named[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => decodeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => decodeCodePoint(parseInt(d, 10)));
}

/**
 * 定位 js_content 正文 div 的字符串区间（含开标签，至配平的 </div> 结束）
 * @returns {{start:number, end:number, openTag:string} | null}
 */
function locateContent(html) {
  const source = maskNonContent(html);
  const tags = /<\/?div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let tag, start = -1, depth = 0, openTag;
  while ((tag = tags.exec(source)) !== null) {
    const closing = /^<\//.test(tag[0]);
    if (start < 0) {
      if (closing || attribute(tag[0], 'id') !== 'js_content') continue;
      start = tag.index;
      openTag = html.slice(start, tags.lastIndex);
      depth = 1;
    } else {
      depth += closing ? -1 : 1;
      if (depth === 0) return { start, end: tags.lastIndex, openTag };
    }
  }
  return null;
}

function extractContentHtml(html) {
  const loc = locateContent(html);
  return loc ? html.slice(loc.start, loc.end) : null;
}

/**
 * 正文资源修复（v0.2.0 核心）
 * 只在 js_content 区间内做标记级改写，不触碰页面 JS。
 */
function repairContent(html) {
  const loc = locateContent(html);
  const stats = { images_repaired: 0, videos_repaired: 0, media_cards_fallback: 0 };
  if (!loc) return { html, stats };

  let frag = html.slice(loc.start, loc.end);

  // 1) img / iframe 懒加载还原：删除占位 src，将 data-src 提升为 src
  frag = frag.replace(/<(img|iframe)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const source = attribute(tag, 'data-src');
    if (!source) return tag;
    const escaped = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let fixed = tag.replace(/\s(?:src|data-src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    fixed = fixed.replace(/\s*\/?>$/, (end) => ` src="${escaped}"` + end);
    if (/^<img/i.test(tag)) stats.images_repaired += 1;
    else stats.videos_repaired += 1;
    return fixed;
  });

  // 2) 让正文可见：去掉隐藏样式（WeChat 默认用 JS 显示正文，离线文件没有这一步）
  frag = frag.replace(/visibility:\s*hidden\s*;\s*(opacity:\s*0\s*;?)?/gi, '');
  frag = frag.replace(/opacity:\s*0\s*;\s*visibility:\s*hidden\s*;?/gi, '');

  // 3) 视频号/语音卡片降级：非微信环境自定义元素不渲染，注入可点击的降级卡片
  if (/<mpvideosnap|<mpvoice/i.test(frag)) {
    stats.media_cards_fallback =
      (frag.match(/<mpvideosnap/gi) || []).length + (frag.match(/<mpvoice/gi) || []).length;
    frag += `
<script>
(function () {
  function buildCards() {
    document.querySelectorAll('mpvideosnap, mpvoice').forEach(function (el) {
      if (el.dataset.repairCard) return;
      el.dataset.repairCard = '1';
      var d = el.getAttribute('data-desc') || el.getAttribute('data-title') || '媒体卡片';
      var url = el.getAttribute('data-url') || '';
      var box = document.createElement('div');
      box.style.cssText = 'border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin:8px 0;background:#f7f7f7;font-size:14px;line-height:1.6;';
      box.innerHTML = '▶ <b></b>' + (url ? '　<a target="_blank" rel="noopener">在浏览器打开媒体源</a>' : '') +
        '<br><small style="color:#999">（视频/音频卡片需在微信客户端打开原文查看）</small>';
      box.querySelector('b').textContent = d;
      var a = box.querySelector('a');
      if (a && url) a.href = url; else if (a) a.remove();
      el.parentNode && el.parentNode.insertBefore(box, el);
    });
  }
  document.addEventListener('DOMContentLoaded', buildCards);
  setTimeout(buildCards, 1500); // 兜底：自定义元素升级失败也能补上
})();
</script>`;
  }

  let out = html.slice(0, loc.start) + frag + html.slice(loc.end);

  // 4) 全局注入 no-referrer：防止浏览器向 mmbiz.qpic.cn 发 Referer 触发防盗链
  out = out.replace(/<head\b[^>]*>/i, (h) => h + '<meta name="referrer" content="no-referrer">');

  return { html: out, stats };
}

/** 提取可直接交给模型的正文，保留段落和链接文字。 */
function extractText(html) {
  const frag = extractContentHtml(html);
  if (!frag) return null;
  return decodeEntities(frag
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(mpvoice|mpvideosnap)\b[^>]*>/gi, '[媒体卡片，需打开原文查看]')
    .replace(/<br\s*\/?>|<\/(?:p|div|section|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaValue(html, property) {
  for (const match of maskNonContent(html).matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (attribute(match[0], 'property') === property) return attribute(match[0], 'content');
  }
  return null;
}

function elementText(html, id) {
  const source = maskNonContent(html);
  const re = /<([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let match;
  while ((match = re.exec(source))) {
    if (attribute(match[0], 'id') !== id) continue;
    const end = source.indexOf('</' + match[1], re.lastIndex);
    if (end < 0) return null;
    return decodeEntities(html.slice(re.lastIndex, end).replace(/<[^>]+>/g, '')).trim();
  }
  return null;
}

function extractTitle(html) {
  return (metaValue(html, 'og:title') || elementText(html, 'activity-name') || '').replace(/\s+/g, ' ').trim() || null;
}

function extractAccount(html) {
  return (metaValue(html, 'og:article:author') || elementText(html, 'js_name') || '').trim() || null;
}

/** 文件名安全化 */
function safeName(title, url) {
  const hash = crypto.createHash('sha1').update(String(url.href || url)).digest('hex').slice(0, 8);
  const base = (title || 'wechat_article')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '') + '_' + crypto.randomBytes(3).toString('hex');
  return `${ts}_${base}_${hash}.html`;
}

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

async function download(url, fetchImpl) {
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; ; redirects += 1) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual', signal,
    });
    if (REDIRECT_CODES.has(res.status)) {
      await res.body?.cancel();
      if (redirects >= 3) throw new Error('跳转次数超过 3 次');
      const location = res.headers.get('location');
      if (!location) throw new Error('跳转响应缺少 Location');
      const next = validateUrl(new URL(location, url).href);
      if (!next.ok) throw new Error('已阻止跳转：' + next.reason);
      url = next.url;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}`, http_status: res.status };
    }
    if (Number(res.headers.get('content-length')) > MAX_HTML_BYTES) {
      await res.body?.cancel();
      throw new Error('网页超过 10 MiB 上限');
    }
    const chunks = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > MAX_HTML_BYTES) throw new Error('网页超过 10 MiB 上限');
        chunks.push(Buffer.from(chunk));
      }
    }
    return { html: Buffer.concat(chunks).toString('utf8'), final_url: url.href };
  }
}

/** 第三个参数仅供本地测试注入 HTTP 实现，不对 MCP 调用方开放。 */
async function fetchArticle(rawUrl, saveDir, { fetchImpl = fetch } = {}) {
  const v = validateUrl(rawUrl);
  if (!v.ok) return { status: 'failed', error: v.reason };
  if (typeof saveDir !== 'string' || !path.isAbsolute(saveDir)) {
    return { status: 'failed', error: 'save_dir 必须是绝对路径' };
  }
  let downloaded;
  try { downloaded = await download(v.url, fetchImpl); }
  catch (e) { return { status: 'failed', error: '下载失败：' + e.message, url: v.url.href }; }
  if (downloaded.error) return { status: 'failed', url: v.url.href, ...downloaded };
  const { html, final_url } = downloaded;
  if (!locateContent(html)) {
    const verify = /环境异常|环境校验|操作频繁|访问过于频繁/.test(html);
    return { status: 'failed', url: v.url.href, error: verify
      ? '命中微信环境校验页，请稍后重试或在微信中打开原文'
      : '未找到完整的正文节点，文章可能失效、需要登录或页面结构不受支持' };
  }
  const text = extractText(html);
  if (!text) return { status: 'failed', url: v.url.href, error: '正文没有可提取的文字；纯图片文章暂不支持文字识别' };
  const title = extractTitle(html) || '(未提取到标题)';
  const account = extractAccount(html) || '(未提取到公众号名)';
  const repaired = repairContent(html);
  const body = Buffer.from(repaired.html, 'utf8');
  const file = path.join(saveDir, safeName(title, v.url));
  const textFile = file.replace(/\.html$/, '.txt');
  try {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(file, body, { flag: 'wx' });
    fs.writeFileSync(textFile, text, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    // 正文已获取时，归档失败仍允许调用方直接阅读。
    return { status: 'success', url: v.url.href, final_url, title, account, text,
      text_length: text.length, file: null, text_file: null,
      archive_error: '本地保存失败：' + e.message, saved_at: null };
  }
  return {
    status: 'success', url: v.url.href, final_url, title, account, text,
    file, text_file: textFile, html_bytes: body.length, text_length: text.length,
    has_content_node: true, ...repaired.stats, saved_at: new Date().toISOString(),
  };
}

module.exports = {
  fetchArticle, validateUrl, extractText, extractTitle, extractContentHtml,
  locateContent, repairContent,
};
