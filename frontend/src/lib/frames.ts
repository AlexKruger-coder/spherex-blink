import { api } from '../api';
import type { BandEpoch, BandKey, ColormapMode, GridData, Manifest, Mode, PixelMode } from '../types';
import { bandRgb } from './colors';

/** Raw numbers for one band of one field: native grids (for probing) and bicubic-upsampled copies (for display). */
interface RawBand {
  kind: 'grid';
  w: number;
  h: number;
  factor: number;
  meta: BandEpoch[];
  native: Float32Array[];
  upsampled: Float32Array[];
  vmin: number;
  /** White point shared by all plates of the band: a high percentile of the pooled data. */
  white: number;
  diffAbsMax: number;
  wavelength: number;
}

interface RawRgbGrid {
  kind: 'rgb_grid';
  w: number;
  h: number;
  factor: number;
  meta: BandEpoch[];
  r: RawBand;
  g: RawBand;
  b: RawBand;
  nativeMean: Float32Array[];
}

interface RawImages {
  kind: 'image';
  w: number;
  h: number;
  factor: number;
  meta: BandEpoch[];
  epochs: HTMLCanvasElement[];
  diff: HTMLCanvasElement;
  sum: HTMLCanvasElement;
}

type Raw = RawBand | RawRgbGrid | RawImages;

export interface FrameOptions {
  brightness?: number;
  colormap?: ColormapMode;
  pixelMode?: PixelMode;
  epochA?: number;
  epochB?: number;
}

export interface FrameSet {
  key: string;
  band: BandKey;
  meta: BandEpoch[];
  /** Native grid size (field pixels). */
  w: number;
  h: number;
  /** Upsampling factor: canvases are w*factor by h*factor. */
  factor: number;
  epochs: HTMLCanvasElement[];
  /** diffs[i] = plate max(i,1) minus plate 0 (or E_B - E_A). Same length as epochs. */
  diffs: HTMLCanvasElement[];
  /** sums[i] = plate max(i,1) plus plate 0 (or E_B + E_A). Same length as epochs. */
  sums: HTMLCanvasElement[];
  /** Pairwise difference canvas for selected (epochA, epochB): E_B - E_A. */
  pairDiff: HTMLCanvasElement;
  /** Pairwise deep sum canvas for selected (epochA, epochB): E_B + E_A. */
  pairSum: HTMLCanvasElement;
  /** Native 1x resolution canvases for crisp 9x9 Core Loupe rendering. */
  nativeEpochs: HTMLCanvasElement[];
  nativePairDiff: HTMLCanvasElement;
  nativePairSum: HTMLCanvasElement;
  epochA: number;
  epochB: number;
  /** Native grids for cursor probing. */
  native: Float32Array[] | null;
}

const rawCache = new Map<string, Promise<Raw>>();
const renderCache = new Map<string, FrameSet>();
const flagImageCache = new Map<string, HTMLImageElement>();

const gridName = (url: string) => (url.split('/').pop() ?? '').replace('.npy.gz', '');

export function getFlagImage(url: string | undefined, onLoad?: () => void): HTMLImageElement | null {
  if (!url) return null;
  let img = flagImageCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    if (onLoad) img.onload = onLoad;
    img.src = url;
    flagImageCache.set(url, img);
  } else if (!img.complete && onLoad) {
    const prev = img.onload;
    img.onload = (ev) => {
      if (typeof prev === 'function') prev.call(img!, ev);
      onLoad();
    };
  }
  return img;
}

function toFloat(g: GridData): Float32Array {
  const out = new Float32Array(g.width * g.height);
  let i = 0;
  for (const row of g.data) for (const v of row) out[i++] = v === null || !Number.isFinite(v) ? g.median : v;
  return out;
}

/** Mitchell–Netravali (B = C = 1/3): smooth and round, with far less ringing than Catmull-Rom. */
function mitchell(t: number): [number, number, number, number] {
  const B = 1 / 3;
  const C = 1 / 3;
  const near = (x: number) => ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  const far = (x: number) => ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  return [far(1 + t), near(t), near(1 - t), far(2 - t)];
}

/**
 * Bicubic upsampling. Each pass is clamped to the range of the two nearest samples, so a very bright
 * star can never produce dark halos or negative values.
 */
