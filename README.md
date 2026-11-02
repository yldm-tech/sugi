# sugi

通用的匿名公共图床：免注册，上传图片拿到直链。一个 Cloudflare Worker 加一个 R2 bucket，没有数据库，没有账号体系。

- 线上地址：<https://sugi.moe>（备用 <https://sugi.evan-e2b.workers.dev>）
- Cloudflare 账户：Evan@yldm.tech's Account（`e2b27aea5f599efdbe0a7016a2580d05`），Worker `sugi`，R2 bucket `sugi`（自定义域 `r2.sugi.moe`，作为走缓存的回源地址），zone `sugi.moe`
- 当前状态：**上传闸门开启**，上传需要 `UPLOAD_TOKEN` 或 `TRUSTED_TOKEN`，匿名上传尚未开放（见文末“剩余上线步骤”）

## 用法

### 网页

打开 <https://sugi.moe>，把图片拖进上传框、点击选择文件（可多选），或者直接 Ctrl+V / ⌘V 粘贴剪贴板里的图片。每张图上传后显示缩略图、直链和 Markdown 片段，各带一个复制按钮。类型不对、超过 20 MB、触发频率限制、闸门未开放时都会显示对应的提示。页面按 `Accept-Language` 显示中文或英文（默认英文），右上角可以切换，也可以用 `?lang=zh` / `?lang=en` 指定。网页上传是匿名的，和 curl 匿名上传的限制、闸门完全一样，页面里不含任何令牌。

### 命令行

```sh
# multipart，字段名 file
curl -F file=@shot.png https://sugi.moe/upload
# 或者直接 PUT 文件内容
curl -T shot.png https://sugi.moe/upload
# 要 JSON
curl -H 'Accept: application/json' -T shot.png https://sugi.moe/upload
```

成功返回图片直链，例如 `https://sugi.moe/3f9a1c0b7e2d4a51.png`。新文件返回 201，内容已存在返回 200 和同一个链接。JSON 形如 `{"url":…,"key":…,"size":…,"type":"image/png","deduplicated":false}`。

闸门开启期间要带令牌：`-H "Authorization: Bearer $SUGI_UPLOAD_TOKEN"`。维护者自己（以及代为上传的 agent）用 `TRUSTED_TOKEN`，它同样能过闸门，并且不受任何频率限制。

### 客户端脚本

`bin/sugi-upload` 一次上传一个或多个文件，每个文件输出一行链接（顺序与参数一致），任何一个失败都以非零退出码结束，错误写到 stderr，其余文件照常上传。curl 带 10 秒连接超时和 120 秒总超时，令牌通过 stdin 交给 curl，不会出现在进程列表里。

令牌的来源依次是：`SUGI_TRUSTED_TOKEN` 环境变量，`~/.config/sugi/secrets.env`（或 `SUGI_SECRETS_FILE` 指定的文件）里的 `TRUSTED_TOKEN=` 行，最后才是 `SUGI_UPLOAD_TOKEN`。维护者本机已经有 secrets.env，直接用即可：

```sh
bin/sugi-upload before.png after.png
```

另一台机器要用，把 `TRUSTED_TOKEN=...` 那一行拷到它的 `~/.config/sugi/secrets.env`（权限 600），或者导出 `SUGI_TRUSTED_TOKEN`。`SUGI_URL` 默认 `https://sugi.moe`。

连接失败（curl 退出码 7）时会再用 `--ipv4` 试一次；如果系统解析器里根本没有缓存 A 记录（macOS 在 zone 刚生效时可能只缓存了 AAAA），再用 `dig` 直接查 A 记录并用 `--resolve` 钉住地址。这几次重试的 curl 报错会出现在 stderr，最终结果以退出码和 stdout 为准。

在 Markdown 里嵌入：`![](https://sugi.moe/3f9a1c0b7e2d4a51.png)`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / HEAD | `/` | 说明页（纯 HTML，无外部资源） |
| POST / PUT | `/upload` | 上传；multipart 字段 `file`，或原始请求体 |
| GET / HEAD | `/<key>` | 取图，支持 `If-None-Match` 返回 304 |
| DELETE | `/<key>` | 删除并清除缓存，需 `ADMIN_TOKEN` |
| GET | `/admin/info/<key>` | 查看对象的上传时间、来源 HMAC、SHA-256，需 `ADMIN_TOKEN` |
| POST | `/admin/purge-by-source` | 按来源 HMAC 批量删除并清除缓存，需 `ADMIN_TOKEN` |

