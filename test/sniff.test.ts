import { describe, expect, it } from "vitest";
import { sniffImageType } from "../src/sniff";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

describe("sniffImageType", () => {
  it("detects PNG", () => {
    expect(sniffImageType(cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13]))).toMatchObject({ ext: "png", mime: "image/png" });
  });

  it("detects JPEG", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toMatchObject({ ext: "jpg", mime: "image/jpeg" });
  });

  it("detects GIF87a and GIF89a", () => {
    expect(sniffImageType(cat(enc("GIF87a"), [1, 0]))).toMatchObject({ ext: "gif" });
    expect(sniffImageType(cat(enc("GIF89a"), [1, 0]))).toMatchObject({ ext: "gif", mime: "image/gif" });
  });

  it("detects WebP (lossy, lossless, extended)", () => {
    for (const chunk of ["VP8 ", "VP8L", "VP8X"]) {
      expect(sniffImageType(cat(enc("RIFF"), [0x24, 0, 0, 0], enc("WEBP"), enc(chunk)))).toMatchObject({ ext: "webp", mime: "image/webp" });
    }
  });

  it("rejects other RIFF containers such as WAV and AVI", () => {
    expect(sniffImageType(cat(enc("RIFF"), [0x24, 0, 0, 0], enc("WAVEfmt ")))).toBeNull();
    expect(sniffImageType(cat(enc("RIFF"), [0x24, 0, 0, 0], enc("AVI LIST")))).toBeNull();
    expect(sniffImageType(cat(enc("RIFF"), [0x24, 0, 0, 0], enc("WEBPXXXX")))).toBeNull();
  });

  it("rejects SVG, HTML, PDF, text and truncated magic", () => {
    expect(sniffImageType(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(enc('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffImageType(enc("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageType(enc("%PDF-1.7"))).toBeNull();
    expect(sniffImageType(enc("hello"))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });

  it("rejects HTML that merely mentions an image signature later in the file", () => {
    expect(sniffImageType(cat(enc("<html>"), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
  });
});
