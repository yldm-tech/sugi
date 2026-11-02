import qrcode from "qrcode-generator";

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

// The design's dotted QR code: round modules, rounded finder patterns, and a clear square in the middle for the hamster badge (error correction level H tolerates it).
export function qrSvg(text: string, size = 150): string {
  const q = qrcode(0, "H");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const c0 = n / 2;
  const cl = n * 0.15;
  const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  let dots = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c) || inFinder(r, c) || (Math.abs(r + 0.5 - c0) < cl && Math.abs(c + 0.5 - c0) < cl)) continue;
      dots += `M${c + 0.08} ${r + 0.5}a.42 .42 0 1 0 .84 0a.42 .42 0 1 0 -.84 0`;
    }
  }
  let finders = "";
  for (const [x, y] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    finders += roundedRect(x, y, 7, 7, 2.2) + roundedRect(x + 1, y + 1, 5, 5, 1.5) + roundedRect(x + 2, y + 2, 3, 3, 1);
  }
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="${size}" height="${size}" role="img" aria-label="QR"><path d="${dots}" fill="#3F4A3C"/><path d="${finders}" fill="#3F4A3C" fill-rule="evenodd"/></svg>`;
}
