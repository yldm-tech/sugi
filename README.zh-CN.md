# sugi

[English](README.md)

sugi 是一个匿名图床，图片和短视频都能传，整个跑在 Cloudflare 上：一个 Worker，一个存文件的 R2 bucket，一个存打包链接的 D1 数据库。不用注册，拖进来就能拿到直链，可以永久保存，也可以 1 小时、12 小时或 3 天后自动删除。自带中英双语网站、HTTP API、命令行工具和 MCP 服务，还有一只什么都往腮帮子里屯的仓鼠。

作者自己运营的实例是 <https://sugi.moe>。这个仓库用来部署你自己的：你的名字、你的域名、你的规则。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yldm-tech/sugi)

## 功能

- 图片和短视频：PNG、JPEG、WebP、GIF、AVIF、MP4、WebM，单个文件最大 200 MB。类型只看文件内容，不看文件名和 Content-Type；其他格式（SVG、HTML、PDF、压缩包等）一律拒绝。
- 拖放、选择文件、粘贴，或者贴一个链接让服务器去搬。超过 90 MB 的文件自动分片上传（R2 multipart），不会撞上 Cloudflare 的请求体上限。
- 永久或临时链接（1 小时、12 小时、3 天），随机 id（`k3x9qa2m`）或可爱 id（`snow-sesame-19`），每个文件有分享页，可以复制成 Markdown、HTML、BBCode，多个文件可以打包成一个链接。
- 「我的文件」把上传记录和删除凭证存在浏览器里，不需要账号。网页上传时默认在浏览器里抹掉照片的位置信息（EXIF、XMP）。
- 不保存 IP 地址。每次上传只记下上传者 IP 的 HMAC（用服务器端密钥算），够用来清除某个滥用来源的全部上传，别的什么都做不了。
- 按 IP 限流，严格的安全响应头（基于 nonce 的 CSP、`nosniff`、文件从独立的 origin 提供并带自己的 CSP），没有第三方脚本、字体或统计。
- `curl -F file=@cat.png https://<你的域名>/api/upload` 直接返回链接；命令行工具 `sugi` 和 MCP 服务（`/mcp`）让终端和 AI 助手也能传。

## 部署

### 一键部署

点上面的 **Deploy to Cloudflare**。Cloudflare 会把这个仓库复制到你的 GitHub 或 GitLab 账号，创建 R2 bucket 和 D1 数据库，让你填下面两个 secret，然后部署 Worker。部署完就能在 `*.workers.dev` 地址上用，数据库表在第一次请求时由 Worker 自己建好。

