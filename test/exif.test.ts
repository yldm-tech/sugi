import { describe, expect, it } from "vitest";
import { readOrientation, stripJpeg, stripMetadata, stripPng, stripWebp } from "../client/exif";

const enc = new TextEncoder();
const bytes = (...parts: (number[] | Uint8Array | string)[]) => {
  const arrs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const u16 = (n: number) => [n >> 8, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const contains = (hay: Uint8Array, needle: string) => new TextDecoder("latin1").decode(hay).includes(needle);

function segment(marker: number, payload: Uint8Array): Uint8Array {
  return bytes([0xff, marker, ...u16(payload.length + 2)], payload);
}

// Little-endian TIFF with IFD0 holding Orientation and a GPSInfo pointer, followed by a GPS IFD with a latitude ref.
function exifTiff(orientation: number): Uint8Array {
  const ifd0 = [...[2, 0], ...[0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0], ...[0x25, 0x88, 4, 0, 1, 0, 0, 0, ...u32le(38)], 0, 0, 0, 0];
  const gps = [...[1, 0], ...[0x01, 0x00, 2, 0, 2, 0, 0, 0, 0x4e, 0, 0, 0], 0, 0, 0, 0];
  return bytes("II", [42, 0], u32le(8), ifd0, gps, "GPSDATA-SECRET");
}

const SCAN = bytes([0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6], [0x11, 0x22, 0x33, 0xff, 0x00, 0x44], [0xff, 0xd9]);

function jpegWith(...segments: Uint8Array[]): Uint8Array {
  return bytes([0xff, 0xd8], ...segments, SCAN);
}

describe("JPEG", () => {
  it("drops Exif, XMP and APP13 and keeps the orientation", async () => {
    const app0 = segment(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]));
    const exif = segment(0xe1, bytes("Exif\0\0", exifTiff(6)));
    const xmp = segment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta>GPS-IN-XMP</x:xmpmeta>"));
    const iptc = segment(0xed, bytes("Photoshop 3.0\0", "IPTC-CITY"));
    const icc = segment(0xe2, bytes("ICC_PROFILE\0", [1, 1, 9, 9]));
    const src = jpegWith(app0, exif, xmp, iptc, icc);
    const out = stripJpeg(src)!;
    expect(out).not.toBeNull();
    for (const secret of ["GPSDATA-SECRET", "GPS-IN-XMP", "IPTC-CITY"]) expect(contains(out, secret), secret).toBe(false);
    expect(contains(out, "ICC_PROFILE")).toBe(true);
    expect(contains(out, "JFIF")).toBe(true);
    // SOI, APP0, then the rebuilt orientation-only Exif segment.
    const at = 2 + app0.length;
    expect(Array.from(out.subarray(at, at + 4))).toEqual([0xff, 0xe1, 0, 34]);
    expect(readOrientation(out.subarray(at + 10, at + 36))).toBe(6);
    // Image data is untouched.
    expect(Array.from(out.subarray(out.length - SCAN.length))).toEqual(Array.from(SCAN));
  });

  it("does not add an orientation segment for orientation 1", () => {
    const out = stripJpeg(jpegWith(segment(0xe1, bytes("Exif\0\0", exifTiff(1)))))!;
    expect(contains(out, "Exif")).toBe(false);
    expect(out.length).toBe(2 + SCAN.length);
  });

  it("returns null when there is nothing to remove or the file is not a JPEG", () => {
    expect(stripJpeg(jpegWith(segment(0xe0, bytes("JFIF\0", [1, 1]))))).toBeNull();
    expect(stripJpeg(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // Truncated segment length: leave the file alone rather than produce garbage.
    expect(stripJpeg(bytes([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2, 3]))).toBeNull();
  });
});

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return bytes(u32be(data.length), type, data, [0xde, 0xad, 0xbe, 0xef]);
}

describe("PNG", () => {
  it("drops eXIf and XMP text chunks and keeps everything else", () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = pngChunk("IHDR", new Uint8Array(13));
    const exif = pngChunk("eXIf", bytes("MM", "GPSDATA-SECRET"));
    const xmp = pngChunk("iTXt", bytes("XML:com.adobe.xmp\0\0\0\0\0", "GPS-IN-XMP"));
    const comment = pngChunk("tEXt", bytes("Comment\0", "hello"));
    const idat = pngChunk("IDAT", bytes([1, 2, 3]));
    const iend = pngChunk("IEND", new Uint8Array(0));
    const out = stripPng(bytes(sig, ihdr, exif, xmp, comment, idat, iend))!;
    expect(Array.from(out)).toEqual(Array.from(bytes(sig, ihdr, comment, idat, iend)));
    expect(stripPng(bytes(sig, ihdr, idat, iend))).toBeNull();
  });
});

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  return bytes(type, u32le(data.length), data, data.length & 1 ? [0] : []);
}

describe("WebP", () => {
  it("drops EXIF and XMP chunks, clears their flags and fixes the RIFF size", () => {
    const vp8x = riffChunk("VP8X", bytes([0x0c | 0x10, 0, 0, 0, 9, 0, 0, 9, 0, 0]));
    const img = riffChunk("VP8 ", bytes([1, 2, 3, 4, 5]));
    const exif = riffChunk("EXIF", bytes("GPSDATA-SECRET"));
    const xmp = riffChunk("XMP ", bytes("GPS-IN-XMP!"));
    const body = bytes("WEBP", vp8x, img, exif, xmp);
    const src = bytes("RIFF", u32le(body.length), body);
    const out = stripWebp(src)!;
    expect(contains(out, "GPSDATA-SECRET")).toBe(false);
    expect(contains(out, "GPS-IN-XMP")).toBe(false);
    const view = new DataView(out.buffer, out.byteOffset);
    expect(view.getUint32(4, true)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
    expect(out[20] & 0x10).toBe(0x10);
    expect(contains(out, "VP8 ")).toBe(true);
  });

  it("leaves simple (non-VP8X) WebP alone", () => {
    const body = bytes("WEBP", riffChunk("VP8 ", bytes([1, 2, 3])));
    expect(stripWebp(bytes("RIFF", u32le(body.length), body))).toBeNull();
  });
});

describe("stripMetadata", () => {
  it("dispatches by format and ignores others", () => {
    expect(stripMetadata(jpegWith(segment(0xe1, bytes("Exif\0\0", exifTiff(3)))))).not.toBeNull();
    expect(stripMetadata(bytes("GIF89a", [0, 0]))).toBeNull();
  });
});
