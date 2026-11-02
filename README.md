# sugi

通用的匿名公共图床：免注册，上传图片和短视频拿到直链。一个 Cloudflare Worker，加一个 R2 bucket 存文件、一个 D1 数据库存打包链接，没有账号体系。

- 线上地址：<https://sugi.moe>；直链在 <https://files.sugi.moe>（永久）和 <https://tmp.sugi.moe>（临时），旧链接 `https://sugi.moe/<16 位十六进制>.<ext>` 永久有效
- Cloudflare 账户：Evan@yldm.tech's Account（`e2b27aea5f599efdbe0a7016a2580d05`）；Worker `sugi`；R2 bucket `sugi`（自定义域 `r2.sugi.moe`，作为走缓存的回源地址）；D1 数据库 `sugi`（`61f7d685-83be-4cad-9a56-b6ce9887affb`）；zone `sugi.moe`
- 当前状态：生产环境已开放匿名上传（2026-11-02 起没有设置 `UPLOAD_TOKEN`，workers.dev 入口已关闭）。本 README 描述的新版网站和接口还没部署，见文末“上线步骤”

## 用法

### 网页

打开 <https://sugi.moe>，把图片或视频拖进上传框、点击选择文件（可多选），或者直接 Ctrl+V / ⌘V 粘贴。上传前可以选保存时间（永久、1 小时、12 小时、3 天），以及「传完自动复制」「抹掉照片位置信息」「可爱链接名」「传完啾一声」。也可以贴一个图片链接让服务器去搬（「搬过来」）。每个文件上传后显示缩略图和直链，可以复制成直链、Markdown、HTML、BBCode，多个文件可以打包成一个分享链接。

「我的文件」页列出这个浏览器上传过的文件和打包链接（存在 localStorage，连同删除凭证），可以搜索、筛选、多选打包、删除、导出和导入记录。每个文件有自己的分享页 `https://sugi.moe/f/<id>`（预览、各种格式的链接、二维码），打包链接是 `https://sugi.moe/a/<id>`。

页面按 `Accept-Language` 显示中文或英文（默认英文），右上角可以切换（`?lang=zh` / `?lang=en`，会记在 cookie 里）。月亮按钮切换白天和夜间配色，默认 22:00 到 06:00 是夜间。

### HTTP API

```sh
curl -F "file=@cat.png" https://sugi.moe/api/upload                   # 永久，返回直链
curl -F "file=@cat.png" -F "expire=1h" https://sugi.moe/api/upload    # 临时：1h / 12h / 72h
curl -F "url=https://example.com/a.png" https://sugi.moe/api/upload   # 从链接搬运
curl -T cat.png "https://sugi.moe/api/upload?expire=12h&style=cute"   # PUT 原始文件，选项放查询参数
curl -H 'Accept: application/json' -F "file=@cat.png" https://sugi.moe/api/upload
curl -X DELETE -H "Sugi-Token: d_…" https://sugi.moe/api/files/<id>
```

JSON 返回 `{"id", "url", "page", "size", "type", "name", "expires_at", "delete_token"}`，新上传返回 201。完整接口表和限流说明在 <https://sugi.moe/dev>，那一页的内容就是本节的权威版本，下面只列要点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | multipart：`file` 或 `url`，可选 `expire`、`style`（`random`/`cute`）、`name`；单个请求最多 90 MB |
| PUT | `/api/upload` | 原始请求体，选项在查询参数里；必须带 Content-Length |
| POST | `/api/uploads?size=<总字节>` | 分片上传的第一片（5 到 90 MB），返回 `upload` 会话、`part_size`、`parts`、`id`、`etag` |
| PUT | `/api/uploads/<n>` | 第 n 片，请求头 `Sugi-Upload: <会话>`，返回 `etag` |
| POST | `/api/uploads/complete` | 请求头带会话，JSON `{"etags": [...]}`，返回和 `/api/upload` 一样；`DELETE /api/uploads` 放弃 |
| GET | `/api/files/<id>` | 公开信息（链接、大小、类型、过期时间） |
| DELETE | `/api/files/<id>` | `Sugi-Token: <delete_token>`；管理员令牌删除等于下架（见运维手册「处理举报」），可加 `?reason=` 和 `?block_content=1` |
| POST | `/api/albums` | JSON `{"files": [...], "title": "..."}` 或表单 `files=id1,id2&title=`，最多 100 个，返回链接和 `delete_token` |
| GET / DELETE | `/api/albums/<id>` | 读取；删除（`Sugi-Token`，不删里面的文件） |
| POST / PUT | `/upload` | 旧接口，原样保留：只收 PNG/JPEG/WebP/GIF，最大 20 MB，内容哈希做键，返回 `https://sugi.moe/<hash>.<ext>` |
| GET / HEAD / DELETE | `/<hash>.<ext>` | 旧链接；DELETE 需管理员令牌，同样是下架 |
| GET | `/admin/info/<key>` | 管理员：对象元数据（`<hash>.<ext>`、`f/<id>`、`t/<id>`） |
| POST | `/admin/purge-by-source` | 管理员：按来源 HMAC 下架文件和打包链接（和 MCP 的 `takedown_by_source` 一样） |