| Secret | 填什么 |
| --- | --- |
| `IP_HASH_SECRET` | 一个足够长的随机值，例如 `openssl rand -hex 32`。用来算上传者 IP 的 HMAC，也用来签分片上传会话。没设置时上传返回 503，首页也会提示。 |
| `ADMIN_TOKEN` | 另一个随机值。用来删除任意文件、按来源清除（见[处理违规内容](#处理违规内容)）。 |

把链接发出去之前，至少设置 `SITE_NAME`、`OPERATOR_NAME`、`CONTACT_EMAIL`（见[配置](#配置)），并读一遍自己站点的使用条款和隐私政策：它们描述的是**你的**服务，由你负责。

### 从源码部署

```sh
git clone https://github.com/<你>/sugi && cd sugi
npm install
npx wrangler login
npm run deploy                      # 第一次会自动创建 bucket 和数据库
npx wrangler secret put IP_HASH_SECRET
npx wrangler secret put ADMIN_TOKEN
```

不想叫 `my-sugi` 的话，先改 `wrangler.jsonc` 里的 `"name"`。

## 配置

一个实例的身份都在 [`wrangler.jsonc`](wrangler.jsonc) 的 `vars` 里。留空时用默认值，在裸的 `*.workers.dev` 地址上也能工作。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SITE_NAME` | 主机名 | 显示在标题、logo（`pics.example` 显示成 `pics♥example`）、Open Graph 和法律页面里。 |
| `MAIN_ORIGIN` | 请求自己的 origin | 网站和接口的公开地址，例如 `https://pics.example.org`。 |
| `FILES_ORIGIN`、`TMP_ORIGIN` | `<主站>/_files`、`<主站>/_tmp` | 永久和临时文件的地址。有自己的域名时，建议用单独的主机名（`https://files.example.org`、`https://tmp.example.org`）并加成自定义域，这样用户上传的文件永远不会和网站同源。 |
| `OPERATOR_NAME` | 无 | 运营这个站点的个人或公司，写在使用条款和隐私政策里。 |
| `CONTACT_EMAIL`、`ABUSE_EMAIL` | 无 | 一般和隐私问题的联系邮箱，以及举报邮箱（不填时用联系邮箱）。都不填时页面会请访客联系运营者。 |
| `CSAM_SCANNING` | `0` | 只有在 zone 上开启了 Cloudflare 的 [CSAM Scanning Tool](https://developers.cloudflare.com/cache/reference/csam-scanning/)、并且文件经缓存提供（`CACHE_ORIGIN`）之后才设成 `1`，FAQ 和隐私政策只在打开时提到它。 |
| `EMAIL_ROUTING` | `0` | 联系邮箱经 Cloudflare Email Routing 转发时设成 `1`，隐私政策会把它列为处理方。 |
| `WAF_RATE_LIMIT` | `0` | zone 上加好了[限流](#限流)里的 WAF 规则后设成 `1`，开发者页面会说明这条规则。 |
| `STORAGE_LOCATION` | 无 | bucket 的位置提示或司法辖区（`apac`、`weur`、`eu` 等），写进隐私政策。 |
| `RESEND_REGION`、`MAIL_FROM` | 无 | 账号功能用（尚未发布）：登录邮件的 Resend 区域和发件人。 |
| `CACHE_ORIGIN`、`ZONE_ID` | 无 | 让文件经 zone 缓存提供：bucket 上的 [R2 自定义域](https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains)（例如 `https://r2.example.org`）和 zone id。删除文件时会顺带清缓存，需要 secret `CF_PURGE_TOKEN`（只有该 zone 的 Zone → Cache Purge 权限的 API token）。 |
| `FEATURE_CLI` | `1` | 命令行工具（`/install.sh`）和 MCP 服务（`/mcp`）。 |
| `FEATURE_ACCOUNTS`、`FEATURE_DONATE` | `0` | 账号和投喂页还在开发中，保持关闭。 |

可选的 secret：`UPLOAD_TOKEN` 设置后，只有带 `Authorization: Bearer <UPLOAD_TOKEN>` 的请求才能上传（适合私用实例）；`TRUSTED_TOKEN` 能过这道闸门并且不受限流（给自己和自动化用）；`CF_PURGE_TOKEN` 见上。

改了 `wrangler.jsonc` 后跑 `npm run types` 再部署。bucket、数据库、限流器，以及每 10 分钟删除过期文件的 Cron Trigger 都在里面声明。临时文件一到期就返回 404；想再加一道保险，可以给 bucket 加 R2 生命周期规则：`npx wrangler r2 bucket lifecycle add <bucket> expire-tmp t/ --expire-days 4`。

### 限流

Worker 通过 [Rate Limiting 绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)限制每个 IP 每 60 秒 10 次上传（打包链接另算 10 次）。这个绑定按 Cloudflare 节点计数、最终一致，短时间连续请求会多放过很多次才开始拦（我们实测连续上传到第 85 次左右才出现第一个 429）。对外开放的实例如果用了自己的域名，建议再加一条 WAF 速率规则（免费计划：按路径匹配，周期 10 秒）：

- 表达式 `http.request.uri.path in {"/upload" "/api/upload" "/api/uploads"}`，按 IP 计数，每 10 秒 5 次，超出后 Block 10 秒。
- 用了 `TRUSTED_TOKEN` 的话，在它之前加一条自定义规则：路径相同且 `any(http.request.headers["authorization"][*] == "Bearer <TRUSTED_TOKEN>")` 时跳过 `http_ratelimit` 阶段。WAF 没法校验令牌，所以令牌的值会写在规则里，轮换时两处要一起改。

然后把 `WAF_RATE_LIMIT` 设成 `1`。

### 处理违规内容

```sh
admin() { printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" | curl -sS -K - "$@"; }
admin https://<域名>/admin/info/f/k3x9qa2m                  # 元数据，包括来源 HMAC（临时文件是 t/<id>）
admin -X DELETE https://<域名>/api/files/k3x9qa2m
admin -X DELETE https://<域名>/api/albums/<id>
admin -H 'content-type: application/json' -d '{"source":"<hmac>","dry_run":true}' https://<域名>/admin/purge-by-source
```

按来源清除会删掉同一 IP 上传的所有文件和打包链接。只有 IP 时：`printf %s "$IP" | openssl dgst -sha256 -hmac "$IP_HASH_SECRET" -r`。

管理员删除就是下架：对象换成空的墓碑，链接从此返回 451（Unavailable For Legal Reasons），id 不再分配，出过图的地址都清缓存，并在 D1 的审计日志里留下记录。可以加 `?reason=...` 写明原因，加 `?block_content=1` 阻止同样的字节（20 MB 以内的文件）再次上传。

同样的管理功能也能通过 MCP 用：带 `Authorization: Bearer <ADMIN_TOKEN>` 连接 `https://<域名>/mcp`，会多出 `inspect`、`takedown`（可加 `block_content`，打包链接可加 `include_files`）、`list_by_source`、`takedown_by_source`（默认只预演）、`block_source` / `unblock_source`、`unblock_content`、`list_blocks`、`takedown_log`。处理举报的顺序：`inspect` 查链接，`takedown` 下架，`list_by_source` 看同一上传者还传了什么，必要时 `takedown_by_source` 或 `block_source`。管理员令牌也不受限流；用了 WAF 规则的话，把它和 `TRUSTED_TOKEN` 一起写进跳过规则。

## 使用

### HTTP API

```sh
curl -F "file=@cat.png" https://<域名>/api/upload                    # 永久，返回链接
curl -F "file=@cat.png" -F "expire=1h" https://<域名>/api/upload     # 临时：1h / 12h / 72h
curl -F "url=https://example.com/a.png" https://<域名>/api/upload    # 从链接搬运
curl -T cat.png "https://<域名>/api/upload?expire=12h&style=cute"    # PUT 原始文件，选项放查询参数
curl -H 'Accept: application/json' -F "file=@cat.png" https://<域名>/api/upload
curl -X DELETE -H "Sugi-Token: d_…" https://<域名>/api/files/<id>
```

带 `Accept: application/json` 时返回 `{"id", "url", "page", "size", "type", "name", "expires_at", "delete_token"}`。每个实例的开发者页面（`/dev`）都有完整的接口说明：分片上传、文件信息、打包链接、错误码和限流。旧的内容寻址接口 `POST /upload`（只收图片，最大 20 MB，链接形如 `/<16 位十六进制>.png`）为老客户端保留。

### 命令行和 MCP

```sh
curl -fsSL https://<域名>/install.sh | sh     # 校验 SHA-256 后装到 ~/.local/bin/sugi
sugi up cat.png dog.gif                       # 每个文件一行链接，自动复制
sugi up -e 1h --cute secret.jpg
sugi album "猫猫合集" *.png
sugi ls ; sugi rm <id>
```

命令行工具只依赖 bash 和 curl，默认连到安装它的那个实例。MCP 服务在 `https://<域名>/mcp`（Streamable HTTP，无状态），工具有 `upload_file`、`upload_url`、`create_album`、`get_file`、`delete_file`，例如 `claude mcp add --transport http sugi https://<域名>/mcp`。

## 开发

```sh
npm install
npm test            # 先打包浏览器脚本，再在 workerd 里跑 vitest
npm run typecheck
npm run dev         # wrangler dev，http://localhost:8787
```

`npm run dev` 需要把本地值写进 `.dev.vars`（参考 [`.dev.vars.example`](.dev.vars.example)），再加上 `MAIN_ORIGIN=http://localhost:8787`、`FILES_ORIGIN=http://localhost:8787/_files`、`TMP_ORIGIN=http://localhost:8787/_tmp`。`scripts/e2e.sh <地址>` 和 `scripts/cli-e2e.sh <地址>` 用合成文件对运行中的实例做端到端检查，最后删掉自己创建的所有东西。

目录：`src/` 是 Worker（路由在 `index.ts`，上传在 `files.ts` 和 `chunked.ts`，页面在 `site/`），`client/` 是浏览器脚本和样式（esbuild 打包），`public/static/` 放字体、图标、Open Graph 图和命令行工具，`migrations/` 是 D1 表结构，`test/` 是测试。字体是自托管的子集；改了用装饰字体的文字后跑 `npm run fonts`，改了 Open Graph 文案后跑 `node scripts/build-og.mjs`。

提 PR 前请看 [CONTRIBUTING.md](CONTRIBUTING.md)，报告安全问题请看 [SECURITY.md](SECURITY.md)。sugi.moe 自己的运维记录在 [docs/operations.md](docs/operations.md)。

## 许可

[MIT](LICENSE) © YLDM Co., Ltd。内置字体 ZCOOL KuaiLe 和 Fredoka 使用 SIL Open Font License（`public/static/fonts/OFL-*.txt`）。你的部署默认使用你自己的名字和通用的 Open Graph 图；请不要把它当成 sugi.moe 来介绍。
