// Remote MCP server at /mcp (Streamable HTTP, stateless: a fresh server per request, JSON responses). Tools hand out upload links for local files, upload base64 data or a link, make albums, read and delete files. Every upload tool call goes through the same gate and rate limit as the HTTP API, using the request's own Authorization header.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { brand } from "./config";
import { createAlbum } from "./albums";
import { deleteFile, findFile, importUrl, parseOptions, publicInfo, storeBytes, UploadResult } from "./files";
import { authorizeUpload, HttpError, isAdmin, isTrusted } from "./http";
import { assertFileNotRemoved, blockSource, inspect, listBlocks, listBySource, readLog, takedown, takedownBySource, unblockContent, unblockSource } from "./moderation";
import { createUploadLinks } from "./links";
import { ALBUM_MAX_FILES, ALBUM_TITLE_MAX, MAX_FILE_BYTES, RATE_LIMIT, RATE_LIMIT_PERIOD_SECONDS, SINGLE_REQUEST_MAX_BYTES, UPLOAD_LINK_MAX, UPLOAD_LINK_TTL_SECONDS } from "./limits";

/** Largest file the upload_file tool takes (decoded). Base64 inflates by a third and the whole JSON-RPC message sits in memory. */
export const MCP_MAX_BYTES = 20 * 1024 * 1024;

export const MCP_VERSION = "1.0.0";

const expire = z.enum(["1h", "12h", "72h"]).optional().describe("Delete the file after this long. Omit to keep it forever.");
const style = z.enum(["random", "cute"]).optional().describe('Link style: "random" (default, hard to guess) or "cute" (word-word-NN, easier to guess).');

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  const message = err instanceof HttpError ? `${err.status}: ${err.message}` : "internal error";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function summary(r: UploadResult) {
  return { url: r.url, page: r.page, id: r.id, size: r.size, type: r.type, name: r.name, expires_at: r.expires_at, delete_token: r.delete_token };
}