错误默认是纯文本，`Accept: application/json` 时是 `{"error": "..."}`。常见状态码：400 参数不对，401 缺令牌或闸门未开放，403 删除凭证不对，404 不存在（过期的临时文件也算），405 方法不对，411 缺 Content-Length，413 太大（单请求超过 90 MB 会提示改用分片），415 类型不支持，429 超过频率限制，502 搬运的远端出错或缓存清除失败，503 未配置 `IP_HASH_SECRET`。

生产环境不需要令牌。`UPLOAD_TOKEN` 是可选的上传闸门：设置后所有上传都要带 `Authorization: Bearer <UPLOAD_TOKEN>`（现在只在本地 `.dev.vars` 里用来测闸门）。维护者和代为上传的 agent 用 `TRUSTED_TOKEN`，它能过闸门且不受任何频率限制。

### 命令行 sugi 和 MCP（`FEATURE_CLI=1` 时开放）

```sh
curl -fsSL https://sugi.moe/install.sh | sh     # 装到 ~/.local/bin/sugi，校验 SHA-256
sugi up cat.png dog.gif                         # 每个文件一行链接，自动复制到剪贴板
sugi up -e 1h --cute secret.jpg                 # 临时、可爱链接名
sugi up --clipboard                             # 剪贴板里的截图（macOS osascript，Linux wl-paste/xclip）
cat cat.png | sugi up - --name cat.png          # 从管道读
sugi album "猫猫合集" *.png                     # 上传并打包；参数也可以是已有的 id 或链接
sugi ls / sugi rm <id>                          # 删除凭证在 ~/.config/sugi/history.jsonl
```

`sugi` 是一个只依赖 bash 和 curl 的脚本（`public/static/cli/sugi`，macOS 自带的 bash 3.2 也能跑），超过 90 MB 自动分片。令牌依次取 `SUGI_TOKEN`、`sugi login` 保存的令牌、`~/.config/sugi/secrets.env` 里的 `TRUSTED_TOKEN`（维护者用）；令牌通过权限 600 的临时 curl 配置文件传给 curl，不出现在进程列表里。`/install.sh` 由 Worker 生成，里面写死了构建时算出的 CLI SHA-256。

MCP 服务在 `https://sugi.moe/mcp`（Streamable HTTP，无状态，用官方 `@modelcontextprotocol/sdk`），工具有 `upload_file`（base64，最大 20 MB）、`upload_url`、`create_album`、`get_file`、`delete_file`（需要上传时返回的 `delete_token`）。上传类工具和 HTTP API 走同一套闸门和限流，用请求自己的 `Authorization` 头。接入：`claude mcp add --transport http sugi https://sugi.moe/mcp`；Claude Desktop 通过 `npx -y mcp-remote https://sugi.moe/mcp`；Cursor 在 `~/.cursor/mcp.json` 里写 `{"mcpServers":{"sugi":{"url":"https://sugi.moe/mcp"}}}`。WAF 规则不覆盖 `/mcp`，因为一次会话里有很多非上传的请求；上传次数由 Worker 限流控制。

### 客户端脚本 bin/sugi-upload

`bin/sugi-upload` 用旧接口 `/upload`，一次上传一个或多个图片，每个文件输出一行链接（顺序与参数一致），任何一个失败都以非零退出码结束。curl 带 10 秒连接超时和 120 秒总超时，令牌通过 stdin 交给 curl，不会出现在进程列表里。

