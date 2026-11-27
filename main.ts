// png-squeeze-01-run-20261127 — a lossless PNG squeezer written from scratch.
//
// Approach, in my own words:
//   1. Decode the stored RGBA PNG the generator writes.
//   2. Analyse the pixels: opaque? grey? at most 256 distinct colours? one
//      fully-transparent colour that no opaque pixel uses (a tRNS key)?
//   3. Try the lossless forms that can hold the image exactly — palette
//      (by count, by luminance), grey / grey+alpha / RGB / RGBA, with a tRNS
//      key where it applies — and, for each form, several per-row filter
//      choices (fixed None/Paeth, minimum-sum-of-absolutes, fewest-distinct-
//      pairs). Screen every candidate with zlib level 6 and keep the
//      smallest; the first wins a tie, so the result is deterministic.
//   4. Compress the winner with my own DEFLATE (lazy LZ77 matching over a
//      32 KiB window plus dynamic Huffman blocks, with a fixed-Huffman
//      fallback per block) and with zlib level 9, and keep whichever stream
//      is smaller. The output is deterministic: no clock, no randomness.
//   5. Write a strict PNG: only IHDR, PLTE, tRNS, IDAT, IEND, bit depth 8,
//      non-interlaced, correct CRCs, one zlib stream in IDAT.
//
// Node 22 runs `node /bot/main.ts`. Standard library only; nothing is
// installed before the program runs.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG decoding (the input: stored RGBA, colour type 6, bit depth 8)
// ---------------------------------------------------------------------------

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeStoredPng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (at + 8 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      if (data[8] !== 8) throw new Error('input bit depth is not 8');
      colourType = data[9];
      if (colourType !== 6) throw new Error('input colour type is not 6');
      if (data[12] !== 0) throw new Error('input is interlaced');
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += len;
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const z = new Uint8Array(idatLen);
  let off = 0;
  for (const chunk of idat) {
    z.set(chunk, off);
    off += chunk.length;
  }
  const raw = inflateSync(z);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[src++];
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev !== null ? prev[x] : 0;
      const c = prev !== null && x >= 4 ? prev[x - 4] : 0;
      if (filter === 0) row[x] = v;
      else if (filter === 1) row[x] = (v + a) & 0xff;
      else if (filter === 2) row[x] = (v + b) & 0xff;
      else if (filter === 3) row[x] = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) row[x] = (v + paethPredictor(a, b, c)) & 0xff;
      else throw new Error('unknown input filter ' + filter);
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// PNG encoding (strict: only IHDR, PLTE, tRNS, IDAT, IEND)
// ---------------------------------------------------------------------------

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // non-interlaced
  return d;
}

// ---------------------------------------------------------------------------
// Row filters
// ---------------------------------------------------------------------------

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev !== null ? prev[x] : 0;
    const c = prev !== null && x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else pred = paethPredictor(a, b, c);
    out[x] = (cur[x] - pred) & 0xff;
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