错误响应默认是纯文本，`Accept: application/json` 时是 `{"error": "..."}`。状态码：400 请求体为空或 multipart 缺 `file` 字段，401 令牌错误，403 管理接口未启用，404 不存在，405 方法不对，409 键冲突，413 超过 20 MB，415 类型不支持，429 超出频率限制（带 `Retry-After: 60`），503 未配置 `IP_HASH_SECRET`。删除接口在对象已删、但缓存清除失败时返回 502 和 `"cache_purged": false`，重试同一个请求即可（对象不存在时也会再清一次缓存）。缓存层拦截的图片（例如 CSAM 命中后的 451）原样透传，不会退回去直接读 bucket。

## 设计

- **类型只看文件头**。PNG（`89 50 4E 47 0D 0A 1A 0A`）、JPEG（`FF D8 FF`）、GIF（`GIF87a`/`GIF89a`）、WebP（`RIFF....WEBPVP8`），其余一律 415，包括 SVG 和 HTML。客户端给的文件名和 Content-Type 完全不看，存储和返回的 Content-Type 由检测结果决定。
- **大小上限 20 MB**。先看 Content-Length，超了直接拒绝；没有 Content-Length 的流式请求边读边计数，一过上限就中断，不会把超大请求整个读进内存。multipart 额外留 64 KB 给边界和分段头，取出文件后再按 20 MB 精确判断。
- **内容寻址**。键是内容 SHA-256 的前 16 位十六进制加检测出的扩展名。同样的内容总是同一个链接；已有对象永不覆盖：先 `head()`，不存在才写，写的时候再带 `etagDoesNotMatch: "*"` 条件，并发上传同一内容时后到的那个不会覆盖先到的。完整 SHA-256 存在元数据里，如果遇到前缀相同但内容不同的文件（64 位前缀，概率可以忽略），返回 409，不会把别人的链接指给新文件。去重时保留的是第一次上传的元数据。
- **永久保存**。没有过期和生命周期规则，删除只能走管理接口。
- **取图响应头**：`Content-Type`（存储的图片类型）、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline; filename="<key>"`、`Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`、`Cache-Control: public, max-age=31536000, immutable`、`ETag`、`Last-Modified`、`Content-Length`。直接在浏览器打开图片时，浏览器会生成一个内置的图片查看页，`img-src 'self'` 让它能显示图片本身，`style-src 'unsafe-inline'` 让它的内联样式生效，其他一切（脚本、外链、表单）都被禁止。
- **滥用追踪不存原始 IP**。每个对象的 R2 customMetadata 里有 `uploaded`（ISO 时间）、`source`（`HMAC-SHA256(IP_HASH_SECRET, CF-Connecting-IP)` 的十六进制）、`sha256`。拿不到 `IP_HASH_SECRET` 就无法从 `source` 反推 IP；同一个 IP 的所有上传 `source` 相同，所以能按来源整批清除。没配置 `IP_HASH_SECRET` 时上传返回 503，宁可不收也不存无法追溯的文件。Workers Logs 故意没开，避免请求日志里留下 IP。
- **走 Cloudflare 缓存出图**。CSAM Scanning Tool 只比对“通过 Cloudflare 缓存提供的内容”，而 Worker 自己的响应不进 zone 缓存。所以设置了 `CACHE_ORIGIN`（`wrangler.jsonc` 的 vars，目标是 `https://r2.sugi.moe`，即 bucket 的 R2 自定义域）后，`GET /<key>` 先用 bucket 绑定 `head()` 确认对象还在，再以 `cacheEverything` 经 zone 缓存去取 `r2.sugi.moe/<key>`，套上 sugi 自己的响应头返回。2026-11-02 实测 `r2.sugi.moe` 的第二次请求即 `cf-cache-status: HIT`。因为先查 bucket，删掉的对象立即 404，不依赖缓存清除；HEAD 和 304 不回源。删除和按来源清除在删完 R2 对象后调用 zone 的 purge API 清掉 `r2.sugi.moe/<key>`（每次最多 30 个 URL），需要 `ZONE_ID` 和 `CF_PURGE_TOKEN`。`CACHE_ORIGIN` 为空时照旧直接读 bucket。注意 `r2.sugi.moe` 本身也能直接访问到图片，只是不带 sugi 的那几个安全响应头，内容和权限与 `sugi.moe/<key>` 相同。
- **频率限制**用 Workers Rate Limiting 绑定（`wrangler.jsonc` 的 `ratelimits`），按来源 HMAC 计数，**每 60 秒 10 次**。这个绑定只支持 10 秒或 60 秒两种周期，所以没法直接写“每小时 60 次”，选了 60 秒 10 次：一次连传几张图不会被拦，持续上传的速率上限是每分钟 10 张。令牌校验在限流之前，没带对令牌的请求不消耗额度。注意这个绑定是按 Cloudflare 节点计数、最终一致的，不是精确配额：2026-11-02 在线上 16 秒内连发 60 次，前 42 次都放行，第 43 次起才开始返回 429。它能压住持续刷量，挡不住短时间的突发，所以 zone 上再加一条 WAF 速率规则（见下）。
- **可信令牌 `TRUSTED_TOKEN`**：维护者和 agent 用，和 `UPLOAD_TOKEN`、`ADMIN_TOKEN` 互相独立，同样用常量时间比较。带 `Authorization: Bearer <TRUSTED_TOKEN>` 的上传跳过 Worker 限流，并且在闸门开启时也能上传；它不能调用管理接口。没设置时没有任何效果。不按 IP 做白名单，因为维护者的 IP 会变，agent 还跑在另一台 Mac 上。
- **WAF 速率规则**（zone `sugi.moe`，Free 计划）：Free 计划只给 1 条速率规则，表达式只能匹配路径，计数周期和封禁时长都只能是 10 秒，按 IP 计数。规则是 `http.request.uri.path eq "/upload"`，每个 IP 每 10 秒最多 5 次，超出后封 10 秒（返回 429）。`/upload` 只接受 POST/PUT，其他方法本来就是 405，所以不按方法区分。Free 计划的速率规则表达式里不能写请求头，可信令牌的豁免放在一条自定义规则里：`http.request.uri.path eq "/upload" and any(http.request.headers["authorization"][*] eq "Bearer <TRUSTED_TOKEN>")` 时执行 Skip，跳过 `http_ratelimit` 阶段（自定义规则阶段在速率规则阶段之前执行）。WAF 无法验证令牌，只能按字面值匹配，**所以 `TRUSTED_TOKEN` 的值也写在这条 zone 规则里，轮换时必须两处一起改**。
- **首页**：纯 HTML 加一段内联脚本，不引用任何外部资源，不用框架。首页有自己的 CSP：`default-src 'none'; script-src 'nonce-<随机>'; style-src 'nonce-<随机>'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`，每次响应换一个 nonce，只有带这个 nonce 的那一段脚本和样式能执行；浏览器端的提示文字放在一个 `type="application/json"` 的数据块里，不执行。因为 nonce 每次不同，首页是 `Cache-Control: private, no-cache`，并带 `Vary: Accept-Language`。图片响应的 CSP 保持原样不变。
- **鉴权**：`Authorization: Bearer <token>`，比较前先对两边各做一次 SHA-256，再用 `crypto.subtle.timingSafeEqual` 比较，长度和内容都不会从耗时上泄露。