令牌依次取 `SUGI_TRUSTED_TOKEN`、`~/.config/sugi/secrets.env`（或 `SUGI_SECRETS_FILE`）里的 `TRUSTED_TOKEN=`、`SUGI_UPLOAD_TOKEN`。`SUGI_URL` 默认 `https://sugi.moe`。连接失败（curl 退出码 7）时先用 `--ipv4` 重试，系统解析器没有 A 记录时再用 `dig`（先本机解析器，再 1.1.1.1）查 A 记录并 `--resolve` 钉住。

```sh
bin/sugi-upload before.png after.png
```

## 设计

### 存储和链接

- **新上传**的键是 `f/<id>`（永久）或 `t/<id>`（临时），id 是 8 位 `[a-z0-9]`，或者勾选「可爱链接名」时的 `word-word-NN`（300 个词，大约 800 万种组合，更好记但更容易被猜到，界面上有提示）。直链是 `FILES_ORIGIN/<id>.<ext>` 或 `TMP_ORIGIN/<id>.<ext>`，扩展名必须和存储的类型一致。新上传不做内容去重：每次上传都是独立对象，有自己的删除凭证，谁删都不会影响别人的链接。
- **customMetadata**：`uploaded`、`uploaded_ms`、`source`（上传者 IP 的 HMAC）、`ext`、`del`（删除凭证的 SHA-256，凭证本身只返回给上传者一次）、`name`（显示名，去掉路径和控制字符，最长 120 字）、临时文件另有 `expires`（毫秒时间戳）。
- **旧上传**的键是 `<sha256 前 16 位>.<ext>`，放在 bucket 根目录，由 `/upload` 写入，内容寻址、不覆盖、前缀碰撞返回 409，行为和链接都没有变。
- **类型只看文件头**：PNG、JPEG、GIF、WebP、AVIF（ISO BMFF 主品牌 `avif`/`avis`，或 `mif1`/`msf1` 且兼容品牌含 AVIF）、MP4（主品牌白名单，排除 QuickTime、纯音频 M4A 和 HEIC）、WebM（EBML 且 DocType 为 `webm`）。其余一律 415。客户端给的文件名和 Content-Type 不参与判断。
- **大小**：单个文件最大 200 MB。Cloudflare Free/Pro 的请求体上限是 100 MB，所以单个请求最多 90 MB，更大的走分片上传（R2 multipart），会话是 Worker 用 `IP_HASH_SECRET` 派生的密钥签名的令牌，Worker 不保存会话状态；第一片在创建 multipart 之前先嗅探类型。PUT 和分片都是流式写入 R2（`FixedLengthStream`），不整个读进内存；multipart 表单用 `@remix-run/multipart-parser` 流式解析，只有文件那一段在内存里。网页和 PUT 客户端超过 90 MB 时自动分片（每片 50 MB）。
- **临时文件**：到期那一刻起返回 404（每次取文件都检查 `expires`）；Cron Trigger 每 10 分钟删除到期对象并清缓存；bucket 上 `t/` 前缀还有一条 R2 生命周期规则（4 天后删除）兜底。临时文件的 `Cache-Control` 和边缘缓存时长都不超过剩余寿命。
- **链接搬运**：只接受 http/https，不接受带用户名密码的链接和 sugi 自己的域名；重定向手动跟随最多 3 次，每一跳都重新检查；整个过程 30 秒超时；远端给了 Content-Length 时最大 200 MB 并流式写入，没给时最多缓冲 20 MB；类型照样按文件头判断；和上传共用限流。
- **打包链接**：D1 的 `albums`（id、标题、创建时间、删除凭证哈希、来源 HMAC）和 `album_files`（顺序和 R2 键）。读取时跳过已删除和已过期的文件；删除打包链接不删文件；按来源清除时一并删除该来源建的打包链接。

### 出图

