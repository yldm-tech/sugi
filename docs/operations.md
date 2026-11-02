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
- **Email Routing**：`hi@sugi.moe`、`admin@sugi.moe`、`abuse@sugi.moe` 转发给维护者。另有一条规则（`6bfbafccef50455aac3eead4ed146e22`）只把测试地址 `E2E_INBOX`（`~/.config/sugi/ops.env`，同时在 `secrets.env` 里，部署时带给 Worker）交给 Worker；catch-all 关闭。
- **账号**：`FEATURE_ACCOUNTS=1`，`ACCOUNT_FEATURES=email,github,google,passkey,sync,tokens`。登录邮件经 Resend（东京区域）从 `login@sugi.moe` 发出，免费额度每天 100 封，和真实用户共用，所以 e2e 每次只发一封。邮件登录的 e2e：向 `E2E_INBOX` 请求登录链接，从 `/admin/e2e-inbox`（或 MCP 的 `read_test_inbox`）取出链接，确认登录、上传归属和退出。`npm run check:account` 跑整套：登录、同步、认领、API 令牌，以及视频规则（匿名视频 403，会话和个人令牌传视频 201），测试令牌最后吊销。
- **视频要登录**：`VIDEO_UPLOADS=account`。CSAM Scanning Tool 只检测图片，所以匿名上传只收图片，视频要登录的会话、API 令牌或 `TRUSTED_TOKEN`/`ADMIN_TOKEN`，否则 403。经 MCP `create_upload` 拿到的上传链接会记下申请人，按申请人的身份判断。
- **管理员令牌**：带 `ADMIN_TOKEN` 的 MCP 请求会多出管理工具（处理举报的流程见下文），并且和 `TRUSTED_TOKEN` 一样不受限流；WAF 跳过规则里两个令牌都有。
- **个人 admin 令牌**：`api_tokens.role` 设为 `admin` 的个人 API 令牌（只能在 D1 里直接改）和 `ADMIN_TOKEN` 一样能用管理工具、不受 Worker 限流；但 WAF 跳过规则里只有两个共享令牌，所以个人 admin 令牌在 `/upload`、`/api/upload`、`/api/uploads` 上仍会被 WAF 按 IP 限速。这是有意的取舍：MCP 不在 WAF 规则里，维护者的命令行用共享的 `TRUSTED_TOKEN`。
- **WAF 速率规则**（zone `sugi.moe`，Free 计划只能按路径匹配、周期和封禁都是 10 秒）：`http.request.uri.path in {"/upload" "/api/upload" "/api/uploads"}`，每个 IP 每 10 秒最多 5 次，超出封 10 秒（429，`error code: 1015`）。分片的后续片（`/api/uploads/<n>`）和 complete 不计数。可信令牌的豁免是一条自定义规则：同样的路径并且 `Authorization` 正好等于 `Bearer <TRUSTED_TOKEN>` 时 Skip `http_ratelimit` 阶段。WAF 无法验证令牌，只能按字面值匹配，**所以 `TRUSTED_TOKEN` 的值也写在这条 zone 规则里，轮换时必须两处一起改**。2026-11-02 两条规则从只匹配 `/upload` 扩大到上面三个路径，线上验证：普通令牌第 6 次起被拦，可信令牌不受影响。

  | 规则                                                     | 阶段                           | ruleset ID                         | rule ID                            |
  | -------------------------------------------------------- | ------------------------------ | ---------------------------------- | ---------------------------------- |
  | sugi trusted uploads skip rate limit（自定义规则，Skip） | `http_request_firewall_custom` | `27e91a99f7b8408fabc6039282a8087e` | `d16fcfbd3bc34e69a2bcbc3a5549a5fc` |
  | sugi upload rate limit per IP（速率规则，Block）         | `http_ratelimit`               | `ad7a86bc252e4cd08ddc0c1ca0e7678d` | `268641d130ef4e5d96184b7f1f57aa4d` |

- **上传限流（2026-11-02 起）**：Worker 里没登录时每个来源（IP 的 HMAC）每分钟 10 次（`UPLOAD_LIMITER`），登录的账号（会话或个人 API 令牌）按账号每分钟 60 次（`ACCOUNT_LIMITER`），每日额度照旧。zone 的 WAF 跳过规则除了两个共享令牌，现在也跳过带 `sugi_session=` cookie 或 `Authorization: Bearer sugi_…` 的请求：伪造 cookie 只能绕过边缘这一层粗限流，Worker 仍按 IP 限制（cookie 无效时按匿名算），伪造的令牌直接 401。网页会根据页面配置里的限额自己排队、控速，碰到 429 就倒计时自动重试（最多 6 次），只有每日额度用完才算失败；命令行同样会控速并按 Retry-After 重试。
- **监控**：日报和告警发到 secret `OPS_EMAIL`（在 `secrets.env` 里），由 cron `5 0 * * *` 发前一天的日报，每 10 分钟检查一次告警。`/healthz` 可以接 UptimeRobot 一类的外部监控。日报和告警都走 Resend，与登录邮件共用每天 100 封的免费额度。
- **Cloudflare 通知**（要在控制台里开，API 令牌没有 Notifications 权限）：Manage Account → Notifications → Add → Billing → Usage Based Billing，分别给 Workers、R2、D1 设阈值；以及 Workers Weekly Summary。