function upsample(src: Float32Array, w: number, h: number, f: number): Float32Array {
  const uw = w * f;
  const uh = h * f;
  const tmp = new Float32Array(h * uw);
  for (let ox = 0; ox < uw; ox++) {
    const p = (ox + 0.5) / f - 0.5;
    const i0 = Math.floor(p);
    const wt = mitchell(p - i0);
    const ix = [i0 - 1, i0, i0 + 1, i0 + 2].map((i) => Math.min(w - 1, Math.max(0, i)));
    for (let y = 0; y < h; y++) {
      const r = y * w;
      const a = src[r + ix[1]];
      const b = src[r + ix[2]];
      const v = src[r + ix[0]] * wt[0] + a * wt[1] + b * wt[2] + src[r + ix[3]] * wt[3];
      tmp[y * uw + ox] = Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
    }
  }
  const out = new Float32Array(uh * uw);
  for (let oy = 0; oy < uh; oy++) {
    const p = (oy + 0.5) / f - 0.5;
    const i0 = Math.floor(p);
    const wt = mitchell(p - i0);
    const iy = [i0 - 1, i0, i0 + 1, i0 + 2].map((i) => Math.min(h - 1, Math.max(0, i)) * uw);
    for (let x = 0; x < uw; x++) {
      const a = tmp[iy[1] + x];
      const b = tmp[iy[2] + x];
      const v = tmp[iy[0] + x] * wt[0] + a * wt[1] + b * wt[2] + tmp[iy[3] + x] * wt[3];
      out[oy * uw + x] = Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
    }
  }
  return out;
}

/** Separable Gaussian blur. Used at ~half a native pixel, well below the instrument's own point-spread width. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Level reached by the strongest 0.5% of |change|: what counts as "full strength" in the difference view. */
function changeScale(values: Float32Array): number {
  const dev = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i]);
  dev.sort();
  return Math.max(dev[Math.floor(dev.length * 0.995)], 1e-6);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

function scaledCanvas(img: HTMLImageElement, w: number, h: number, smooth = true): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function chooseFactor(w: number, h: number) {
  return Math.max(2, Math.ceil(760 / Math.max(w, h)));
}

function percentile(arrays: Float32Array[], p: number): number {
  const pooled = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    pooled.set(a, o);
    o += a.length;
  }
  pooled.sort();
  return pooled[Math.min(pooled.length - 1, Math.floor((p / 100) * pooled.length))];
}

async function fetchRawBand(manifest: Manifest, band: BandKey): Promise<RawBand> {
  const info = manifest.detectors[band];
  const meta = info?.epochs ?? [];
  if (!meta.length) throw new Error(`No plates for ${band} in this field.`);
  const w = manifest.wcs.width;
  const h = manifest.wcs.height;
  const factor = chooseFactor(w, h);

  const grids = await Promise.all(meta.map((m) => api.grid(manifest.target_key, gridName(m.grid_url))));
  const native = grids.map(toFloat);
  return {
    kind: 'grid',
    w: grids[0].width,
    h: grids[0].height,
    factor,
    meta,
    native,
    upsampled: native.map((a) =>
      gaussianBlur(upsample(a, grids[0].width, grids[0].height, factor), grids[0].width * factor, grids[0].height * factor, 0.5 * factor),
    ),
    vmin: info.norm_vmin ?? grids[0].vmin,
    white: Math.max(percentile(native, 99.95), (info.norm_vmax ?? grids[0].vmax) * 1.2),
    diffAbsMax: info.diff_abs_max ?? grids[0].abs_max ?? 1,
    wavelength: info.measured_central_wavelength_um,
  };
}

