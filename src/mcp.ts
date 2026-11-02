// Remote MCP server at /mcp (Streamable HTTP, stateless: a fresh server per request, JSON responses). Tools upload base64 data or a link, make albums, read and delete files. Every upload tool call goes through the same gate and rate limit as the HTTP API, using the request's own Authorization header.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createAlbum } from "./albums";
import { deleteFile, findFile, importUrl, parseOptions, publicInfo, storeBytes, UploadResult } from "./files";
import { authorizeUpload, HttpError } from "./http";
import { ALBUM_MAX_FILES, ALBUM_TITLE_MAX } from "./limits";

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

function buildServer(request: Request, env: Env): McpServer {
  const server = new McpServer({ name: "sugi", version: MCP_VERSION }, { instructions: "sugi.moe hosts images and short videos (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM) and returns direct links. Uploads are public. Keep the delete_token from each upload if the user may want to delete the file later." });

  server.registerTool(
    "upload_file",
    {
      title: "Upload a file",
      description: `Upload an image or short video given as base64 (max ${MCP_MAX_BYTES / 1024 / 1024} MB). Returns the direct link, the share page and a delete_token.`,
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
      description: "Fetch an image or short video from an http(s) link and host it on sugi. Returns the direct link, the share page and a delete_token.",
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
      return found ? text(publicInfo(env, found.file)) : failure(new HttpError(404, "not found"));
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
  const server = buildServer(request, env);
  // Room for a maximum-size base64 file plus the JSON-RPC envelope; larger bodies are refused by the transport with 413.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: Math.ceil((MCP_MAX_BYTES * 4) / 3) + 1024 * 1024 });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
