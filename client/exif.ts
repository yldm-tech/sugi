// Removes location and camera metadata from photos in the browser, before upload, without re-encoding the pixels.
//
// JPEG: drops APP1 Exif and XMP segments and APP13 (Photoshop/IPTC). The Exif orientation is kept by writing a minimal Exif segment that holds only the Orientation tag, so phone photos do not turn sideways.
// PNG: drops eXIf chunks and text chunks that carry XMP or raw Exif/IPTC profiles.
// WebP: drops EXIF and XMP chunks and clears their flags in the VP8X header.
// Anything else (AVIF, GIF, video) is returned unchanged; null means "not a format this handles or nothing to remove".

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

function startsWithAscii(bytes: Uint8Array, offset: number, s: string): boolean {
  if (offset + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[offset + i] !== s.charCodeAt(i)) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Reads the Orientation tag (0x0112) from IFD0 of an Exif TIFF block; returns null when absent or malformed.
export function readOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function orientationSegment(orientation: number): Uint8Array {
  // "Exif\0\0" + big-endian TIFF header + one IFD entry (Orientation, SHORT, 1) + next-IFD offset 0.
  const tiff = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const payload = concat([enc.encode("Exif\0\0"), tiff]);
  const len = payload.length + 2;
  return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), payload]);
}

export function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let orientation: number | null = null;
  let removed = false;
  let insertAt = 1; // index in `kept` after which the orientation segment goes (after SOI, or after APP0)
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return null; // not a marker where one is expected: leave the file alone
    const marker = bytes[off + 1];
    if (marker === 0xff) {
      off++; // fill byte
      continue;
    }
    // Start of scan: everything after this is image data; copy it verbatim.
    if (marker === 0xda) {
      kept.push(bytes.subarray(off));
      off = bytes.length;
      break;
    }
    // Markers without a length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(bytes.subarray(off, off + 2));
      off += 2;
      continue;
    }
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 2 || off + 2 + len > bytes.length) return null;
    const seg = bytes.subarray(off, off + 2 + len);
    const body = off + 4;
    let drop = false;
    if (marker === 0xe1) {
      if (startsWithAscii(bytes, body, "Exif\0\0")) {
        orientation = orientation ?? readOrientation(bytes.subarray(body + 6, off + 2 + len));
        drop = true;
      } else if (startsWithAscii(bytes, body, "http://ns.adobe.com/")) {
        drop = true; // XMP and extended XMP
      }
    } else if (marker === 0xed) {
      drop = true; // APP13: Photoshop image resources, including IPTC (which can hold locations)
    }
    if (drop) {
      removed = true;
    } else {
      kept.push(seg);
      if (marker === 0xe0 && kept.length === 2) insertAt = 2;
    }
    off += 2 + len;
  }
  if (!removed) return null;
  if (orientation !== null && orientation !== 1) kept.splice(insertAt, 0, orientationSegment(orientation));
  return concat(kept);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_META_KEYWORDS = ["XML:com.adobe.xmp", "Raw profile type exif", "Raw profile type APP1", "Raw profile type iptc", "Raw profile type xmp"];

export function stripPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8 || !PNG_SIG.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let removed = false;
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = dec.decode(bytes.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (end > bytes.length) return null;
    let drop = type === "eXIf";
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const data = bytes.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      const keyword = dec.decode(data.subarray(0, nul < 0 ? data.length : nul));
      drop = PNG_META_KEYWORDS.includes(keyword);
    }
    if (drop) removed = true;
    else kept.push(bytes.subarray(off, end));
    off = end;
    if (type === "IEND") break;
  }
  return removed ? concat(kept) : null;
}

export function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 21 || !startsWithAscii(bytes, 0, "RIFF") || !startsWithAscii(bytes, 8, "WEBP") || !startsWithAscii(bytes, 12, "VP8X")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [];
  let removed = false;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = dec.decode(bytes.subarray(off, off + 4));
    const len = view.getUint32(off + 4, true);
    const end = off + 8 + len + (len & 1);
    if (off + 8 + len > bytes.length) return null;
    if (type === "EXIF" || type === "XMP ") removed = true;
    else kept.push(bytes.subarray(off, Math.min(end, bytes.length)));
    off = end;
  }
  if (!removed) return null;
  const body = concat(kept);
  // VP8X flags byte: bit 3 = EXIF present, bit 2 = XMP present.
  body[8] &= ~0x0c;
  const header = new Uint8Array(12);
  header.set(enc.encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(enc.encode("WEBP"), 8);
  return concat([header, body]);
}

/** Returns a cleaned copy, or null when the format is not handled or there was nothing to remove. */
export function stripMetadata(bytes: Uint8Array): Uint8Array | null {
  return stripJpeg(bytes) ?? stripPng(bytes) ?? stripWebp(bytes);
}