/** How many bytes written before a row brute force compresses its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

function filteredData(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    if (choice === 'brute') {
      // Per row, weigh every filter by what zlib actually writes for it
      // with the preceding filtered bytes as its dictionary, and keep the
      // smallest. This is the expensive choice, and the one that wins
      // most on text and window edges where a heuristic misjudges a row.
      const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
      const trialRow = new Uint8Array(stride + 1);
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        trialRow[0] = t;
        filterRow(t, cur, prev, bpp, trialRow.subarray(1));
        const cost =
          before.length === 0
            ? deflateSync(trialRow, { level: BRUTE_LEVEL, memLevel: 9 }).length
            : deflateSync(trialRow, { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
        if (cost < best) {
          best = cost;
          type = t;
        }
      }
      raw[at] = type;
      filterRow(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trials[t]);
      const cost = choice === 'minsum' ? signedSum(trials[t]) : pairsOf(trials[t], seen, ++stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Image analysis and lossless forms
// ---------------------------------------------------------------------------

interface ColourEntry {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: ColourEntry[] | null; // null when more than 256 distinct colours
}

function analyseImage(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const word = r | (g << 8) | (b << 16) | (a << 24);
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else counts.set(word, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: ColourEntry[] = [];
  for (const [word, count] of counts) {
    colours.push({
      r: word & 0xff,
      g: (word >> 8) & 0xff,
      b: (word >> 16) & 0xff,
      a: (word >>> 24) & 0xff,
      word,
      count,
    });
  }
  return { opaque, grey, colours };
}

/** The one fully-transparent colour a tRNS key can stand for, or null. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

function paletteForm(rgba: Uint8Array, colours: ColourEntry[], order: 'count' | 'luminance'): Form {
  const lum = (c: ColourEntry): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const word = rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24);
    indices[i] = index.get(word) as number;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, filters: order === 'count' ? [0, 'minsum'] : [0, 'minsum', 'brute'] };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------------------
// My own DEFLATE: lazy LZ77 matching + dynamic Huffman blocks.
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_CHAIN = 1024;
const GOOD_MATCH = 64;
const BLOCK_BYTES = 192 * 1024;

function lenSymbol(len: number): number {
  for (let s = 28; s >= 0; s--) if (len >= LEN_BASE[s]) return s;
  return 0;
}

function distSymbol(dist: number): number {
  for (let s = 29; s >= 0; s--) if (dist >= DIST_BASE[s]) return s;
  return 0;
}

interface Token {
  lit: number; // literal byte 0..255, or length symbol 257..285
  len: number; // match length (0 for a literal)
  dist: number; // match distance (0 for a literal)
  pos: number; // input position where the token starts
}

function hash3(data: Uint8Array, i: number): number {
  const v = ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 2654435761;
  return (v >>> 17) & 0x7fff;
}

/** Lazy LZ77 tokenisation of the whole input in one pass (window spans blocks). */
function tokenize(data: Uint8Array): Token[] {
  const n = data.length;
  const tokens: Token[] = [];
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const matchAt = (i: number, bestLen: number): { len: number; dist: number } => {
    if (i + 3 > n) return { len: 0, dist: 0 };
    const h = hash3(data, i);
    let cand = head[h];
    let foundLen = 0;
    let foundDist = 0;
    const minPos = i - 32768 > 0 ? i - 32768 : 0;
    const maxLen = Math.min(258, n - i);
    let chain = 0;
    while (cand >= minPos && cand !== -1 && chain < MAX_CHAIN) {
      chain++;
      if (data[cand + foundLen] === data[i + foundLen]) {
        let len = 0;
        // Compare four bytes at a time while they agree.
        while (len + 4 <= maxLen && view.getUint32(cand + len) === view.getUint32(i + len)) len += 4;
        while (len < maxLen && data[cand + len] === data[i + len]) len++;
        if (len > foundLen) {
          foundLen = len;
          foundDist = i - cand;
          if (len >= maxLen || len >= GOOD_MATCH) break;
        }
      }
      cand = prev[cand];
    }
    return { len: foundLen, dist: foundDist };
  };

  const insert = (i: number): void => {
    if (i + 3 > n) return;
    const h = hash3(data, i);
    prev[i] = head[h];
    head[h] = i;
  };

  let i = 0;
  while (i < n) {
    const cur = matchAt(i, 0);
    if (cur.len >= 3) {
      // Lazy: is the match one byte ahead longer?
      const next = matchAt(i + 1, 0);
      if (next.len > cur.len) {
        tokens.push({ lit: data[i], len: 0, dist: 0, pos: i });
        insert(i);
        i++;
        continue;
      }
      tokens.push({ lit: 257 + lenSymbol(cur.len), len: cur.len, dist: cur.dist, pos: i });
      for (let k = 0; k < cur.len; k++) insert(i + k);
      i += cur.len;
    } else {
      tokens.push({ lit: data[i], len: 0, dist: 0, pos: i });
      insert(i);
      i++;
    }
  }
  return tokens;
}

// Length-limited Huffman code lengths from symbol frequencies (max 15 bits).
function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used: number[] = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) used.push(s);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  // Min-heap of [frequency, symbol-or-node] built over tree nodes.
  interface HNode {
    f: number;
    sym: number; // >= 0 a leaf symbol, -1 an inner node
    left: HNode | null;
    right: HNode | null;
  }
  const heap: HNode[] = [];
  const push = (node: HNode): void => {
    heap.push(node);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p].f <= heap[k].f) break;
      const tmp = heap[p];
      heap[p] = heap[k];
      heap[k] = tmp;
      k = p;
    }
  };
  const pop = (): HNode => {
    const top = heap[0];
    const last = heap.pop() as HNode;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === k) break;
        const tmp = heap[m];
        heap[m] = heap[k];
        heap[k] = tmp;
        k = m;
      }
    }
    return top;
  };
  for (const s of used) push({ f: freq[s], sym: s, left: null, right: null });
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    push({ f: a.f + b.f, sym: -1, left: a, right: b });
  }
  const depths = new Int32Array(n);
  const walk = (node: HNode, d: number): void => {
    if (node.sym >= 0) {
      depths[node.sym] = d;
      return;
    }
    walk(node.left as HNode, d + 1);
    walk(node.right as HNode, d + 1);
  };
  walk(heap[0], 0);
  // Length limiting: count depths, clamping the overflowing codes to
  // maxBits first (zlib's gen_bitlen), then shift pairs of codes down
  // until the counts describe a complete prefix code again.
  const blCount = new Int32Array(maxBits + 2);
  let overflow = 0;
  for (const s of used) {
    if (depths[s] > maxBits) {
      overflow++;
      blCount[maxBits]++;
    } else blCount[depths[s]]++;
  }
  if (overflow > 0) {
    let over = overflow;
    while (over > 0) {
      let m = maxBits - 1;
      while (m > 0 && blCount[m] === 0) m--;
      blCount[m]--;
      blCount[m + 1] += 2;
      blCount[maxBits]--;
      over -= 2;
    }
    // Reassign depths by frequency: the most frequent symbols get the
    // shortest depths available.
    const order = [...used].sort((a, b) => freq[b] - freq[a] || a - b);
    let k = 0;
    for (let d = 1; d <= maxBits; d++) {
      for (let c = 0; c < blCount[d]; c++) lengths[order[k++]] = d;
    }
    // Any symbol the counts did not cover (rounding) gets maxBits.
    for (; k < order.length; k++) lengths[order[k]] = maxBits;
    return lengths;
  }
  for (const s of used) lengths[s] = depths[s];
  return lengths;
}

