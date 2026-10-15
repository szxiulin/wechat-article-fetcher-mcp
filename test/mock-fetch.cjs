// 仅由协议测试通过 node --require 加载，不参与实际启动。
'use strict';
globalThis.fetch = async () => new Response('<html><head><meta property="og:title" content="协议测试"></head><body><div id="js_content"><p>第一段正文。</p><p>第二段正文。</p></div></body></html>');
