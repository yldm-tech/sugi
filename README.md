# sugi

水杉输入法（msime）项目自用的匿名图床，用来放 PR 截图。一个 Cloudflare Worker 加一个 R2 bucket，没有数据库，没有账号体系。

- 线上地址：<https://sugi.moe>（备用 <https://sugi.evan-e2b.workers.dev>）
- Cloudflare 账户：Evan@yldm.tech's Account（`e2b27aea5f599efdbe0a7016a2580d05`），Worker `sugi`，R2 bucket `sugi`，zone `sugi.moe`
- 当前状态：**上传闸门开启**，上传需要 `UPLOAD_TOKEN`，匿名上传尚未开放（见文末“剩余上线步骤”）

## 用法

```sh
# multipart，字段名 file
curl -F file=@shot.png https://sugi.moe/upload
# 或者直接 PUT 文件内容
curl -T shot.png https://sugi.moe/upload
# 要 JSON
curl -H 'Accept: application/json' -T shot.png https://sugi.moe/upload
```

成功返回图片直链，例如 `https://sugi.moe/3f9a1c0b7e2d4a51.png`。新文件返回 201，内容已存在返回 200 和同一个链接。JSON 形如 `{"url":…,"key":…,"size":…,"type":"image/png","deduplicated":false}`。

闸门开启期间要带令牌：`-H "Authorization: Bearer $SUGI_UPLOAD_TOKEN"`。

### 客户端脚本

`bin/sugi-upload` 一次上传一个或多个文件，每个文件输出一行链接（顺序与参数一致），任何一个失败都以非零退出码结束，错误写到 stderr，其余文件照常上传。curl 带 10 秒连接超时和 120 秒总超时，令牌通过 stdin 交给 curl，不会出现在进程列表里。

```sh
export SUGI_URL=https://sugi.moe          # 默认就是这个
export SUGI_UPLOAD_TOKEN=...               # 闸门开启期间需要
bin/sugi-upload before.png after.png
```

在 PR 里引用：`![after](https://sugi.moe/3f9a1c0b7e2d4a51.png)`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / HEAD | `/` | 说明页（纯 HTML，无外部资源） |
| POST / PUT | `/upload` | 上传；multipart 字段 `file`，或原始请求体 |
| GET / HEAD | `/<key>` | 取图，支持 `If-None-Match` 返回 304 |
| DELETE | `/<key>` | 删除，需 `ADMIN_TOKEN` |
| GET | `/admin/info/<key>` | 查看对象的上传时间、来源 HMAC、SHA-256，需 `ADMIN_TOKEN` |
| POST | `/admin/purge-by-source` | 按来源 HMAC 批量删除，需 `ADMIN_TOKEN` |

错误响应默认是纯文本，`Accept: application/json` 时是 `{"error": "..."}`。状态码：400 请求体为空或 multipart 缺 `file` 字段，401 令牌错误，403 管理接口未启用，404 不存在，405 方法不对，409 键冲突，413 超过 20 MB，415 类型不支持，429 超出频率限制（带 `Retry-After: 60`），503 未配置 `IP_HASH_SECRET`。

## 设计

