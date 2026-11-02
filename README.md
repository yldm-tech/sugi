# sugi

[简体中文](README.zh-CN.md)

sugi is an anonymous image and short-video host that runs entirely on Cloudflare: one Worker, one R2 bucket for the files and one D1 database for albums. No sign-up: drop in a picture or a short video and get a direct link, kept forever or deleted after 1 hour, 12 hours or 3 days. It comes with a bilingual (Chinese and English) website, an HTTP API, a command-line tool and an MCP server, and a hamster that stuffs everything into its cheeks.

The instance run by its authors is <https://sugi.moe>. This repository deploys your own: your name, your domain, your rules.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yldm-tech/sugi)

<p align="center"><img src="https://files.sugi.moe/ra0q3vx8.png" alt="The sugi home page on a desktop browser" width="640"> <img src="https://files.sugi.moe/qv2ib7oj.png" alt="The sugi home page on a phone" width="180"></p>

## Features

- Images and short videos: PNG, JPEG, WebP, GIF, AVIF, MP4 and WebM, up to 200 MB per file. The type is decided from the file's bytes, never from its name or Content-Type; everything else (SVG, HTML, PDF, archives…) is refused.
- Uploads by drag and drop, file picker, paste, or a link to import. Files over 90 MB are uploaded in chunks (R2 multipart), so they fit under Cloudflare's request body limit.
- Permanent or temporary links (1 h / 12 h / 72 h), random ids (`k3x9qa2m`) or cute ones (`snow-sesame-19`), share pages with copyable Markdown, HTML and BBCode, and albums that bundle files behind one link.
- "My files" keeps the history and delete tokens in the browser, so no account is needed. Location metadata (EXIF, XMP) is stripped in the browser before upload by default.
- Optional accounts with passwordless email login (`FEATURE_ACCOUNTS`); uploads made while logged in are recorded under the account.
- No IP addresses are stored. Each upload records an HMAC of the uploader's IP under a server-side key, which is enough to remove everything from one abusive source and nothing more.
- Per-IP rate limits, strict security headers (nonce-based CSP, `nosniff`, files served from a separate origin with their own CSP), no third-party scripts, fonts or analytics.
- `curl -F file=@cat.png https://<your host>/api/upload` returns a link; the `sugi` CLI and the MCP server (`/mcp`) let terminals and AI assistants upload too, including local files through one-time upload links.
- Moderation for the operator over HTTP and MCP: takedowns that leave a 451 tombstone, content and source blocklists, and an audit log.

## Deploy

### One click

Press **Deploy to Cloudflare** above. Cloudflare copies this repository into your GitHub or GitLab account, creates the R2 bucket and the D1 database, asks for the two secrets below and deploys the Worker. The site then works on its `*.workers.dev` address; the Worker creates its database tables on the first request.

