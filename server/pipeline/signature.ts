import { PNG } from "pngjs";

/**
 * Visual "sameness" fingerprint of a mockup, so we never send two near-identical template layouts
 * (the failure that measured 0.99 similarity clusters and lost a client). A 64-bit difference hash
 * of the top fold, computed on grayscale so it keys on layout/structure rather than brand colour or
 * the specific words — two mockups from the same template score high even with different content.
 */

const COLS = 9;
const ROWS = 8;

/** 64-bit dHash of a PNG screenshot, as 16 hex characters. */
export function dhash(png: Buffer): string {
  const { width: W, height: H, data } = PNG.sync.read(png);
  // Average grayscale over a COLS×ROWS grid of blocks.
  const gray = new Array(COLS * ROWS).fill(0);
  for (let ry = 0; ry < ROWS; ry++) {
    const y0 = Math.floor((ry * H) / ROWS);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * H) / ROWS));
    for (let rx = 0; rx < COLS; rx++) {
      const x0 = Math.floor((rx * W) / COLS);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * W) / COLS));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      gray[ry * COLS + rx] = n ? sum / n : 0;
    }
  }
  // Each pixel brighter than the one to its right → 1 bit. 8 comparisons × 8 rows = 64 bits.
  let bits = "";
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS - 1; rx++) {
      bits += gray[ry * COLS + rx] < gray[ry * COLS + rx + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, i) => (i.toString(2).match(/1/g) || []).length);

/** Number of differing bits between two 16-hex-char hashes (0 = identical, 64 = opposite). */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15];
  return d;
}

/** 1 = identical layout, 0 = completely different. */
export const similarity = (a: string, b: string) => 1 - hamming(a, b) / 64;