async function fetchRaw(manifest: Manifest, band: BandKey): Promise<Raw> {
  const info = manifest.detectors[band];
  const meta = info?.epochs ?? [];
  if (!meta.length) throw new Error(`No plates for ${band} in this field.`);
  const w = manifest.wcs.width;
  const h = manifest.wcs.height;
  const factor = chooseFactor(w, h);

  if (band === 'RGB') {
    const hasD6 = !!manifest.detectors.D6?.epochs?.length;
    const hasD4 = !!manifest.detectors.D4?.epochs?.length;
    const hasD2 = !!manifest.detectors.D2?.epochs?.length;
    if (hasD6 && hasD4 && hasD2) {
      try {
        const [r, g, b] = await Promise.all([
          loadRaw(manifest, 'D6') as Promise<RawBand>,
          loadRaw(manifest, 'D4') as Promise<RawBand>,
          loadRaw(manifest, 'D2') as Promise<RawBand>,
        ]);
        if (r.kind === 'grid' && g.kind === 'grid' && b.kind === 'grid') {
          const count = Math.min(r.native.length, g.native.length, b.native.length);
          const nativeMean: Float32Array[] = [];
          for (let e = 0; e < count; e++) {
            const arr = new Float32Array(r.w * r.h);
            for (let k = 0; k < arr.length; k++) {
              arr[k] = (r.native[e][k] + g.native[e][k] + b.native[e][k]) / 3;
            }
            nativeMean.push(arr);
          }
          return {
            kind: 'rgb_grid',
            w: r.w,
            h: r.h,
            factor: r.factor,
            meta,
            r,
            g,
            b,
            nativeMean,
          };
        }
      } catch {
        /* Fall back to PNG images if grid loading fails */
      }
    }

    const [images, diff, sum] = await Promise.all([
      Promise.all(meta.map((m) => loadImage(m.image_url))),
      loadImage(info.diff_image_url),
      loadImage(info.sum_image_url ?? info.diff_image_url),
    ]);
    return {
      kind: 'image',
      w,
      h,
      factor,
      meta,
      epochs: images.map((img) => scaledCanvas(img, w * factor, h * factor)),
      diff: scaledCanvas(diff, w * factor, h * factor),
      sum: scaledCanvas(sum, w * factor, h * factor),
    };
  }

  return fetchRawBand(manifest, band);
}

export function loadRaw(manifest: Manifest, band: BandKey): Promise<Raw> {
  const id = `${manifest.target_key}|${band}`;
  let p = rawCache.get(id);
  if (!p) {
    p = fetchRaw(manifest, band);
    p.catch(() => rawCache.delete(id));
    rawCache.set(id, p);
  }
  return p;
}

/** Tone curve & scientific colormaps (Observatory default, Inferno, Viridis, Grayscale, WiseView Inverted). */
function buildLut(wavelength: number, colormap: ColormapMode = 'observatory'): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);

  if (colormap === 'grayscale') {
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const v = Math.round(9 + t * 246);
      lut[i * 3] = v;
      lut[i * 3 + 1] = v + Math.round((1 - t) * 3);
      lut[i * 3 + 2] = v + Math.round((1 - t) * 8);
    }
    return lut;
  }

  if (colormap === 'inverted_wiseview') {
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const v = Math.round(248 - Math.pow(t, 0.9) * 238);
      lut[i * 3] = v;
      lut[i * 3 + 1] = v;
      lut[i * 3 + 2] = v;
    }
    return lut;
  }

  if (colormap === 'viridis' || colormap === 'inferno') {
    const stops: [number, [number, number, number]][] =
      colormap === 'viridis'
        ? [
            [0.0, [16, 12, 44]],
            [0.25, [59, 82, 139]],
            [0.5, [33, 145, 140]],
            [0.75, [94, 201, 98]],
            [1.0, [253, 231, 37]],
          ]
        : [
            [0.0, [12, 10, 28]],
            [0.22, [82, 18, 110]],
            [0.48, [175, 48, 92]],
            [0.74, [242, 128, 32]],
            [1.0, [252, 250, 165]],
          ];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 1;
      while (k < stops.length - 1 && t > stops[k][0]) k++;
      const [t0, c0] = stops[k - 1];
      const [t1, c1] = stops[k];
      const u = (t - t0) / (t1 - t0);
      for (let c = 0; c < 3; c++) {
        lut[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * u);
      }
    }
    return lut;
  }

  // Default 'observatory': cool shadows, Fog mid-tones, warm highlights nudged toward the band's infrared colour.
  const stops: [number, [number, number, number]][] = [
    [0.0, [9, 12, 17]],
    [0.16, [22, 30, 41]],
    [0.42, [88, 104, 121]],
    [0.72, [201, 211, 219]],
    [1.0, [255, 247, 234]],
  ];
  const tint = bandRgb(wavelength);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && t > stops[k][0]) k++;
    const [t0, c0] = stops[k - 1];
    const [t1, c1] = stops[k];
    const u = (t - t0) / (t1 - t0);
    const mixT = 0.16 * t * t;
    for (let c = 0; c < 3; c++) {
      const base = c0[c] + (c1[c] - c0[c]) * u;
      lut[i * 3 + c] = base * (1 - mixT) + tint[c] * mixT;
    }
  }
  return lut;
}

