# Changelog

All notable changes to sugi are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Daily upload quotas per source, per account and for the whole site (`QUOTA_*`); 429 or 507 with Retry-After.
- `/healthz`, a daily operations report and threshold alerts by email (`OPS_EMAIL`, `ALERT_*`), and the admin MCP tool `ops_report`.
- A report form on file and album pages (`POST /api/reports`), an hourly digest to the abuse address, and the admin MCP tools `list_reports` and `resolve_report`.
- The donate page ("Feed the hamster") with an Alipay QR code and link (`DONATE_ALIPAY_QR`, `DONATE_ALIPAY_LINK`), and a cost list computed from real data: R2 storage from the measured bucket size, the free plans in use, and the domain renewal when `DONATE_DOMAIN_COST_USD` is set. It replaces `FEATURE_DONATE`.
- Integrations: a ShareX custom uploader at `/integrations/sharex.sxcu`, settings for PicGo / PicList, uPic, Typora and Obsidian on `/dev#tools`, and `sugi up --plain` for tools that read bare links.

- Resumable chunked uploads: the website keeps an unfinished big upload's progress in the browser, waits out a lost connection and continues after a reload when the file is picked again; the CLI keeps it in `~/.config/sugi/pending/`, continues on the next run, shows progress bars and has `sugi abort FILE`. Cancelling aborts the multipart upload on the server.
- The upload queue on the website and the CLI pace themselves under the server's limits and retry after a 429 on their own; logged-in accounts may start 60 uploads a minute.

- `NOINDEX` keeps an instance out of search engines (robots.txt and `X-Robots-Tag`), for staging and private instances.

- Optional backup of permanent files to a second R2 bucket (`BACKUP` binding), with a 7-day grace period for deleted files, immediate removal of taken-down files, and the admin MCP tools `backup_status` and `restore_from_backup`.

### Changed

- Videos need an account or a maintainer token by default (`VIDEO_UPLOADS`), since Cloudflare's CSAM Scanning Tool checks images only.
- Upload links from the MCP tool `create_upload` carry who asked for them, so quotas, ownership and the video rule apply to that account.

## [1.0.0] - 2026-11-02

The first public release.

### Uploading and sharing

- Images and short videos (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM) up to 200 MB, recognised by their content; everything else is refused.
- Drag and drop, file picker, paste, and importing from a link; files over 90 MB are uploaded in chunks.
- Permanent or temporary links (1 h, 12 h, 72 h), random or cute ids, share pages with Markdown, HTML and BBCode, QR codes, and albums.
- "My files" keeps history and delete tokens in the browser, with search, filters, export and import. Photo location metadata is stripped in the browser before upload.
- The original content-addressed `POST /upload` endpoint and its links keep working.

### API, command line and MCP

- HTTP API: `/api/upload` (PUT and multipart POST), chunked uploads, file info, deletion with delete tokens, albums.
- The `sugi` command-line tool, installed with a checksum-verified `install.sh`.
- A remote MCP server at `/mcp` with `upload_file`, `upload_url`, `create_upload` (one-time upload links for local files), `create_album`, `get_file` and `delete_file`.

### Accounts

- Optional accounts (`FEATURE_ACCOUNTS`, `ACCOUNT_FEATURES`) with passwordless email login: the emailed link opens a confirmation page, so link scanners cannot use it. Uploads made while logged in belong to the account.

### Privacy, security and moderation

- No IP addresses are stored; uploads carry an HMAC of the uploader's IP. Source fingerprints in takedown records are erased after two years.
- Nonce-based CSP, files served from separate origins with their own CSP, no third-party scripts, fonts or analytics.
- Per-IP rate limits in the Worker, plus a documented zone WAF rule.
- Cache-through serving so Cloudflare's CSAM Scanning Tool sees every file, with cache purges on deletion.
- Admin moderation over HTTP and MCP: inspect, takedown with a 451 tombstone, content-hash and source blocklists, takedown by source, and an audit log.

### Website

- Bilingual (Chinese and English) pages with day and night themes, a hamster mascot, SEO metadata and Open Graph images.
- Layout checked at widths from 360 to 1280 px.

### Self-hosting

- One-click "Deploy to Cloudflare": the R2 bucket and D1 database are created on the first deploy, the schema is applied at runtime, and the site works on `*.workers.dev`.
- Every operator-specific detail (name, domains, contacts, legal statements) comes from configuration.

[1.0.0]: https://github.com/yldm-tech/sugi/releases/tag/v1.0.0
