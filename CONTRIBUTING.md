# Contributing to sugi

Thanks for helping. Bug reports, fixes and small features are welcome; for anything larger, open an issue first so we can agree on the shape before you write it.

## Before you start

- Read the [README](README.md) for how the pieces fit together, and the developer page (`/dev`) of a local instance for the API.
- `npm install`, then `npm test` and `npm run typecheck` must pass before and after your change. Add or update tests in `test/` for behaviour you change.
- To try the site locally, copy `.dev.vars.example` to `.dev.vars`, fill in values and add the local origins listed in the README, then `npm run dev`.

## Ground rules

- **Security model.** The page CSP allows only nonce'd scripts and styles: no inline `style=` attributes, no inline event handlers, no external scripts, fonts or images. Set dynamic styles through the CSSOM. Uploaded files are only ever served from the files origins, never from the site's origin.
- **Privacy.** Never store or log raw IP addresses; use the source HMAC. Do not add analytics, trackers or third-party requests.
- **Both languages.** Every user-facing string exists in Chinese and English (`t("中文", "English")` in templates, `src/site/strings.ts` for the browser script).
- **No deployment specifics in code.** Names, domains, contacts and operator-specific statements come from `wrangler.jsonc` vars (`src/config.ts`), so every deployment describes itself. The sugi.moe values live only in `wrangler.production.jsonc`.
- **Legal pages.** Changes to the terms or the privacy policy (`src/site/pages/info.ts`, `src/site/pages/privacy.ts`) need a maintainer's review; say why in the PR.
- **Fonts.** If you change text that uses the display face (page titles, the mascot's lines, empty states), run `npm run fonts` so the subset covers the new characters.
- **Dependencies.** Prefer an established library over hand-written parsing or protocol code, and explain new dependencies in the PR.

## Screenshots for UI changes

Every pull request that changes what the site looks like must include **before and after screenshots** of the affected pages (both languages if the layout differs, and day and night if colours change). Put them side by side in a table in the PR description.

Host the images on sugi.moe itself, so the links are direct image links that GitHub renders:

```sh
sugi up before.png after.png                                  # with the CLI: curl -fsSL https://sugi.moe/install.sh | sh
curl -F "file=@before.png" https://sugi.moe/api/upload        # or plain curl; prints the link
```

Anonymous uploads are rate limited to 10 per minute per IP (and at most 5 within any 10 seconds), so upload a handful at a time. If sugi.moe is unavailable, use catbox.moe as a fallback and link the direct `files.catbox.moe` URL. Do not use ad-supported file hosts.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- One topic per pull request. Describe what changed and why, how you tested it, and include screenshots for UI changes.
- Do not hard-wrap prose in commit messages, PR descriptions or code comments; one paragraph is one line.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