- **类型只看文件头**。PNG（`89 50 4E 47 0D 0A 1A 0A`）、JPEG（`FF D8 FF`）、GIF（`GIF87a`/`GIF89a`）、WebP（`RIFF....WEBPVP8`），其余一律 415，包括 SVG 和 HTML。客户端给的文件名和 Content-Type 完全不看，存储和返回的 Content-Type 由检测结果决定。
- **大小上限 20 MB**。先看 Content-Length，超了直接拒绝；没有 Content-Length 的流式请求边读边计数，一过上限就中断，不会把超大请求整个读进内存。multipart 额外留 64 KB 给边界和分段头，取出文件后再按 20 MB 精确判断。
- **内容寻址**。键是内容 SHA-256 的前 16 位十六进制加检测出的扩展名。同样的内容总是同一个链接；已有对象永不覆盖：先 `head()`，不存在才写，写的时候再带 `etagDoesNotMatch: "*"` 条件，并发上传同一内容时后到的那个不会覆盖先到的。完整 SHA-256 存在元数据里，如果遇到前缀相同但内容不同的文件（64 位前缀，概率可以忽略），返回 409，不会把别人的链接指给新文件。去重时保留的是第一次上传的元数据。
- **永久保存**。没有过期和生命周期规则，删除只能走管理接口。
- **取图响应头**：`Content-Type`（存储的图片类型）、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline; filename="<key>"`、`Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`、`Cache-Control: public, max-age=31536000, immutable`、`ETag`、`Last-Modified`、`Content-Length`。直接在浏览器打开图片时，浏览器会生成一个内置的图片查看页，`img-src 'self'` 让它能显示图片本身，`style-src 'unsafe-inline'` 让它的内联样式生效，其他一切（脚本、外链、表单）都被禁止。
- **滥用追踪不存原始 IP**。每个对象的 R2 customMetadata 里有 `uploaded`（ISO 时间）、`source`（`HMAC-SHA256(IP_HASH_SECRET, CF-Connecting-IP)` 的十六进制）、`sha256`。拿不到 `IP_HASH_SECRET` 就无法从 `source` 反推 IP；同一个 IP 的所有上传 `source` 相同，所以能按来源整批清除。没配置 `IP_HASH_SECRET` 时上传返回 503，宁可不收也不存无法追溯的文件。Workers Logs 故意没开，避免请求日志里留下 IP。
- **频率限制**用 Workers Rate Limiting 绑定（`wrangler.jsonc` 的 `ratelimits`），按来源 HMAC 计数，**每 60 秒 10 次**。这个绑定只支持 10 秒或 60 秒两种周期，所以没法直接写“每小时 60 次”，选了 60 秒 10 次：一次 PR 连传几张截图不会被拦，持续上传的速率上限是每分钟 10 张。令牌校验在限流之前，没带对令牌的请求不消耗额度。注意这个绑定是按 Cloudflare 节点计数、最终一致的，不是精确配额：2026-11-02 在线上 16 秒内连发 60 次，前 42 次都放行，第 43 次起才开始返回 429。它能压住持续刷量，挡不住短时间的突发。
- **鉴权**：`Authorization: Bearer <token>`，比较前先对两边各做一次 SHA-256，再用 `crypto.subtle.timingSafeEqual` 比较，长度和内容都不会从耗时上泄露。

### Secrets

| 名称 | 作用 | 未设置时 |
| --- | --- | --- |
| `IP_HASH_SECRET` | 来源 HMAC 的密钥 | 上传返回 503 |
| `ADMIN_TOKEN` | 管理接口令牌 | 管理接口返回 403 |
| `UPLOAD_TOKEN` | 上传闸门令牌 | 匿名上传 |

只存在两处：Cloudflare 的 Worker secrets，以及本机 `~/.config/sugi/secrets.env`（权限 600，`KEY=value` 格式）。不要提交到仓库，不要贴进 issue 或聊天。

## 开发

```sh
npm install
npm test            # vitest + @cloudflare/vitest-plugin，在本地 workerd 里跑
npm run typecheck
npx wrangler dev    # 本地调试，secrets 放 .dev.vars（已 gitignore）
```

`wrangler.jsonc` 里固定了 `account_id`，不需要再设 `CLOUDFLARE_ACCOUNT_ID`。改了 `wrangler.jsonc` 后跑一次 `npm run types` 重新生成 `worker-configuration.d.ts`。

部署：`npx wrangler deploy`。部署不会删除已有 secrets。

线上端到端检查（会上传一张真实图片，校验往返字节和响应头、HTML/SVG 被拒、闸门开启时匿名上传被拒，最后删除测试对象）：

```sh
scripts/e2e.sh https://sugi.moe ~/msime-screenshots/settings-description-tooltip/after-macos-settings.png
```

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

Worker 的响应没有进 Cloudflare 边缘缓存，删除后立即 404；但已经被 GitHub camo 或浏览器缓存的副本不受控制。

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
3. `npx wrangler secret list` 确认三个都是 `secret_text`。

轮换 `UPLOAD_TOKEN`、`ADMIN_TOKEN` 会立即让旧令牌失效。轮换 `IP_HASH_SECRET` 要小心：之后的新上传用新密钥算 `source`，旧对象的 `source` 不变，所以同一个 IP 在轮换前后会是两个不同的 `source`。按 IP 清理旧上传时还需要旧密钥，轮换前把旧值另存一份（同样权限 600）。

## 剩余上线步骤

已完成：

- 域名 sugi.moe 已在 Namecheap 注册，nameserver 指向 Cloudflare（`oaklyn` / `yisroel.ns.cloudflare.com`），zone 已在 Evan@yldm.tech's Account 激活（2026-11-02）。
- Worker 已挂上自定义域 `sugi.moe`（`wrangler.jsonc` 的 `routes`），线上端到端检查通过。

还没做，按顺序：

1. **开启 Cloudflare CSAM Scanning Tool**：Dashboard → sugi.moe → Caching → Configuration → CSAM Scanning Tool，填写通知邮箱并完成验证。**注意**：官方文档说它比对的是“通过 Cloudflare 缓存提供的内容”，而目前图片由 Worker 直接从 R2 读出返回，不经过边缘缓存，很可能扫不到。开放匿名上传前需要先决定让图片走缓存（例如 Worker 改为经缓存回源，或给 bucket 挂一个 R2 自定义域专门出图），同时让删除接口调用 zone 的缓存清除 API，否则删掉的图会在各节点缓存里留到 `max-age` 过期。
2. **设置 Email Routing**：Dashboard → sugi.moe → Email → Email Routing，启用后添加规则 `abuse@sugi.moe` 转发到维护者邮箱，并验证目标地址。说明页上写的举报邮箱就是它，开放匿名上传前必须能收到信。
3. 按需在 zone 上加 WAF / 速率规则作为第二道限流（Worker 内的限流有突发放行的问题，见上文）。
4. **开放匿名上传**：

   ```sh
   npx wrangler secret delete UPLOAD_TOKEN
   ```

   同时**从 `~/.config/sugi/secrets.env` 删掉 `UPLOAD_TOKEN` 那一行**，否则下次 `wrangler deploy --secrets-file` 会把闸门重新打开。之后访问 <https://sugi.moe/> 确认“上传需要令牌”的提示消失，用不带令牌的 `curl -T shot.png https://sugi.moe/upload` 验证一次。
