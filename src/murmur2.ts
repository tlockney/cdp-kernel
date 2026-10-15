// MurmurHash2 (32-bit), as the Jupyter debugger uses it to name a cell's
// source (#18). JupyterLab computes a cell's path itself, as tmpFilePrefix +
// murmur2(code, hashSeed) + tmpFileSuffix, and the kernel must name the
// cell's script the same way, so this follows JupyterLab's
// packages/debugger/src/hash.ts (Modified BSD License, Copyright (c) Jupyter
// Development Team), itself adapted from Gary Court's murmurhash2_gc.js
// (MIT License, Copyright (c) 2011 Gary Court).

const M = 0x5bd1e995;
const ENCODER = new TextEncoder();

/** 32-bit multiply by M, without leaving the safe-integer range. */
function mul(x: number): number {
  return (x & 0xffff) * M + ((((x >>> 16) * M) & 0xffff) << 16);
}

/** The hash of a string's UTF-8 bytes. */
export function murmur2(str: string, seed: number): number {
  const data = ENCODER.encode(str);
  let len = data.length;
  let h = seed ^ len;
  let i = 0;
  while (len >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = mul(k);
    k ^= k >>> 24;
    k = mul(k);
    h = mul(h) ^ k;
    len -= 4;
    i += 4;
  }
  if (len === 3) h ^= data[i + 2] << 16;
  if (len >= 2) h ^= data[i + 1] << 8;
  if (len >= 1) {
    h ^= data[i];
    h = mul(h);
  }
  h ^= h >>> 13;
  h = mul(h);
  h ^= h >>> 15;
  return h >>> 0;
}