function decodeBase64(data: string): Uint8Array {
  const clean = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if ((clean.length * 3) / 4 > MCP_MAX_BYTES + 3) throw new HttpError(413, `file too large for MCP (max ${MCP_MAX_BYTES / 1024 / 1024} MB); use the HTTP API or the sugi CLI for bigger files`);
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new HttpError(400, "data is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MB = 1024 * 1024;
const FORMATS = "PNG, JPEG, WebP, GIF, AVIF, MP4 and WebM only (no SVG, HTML, PDF, fonts, archives or other files; the type is read from the file's bytes, not its name)";

function instructions(env: Env): string {
  const host = env.MAIN_ORIGIN;
  return [
    `This server hosts images and short videos on ${brand(env).siteName} and returns direct links. Accepted: ${FORMATS}, up to ${MAX_FILE_BYTES / MB} MB per file. Every upload is public to anyone with the link.`,
    "Pick the upload path by where the file is:",
    `1. Local files, and you can run shell commands: use the sugi CLI, it is fastest and handles any number of files and big files: \`sugi up <files...>\` (prints one link per file; add \`-e 1h|12h|72h\` for temporary links, \`--json\` for delete tokens). Install it once with \`curl -fsSL ${host}/install.sh | sh\`.`,
    `2. Local files without the CLI: call create_upload with count = number of files, then upload each file to its own link with \`curl -T <path> '<upload_url>'\` (or \`curl -F file=@<path> '<upload_url>'\`). Links work once, expire after ${UPLOAD_LINK_TTL_SECONDS / 60} minutes and take files up to ${SINGLE_REQUEST_MAX_BYTES / MB} MB.`,
    "3. Files already on the internet: upload_url with the link.",
    `4. upload_file (base64 inside the tool call) only for small content you generated yourself; never re-type or hand-copy base64 of an existing file, it corrupts easily. Max ${MCP_MAX_BYTES / MB} MB.`,
    `Without a token, uploads are rate limited to ${RATE_LIMIT} per ${RATE_LIMIT_PERIOD_SECONDS} seconds per IP. Keep each upload's delete_token if the user may want to delete the file later (delete_file).`,
  ].join("\n");
}

const ADMIN_INSTRUCTIONS = [
  "This connection carries the admin token: it is never rate limited and also has moderation tools.",
  "Handling an abuse report: inspect the reported link (status, source, albums) -> takedown it (block_content: true for material that must never come back, e.g. CSAM or repeated spam; give a reason) -> list_by_source to see what else the same uploader posted -> takedown_by_source (dry_run first, then dry_run: false) and/or block_source if the whole source is abusive. Every action is recorded in takedown_log. Taken-down links answer 451 and their ids are never reused.",
  "Moderation tools act immediately on production data; confirm with the user before takedown_by_source with dry_run: false and before blocking a source.",
].join("\n");

function registerAdminTools(server: McpServer, env: Env): void {
  const target = z.string().describe("A file id or any sugi link: files./tmp. link, share page /f/<id>, legacy /<16 hex>.<ext>, or an album link /a/<id>.");
  const sourceArg = z.string().describe("A 64-hex source HMAC, or any file/album link whose uploader to use.");
  const reason = z.string().max(500).optional().describe("Why (recorded in the audit log).");
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(err);
    }
  };

  server.registerTool(
    "inspect",
    { title: "Inspect a file or album (admin)", description: "Everything known about a file or album: status (live, expired, taken_down, missing), type, size, created and expiry times, source HMAC and whether it is blocked, content hash (legacy and removed items), album memberships and takedown record.", inputSchema: { target }, annotations: { readOnlyHint: true } },
    async (args) => run(() => inspect(env, args.target)),
  );
  server.registerTool(
    "takedown",
    {
      title: "Take down a file or album (admin)",
      description: "Remove a file or album after a report: the object is deleted, every URL it was served from is purged from the cache, and a tombstone keeps the id from being reused and answers 451 from now on. block_content: true also records the content SHA-256 so identical uploads are refused on every upload path (files up to 20 MB; bigger files are only taken down). For albums, include_files: true also takes down every file in it.",
      inputSchema: { target, reason, block_content: z.boolean().optional().describe("Also block re-uploads of the same bytes."), include_files: z.boolean().optional().describe("Albums only: take down the files too.") },
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => takedown(env, args.target, { reason: args.reason ?? null, blockContent: args.block_content, includeFiles: args.include_files, via: "mcp" })),
  );
  server.registerTool(
    "list_by_source",
    { title: "List uploads from the same source (admin)", description: "Files and albums uploaded from the same source HMAC (the same IP), newest first, paginated.", inputSchema: { source: sourceArg, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } },
    async (args) => run(() => listBySource(env, args.source, args.offset ?? 0, args.limit ?? 50)),
  );
  server.registerTool(
    "takedown_by_source",
    {
      title: "Take down everything from a source (admin)",
      description: "Take down every file and album from the same source HMAC. dry_run defaults to true and only reports what would be removed; pass dry_run: false to do it.",
      inputSchema: { source: sourceArg, dry_run: z.boolean().optional().describe("Default true."), reason, block_content: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => takedownBySource(env, args.source, { dryRun: args.dry_run ?? true, reason: args.reason ?? null, blockContent: args.block_content, via: "mcp" })),
  );
  server.registerTool(
    "block_source",
    { title: "Block a source from uploading (admin)", description: "Stop a source HMAC from uploading (its uploads get a neutral 403), until unblocked or for expires_in_hours.", inputSchema: { source: sourceArg, reason, expires_in_hours: z.number().positive().max(24 * 365).optional() } },
    async (args) => run(() => blockSource(env, args.source, args.reason ?? null, args.expires_in_hours ?? null)),
  );
  server.registerTool(
    "unblock_source",
    { title: "Unblock a source (admin)", description: "Lift a block_source.", inputSchema: { source: sourceArg, reason } },
    async (args) => run(() => unblockSource(env, args.source, args.reason ?? null)),
  );
  server.registerTool(
    "unblock_content",
    { title: "Unblock content (admin)", description: "Remove a SHA-256 from the content blocklist (see list_blocks), so the same bytes may be uploaded again.", inputSchema: { sha256: z.string(), reason } },
    async (args) => run(() => unblockContent(env, args.sha256, args.reason ?? null)),
  );
  server.registerTool(
    "list_blocks",
    { title: "List blocks (admin)", description: "Blocked sources (with expiry) and blocked content hashes, newest first.", inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } },
    async (args) => run(() => listBlocks(env, args.limit ?? 100)),
  );
  server.registerTool(
    "takedown_log",
    { title: "Admin audit log (admin)", description: "Recent admin actions (takedowns, blocks, unblocks), newest first.", inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } },
    async (args) => run(() => readLog(env, args.limit ?? 50)),
  );
}