| Secret           | What to enter                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IP_HASH_SECRET` | A long random value, e.g. `openssl rand -hex 32`. Keys the HMAC of uploader IPs and signs chunked upload sessions. Uploads are refused (503) until it is set, and the home page says so. |
| `ADMIN_TOKEN`    | Another long random value. Lets you delete any file and purge everything from one source (see [Moderation](#moderation)).                                                                |

Before you share the link, set at least `SITE_NAME`, `OPERATOR_NAME` and `CONTACT_EMAIL` (see [Configuration](#configuration)) and read your terms and privacy pages: they describe _your_ service, and you are responsible for them.

### From a clone

```sh
git clone https://github.com/<you>/sugi && cd sugi
npm install
npx wrangler login
npm run deploy                      # creates the bucket and the database on the first run
npx wrangler secret put IP_HASH_SECRET
npx wrangler secret put ADMIN_TOKEN
```

Change `"name"` in `wrangler.jsonc` first if you want something other than `my-sugi`.

## Configuration

Everything that makes an instance yours is a variable in [`wrangler.jsonc`](wrangler.jsonc) (`vars`). Empty values fall back to defaults that work on a bare `*.workers.dev` address.

| Variable                             | Default                        | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_NAME`                          | the hostname                   | Shown in titles, the logo (`pics.example` becomes `pics♥example`), Open Graph and the legal pages.                                                                                                                                                                                                                                                        |
| `MAIN_ORIGIN`                        | the request's origin           | Public origin of the website and API, e.g. `https://pics.example.org`.                                                                                                                                                                                                                                                                                    |
| `FILES_ORIGIN`, `TMP_ORIGIN`         | `<main>/_files`, `<main>/_tmp` | Where permanent and temporary files are served. With your own domain, use dedicated hostnames (`https://files.example.org`, `https://tmp.example.org`) and add them as custom domains: uploaded files then never share an origin with the site.                                                                                                           |
| `OPERATOR_NAME`                      | none                           | Person or company running the site, named on the terms and privacy pages.                                                                                                                                                                                                                                                                                 |
| `CONTACT_EMAIL`, `ABUSE_EMAIL`       | none                           | General and privacy contact, and where abuse reports go (falls back to the contact). Without them the pages tell visitors to contact the operator.                                                                                                                                                                                                        |
| `CSAM_SCANNING`                      | `0`                            | Set to `1` only after enabling Cloudflare's [CSAM Scanning Tool](https://developers.cloudflare.com/cache/reference/csam-scanning/) on your zone and serving files through the cache (`CACHE_ORIGIN`). The FAQ and privacy policy only mention it when this is on.                                                                                         |
| `EMAIL_ROUTING`                      | `0`                            | Set to `1` if mail to your contact addresses goes through Cloudflare Email Routing; the privacy policy then lists it.                                                                                                                                                                                                                                     |
| `WAF_RATE_LIMIT`                     | `0`                            | Set to `1` once your zone has the WAF rule from [Rate limits](#rate-limits); the developer page then describes it.                                                                                                                                                                                                                                        |
| `STORAGE_LOCATION`                   | none                           | R2 location hint or jurisdiction of your bucket (`apac`, `weur`, `eu`…), stated in the privacy policy.                                                                                                                                                                                                                                                    |
| `MAIL_FROM`, `RESEND_REGION` | none | Accounts: sender of login emails (e.g. `pics <login@example.org>`, a domain verified with your mail provider) and, for the privacy policy, the Resend region. Login emails go through Resend (`RESEND_API_KEY` secret) or a `send_email` binding named `EMAIL`. |
| `CACHE_ORIGIN`, `ZONE_ID`            | none                           | Serve files through your zone's cache: an [R2 custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains) on the bucket (e.g. `https://r2.example.org`) and the zone id. Deleting a file then purges it from the cache, which needs the `CF_PURGE_TOKEN` secret (an API token with Zone → Cache Purge on that zone only). |
| `FEATURE_CLI`                        | `1`                            | The `sugi` CLI (`/install.sh`) and the MCP server (`/mcp`).                                                                                                                                                                                                                                                                                               |
| `FEATURE_ACCOUNTS` | `0` | Optional accounts. `ACCOUNT_FEATURES` lists the parts that are on; currently only `email` (magic-link login) is available. |
| `ACCOUNT_FEATURES` | `email` | Comma-separated account features to enable when `FEATURE_ACCOUNTS` is `1`. |
| `FEATURE_DONATE` | `0` | A donation page; it shows only the amounts and payment links you put in `src/site/pages/donate.ts`. |

Optional secrets: `UPLOAD_TOKEN` closes uploads to everyone without `Authorization: Bearer <UPLOAD_TOKEN>` (useful for a private instance); `TRUSTED_TOKEN` passes that gate and skips the rate limits (for yourself and your automation); `CF_PURGE_TOKEN` as above; `RESEND_API_KEY` for login emails; `E2E_INBOX`, one hard-to-guess address on your domain routed to the Worker with Email Routing, whose mail the Worker keeps for an hour so automated tests can complete an email login (admins read it at `/admin/e2e-inbox`).

After changing `wrangler.jsonc`, run `npm run types` and deploy again. The bucket, the database, the rate limiter and a cron trigger that deletes expired files every 10 minutes are all declared there. Expired files already return 404 the moment they expire; as a safety net you can also add an R2 lifecycle rule: `npx wrangler r2 bucket lifecycle add <bucket> expire-tmp t/ --expire-days 4`.

### Rate limits

The Worker allows each IP 10 uploads (and separately 10 albums) per 60 seconds through the [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). That binding counts per Cloudflare location and is eventually consistent, so a fast burst gets through well past the limit before it bites (in our tests the first 429 came after about 85 sequential uploads). For a public instance on your own domain, add a WAF rate limiting rule as well (free plan: path match, 10-second period):

- Expression: `http.request.uri.path in {"/upload" "/api/upload" "/api/uploads"}`, characteristic IP, 5 requests per 10 seconds, action Block for 10 seconds.
- If you use `TRUSTED_TOKEN`, add a custom rule before it that skips the `http_ratelimit` phase when `http.request.uri.path` matches the same paths and `any(http.request.headers["authorization"][*] == "Bearer <TRUSTED_TOKEN>")`. The WAF cannot verify tokens, so the value itself is in the rule; change both together when you rotate it.

Then set `WAF_RATE_LIMIT` to `1`.

### Moderation

```sh
admin() { printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" | curl -sS -K - "$@"; }
admin https://<host>/admin/info/f/k3x9qa2m                  # metadata, including the source HMAC (t/<id> for temporary files)
admin -X DELETE https://<host>/api/files/k3x9qa2m
admin -X DELETE https://<host>/api/albums/<id>
admin -H 'content-type: application/json' -d '{"source":"<hmac>","dry_run":true}' https://<host>/admin/purge-by-source
```

Purge by source removes every file and album uploaded from the same IP. If you only have an IP: `printf %s "$IP" | openssl dgst -sha256 -hmac "$IP_HASH_SECRET" -r`.

An admin deletion is a takedown: the object is replaced by an empty tombstone, so the link answers 451 Unavailable For Legal Reasons from then on and the id is never reused, every URL it was served from is purged, and the action is recorded in an audit log in D1. Add `?reason=...` to record why, and `?block_content=1` to block the same bytes (files up to 20 MB) from being uploaded again.

The same moderation is available over MCP: connect to `https://<host>/mcp` with `Authorization: Bearer <ADMIN_TOKEN>` and the server adds `inspect`, `takedown` (with `block_content`, and `include_files` for albums), `list_by_source`, `takedown_by_source` (dry run by default), `block_source` / `unblock_source`, `unblock_content`, `list_blocks` and `takedown_log`. Handling a report: `inspect` the link, `takedown` it, `list_by_source` to see what else that uploader posted, then `takedown_by_source` or `block_source` if the whole source is abusive. The admin token is also never rate limited; if you use the WAF rule, add it to the skip rule next to `TRUSTED_TOKEN`.

## Security checklist

Before you open an instance to the public:

- Set long random values for `IP_HASH_SECRET` and `ADMIN_TOKEN`, and keep them out of the repository (`wrangler secret put` or the dashboard).
- Use your own domain with separate hostnames for `FILES_ORIGIN` and `TMP_ORIGIN`, so uploaded files never share an origin with the site and its cookies.
- Add the WAF rate limiting rule from [Rate limits](#rate-limits); the Worker's own limiter is permissive under bursts.
- Serve files through the cache (`CACHE_ORIGIN`, `ZONE_ID`, `CF_PURGE_TOKEN`) and enable Cloudflare's CSAM Scanning Tool on the zone, then set `CSAM_SCANNING=1`.
- Set `OPERATOR_NAME`, `CONTACT_EMAIL` and `ABUSE_EMAIL`, make sure mail to them reaches you, and read the generated terms and privacy pages as your own legal text.
- Leave Workers Logs off (the template does) unless you change the privacy policy to say otherwise.
- Keep an eye on reports and use the [moderation](#moderation) tools; consider a takedown with `block_content` for anything that must never come back.

## Using it

### HTTP API

```sh
curl -F "file=@cat.png" https://<host>/api/upload                    # permanent; prints the link
curl -F "file=@cat.png" -F "expire=1h" https://<host>/api/upload     # temporary: 1h / 12h / 72h
curl -F "url=https://example.com/a.png" https://<host>/api/upload    # import from a link
curl -T cat.png "https://<host>/api/upload?expire=12h&style=cute"    # raw PUT, options in the query
curl -H 'Accept: application/json' -F "file=@cat.png" https://<host>/api/upload
curl -X DELETE -H "Sugi-Token: d_…" https://<host>/api/files/<id>
```

With `Accept: application/json` you get `{"id", "url", "page", "size", "type", "name", "expires_at", "delete_token"}`. The developer page (`/dev`) on every instance documents the full API: chunked uploads, file info, albums, errors and limits. The original content-addressed endpoint `POST /upload` (images up to 20 MB, links like `/<16 hex>.png`) is kept for old clients.

### Command line and MCP

```sh
curl -fsSL https://<host>/install.sh | sh     # installs ~/.local/bin/sugi after checking its SHA-256
sugi up cat.png dog.gif                       # one link per file, copied to the clipboard
sugi up -e 1h --cute secret.jpg
sugi album "Cats" *.png
sugi ls ; sugi rm <id>
```

The CLI needs only bash and curl and talks to the instance it was installed from. The MCP server at `https://<host>/mcp` (Streamable HTTP, stateless) offers `upload_file`, `upload_url`, `create_album`, `get_file` and `delete_file`; for example `claude mcp add --transport http sugi https://<host>/mcp`.

## Development

```sh
npm install
npm run dev            # wrangler dev on http://localhost:8787
npm test               # builds the browser bundle, then runs vitest inside workerd
npm run typecheck      # Worker and browser script
npm run check          # Biome lint and format check (npm run format fixes formatting)
npm run check:layout   # every page at 360-1280 px against a running npm run dev (needs Playwright's Chromium)
```

For `npm run dev`, put local values in `.dev.vars` (see [`.dev.vars.example`](.dev.vars.example)), plus `MAIN_ORIGIN=http://localhost:8787`, `FILES_ORIGIN=http://localhost:8787/_files` and `TMP_ORIGIN=http://localhost:8787/_tmp`. `scripts/e2e.sh <url>` and `scripts/cli-e2e.sh <url>` check a running instance end to end with synthetic files and delete everything they create. CI runs lint, typecheck, tests, a build and the layout check on every pull request.

Layout: `src/` is the Worker (routing in `index.ts`; files in `files.ts`, `upload.ts`, `serve.ts`, `chunked.ts` and `links.ts`; moderation in `moderation.ts`; accounts in `auth/`; pages in `site/`), `client/` the browser script and styles (bundled by esbuild), `public/static/` fonts, icons, Open Graph images and the CLI, `migrations/` the D1 schema, `test/` the tests. Fonts are self-hosted subsets; after changing text that uses the display face run `npm run fonts`, and after changing the Open Graph copy run `node scripts/build-og.mjs`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) to report a vulnerability. The maintainers' notes for running sugi.moe itself are in [docs/operations.md](docs/operations.md) (Chinese).

## License

[MIT](LICENSE) © YLDM Co., Ltd. The bundled fonts ZCOOL KuaiLe and Fredoka are under the SIL Open Font License (`public/static/fonts/OFL-*.txt`). Your deployment uses its own name and generic Open Graph images by default; please don't present it as sugi.moe.
