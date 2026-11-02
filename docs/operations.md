# sugi.moe 运维手册

这份文档只适用于 YLDM Co., Ltd. 运营的 <https://sugi.moe>。自己部署 sugi 请看 [README](../README.md)。

## 部署

- Cloudflare 账户 `e2b27aea5f599efdbe0a7016a2580d05`（也是 zone `sugi.moe` 所在的账户；Worker 的自定义域必须和 zone 在同一个账户）。
- Worker `sugi`，配置在 [`wrangler.production.jsonc`](../wrangler.production.jsonc)；R2 bucket `sugi`（存储区域 APAC，自定义域 `r2.sugi.moe` 作为走缓存的回源地址）；D1 数据库 `sugi`（`61f7d685-83be-4cad-9a56-b6ce9887affb`）。
- 自定义域：`sugi.moe`（网站和接口）、`files.sugi.moe`（永久文件）、`tmp.sugi.moe`（临时文件），workers.dev 入口关闭。
- 生产环境开放匿名上传：Worker secrets 里没有 `UPLOAD_TOKEN`。
- 部署只用 `npm run deploy:production`（[`scripts/deploy-production.sh`](../scripts/deploy-production.sh)）：它先拒绝含 `UPLOAD_TOKEN` 或缺少必要 secret 的 secrets 文件，打印当前版本作为回滚目标，再执行 `wrangler deploy --config wrangler.production.jsonc --secrets-file ~/.config/sugi/secrets.env`。回滚：`npx wrangler rollback <版本 id> --config wrangler.production.jsonc`。
- 每次部署后跑 `scripts/e2e.sh https://sugi.moe`（旧链接、`bin/sugi-upload`、新接口、缓存清除、限流和 WAF），开了 `FEATURE_CLI` 时再跑 `SUGI_TOKEN=<TRUSTED_TOKEN> scripts/cli-e2e.sh https://sugi.moe`。两个脚本都只上传现场生成的合成文件，并删掉自己创建的所有对象。

## 生产环境才有的设置

- **缓存出图和 CSAM Scanning Tool**：`CACHE_ORIGIN=https://r2.sugi.moe`，Worker 经 zone 缓存取文件，所以 Cloudflare 的 CSAM Scanning Tool 能看到每个文件（Dashboard → sugi.moe → Caching → Configuration → CSAM Scanning Tool，通知发到维护者邮箱）。删除时用 `CF_PURGE_TOKEN`（只有 sugi.moe 的 Zone → Cache Purge 权限）清缓存。
- **R2 生命周期兜底**：规则 `expire-tmp`，`t/` 前缀 4 天后删除。
- **Email Routing**：`hi@sugi.moe`、`admin@sugi.moe`、`abuse@sugi.moe` 转发给维护者。
- **WAF 速率规则**（zone `sugi.moe`，Free 计划只能按路径匹配、周期和封禁都是 10 秒）：`http.request.uri.path in {"/upload" "/api/upload" "/api/uploads"}`，每个 IP 每 10 秒最多 5 次，超出封 10 秒（429，`error code: 1015`）。分片的后续片（`/api/uploads/<n>`）和 complete 不计数。可信令牌的豁免是一条自定义规则：同样的路径并且 `Authorization` 正好等于 `Bearer <TRUSTED_TOKEN>` 时 Skip `http_ratelimit` 阶段。WAF 无法验证令牌，只能按字面值匹配，**所以 `TRUSTED_TOKEN` 的值也写在这条 zone 规则里，轮换时必须两处一起改**。2026-11-02 两条规则从只匹配 `/upload` 扩大到上面三个路径，线上验证：普通令牌第 6 次起被拦，可信令牌不受影响。

  | 规则                                                     | 阶段                           | ruleset ID                         | rule ID                            |
  | -------------------------------------------------------- | ------------------------------ | ---------------------------------- | ---------------------------------- |
  | sugi trusted uploads skip rate limit（自定义规则，Skip） | `http_request_firewall_custom` | `27e91a99f7b8408fabc6039282a8087e` | `d16fcfbd3bc34e69a2bcbc3a5549a5fc` |
  | sugi upload rate limit per IP（速率规则，Block）         | `http_ratelimit`               | `ad7a86bc252e4cd08ddc0c1ca0e7678d` | `268641d130ef4e5d96184b7f1f57aa4d` |


## Secrets

Secrets 只存在两处：Cloudflare 的 Worker secrets，以及本机 `~/.config/sugi/secrets.env`（权限 600）。`TRUSTED_TOKEN` 例外，它的值还在 zone 的 WAF 自定义规则里。`secrets.env` 会被 `wrangler deploy --secrets-file` 整个上传，所以只放 Worker 要用的东西；改 WAF 用的 ops token 放在 `~/.config/sugi/ops.env`。

## 常用操作

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
2. `npm run deploy:production`。
3. `npx wrangler secret list --config wrangler.production.jsonc` 确认都是 `secret_text`。

轮换 `TRUSTED_TOKEN` 时同一轮里要改 WAF 自定义规则（上表的 rule，`PATCH /zones/0ec67ba827776b3d9e3452483205b04c/rulesets/27e91a99f7b8408fabc6039282a8087e/rules/d16fcfbd3bc34e69a2bcbc3a5549a5fc` 更新 `expression`）。轮换 `IP_HASH_SECRET` 会让同一 IP 前后有两个不同的 `source`，并让进行中的分片上传会话失效；轮换前把旧值另存一份。

## 首次上线记录

已完成：zone、`sugi.moe` 自定义域、`r2.sugi.moe`、缓存出图和清除、WAF 两条规则（已覆盖新接口）、Email Routing `abuse@sugi.moe`、`TRUSTED_TOKEN`、D1 数据库 `sugi`（已创建，表结构见 `migrations/`）。

2026-11-02 改版上线时的步骤：

1. 远端 D1 建表：`npx wrangler d1 migrations apply sugi --remote`。
2. R2 生命周期兜底：`npx wrangler r2 bucket lifecycle add sugi expire-tmp t/ --expire-days 4`。
3. `npx wrangler deploy --secrets-file ~/.config/sugi/secrets.env`（当时生产配置还在 `wrangler.jsonc` 里，现在用 `npm run deploy:production`）：会同时挂上 `files.sugi.moe` 和 `tmp.sugi.moe` 两个自定义域，并启用 Cron Trigger。
4. `scripts/e2e.sh https://sugi.moe`。

每次部署前仍要确认：

1. **CSAM Scanning Tool 已开启**（FAQ 和隐私政策里写了“会由 Cloudflare 的 CSAM 扫描工具检测”）：Dashboard → sugi.moe → Caching → Configuration → CSAM Scanning Tool，通知发到维护者邮箱。
2. `~/.config/sugi/secrets.env` 里**没有** `UPLOAD_TOKEN`：`--secrets-file` 部署会把文件里的每一项都设成 Worker secret，有这一行就会把闸门重新打开。
3. 隐私政策和使用条款已经由维护者审阅（`src/site/pages/privacy.ts` 里带 `review` 备注的段落）。