function buildServer(request: Request, env: Env, admin: boolean): McpServer {
  const server = new McpServer({ name: "sugi", version: MCP_VERSION }, { instructions: admin ? `${instructions(env)}\n\n${ADMIN_INSTRUCTIONS}` : instructions(env) });
  if (admin) registerAdminTools(server, env);

  server.registerTool(
    "create_upload",
    {
      title: "Get upload links for local files",
      description: `Upload local files without base64: returns \`count\` one-time upload links (valid ${UPLOAD_LINK_TTL_SECONDS / 60} minutes, max ${SINGLE_REQUEST_MAX_BYTES / MB} MB per file) and the curl command for each. Run \`curl -T <path> '<upload_url>'\` once per file; the response is JSON with url, page, id and delete_token. Use this when you can run shell commands but the sugi CLI is not installed. Accepted: ${FORMATS}.`,
      inputSchema: {
        count: z.number().int().min(1).max(UPLOAD_LINK_MAX).optional().describe(`How many links (one per file), 1 to ${UPLOAD_LINK_MAX}. Default 1.`),
        filename: z.string().optional().describe("Display name for the file (only with count 1; otherwise the uploaded file's own name is used with curl -F, or add ?name= to the link)."),
        expire,
        style,
      },
    },
    async (args) => {
      try {
        const count = args.count ?? 1;
        if (count > RATE_LIMIT && !(await isTrusted(request, env))) throw new HttpError(429, `without a token you can upload at most ${RATE_LIMIT} files per ${RATE_LIMIT_PERIOD_SECONDS} seconds; ask for ${RATE_LIMIT} links or fewer at a time`);
        const uploader = await authorizeUpload(request, env, "upload", count);
        const opts = parseOptions((k) => (k === "expire" ? (args.expire ?? null) : k === "style" ? (args.style ?? null) : k === "name" ? (args.filename ?? null) : null));
        const made = await createUploadLinks(env, uploader, opts, count);
        return text({
          ...made,
          max_bytes_per_file: SINGLE_REQUEST_MAX_BYTES,
          how_to_upload: "One file per link. Raw body: curl -sS -T <path> '<upload_url>'. Multipart (keeps the file name): curl -sS -F file=@<path> '<upload_url>'. Each returns JSON with url, page, id, delete_token. Do not pipe (curl needs the file length).",
          commands: made.links.map((l) => `curl -sS -T <path> '${l.upload_url}'`),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload a file",
      description: `Upload an image or short video given as base64 (max ${MCP_MAX_BYTES / MB} MB). Only for small content you generated yourself; for files on disk use the sugi CLI or create_upload, for files on the web use upload_url. Accepted: ${FORMATS}. Returns the direct link, the share page and a delete_token.`,
      inputSchema: { data: z.string().describe("File content, base64 (a data: URL prefix is accepted)."), filename: z.string().optional().describe("Original file name, shown on the share page."), expire, style },
    },
    async (args) => {
      try {
        const uploader = await authorizeUpload(request, env);
        const opts = parseOptions((k) => (k === "expire" ? (args.expire ?? null) : k === "style" ? (args.style ?? null) : k === "name" ? (args.filename ?? null) : null));
        return text(summary(await storeBytes(env, uploader, opts, decodeBase64(args.data))));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "upload_url",
    {
      title: "Copy a file from a link",
      description: `Fetch an image or short video from an http(s) link that is already on the internet and host it here. Accepted: ${FORMATS}. Returns the direct link, the share page and a delete_token.`,
      inputSchema: { url: z.string().describe("http or https link to an image or video."), expire, style },
    },
    async (args) => {
      try {
        const uploader = await authorizeUpload(request, env);
        const opts = parseOptions((k) => (k === "expire" ? (args.expire ?? null) : k === "style" ? (args.style ?? null) : null));
        return text(summary(await importUrl(env, uploader, opts, args.url)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "create_album",
    {
      title: "Bundle files into one link",
      description: `Make one share link (an album page) from up to ${ALBUM_MAX_FILES} uploaded files, given by id or link.`,
      inputSchema: { files: z.array(z.string()).min(1).max(ALBUM_MAX_FILES).describe("File ids or sugi links."), title: z.string().max(ALBUM_TITLE_MAX).optional() },
    },
    async (args) => {
      try {
        const uploader = await authorizeUpload(request, env, "album");
        return text(await createAlbum(env, uploader, args.files, args.title ?? ""));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_file",
    { title: "Look up a file", description: "Public information about an uploaded file: link, size, type and expiry.", inputSchema: { id: z.string().describe("File id or sugi link.") }, annotations: { readOnlyHint: true } },
    async (args) => {
      const id = args.id.trim().replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "");
      const found = await findFile(env, id);
      if (found) return text(publicInfo(env, found.file));
      try {
        await assertFileNotRemoved(env, id);
        return failure(new HttpError(404, "not found"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete a file",
      description: "Delete a file uploaded earlier, using the delete_token that its upload returned.",
      inputSchema: { id: z.string().describe("File id or sugi link."), delete_token: z.string().describe("The delete_token returned by the upload.") },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const id = args.id.trim().replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "");
        const done = await deleteFile(env, id, args.delete_token);
        if (!done) throw new HttpError(404, "not found");
        return text({ deleted: id, cache_purged: done.cachePurged });
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
  }
  // Permissions come from the bearer token: the admin token adds the moderation tools (and, like the trusted token, is never rate limited).
  const server = buildServer(request, env, await isAdmin(request, env));
  // Room for a maximum-size base64 file plus the JSON-RPC envelope; larger bodies are refused by the transport with 413.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: Math.ceil((MCP_MAX_BYTES * 4) / 3) + 1024 * 1024 });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