## Staging

- **地址**：https://sugi-staging.evan-e2b.workers.dev （Worker `sugi-staging`，配置 `wrangler.staging.jsonc`）。和 sugi.moe 跑同一份代码、同样的设置，但数据库（D1 `sugi-staging`，`e0345a79-7076-447b-bd8f-e6015aeb1bdd`）、bucket（R2 `sugi-staging`）、限流计数（namespace 48615、48616）和 secrets 都是独立的。`NOINDEX=1`：robots.txt 全部禁止，所有响应带 `X-Robots-Tag: noindex`。
- **和生产的区别**：workers.dev 前面没有 zone，所以没有 WAF 规则、没有经 r2.sugi.moe 的缓存回源、没有 CSAM 扫描；文件从同一域名的 `/_files`、`/_tmp` 出图。没有 OAuth（GitHub、Google 的回调只登记了 sugi.moe），`ACCOUNT_FEATURES=email,passkey,sync,tokens`。不发日报（没有 `OPS_EMAIL`）。
- **secrets**：`~/.config/sugi/staging.env`（600）：自己的 `IP_HASH_SECRET`、`ADMIN_TOKEN`、`TRUSTED_TOKEN`，以及和生产共用的 `RESEND_API_KEY`、`E2E_INBOX`（为了能测邮件登录）。
- **部署**：`npm run deploy:staging`（先 `d1 migrations apply --remote`，再 deploy）。改动先上 staging、跑完测试再上生产。
- **测试默认打 staging**：`scripts/e2e.sh`、`scripts/cli-e2e.sh`、`npm run check:layout`、`npm run check:passkey`、`npm run check:account` 不带地址时都打 staging，令牌自动从 `staging.env` 取。`check:account` 的登录邮件只能投递到生产 Worker（Email Routing），所以它从 https://sugi.moe 的 E2E 收件箱（生产的 `ADMIN_TOKEN`）读信，再去 staging 点链接，每次运行发一封 Resend 邮件。要测生产时把 `https://sugi.moe` 作为参数传进去（e2e.sh 会自动打开 WAF 和缓存回源检查）。
- **生产只做轻量检查**：`scripts/deploy-production.sh` 部署完会自动跑 `scripts/smoke.sh https://sugi.moe`：`/healthz`、几个页面、用可信令牌传一个文件、原样取回、用删除凭证删掉、确认 404。
- **CI 部署 staging**（`.github/workflows/staging.yml`）：main 上的 CI 通过后自动做远程迁移、部署 `sugi-staging`，再对它跑 `smoke.sh` 和 `e2e.sh`；也可以在 Actions 里手动触发（workflow_dispatch）。用的是仓库 secret `CLOUDFLARE_API_TOKEN`：Account 级、只限 yldm 账号，`Workers Scripts: Edit`、`D1: Edit`、`Workers R2 Storage: Read`（实际给的令牌还能只读列出 sugi.moe zone），没有过期时间。staging 的管理员和可信令牌存为仓库 secret `STAGING_ADMIN_TOKEN`、`STAGING_TRUSTED_TOKEN`（和 `~/.config/sugi/staging.env` 一致，轮换时两处一起改）。Worker 的 secrets 部署之间会保留，所以 CI 不需要其他 secrets。**生产仍然只从维护者本机部署**（`npm run deploy:production`）；以后要让 CI 部署生产，需要另一枚加了 sugi.moe 的 `Workers Routes: Edit` 和 `DNS: Edit` 的令牌，只给受保护的环境用。

## 备份

- **内容**：R2 `sugi` 里永久保存的文件（`f/` 和旧接口的 `<16 位十六进制>.<扩展名>`）复制到 R2 `sugi-backup`（APAC，和主 bucket 同一位置，隐私政策里写的存储区域不变）。临时文件（`t/`）不备份。staging 对应 `sugi-staging-backup`。
- **频率**：每 10 分钟的 cron 处理一批（100 个对象），按游标（`ops_state` 里的 `backup_cursor`）把整个 bucket 一轮轮走完；源对象的 etag 记在副本的 `src_etag` 里，没变的不重复复制。按现在的规模每轮几分钟就走完，所以新文件一般在半小时内进备份。
- **删除**：用户删掉（或账号删除连带删掉）的文件，备份副本再留 7 天（`backup_gone` 表记开始时间），之后清理，防止误删一大批时无法恢复。**下架的文件立即从备份删除**（下架流程里直接删，备份清理也会再检查一次墓碑），恢复时也永远跳过墓碑。
- **数据库**：D1 不在这个备份里，用 D1 自带的 Time Travel（`wrangler d1 time-travel info sugi` / `restore sugi --timestamp=…`，免费计划可回到 7 天内任一时刻）。
- **查看**：管理员 MCP 的 `backup_status`（对象数、字节数、等待清理的已删除副本）。

