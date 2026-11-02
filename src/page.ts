function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderIndex(origin: string, maxMiB: number, rateLimit: string, tokenRequired: boolean): string {
  const o = escapeHtml(origin);
  const gate = tokenRequired
    ? `<p class="note">目前处于内测阶段：上传需要令牌（<code>Authorization: Bearer &lt;token&gt;</code>），匿名上传暂未开放。</p>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sugi</title>
<style>
body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
pre, code { font-family: ui-monospace, monospace; font-size: 0.9em; background: #f3f3f3; }
pre { padding: 0.75rem; overflow-x: auto; }
.note { padding: 0.5rem 0.75rem; background: #fff6d6; }
</style>
</head>
<body>
<h1>sugi</h1>
<p>水杉输入法项目用来放 PR 截图的匿名图床。</p>
${gate}
<h2>用法</h2>
<pre>curl -F file=@shot.png ${o}/upload</pre>
<p>也可以直接 PUT 文件内容：</p>
<pre>curl -T shot.png ${o}/upload</pre>
<p>返回图片的直链（纯文本）。请求头带 <code>Accept: application/json</code> 时返回 JSON。</p>
<h2>限制</h2>
<ul>
<li>只接受 PNG、JPEG、WebP、GIF，按文件内容判断类型，文件名和 Content-Type 一概不看。</li>
<li>单个文件最大 ${maxMiB} MB。</li>
<li>每个来源 ${escapeHtml(rateLimit)}，超出返回 429。</li>
<li>相同内容总是得到同一个链接，已有的文件不会被覆盖。</li>
</ul>
<h2>请注意</h2>
<p>上传的图片<strong>公开</strong>且<strong>永久</strong>保存，任何拿到链接的人都能看到，上传后无法自行删除。不要上传含个人信息、密钥或令牌的截图。</p>
<h2>滥用举报</h2>
<p>发现违法或侵权内容，请把图片链接发到 <a href="mailto:abuse@sugi.moe">abuse@sugi.moe</a>。</p>
</body>
</html>
`;
}