- 取文件时先用 bucket 绑定 `head()` 确认对象存在且没过期，再以 `cacheEverything` 经 zone 缓存去取 `r2.sugi.moe/<key>`（`CACHE_ORIGIN`），套上 sugi 自己的响应头返回；这样 Cloudflare 基于缓存的功能（CSAM Scanning Tool）能看到每一个文件。`Range` 请求会转给缓存层，视频可以拖动进度条。缓存层的拦截（例如 CSAM 命中后的 451）原样透传。删除时在删完 R2 对象后调用 zone 的 purge API 清掉 `r2.sugi.moe/<key>`，需要 `ZONE_ID` 和 `CF_PURGE_TOKEN`；清除失败返回 502，重试即可。
- 响应头：`Content-Type`、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline; filename="<id>.<ext>"`、`Accept-Ranges: bytes`、`ETag`、`Last-Modified`；图片的 CSP 是 `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`，视频是 `default-src 'none'; media-src 'self'; style-src 'unsafe-inline'`；永久文件 `public, max-age=31536000, immutable`，临时文件 `public, max-age=<剩余秒数>`。
- `files.sugi.moe` 和 `tmp.sugi.moe` 只出文件：根路径跳转到主站，其他路径 404，只接受 GET/HEAD。

### 网站

- 每个页面都由 Worker 渲染（中英双语），浏览器脚本接管站内链接：点链接时只取主体内容（请求头 `X-Sugi-Partial: 1`，返回 JSON）替换进页面，所以正在进行的上传不会因为换页而中断。
- 页面 CSP：`default-src 'none'; script-src 'nonce-<随机>' 'strict-dynamic'; style-src 'nonce-<随机>'; img-src 'self' data: blob: <files> <tmp>; media-src 'self' blob: <files> <tmp>; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`，每次响应换 nonce，没有内联 style 属性和内联事件；动态样式都走 CSSOM。页面是 `Cache-Control: private, no-cache`。
- 不引用任何外部资源。字体自托管并裁剪：ZCOOL KuaiLe（只含页面实际用到的字，约 57 KB）和 Fredoka（拉丁字母，字重 500 到 700，约 28 KB），正文用系统字体，代码用系统等宽字体。浏览器脚本和样式由 esbuild 打包成带内容哈希的文件（脚本约 33 KB，样式约 32 KB，未压缩）。
- SEO：每页有中英文的 title 和 description、canonical、hreflang（`?lang=zh`、`?lang=en`，`x-default` 是不带参数、按 Accept-Language 决定语言的地址）、Open Graph 和 Twitter 卡片；首页有 WebSite 和 Organization 的 JSON-LD，问问题页有 FAQPage。`/robots.txt` 屏蔽 `/api/`、`/mcp`、`/admin/`、`/auth/`，`/sitemap.xml` 列出公开页面（投喂和登录页只在开关打开时出现）。用户内容不进搜索引擎：`/f/<id>`、`/a/<id>`、`/mine`、404 页带 `<meta name="robots" content="noindex, nofollow">` 和 `X-Robots-Tag: noindex`，files/tmp 两个域名和旧链接的每个响应都带 `X-Robots-Tag: noindex`。永久图片的分享页用图片本身做 og:image，其他页面用渲染好的 OG 图。
- OG 图（1200×630，首页、开发者、问问题、使用条款、隐私政策各一张，中英文各一）和 PNG 图标（32、192、512、apple-touch-icon 180）由 `scripts/build-og.mjs` 用 resvg 从 SVG 渲染，文件名带内容哈希，渲染结果和清单 `src/site/og-images.ts` 都提交在仓库里；改了文案或图案后先跑一次 `scripts/subset-fonts.sh`（把完整字体下载到 `~/.cache/sugi-fonts`），再跑 `node scripts/build-og.mjs`。另外有 `/manifest.webmanifest`、`/favicon.ico`（32px PNG）和 `/apple-touch-icon.png`。
- 「抹掉照片位置信息」在浏览器里、上传之前处理，不重新编码像素：JPEG 删掉 APP1 Exif/XMP 和 APP13，只保留方向（重写一个只含 Orientation 的最小 Exif 段）；PNG 删掉 eXIf 和带 XMP/Exif/IPTC 的文本块；WebP 删掉 EXIF/XMP 块并清掉 VP8X 里的标志位。AVIF、视频和 API 上传不处理。代码在 `client/exif.ts`。
- 仓仓（仓鼠）：眼睛跟着鼠标，戳它会冒心，拖文件时张嘴，上传中流汗、大文件时摇晃，传完开心并撒瓜子叶子，闲置 15 秒跑轮子、60 秒睡觉；11 月到 2 月戴围巾，夜间戴睡帽，圣诞戴圣诞帽，春节抱红包，万圣节抱南瓜；Konami 秘籍切换金色仓仓；标签页图标显示上传进度和心情。

### 滥用、限流和鉴权

- **不存原始 IP**：每个文件和打包链接只记录 `HMAC-SHA256(IP_HASH_SECRET, CF-Connecting-IP)`。拿不到密钥就不能从它反推 IP；同一 IP 的 HMAC 相同，所以能按来源整批清除。没配置 `IP_HASH_SECRET` 时上传返回 503。Workers Logs 没开。
- **Worker 限流**（Rate Limiting 绑定，按来源 HMAC）：每 60 秒 10 次上传（一次上传、一次链接搬运、一次分片上传的开始各算一次），打包链接单独计数，也是 60 秒 10 次。这个绑定按节点计数、最终一致，短时间突发会放过几十次，所以另有 WAF 规则。
- **WAF 速率规则**（zone `sugi.moe`，Free 计划只能按路径匹配、周期和封禁都是 10 秒）：`http.request.uri.path in {"/upload" "/api/upload" "/api/uploads"}`，每个 IP 每 10 秒最多 5 次，超出封 10 秒（429，`error code: 1015`）。分片的后续片（`/api/uploads/<n>`）和 complete 不计数。可信令牌的豁免是一条自定义规则：同样的路径并且 `Authorization` 正好等于 `Bearer <TRUSTED_TOKEN>` 时 Skip `http_ratelimit` 阶段。WAF 无法验证令牌，只能按字面值匹配，**所以 `TRUSTED_TOKEN` 的值也写在这条 zone 规则里，轮换时必须两处一起改**。2026-11-02 两条规则从只匹配 `/upload` 扩大到上面三个路径，线上验证：普通令牌第 6 次起被拦，可信令牌不受影响。

  | 规则 | 阶段 | ruleset ID | rule ID |
  | --- | --- | --- | --- |
  | sugi trusted uploads skip rate limit（自定义规则，Skip） | `http_request_firewall_custom` | `27e91a99f7b8408fabc6039282a8087e` | `d16fcfbd3bc34e69a2bcbc3a5549a5fc` |
  | sugi upload rate limit per IP（速率规则，Block） | `http_ratelimit` | `ad7a86bc252e4cd08ddc0c1ca0e7678d` | `268641d130ef4e5d96184b7f1f57aa4d` |

- **鉴权**：`Authorization: Bearer <token>` 和 `Sugi-Token` 都先对两边做 SHA-256，再用 `crypto.subtle.timingSafeEqual` 比较。

### Secrets 和配置

| Secret | 作用 | 未设置时 |
| --- | --- | --- |
| `IP_HASH_SECRET` | 来源 HMAC 的密钥，也用来签分片上传会话 | 上传返回 503 |
| `ADMIN_TOKEN` | 管理接口令牌 | 管理接口返回 403 |
| `UPLOAD_TOKEN` | 上传闸门令牌（生产环境不设置） | 匿名上传 |
| `TRUSTED_TOKEN` | 维护者令牌：过闸门、免限流 | 无可信令牌 |
| `CF_PURGE_TOKEN` | Cloudflare API token，只有 sugi.moe 的 Zone → Cache Purge 权限 | 开了 `CACHE_ORIGIN` 时删除返回 502 |

Secrets 只存在两处：Cloudflare 的 Worker secrets，以及本机 `~/.config/sugi/secrets.env`（权限 600）。`TRUSTED_TOKEN` 例外，它的值还在 zone 的 WAF 自定义规则里。`secrets.env` 会被 `wrangler deploy --secrets-file` 整个上传，所以只放 Worker 要用的东西；改 WAF 用的 ops token 放在 `~/.config/sugi/ops.env`。

`wrangler.jsonc` 的 `vars`：`CACHE_ORIGIN`、`ZONE_ID`、`MAIN_ORIGIN`、`FILES_ORIGIN`、`TMP_ORIGIN`，以及功能开关 `FEATURE_ACCOUNTS`、`FEATURE_CLI`、`FEATURE_DONATE`（`"1"` 打开）。账号、命令行/MCP、投喂页属于后续阶段，开关关闭时它们的入口、页面和文案都不出现；投喂页没有任何内置金额或名单，数据要由维护者提供（`src/site/pages/info.ts` 的 `DONATE_DATA`）。

`FILES_ORIGIN`/`TMP_ORIGIN` 可以带路径（例如 `http://localhost:8787/_files`），这时文件在任何主机名下的那个路径提供；本地开发靠这个，因为 `wrangler dev` 会把每个请求的主机名改写成第一条路由。