/**
 * Canonical Huffman codes for `lengths`, returned bit-reversed: DEFLATE
 * packs a Huffman code most-significant bit first, while every other
 * field in the stream is packed least-significant bit first, so a code
 * must be reversed before this file's LSB-first BitWriter writes it.
 * Every code this file writes comes from here, fixed and dynamic alike.
 */
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) {
      const c = nextCode[l]++;
      // Reverse the code's l bits so the BitWriter's LSB-first packing
      // puts the code's most-significant bit on the wire first.
      let r = 0;
      for (let i = 0; i < l; i++) r = (r << 1) | ((c >> i) & 1);
      codes[s] = r;
    }
  }
  return codes;
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;

  write(value: number, count: number): void {
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }

  align(): void {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }

  finish(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

const FIXED_LIT_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s++) FIXED_LIT_LEN[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);
const FIXED_LIT_CODE = canonicalCodes(FIXED_LIT_LEN);
const FIXED_DIST_CODE = canonicalCodes(FIXED_DIST_LEN);

function tokenBitCost(
  tokens: Token[],
  litLen: Uint8Array,
  distLen: Uint8Array,
): number {
  let cost = 0;
  for (const t of tokens) {
    if (t.len === 0) {
      cost += litLen[t.lit];
    } else {
      const ls = t.lit - 257;
      cost += litLen[t.lit] + LEN_EXTRA[ls];
      const ds = distSymbol(t.dist);
      cost += distLen[ds] + DIST_EXTRA[ds];
    }
  }
  cost += litLen[256]; // end of block
  return cost;
}