### Secrets

| 名称 | 作用 | 未设置时 |
| --- | --- | --- |
| `IP_HASH_SECRET` | 来源 HMAC 的密钥 | 上传返回 503 |
| `ADMIN_TOKEN` | 管理接口令牌 | 管理接口返回 403 |
| `UPLOAD_TOKEN` | 上传闸门令牌 | 匿名上传 |
| `TRUSTED_TOKEN` | 维护者令牌：过闸门、免限流 | 无可信令牌 |
| `CF_PURGE_TOKEN` | Cloudflare API token，只有 sugi.moe 的 Zone → Cache Purge 权限 | 开了 `CACHE_ORIGIN` 时删除返回 502 |

只存在两处：Cloudflare 的 Worker secrets，以及本机 `~/.config/sugi/secrets.env`（权限 600，`KEY=value` 格式）。`TRUSTED_TOKEN` 例外，它的值还在 zone 的 WAF 自定义规则里。不要提交到仓库，不要贴进 issue 或聊天。

`secrets.env` 会被 `wrangler deploy --secrets-file` 整个上传成 Worker secrets，所以只放 Worker 要用的东西。运维用的 Cloudflare API token（改 WAF 规则用）放在另一个文件 `~/.config/sugi/ops.env`（权限 600），不要放进 secrets.env。