/**
 * SPHEREx fields span four orders of magnitude between sky and a bright star. A strong asinh curve (as used in
 * astro-photography) lifts the faint sky while the star keeps a smooth gradient instead of a flat disc.
 */
const ASINH_K = 1000;
const ASINH_NORM = Math.asinh(ASINH_K);

function paintPlate(data: Float32Array, uw: number, uh: number, raw: RawBand, brightness: number, lut: Uint8ClampedArray) {
  const c = document.createElement('canvas');
  c.width = uw;
  c.height = uh;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(uw, uh);
  const span = Math.max(1e-6, (raw.white - raw.vmin) / brightness);
  for (let i = 0; i < data.length; i++) {
    const t = Math.min(1, Math.max(0, (data[i] - raw.vmin) / span));
    const y = Math.asinh(ASINH_K * t) / ASINH_NORM;
    const li = ((y * 255 + (Math.random() - 0.5)) | 0) * 3;
    const o = i * 4;
    const j = li < 0 ? 0 : li > 765 ? 765 : li;
    img.data[o] = lut[j];
    img.data[o + 1] = lut[j + 1];
    img.data[o + 2] = lut[j + 2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Signed difference: warm = "it was here" (brighter in Plate A), cool = "it is here now" (brighter in Plate B). */
function paintDiff(
  a: Float32Array,
  b: Float32Array,
  uw: number,
  uh: number,
  scale: number,
  brightness = 1,
  colormap: ColormapMode = 'observatory',
) {
  const c = document.createElement('canvas');
  c.width = uw;
  c.height = uh;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(uw, uh);
  const inverted = colormap === 'inverted_wiseview';
  const was = inverted ? [210, 68, 24] : [232, 104, 52];
  const now = inverted ? [28, 104, 205] : [120, 178, 240];
  const bg = inverted ? [246, 248, 250] : [8, 10, 13];
  const inv = brightness / Math.max(scale, 1e-6);
  const K = 40;
  const norm = Math.asinh(K);
  for (let i = 0; i < a.length; i++) {
    const d = (b[i] - a[i]) * inv;
    const m = Math.min(1, Math.asinh(K * Math.min(1, Math.abs(d))) / norm);
    const col = d < 0 ? was : now;
    const o = i * 4;
    img.data[o] = bg[0] + (col[0] - bg[0]) * m;
    img.data[o + 1] = bg[1] + (col[1] - bg[1]) * m;
    img.data[o + 2] = bg[2] + (col[2] - bg[2]) * m;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Deep stack sum (E_B + E_A): averages the two plates and stretches with the band's LUT for √2 deeper SNR. */
function paintSum(
  a: Float32Array,
  b: Float32Array,
  uw: number,
  uh: number,
  raw: RawBand,
  brightness: number,
  lut: Uint8ClampedArray,
) {
  const avg = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    avg[i] = 0.5 * (a[i] + b[i]);
  }
  return paintPlate(avg, uw, uh, raw, brightness, lut);
}

/** Synthesize RGB plate (R=D6, G=D4, B=D2) from Float32 arrays. */
function paintRgbPlate(
  rArr: Float32Array,
  gArr: Float32Array,
  bArr: Float32Array,
  uw: number,
  uh: number,
  raw: RawRgbGrid,
  brightness: number,
) {
  const c = document.createElement('canvas');
  c.width = uw;
  c.height = uh;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(uw, uh);
  const rSpan = Math.max(1e-6, (raw.r.white - raw.r.vmin) / brightness);
  const gSpan = Math.max(1e-6, (raw.g.white - raw.g.vmin) / brightness);
  const bSpan = Math.max(1e-6, (raw.b.white - raw.b.vmin) / brightness);

  for (let i = 0; i < rArr.length; i++) {
    const tr = Math.min(1, Math.max(0, (rArr[i] - raw.r.vmin) / rSpan));
    const tg = Math.min(1, Math.max(0, (gArr[i] - raw.g.vmin) / gSpan));
    const tb = Math.min(1, Math.max(0, (bArr[i] - raw.b.vmin) / bSpan));
    const yr = Math.asinh(ASINH_K * tr) / ASINH_NORM;
    const yg = Math.asinh(ASINH_K * tg) / ASINH_NORM;
    const yb = Math.asinh(ASINH_K * tb) / ASINH_NORM;
    const o = i * 4;
    img.data[o] = Math.round(9 + yr * 246);
    img.data[o + 1] = Math.round(11 + yg * 244);
    img.data[o + 2] = Math.round(15 + yb * 240);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Synthesize RGB pairwise difference (E_B - E_A) from D6, D4, D2 Float32 arrays. */
function paintRgbDiff(
  rA: Float32Array,
  rB: Float32Array,
  gA: Float32Array,
  gB: Float32Array,
  bA: Float32Array,
  bB: Float32Array,
  uw: number,
  uh: number,
  rScale: number,
  gScale: number,
  bScale: number,
  brightness: number,
) {
  const c = document.createElement('canvas');
  c.width = uw;
  c.height = uh;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(uw, uh);
  const invR = brightness / Math.max(rScale, 1e-6);
  const invG = brightness / Math.max(gScale, 1e-6);
  const invB = brightness / Math.max(bScale, 1e-6);
  const K = 25;
  const norm = Math.asinh(K);

  for (let i = 0; i < rA.length; i++) {
    const dr = (rB[i] - rA[i]) * invR;
    const dg = (gB[i] - gA[i]) * invG;
    const db = (bB[i] - bA[i]) * invB;
    const sr = Math.sign(dr) * (Math.asinh(K * Math.min(1, Math.abs(dr))) / norm);
    const sg = Math.sign(dg) * (Math.asinh(K * Math.min(1, Math.abs(dg))) / norm);
    const sb = Math.sign(db) * (Math.asinh(K * Math.min(1, Math.abs(db))) / norm);
    // Combine chromatic difference with warm/cool dipole readability
    const mag = Math.max(Math.abs(sr), Math.abs(sg), Math.abs(sb));
    const meanSign = (sr + sg + sb) / 3;
    const o = i * 4;
    if (mag < 0.04) {
      img.data[o] = 8;
      img.data[o + 1] = 10;
      img.data[o + 2] = 13;
    } else {
      const rVal = 8 + Math.max(0, meanSign < 0 ? -sr * 224 : sr * 185);
      const gVal = 10 + Math.max(0, meanSign < 0 ? -sg * 98 : sg * 175);
      const bVal = 13 + Math.max(0, meanSign < 0 ? -sb * 48 : sb * 235);
      img.data[o] = Math.min(255, Math.round(rVal));
      img.data[o + 1] = Math.min(255, Math.round(gVal));
      img.data[o + 2] = Math.min(255, Math.round(bVal));
    }
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Synthesize RGB pairwise deep sum (E_B + E_A) from D6, D4, D2 Float32 arrays. */
function paintRgbSum(
  rA: Float32Array,
  rB: Float32Array,
  gA: Float32Array,
  gB: Float32Array,
  bA: Float32Array,
  bB: Float32Array,
  uw: number,
  uh: number,
  raw: RawRgbGrid,
  brightness: number,
) {
  const rAvg = new Float32Array(rA.length);
  const gAvg = new Float32Array(gA.length);
  const bAvg = new Float32Array(bA.length);
  for (let i = 0; i < rA.length; i++) {
    rAvg[i] = 0.5 * (rA[i] + rB[i]);
    gAvg[i] = 0.5 * (gA[i] + gB[i]);
    bAvg[i] = 0.5 * (bA[i] + bB[i]);
  }
  return paintRgbPlate(rAvg, gAvg, bAvg, uw, uh, raw, brightness);
}

function cacheId(manifest: Manifest, band: BandKey, opts: FrameOptions): string {
  const brightness = opts.brightness ?? 1;
  const colormap = opts.colormap ?? 'observatory';
  const pixelMode = opts.pixelMode ?? 'smooth';
  const epCount = manifest.detectors[band]?.epochs?.length ?? 1;
  const sA = Math.max(0, Math.min(epCount - 1, opts.epochA ?? 0));
  const sB = Math.max(0, Math.min(epCount - 1, opts.epochB ?? Math.max(0, epCount - 1)));
  return `${manifest.target_key}|${band}|${brightness.toFixed(2)}|${colormap}|${pixelMode}|${sA}|${sB}`;
}

export function peekFrameSet(manifest: Manifest, band: BandKey, brightnessOrOpts: number | FrameOptions = 1): FrameSet | null {
  const opts: FrameOptions = typeof brightnessOrOpts === 'number' ? { brightness: brightnessOrOpts } : brightnessOrOpts;
  return renderCache.get(cacheId(manifest, band, opts)) ?? null;
}

export async function getFrameSet(
  manifest: Manifest,
  band: BandKey,
  brightnessOrOpts: number | FrameOptions = 1,
): Promise<FrameSet> {
  const opts: FrameOptions = typeof brightnessOrOpts === 'number' ? { brightness: brightnessOrOpts } : brightnessOrOpts;
  const brightness = opts.brightness ?? 1;
  const colormap = opts.colormap ?? 'observatory';
  const pixelMode = opts.pixelMode ?? 'smooth';

  const raw = await loadRaw(manifest, band);
  const epCount = raw.meta.length;
  const sA = Math.max(0, Math.min(epCount - 1, opts.epochA ?? 0));
  const sB = Math.max(0, Math.min(epCount - 1, opts.epochB ?? Math.max(0, epCount - 1)));

  const id = cacheId(manifest, band, { brightness, colormap, pixelMode, epochA: sA, epochB: sB });
  const hit = renderCache.get(id);
  if (hit) return hit;

  let set: FrameSet;
  if (raw.kind === 'image') {
    set = {
      key: manifest.target_key,
      band,
      meta: raw.meta,
      w: raw.w,
      h: raw.h,
      factor: raw.factor,
      epochs: raw.epochs,
      diffs: raw.epochs.map(() => raw.diff),
      sums: raw.epochs.map(() => raw.sum),
      pairDiff: raw.diff,
      pairSum: raw.sum,
      nativeEpochs: raw.epochs,
      nativePairDiff: raw.diff,
      nativePairSum: raw.sum,
      epochA: sA,
      epochB: sB,
      native: null,
    };
  } else if (raw.kind === 'rgb_grid') {
    const isNative = pixelMode === 'native';
    const factor = isNative ? 1 : raw.factor;
    const uw = raw.w * factor;
    const uh = raw.h * factor;
    const rSrc = isNative ? raw.r.native : raw.r.upsampled;
    const gSrc = isNative ? raw.g.native : raw.g.upsampled;
    const bSrc = isNative ? raw.b.native : raw.b.upsampled;

    const epochs = rSrc.map((_, i) => paintRgbPlate(rSrc[i], gSrc[i], bSrc[i], uw, uh, raw, brightness));
    const nativeEpochs = isNative
      ? epochs
      : raw.r.native.map((_, i) => paintRgbPlate(raw.r.native[i], raw.g.native[i], raw.b.native[i], raw.w, raw.h, raw, brightness));

    const rDiffNative = raw.r.native[sB].map((v, k) => v - raw.r.native[sA][k]);
    const gDiffNative = raw.g.native[sB].map((v, k) => v - raw.g.native[sA][k]);
    const bDiffNative = raw.b.native[sB].map((v, k) => v - raw.b.native[sA][k]);
    const rScale = changeScale(rDiffNative);
    const gScale = changeScale(gDiffNative);
    const bScale = changeScale(bDiffNative);

    const pairDiff = paintRgbDiff(rSrc[sA], rSrc[sB], gSrc[sA], gSrc[sB], bSrc[sA], bSrc[sB], uw, uh, rScale, gScale, bScale, brightness);
    const nativePairDiff = isNative
      ? pairDiff
      : paintRgbDiff(
          raw.r.native[sA],
          raw.r.native[sB],
          raw.g.native[sA],
          raw.g.native[sB],
          raw.b.native[sA],
          raw.b.native[sB],
          raw.w,
          raw.h,
          rScale,
          gScale,
          bScale,
          brightness,
        );

    const pairSum = paintRgbSum(rSrc[sA], rSrc[sB], gSrc[sA], gSrc[sB], bSrc[sA], bSrc[sB], uw, uh, raw, brightness);
    const nativePairSum = isNative
      ? pairSum
      : paintRgbSum(
          raw.r.native[sA],
          raw.r.native[sB],
          raw.g.native[sA],
          raw.g.native[sB],
          raw.b.native[sA],
          raw.b.native[sB],
          raw.w,
          raw.h,
          raw,
          brightness,
        );

    set = {
      key: manifest.target_key,
      band,
      meta: raw.meta,
      w: raw.w,
      h: raw.h,
      factor,
      epochs,
      diffs: epochs.map(() => pairDiff),
      sums: epochs.map(() => pairSum),
      pairDiff,
      pairSum,
      nativeEpochs,
      nativePairDiff,
      nativePairSum,
      epochA: sA,
      epochB: sB,
      native: raw.nativeMean,
    };
  } else {
    const isNative = pixelMode === 'native';
    const factor = isNative ? 1 : raw.factor;
    const uw = raw.w * factor;
    const uh = raw.h * factor;
    const src = isNative ? raw.native : raw.upsampled;
    const lut = buildLut(raw.wavelength, colormap);

    const epochs = src.map((d) => paintPlate(d, uw, uh, raw, brightness, lut));
    const nativeEpochs = isNative ? epochs : raw.native.map((d) => paintPlate(d, raw.w, raw.h, raw, brightness, lut));

    const nativeDiffArr = raw.native[sB].map((v, k) => v - raw.native[sA][k]);
    const scalePair = raw.native.length < 2 ? 1 : changeScale(nativeDiffArr);
    const pairDiff = paintDiff(src[sA], src[sB], uw, uh, scalePair, brightness, colormap);
    const nativePairDiff = isNative
      ? pairDiff
      : paintDiff(raw.native[sA], raw.native[sB], raw.w, raw.h, scalePair, brightness, colormap);

    const pairSum = paintSum(src[sA], src[sB], uw, uh, raw, brightness, lut);
    const nativePairSum = isNative
      ? pairSum
      : paintSum(raw.native[sA], raw.native[sB], raw.w, raw.h, raw, brightness, lut);

    set = {
      key: manifest.target_key,
      band,
      meta: raw.meta,
      w: raw.w,
      h: raw.h,
      factor,
      epochs,
      diffs: epochs.map(() => pairDiff),
      sums: epochs.map(() => pairSum),
      pairDiff,
      pairSum,
      nativeEpochs,
      nativePairDiff,
      nativePairSum,
      epochA: sA,
      epochB: sB,
      native: raw.native,
    };
  }

  if (renderCache.size > 32) renderCache.delete(renderCache.keys().next().value as string);
  renderCache.set(id, set);
  return set;
}

/**
 * Pixel value of plate `epoch` (or pairwise difference / sum) at array coordinates (x right, y up, as in the manifest).
 * The API serves grids north-up, so the stored row index counts from the top.
 */
export function valueAt(
  set: FrameSet,
  epoch: number,
  x: number,
  y: number,
  mode: Mode = 'blink',
  epochA = set.epochA,
  epochB = set.epochB,
): number | null {
  if (!set.native) return null;
  const col = Math.round(x);
  const rowFromTop = set.h - 1 - Math.round(y);
  if (col < 0 || rowFromTop < 0 || col >= set.w || rowFromTop >= set.h) return null;
  const idx = rowFromTop * set.w + col;
  const n = set.native.length;
  if (n === 0) return null;
  const sA = Math.max(0, Math.min(n - 1, epochA));
  const sB = Math.max(0, Math.min(n - 1, epochB));
  const sE = Math.max(0, Math.min(n - 1, epoch));
  if (mode === 'changes') {
    const va = set.native[sA]?.[idx];
    const vb = set.native[sB]?.[idx];
    return va !== undefined && vb !== undefined ? vb - va : null;
  }
  if (mode === 'sum') {
    const va = set.native[sA]?.[idx];
    const vb = set.native[sB]?.[idx];
    return va !== undefined && vb !== undefined ? vb + va : null;
  }
  return set.native[sE]?.[idx] ?? null;
}