## 开发

```sh
npm install
npm test             # 先打包浏览器脚本，再跑 vitest + @cloudflare/vitest-plugin（本地 workerd）
npm run typecheck    # Worker 和浏览器脚本两套 tsconfig
npm run fonts        # 改了界面文字后重新裁剪字体（需要 curl 和 uv）
npx wrangler d1 migrations apply sugi --local
npx wrangler dev     # 本地调试
```

本地调试的 `.dev.vars`（已 gitignore）示例：

```
IP_HASH_SECRET=local-dev-ip-hash-secret
ADMIN_TOKEN=local-dev-admin
UPLOAD_TOKEN=local-dev-upload
TRUSTED_TOKEN=local-dev-trusted
CACHE_ORIGIN=
MAIN_ORIGIN=http://localhost:8787
FILES_ORIGIN=http://localhost:8787/_files
TMP_ORIGIN=http://localhost:8787/_tmp
```

`wrangler dev` 和 `wrangler deploy` 都会先执行 `scripts/build-client.mjs`（`client/` → `public/static/build/`，并生成 `src/generated/assets.ts`）。改了 `wrangler.jsonc` 后跑 `npm run types`。

命令行的端到端检查（临时安装目录和配置目录，只传合成文件，最后全部删除）：`SUGI_TOKEN=<令牌> scripts/cli-e2e.sh http://localhost:8787`（本地 `.dev.vars` 里要有 `FEATURE_CLI=1`）。