非机密配置在 `wrangler.jsonc` 的 `vars`：`CACHE_ORIGIN`（走缓存的回源地址，空表示不走缓存）、`ZONE_ID`（sugi.moe 的 zone ID）。

## 开发

```sh
npm install
npm test            # vitest + @cloudflare/vitest-plugin，在本地 workerd 里跑
npm run typecheck
npx wrangler dev    # 本地调试，secrets 放 .dev.vars（已 gitignore）
```

`wrangler.jsonc` 里固定了 `account_id`，不需要再设 `CLOUDFLARE_ACCOUNT_ID`。改了 `wrangler.jsonc` 后跑一次 `npm run types` 重新生成 `worker-configuration.d.ts`。

部署：`npx wrangler deploy`。部署不会删除已有 secrets。

线上端到端检查：每次运行现场生成一张随机像素、带本次运行 ID 的合成 PNG，校验往返字节和响应头、HTML/SVG 被拒、闸门开启时匿名上传被拒、删除；然后用可信令牌和普通令牌各连发 `SUGI_E2E_BURST`（默认 100）次，可信令牌必须全部 201，普通令牌必须出现 429。

```sh
scripts/e2e.sh https://sugi.moe
```

**不要拿真实图片做测试再删掉。** 键是内容哈希，删一个键等于删掉所有人上传的同一份内容。脚本因此不接受输入文件，只删除本次运行确认由自己创建的对象（上传返回 201 且 `deduplicated:false`，删除前再核对 `sha256` 和上传时间）；连发产生的对象逐个按键删除，不用 `purge-by-source`，因为按来源清除会连带删掉同一台机器上的真实上传。

闸门关闭以后，脚本里“anonymous upload rejected”这一项会按预期失败。

## 运维手册

下面的命令都先加载令牌：

```sh
set -a; . ~/.config/sugi/secrets.env; set +a
admin() { printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" | curl -sS -K - "$@"; }
```

### 按 key 删除

收到举报链接 `https://sugi.moe/3f9a1c0b7e2d4a51.png`：

```sh
admin https://sugi.moe/admin/info/3f9a1c0b7e2d4a51.png     # 先看来源，留作记录
admin -X DELETE https://sugi.moe/3f9a1c0b7e2d4a51.png
```

删除后 `sugi.moe/<key>` 立即 404；开了 `CACHE_ORIGIN` 时还会清掉 `r2.sugi.moe/<key>` 的 zone 缓存，返回体里 `"cache_purged": true` 才算清干净，502 就重试。已经被 GitHub camo 或浏览器缓存的副本不受控制。

### 按来源清除

同一来源上传了一批违规内容时，先用 info 拿到 `source`，先干跑看匹配了哪些，再真删：

```sh
SRC=$(admin https://sugi.moe/admin/info/3f9a1c0b7e2d4a51.png | sed -E 's/.*"source":"([0-9a-f]+)".*/\1/')
admin -H 'content-type: application/json' -d "{\"source\":\"$SRC\",\"dry_run\":true}" https://sugi.moe/admin/purge-by-source
admin -H 'content-type: application/json' -d "{\"source\":\"$SRC\"}" https://sugi.moe/admin/purge-by-source
```

如果手上只有 IP（比如执法机关来函），本地算出它的 HMAC 再清除：

```sh
SRC=$(printf %s "$IP" | openssl dgst -sha256 -hmac "$IP_HASH_SECRET" -r | cut -d' ' -f1)
```

清除会遍历整个 bucket（每页 1000 个对象），对象数到几十万量级以前都没问题；再大就需要换成按来源建索引。

### 轮换 secrets

1. 在 `~/.config/sugi/secrets.env` 里换掉要轮换的值，例如 `openssl rand -hex 32`。
2. `npx wrangler deploy --secrets-file ~/.config/sugi/secrets.env`，文件里的 secrets 随新版本一起生效，没写在文件里的不会被删。
3. `npx wrangler secret list` 确认它们都是 `secret_text`。

