export interface ImageType {
  ext: "png" | "jpg" | "webp" | "gif";
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export const PNG: ImageType = { ext: "png", mime: "image/png" };
export const JPEG: ImageType = { ext: "jpg", mime: "image/jpeg" };
export const WEBP: ImageType = { ext: "webp", mime: "image/webp" };
export const GIF: ImageType = { ext: "gif", mime: "image/gif" };

export const TYPES_BY_EXT: Record<string, ImageType> = {
  png: PNG,
  jpg: JPEG,
  webp: WEBP,
  gif: GIF,
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

// Detects the image type from the leading bytes only. Client-supplied names and content types are never consulted, so anything that is not one of the four formats (SVG, HTML, PDF, ...) is rejected here.
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_MAGIC)) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return GIF;
  // RIFF container: "RIFF" <u32 size> "WEBP" followed by a chunk header such as "VP8 ", "VP8L" or "VP8X".
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8) && startsWith(bytes, ascii("VP8"), 12)) return WEBP;
  return null;
}
