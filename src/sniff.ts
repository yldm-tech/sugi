export interface MediaType {
  ext: "png" | "jpg" | "webp" | "gif" | "avif" | "mp4" | "webm";
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif" | "video/mp4" | "video/webm";
  kind: "image" | "video";
}

export const PNG: MediaType = { ext: "png", mime: "image/png", kind: "image" };
export const JPEG: MediaType = { ext: "jpg", mime: "image/jpeg", kind: "image" };
export const WEBP: MediaType = { ext: "webp", mime: "image/webp", kind: "image" };
export const GIF: MediaType = { ext: "gif", mime: "image/gif", kind: "image" };
export const AVIF: MediaType = { ext: "avif", mime: "image/avif", kind: "image" };
export const MP4: MediaType = { ext: "mp4", mime: "video/mp4", kind: "video" };
export const WEBM: MediaType = { ext: "webm", mime: "video/webm", kind: "video" };

/** Types accepted by the legacy content-addressed /upload endpoint. */
export const TYPES_BY_EXT: Record<string, MediaType> = { png: PNG, jpg: JPEG, webp: WEBP, gif: GIF };

/** Types accepted by the current upload API. */
export const MEDIA_BY_EXT: Record<string, MediaType> = { ...TYPES_BY_EXT, avif: AVIF, mp4: MP4, webm: WEBM };

/** How many leading bytes the sniffers look at. Callers peeking a stream should buffer at least this much (or the whole file if shorter). */
export const SNIFF_BYTES = 64;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// Detects the image type from the leading bytes only. Client-supplied names and content types are never consulted, so anything that is not one of the four formats (SVG, HTML, PDF, ...) is rejected here.
export function sniffImageType(bytes: Uint8Array): MediaType | null {
  if (startsWith(bytes, PNG_MAGIC)) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return GIF;
  // RIFF container: "RIFF" <u32 size> "WEBP" followed by a chunk header such as "VP8 ", "VP8L" or "VP8X".
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8) && startsWith(bytes, ascii("VP8"), 12)) return WEBP;
  return null;
}

// Major brands of the ISO base media file format that mean "MP4 video". QuickTime ("qt  "), audio-only brands (M4A/M4B/M4P) and HEIF images are deliberately absent.
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "mmp4", "M4V ", "M4VH", "M4VP", "f4v "]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function sniffIsoBmff(bytes: Uint8Array): MediaType | null {
  if (bytes.length < 12 || fourcc(bytes, 4) !== "ftyp") return null;
  const major = fourcc(bytes, 8);
  if (AVIF_BRANDS.has(major)) return AVIF;
  if (MP4_BRANDS.has(major)) return MP4;
  // Generic HEIF major brands are AVIF only when an AVIF brand is listed as compatible.
  if (major === "mif1" || major === "msf1") {
    const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(boxSize, bytes.length);
    for (let off = 16; off + 4 <= end; off += 4) if (AVIF_BRANDS.has(fourcc(bytes, off))) return AVIF;
  }
  return null;
}

// WebM is Matroska with DocType "webm": EBML magic, then the DocType element (ID 0x4282) inside the header.
function sniffWebm(bytes: Uint8Array): MediaType | null {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 4; i + 7 <= limit; i++) {
    if (bytes[i] === 0x42 && bytes[i + 1] === 0x82) {
      // One-byte size vint (0x84 = length 4) followed by the doc type.
      const size = bytes[i + 2] & 0x7f;
      if ((bytes[i + 2] & 0x80) === 0x80 && size === 4 && fourcc(bytes, i + 3) === "webm") return WEBM;
      return null;
    }
  }
  return null;
}

// Detects every type the current upload API accepts: the four legacy image formats plus AVIF, MP4 and WebM.
export function sniffMedia(bytes: Uint8Array): MediaType | null {
  return sniffImageType(bytes) ?? sniffIsoBmff(bytes) ?? sniffWebm(bytes);
}