轮换 `UPLOAD_TOKEN`、`ADMIN_TOKEN` 会立即让旧令牌失效。轮换 `TRUSTED_TOKEN` 时，**同一轮里**还要改 zone 的 WAF 自定义规则（Security → WAF → Custom rules → “sugi trusted uploads skip rate limit”）里的字面值，否则新令牌会被 WAF 限流，而旧令牌的值仍能绕过 WAF（但过不了 Worker）；各台机器的 secrets.env 也要同步更新。`CF_PURGE_TOKEN` 在 Dashboard → My Profile → API Tokens 里 Roll，再按上面两步更新。轮换 `IP_HASH_SECRET` 要小心：之后的新上传用新密钥算 `source`，旧对象的 `source` 不变，所以同一个 IP 在轮换前后会是两个不同的 `source`。按 IP 清理旧上传时还需要旧密钥，轮换前把旧值另存一份（同样权限 600）。

## 剩余上线步骤

已完成：

- 域名 sugi.moe 已在 Namecheap 注册，nameserver 指向 Cloudflare（`oaklyn` / `yisroel.ns.cloudflare.com`），zone 已在 Evan@yldm.tech's Account 激活（2026-11-02）。
- Worker 已挂上自定义域 `sugi.moe`（`wrangler.jsonc` 的 `routes`），线上端到端检查通过。
- bucket 已挂上 R2 自定义域 `r2.sugi.moe`，响应经 zone 缓存（实测 HIT）。
- Email Routing 已在 sugi.moe 启用（MX 和 SPF 记录由 Cloudflare 添加），规则 `abuse@sugi.moe` 转发到 `suzukaze.haduki@gmail.com`，该目标地址在 API 里显示已验证。
- `TRUSTED_TOKEN` 已上线。

还没做，按顺序：

1. **创建两个 Cloudflare API token**（wrangler 的 OAuth 登录没有创建 token 的权限，也没有改 WAF 规则的权限）。Dashboard → My Profile → API Tokens → Create Token → Custom token：
   - `sugi-worker-cache-purge`：Permissions 只加一条 Zone / Cache Purge / Purge；Zone Resources 选 Include / Specific zone / sugi.moe；Client IP Address Filtering 留空（Worker 的出口 IP 不固定）；TTL 不设。写进 `~/.config/sugi/secrets.env`，一行 `CF_PURGE_TOKEN=...`。
   - `sugi-ops-waf`：Permissions 只加一条 Zone / Zone WAF / Edit；Zone Resources 选 Include / Specific zone / sugi.moe；TTL 设短一点（例如一天），规则建好后可以删掉。写进 `~/.config/sugi/ops.env`，一行 `CF_OPS_TOKEN=...`，权限 600。**不要**写进 secrets.env。
2. **打开走缓存出图**：把 `wrangler.jsonc` 的 `CACHE_ORIGIN` 设为 `"https://r2.sugi.moe"`，执行 `npx wrangler deploy --secrets-file ~/.config/sugi/secrets.env`，跑一遍 `scripts/e2e.sh`，确认删除返回 `"cache_purged": true`。
3. **开启 CSAM Scanning Tool**（没有公开 API，只能在 Dashboard 操作）：Dashboard → Evan@yldm.tech's Account → sugi.moe → Caching → Configuration → CSAM Scanning Tool → Configure，通知邮箱填 `suzukaze.haduki@gmail.com`，按提示完成验证并启用。命中时每天发一封汇总邮件，Cloudflare 会尽量直接拦截命中的 URL（Worker 会把拦截结果透传出去）。
4. **建 WAF 规则**（用 `CF_OPS_TOKEN`）：一条自定义规则做可信令牌豁免（Skip `http_ratelimit`），一条速率规则（`/upload`，每 IP 10 秒 5 次，封 10 秒），见“设计”一节。用可信令牌连发验证不被拦，用普通令牌连发验证出现 429。
5. 发一封测试邮件到 `abuse@sugi.moe`，确认 `suzukaze.haduki@gmail.com` 能收到。
6. **开放匿名上传**（等维护者确认以上全部完成之后）：

   ```sh
   npx wrangler secret delete UPLOAD_TOKEN
   ```

   同时**从 `~/.config/sugi/secrets.env` 删掉 `UPLOAD_TOKEN` 那一行**，否则下次 `wrangler deploy --secrets-file` 会把闸门重新打开。之后访问 <https://sugi.moe/> 确认“上传需要令牌”的提示消失，用不带令牌的 `curl -T shot.png https://sugi.moe/upload` 验证一次。
