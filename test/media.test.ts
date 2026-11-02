import { describe, expect, it } from "vitest";
import { parseRange } from "../src/files";
import { CUTE_WORDS, cuteId, deleteToken, isFileId, randomId } from "../src/ids";
import { parseExpiry } from "../src/limits";
import { sniffImageType, sniffMedia } from "../src/sniff";

const enc = new TextEncoder();
const box = (major: string, compat: string[] = []) => {
  const size = 16 + compat.length * 4;
  const b = new Uint8Array(Math.max(size, 32));
  new DataView(b.buffer).setUint32(0, size);
  b.set(enc.encode("ftyp" + major), 4);
  compat.forEach((c, i) => b.set(enc.encode(c), 16 + i * 4));
  return b;
};

describe("sniffMedia", () => {
  it("recognises MP4 by its major brand", () => {
    for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"]) expect(sniffMedia(box(brand))?.ext, brand).toBe("mp4");
  });

  it("recognises AVIF directly or through a generic HEIF brand", () => {
    expect(sniffMedia(box("avif", ["mif1"]))).toMatchObject({ ext: "avif", mime: "image/avif", kind: "image" });
    expect(sniffMedia(box("avis"))?.ext).toBe("avif");
    expect(sniffMedia(box("mif1", ["miaf", "avif"]))?.ext).toBe("avif");
  });

  it("rejects QuickTime, audio-only MP4, HEIC and generic HEIF without AVIF", () => {
    for (const brand of ["qt  ", "M4A ", "M4B ", "heic", "heix"]) expect(sniffMedia(box(brand, ["isom"])), brand).toBeNull();
    expect(sniffMedia(box("mif1", ["heic"]))).toBeNull();
  });

  it("recognises WebM but not other Matroska", () => {
    const head = (doctype: string) => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | doctype.length, ...enc.encode(doctype), 0, 0, 0, 0]);
    expect(sniffMedia(head("webm"))).toMatchObject({ ext: "webm", mime: "video/webm", kind: "video" });
    expect(sniffMedia(head("matroska"))).toBeNull();
  });

  it("still accepts the legacy formats and still rejects markup", () => {
    expect(sniffMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(sniffMedia(enc.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffMedia(enc.encode("<html>ftypisom"))).toBeNull();
    // The legacy sniffer keeps its four formats only.
    expect(sniffImageType(box("isom"))).toBeNull();
  });
});

describe("ids", () => {
  it("random ids are 8 chars of [a-z0-9] and vary", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("cute ids are word-word-NN from a list of distinct lower-case words", () => {
    expect(new Set(CUTE_WORDS).size).toBe(CUTE_WORDS.length);
    expect(CUTE_WORDS.length).toBeGreaterThanOrEqual(280);
    for (const w of CUTE_WORDS) expect(w).toMatch(/^[a-z]+$/);
    for (let i = 0; i < 100; i++) {
      const id = cuteId();
      expect(id).toMatch(/^[a-z]+-[a-z]+-[1-9][0-9]$/);
      const [a, b] = id.split("-");
      expect(a).not.toBe(b);
      expect(isFileId(id)).toBe(true);
    }
  });

  it("isFileId rejects anything else", () => {
    for (const bad of ["", "ABCDEFGH", "abc", "abcdefghi", "a-b-1", "mochi-puff-100", "../etc", "mochi_puff_42"]) expect(isFileId(bad), bad).toBe(false);
  });

  it("delete tokens are long and URL-safe", () => {
    expect(deleteToken()).toMatch(/^d_[A-Za-z0-9_-]{32}$/);
  });
});

describe("parsers", () => {
  it("parseExpiry", () => {
    expect(parseExpiry(undefined)).toBeNull();
    expect(parseExpiry("perm")).toBeNull();
    expect(parseExpiry(" 1H ")).toBe("1h");
    expect(parseExpiry("3d")).toBe("72h");
    expect(parseExpiry("7d")).toBe("invalid");
  });

  it("parseRange", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-10", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=95-200", 100)).toEqual({ offset: 95, length: 5 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-1", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});
