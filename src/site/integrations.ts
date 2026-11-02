// Ready-made configuration for third-party upload tools. ShareX imports a .sxcu file (a JSON custom uploader); the others are described on the developer page and all use the same request: a multipart POST of the field "file" to /api/upload with Accept: application/json, the link read from the "url" field of the answer.
import { brand } from "../config";
import { methodNotAllowed } from "../http";

export function uploadEndpoint(env: Env): string {
  return `${env.MAIN_ORIGIN}/api/upload`;
}

/** ShareX custom uploader (https://getsharex.com/docs/custom-uploader). Errors come back as {"error": "..."}. */
export function sharexConfig(env: Env): Record<string, unknown> {
  return {
    Version: "15.0.0",
    Name: brand(env).siteName,
    DestinationType: "ImageUploader, FileUploader",
    RequestMethod: "POST",
    RequestURL: uploadEndpoint(env),
    Headers: { Accept: "application/json" },
    Body: "MultipartFormData",
    FileFormName: "file",
    URL: "{json:url}",
    ThumbnailURL: "{json:url}",
    ErrorMessage: "{json:error}",
  };
}

// GET /integrations/sharex.sxcu: downloads as <site name>.sxcu, which ShareX imports on double-click.
export function handleSharexConfig(request: Request, env: Env): Response {
  if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  const name = brand(env).siteName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return new Response(request.method === "HEAD" ? null : `${JSON.stringify(sharexConfig(env), null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.sxcu"`,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Settings for the PicGo / PicList plugin "web-uploader" (picgo-plugin-web-uploader). */
export function picgoConfig(env: Env): Record<string, string> {
  return { url: uploadEndpoint(env), paramName: "file", jsonPath: "url", customHeader: '{"Accept":"application/json"}', customBody: "" };
}