### 恢复

1. 先查：`backup_status`；再对要恢复的范围跑 `restore_from_backup`，默认 `dry_run: true`，只列出会恢复的 key。
2. 单个或几个文件：`restore_from_backup {"keys": ["f/<id>", "abcd0123abcd0123.png"], "dry_run": false}`。文件、元数据（删除凭证的哈希、名称、到期时间、来源）原样回到主 bucket，链接立即恢复；已存在的对象不会被覆盖（`onlyIf`），下架的不会恢复。
3. 一大批（比如误删、bucket 被清空）：不带 `keys`，`{"dry_run": false, "limit": 200}` 一页页恢复，每次用返回的 `next_cursor` 接着调，直到它为 `null`。一页在 Worker 里流式复制，200 个小图片在 CPU 限制内；大文件多时把 `limit` 调小。
4. 整个 bucket 都没了：先 `wrangler r2 bucket create sugi --location apac`（同名、同绑定），再按第 3 步全量恢复；D1 用 Time Travel 回到事故前。
5. 恢复的文件不会自动回到用户账号的「我的文件」里（那是 D1 的 `file_owners`），D1 用 Time Travel 恢复后就一并回来了。

### 成本

- 存储翻倍，但目前远在免费额度内：主 bucket 约 42 MB（见投喂页的实测），备份同样大小，两者合计远低于每月 10 GB 免费存储。超出后备份按 US$0.015/GB·月计，例如永久文件 100 GB 时备份每月多 US$1.50（不含免费额度）。
- 操作次数：每次 cron 两次 list（Class A）、最多 200 次 head（Class B），每月约 8,600 次 Class A、约 86 万次 Class B，加上每个新文件一次 put（Class A），都在免费额度（每月 100 万次 A、1,000 万次 B）内。R2 没有出口流量费，bucket 之间复制也不收流量费。

## 费用

投喂页上不放成本和用量，运营者自己看这里（价格 2026-11-02 核对）：

- **现在**：Workers、D1 在免费计划内；R2 每月前 10 GB 存储、100 万次写、1000 万次读免费（主 bucket 加备份目前合计约 85 MB）；Resend 免费额度每天 100 封、每月 3,000 封；域名 sugi.moe 每年续费（Namecheap，价格待补）。
- **超出后**：[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) 每月 US$5 起（每天请求超过 10 万次时需要；也能放开 CPU 限制，让超过 20 MB 的文件也算内容哈希、下架后挡住重传）；[R2](https://developers.cloudflare.com/r2/pricing/) 存储每 GB·月 US$0.015，写每百万次 US$4.50，读每百万次 US$0.36，流量免费；[Resend Pro](https://resend.com/pricing) 每月 US$20，含 5 万封。
- 存储量随时可以用管理员 MCP 的 `ops_report`（`storage_bytes`）和 `backup_status` 查。

## Secrets

Secrets 只存在两处：Cloudflare 的 Worker secrets，以及本机 `~/.config/sugi/secrets.env`（权限 600）。`TRUSTED_TOKEN` 例外，它的值还在 zone 的 WAF 自定义规则里。`secrets.env` 会被 `wrangler deploy --secrets-file` 整个上传，所以只放 Worker 要用的东西；改 WAF 用的 ops token 放在 `~/.config/sugi/ops.env`。

## 常用操作

```sh
set -a; . ~/.config/sugi/secrets.env; set +a
admin() { printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" | curl -sS -K - "$@"; }
```

### 处理举报（MCP）

`sugi` MCP 服务按请求带的令牌决定权限：带 `ADMIN_TOKEN` 时多出一组管理工具（普通请求看不到也调用不了），并且不受限流。同一个 MCP 条目，把请求头换成管理员令牌即可。

0. `list_reports`：网站上「举报」表单提交的举报（默认只列未处理的），带原因、链接、举报人写的说明和留下的邮箱。新举报会汇总发到 abuse@sugi.moe，最多一小时一封，涉及 CSAM 的标题带 URGENT。看完用 `inspect` 查链接，再 `resolve_report`：`action: "takedown"` 等于下面第 2 步的下架（原因自动记成举报编号加 `note`，CSAM 加 `block_content: true`），`action: "dismiss"` 保留内容并记审计日志。同一链接上所有未处理的举报会一起结掉。不是表单来的举报（邮件直接写到 abuse@）照下面的步骤处理。
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