function emitTokens(
  w: BitWriter,
  tokens: Token[],
  litLen: Uint8Array,
  litCode: Uint32Array,
  distLen: Uint8Array,
  distCode: Uint32Array,
): void {
  for (const t of tokens) {
    if (t.len === 0) {
      w.write(litCode[t.lit], litLen[t.lit]);
    } else {
      const ls = t.lit - 257;
      w.write(litCode[t.lit], litLen[t.lit]);
      if (LEN_EXTRA[ls] > 0) w.write(t.len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSymbol(t.dist);
      w.write(distCode[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) w.write(t.dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.write(litCode[256], litLen[256]);
}

/** Encode one block's tokens with a dynamic Huffman header. */
function emitDynamicBlock(w: BitWriter, tokens: Token[], litLen: Uint8Array, distLen: Uint8Array, isFinal: boolean): void {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  // RLE the code lengths with symbols 16 (repeat previous), 17, 18 (zeros).
  const rleSym: number[] = [];
  const rleVal: number[] = [];
  const rleBits: number[] = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        rleSym.push(18);
        rleVal.push(take - 11);
        rleBits.push(7);
        left -= take;
      }
      if (left >= 3) {
        rleSym.push(17);
        rleVal.push(left - 3);
        rleBits.push(3);
        left = 0;
      }
      for (let k = 0; k < left; k++) {
        rleSym.push(0);
        rleVal.push(0);
        rleBits.push(0);
      }
    } else {
      rleSym.push(v);
      rleVal.push(0);
      rleBits.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        rleSym.push(16);
        rleVal.push(take - 3);
        rleBits.push(2);
        left -= take;
      }
      for (let k = 0; k < left; k++) {
        rleSym.push(v);
        rleVal.push(0);
        rleBits.push(0);
      }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const s of rleSym) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCode = canonicalCodes(clLen);
  w.write(isFinal ? 1 : 0, 1);
  w.write(2, 2); // dynamic Huffman block
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < rleSym.length; k++) {
    w.write(clCode[rleSym[k]], clLen[rleSym[k]]);
    if (rleBits[k] > 0) w.write(rleVal[k], rleBits[k]);
  }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  emitTokens(w, tokens, litLen, litCode, distLen, distCode);
}

/** My DEFLATE stream (raw, no zlib wrapper) for the filtered bytes. */
function myDeflate(data: Uint8Array): Uint8Array {
  const tokens = tokenize(data);
  // Split the token stream into blocks by input position.
  const blocks: Token[][] = [];
  let cur: Token[] = [];
  let nextBoundary = BLOCK_BYTES;
  for (const t of tokens) {
    if (t.pos >= nextBoundary && cur.length > 0) {
      blocks.push(cur);
      cur = [];
      nextBoundary += BLOCK_BYTES;
    }
    cur.push(t);
  }
  if (cur.length > 0 || blocks.length === 0) blocks.push(cur);
  const w = new BitWriter();
  for (let b = 0; b < blocks.length; b++) {
    const bt = blocks[b];
    const isFinal = b === blocks.length - 1;
    const litFreq = new Uint32Array(288);
    const distFreq = new Uint32Array(30);
    for (const t of bt) {
      if (t.len === 0) litFreq[t.lit]++;
      else {
        litFreq[t.lit]++;
        distFreq[distSymbol(t.dist)]++;
      }
    }
    litFreq[256] = 1; // end of block
    if (distFreq.reduce((a, v) => a + v, 0) === 0) distFreq[0] = 1;
    // A Huffman tree needs at least two symbols in each alphabet.
    let litUsed = 0;
    for (let s = 0; s < 288; s++) if (litFreq[s] > 0) litUsed++;
    if (litUsed < 2) litFreq[litUsed === 1 && litFreq[0] === 0 ? 0 : 1] = 1;
    let distUsed = 0;
    for (let s = 0; s < 30; s++) if (distFreq[s] > 0) distUsed++;
    if (distUsed < 2) {
      distFreq[distFreq[0] > 0 ? 1 : 0] = 1;
    }
    const litLen = buildLengths(litFreq, 15);
    const distLen = buildLengths(distFreq, 15);
    const fixedCost = 3 + tokenBitCost(bt, FIXED_LIT_LEN, FIXED_DIST_LEN);
    // Dynamic header cost: rough upper bound used only to choose the type.
    let dynCost = 3 + 5 + 5 + 4 + 19 * 3;
    for (let s = 0; s < 288; s++) if (litLen[s] > 0) dynCost += 8;
    dynCost += tokenBitCost(bt, litLen, distLen);
    if (fixedCost <= dynCost) {
      w.write(isFinal ? 1 : 0, 1);
      w.write(1, 2); // fixed Huffman block
      emitTokens(w, bt, FIXED_LIT_LEN, FIXED_LIT_CODE, FIXED_DIST_LEN, FIXED_DIST_CODE);
    } else {
      emitDynamicBlock(w, bt, litLen, distLen, isFinal);
    }
  }
  return w.finish();
}

function zlibWrap(rawDeflate: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + rawDeflate.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(rawDeflate, 2);
  const a = adler32(data);
  out[2 + rawDeflate.length] = (a >>> 24) & 0xff;
  out[3 + rawDeflate.length] = (a >>> 16) & 0xff;
  out[4 + rawDeflate.length] = (a >>> 8) & 0xff;
  out[5 + rawDeflate.length] = a & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Squeeze one image, then the whole set
// ---------------------------------------------------------------------------

interface Squeezed {
  png: Uint8Array;
  colourType: number;
  bytes: number;
}

function squeezeImage(img: DecodedImage): Squeezed {
  const { width, height, rgba } = img;
  const forms = formsOf(rgba);
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of forms) {
    const chunkOverhead = (form.plte !== null ? 12 + form.plte.length : 0) + (form.trns !== null ? 12 + form.trns.length : 0);
    for (const choice of form.filters) {
      const data = filteredData(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = z.length + chunkOverhead;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const winner = best as { form: Form; data: Uint8Array; bytes: number };
  // Final stream: my own DEFLATE against zlib level 9, keep the smaller.
  const mine = zlibWrap(myDeflate(winner.data), winner.data);
  const theirs = deflateSync(winner.data, { level: 9, memLevel: 9 });
  const idat = mine.length <= theirs.length ? mine : new Uint8Array(theirs.buffer, theirs.byteOffset, theirs.length);
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, winner.form.colourType)]];
  if (winner.form.plte !== null) chunks.push(['PLTE', winner.form.plte]);
  if (winner.form.trns !== null) chunks.push(['tRNS', winner.form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  const png = pngOf(chunks);
  return { png, colourType: winner.form.colourType, bytes: png.length };
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodeStoredPng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const out = squeezeImage(image);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), out.png);
}