端到端检查（每次现场生成随机内容的合成文件，只删除自己创建的对象；新 API 的文件用各自的删除凭证删除）：

```sh
scripts/e2e.sh https://sugi.moe
# 本地：
SUGI_SECRETS_FILE=<本地令牌文件> SUGI_CACHE_ORIGIN= SUGI_E2E_EXPECT_WAF=0 scripts/e2e.sh http://localhost:8787
```

**不要拿真实图片做测试再按旧链接删除。** 旧链接是内容哈希，删一个键等于删掉所有人上传的同一份内容。

## 运维手册

```sh
set -a; . ~/.config/sugi/secrets.env; set +a
admin() { printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" | curl -sS -K - "$@"; }
```

### 处理举报（MCP）

`sugi` MCP 服务按请求带的令牌决定权限：带 `ADMIN_TOKEN` 时多出一组管理工具（普通请求看不到也调用不了），并且不受限流。同一个 MCP 条目，把请求头换成管理员令牌即可。

1. `inspect`：把举报的链接（files./tmp. 直链、`/f/<id>` 分享页、旧链接、`/a/<id>` 打包链接都行）查一遍，看状态、来源 HMAC、所在的打包链接。
2. `takedown`：下架，写上 `reason`。对象换成墓碑，所有出过图的地址（缓存回源地址、直链、分享页）清缓存，链接从此返回 451（浏览器看到一句中英文的“因被举报已删除”，带 noindex），id 不再分配。CSAM、反复出现的垃圾内容加 `block_content: true`，记下内容的 SHA-256，之后任何上传途径（普通上传、multipart、链接搬运、`create_upload` 链接、旧接口 `/upload`）传同样的字节都会被 451 拒绝。内容屏蔽只覆盖 20 MB 以内的文件：Worker 在 CPU 限制内算不完更大文件的哈希（实测 95 MB 会触发 1102），更大的文件只下架、不屏蔽，结果里会列在 `not_blocked_too_big`。打包链接也能下架，`include_files: true` 连同里面的文件一起下架。
3. `list_by_source`：同一来源还传过什么（按时间倒序，分页）。
4. `takedown_by_source`：整批下架，默认 `dry_run: true` 只列出来，确认后再传 `dry_run: false`；必要时 `block_source`（可设 `expires_in_hours`），该来源之后的上传得到不说明原因的 403。
5. `takedown_log` 看最近的管理操作；`list_blocks` 看屏蔽列表；误伤时用 `unblock_source`、`unblock_content` 解除。

下架记录、屏蔽列表和审计日志在 D1（`migrations/0002_moderation.sql`），墓碑对象留在 R2 原来的键上。HTTP 的管理员删除和按来源清除走的是同一套逻辑。

### 删除单个文件

```sh
admin https://sugi.moe/admin/info/f/k3x9qa2m                 # 新链接 files.sugi.moe/k3x9qa2m.png（临时文件是 t/<id>）
admin -X DELETE https://sugi.moe/api/files/k3x9qa2m
admin https://sugi.moe/admin/info/3f9a1c0b7e2d4a51.png       # 旧链接 sugi.moe/3f9a1c0b7e2d4a51.png
admin -X DELETE https://sugi.moe/3f9a1c0b7e2d4a51.png
admin -X DELETE https://sugi.moe/api/albums/<id>             # 打包链接
```

返回体里 `"cache_purged": true` 才算清干净，502 就重试（重试会再清一次缓存）。管理员删除就是下架：对象换成墓碑，链接从此返回 451，id 不再分配，并写进审计日志。已经被别处（GitHub camo、浏览器）缓存的副本不受控制。

### 按来源清除

```sh
SRC=$(admin https://sugi.moe/admin/info/f/k3x9qa2m | sed -E 's/.*"source":"([0-9a-f]+)".*/\1/')
admin -H 'content-type: application/json' -d "{\"source\":\"$SRC\",\"dry_run\":true}" https://sugi.moe/admin/purge-by-source
admin -H 'content-type: application/json' -d "{\"source\":\"$SRC\"}" https://sugi.moe/admin/purge-by-source
```

只有 IP 时：`SRC=$(printf %s "$IP" | openssl dgst -sha256 -hmac "$IP_HASH_SECRET" -r | cut -d' ' -f1)`。清除会遍历整个 bucket，并删除该来源的打包链接。

### 轮换 secrets

1. 在 `~/.config/sugi/secrets.env` 里换掉要轮换的值（`openssl rand -hex 32`）。
2. `npx wrangler deploy --secrets-file ~/.config/sugi/secrets.env`。
3. `npx wrangler secret list` 确认都是 `secret_text`。

轮换 `TRUSTED_TOKEN` 时同一轮里要改 WAF 自定义规则（上表的 rule，`PATCH /zones/0ec67ba827776b3d9e3452483205b04c/rulesets/27e91a99f7b8408fabc6039282a8087e/rules/d16fcfbd3bc34e69a2bcbc3a5549a5fc` 更新 `expression`）。轮换 `IP_HASH_SECRET` 会让同一 IP 前后有两个不同的 `source`，并让进行中的分片上传会话失效；轮换前把旧值另存一份。

## 上线步骤

已完成：zone、`sugi.moe` 自定义域、`r2.sugi.moe`、缓存出图和清除、WAF 两条规则（已覆盖新接口）、Email Routing `abuse@sugi.moe`、`TRUSTED_TOKEN`、D1 数据库 `sugi`（已创建，表结构见 `migrations/`）。

这次改版部署时，按顺序：

1. 远端 D1 建表：`npx wrangler d1 migrations apply sugi --remote`。
2. R2 生命周期兜底：`npx wrangler r2 bucket lifecycle add sugi expire-tmp t/ --expire-days 4`。
3. `npx wrangler deploy --secrets-file ~/.config/sugi/secrets.env`：会同时挂上 `files.sugi.moe` 和 `tmp.sugi.moe` 两个自定义域，并启用 Cron Trigger。
4. `scripts/e2e.sh https://sugi.moe`。

部署之前请确认：

1. **CSAM Scanning Tool 已开启**（FAQ 和隐私政策里写了“会由 Cloudflare 的 CSAM 扫描工具检测”）：Dashboard → sugi.moe → Caching → Configuration → CSAM Scanning Tool，通知邮箱 `suzukaze.haduki@gmail.com`。
2. `~/.config/sugi/secrets.env` 里**没有** `UPLOAD_TOKEN`：`--secrets-file` 部署会把文件里的每一项都设成 Worker secret，有这一行就会把闸门重新打开。
3. 隐私政策和使用条款已经由维护者审阅（`src/site/pages/privacy.ts` 里带 `review` 备注的段落）。
