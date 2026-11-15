import type { BandKey, EpochPosition, Manifest, Mode } from '../types';

export interface PathPoint {
  epochIndex: number;
  iso: string;
  x: number;
  y: number;
  ra: number;
  dec: number;
}

export interface Marker {
  id: string;
  kind: 'target' | 'gaia';
  name: string;
  subtitle: string;
  moves: boolean;
  /** Total drift between the first and the last plate, in field pixels. */
  drift: number;
  path: PathPoint[];
}

const MOVE_PX = 0.5;
export const ARCSEC_PER_PIXEL = 6.2;

export const FOV_OPTIONS = [
  { value: 0.05, short: '0.05°', arcmin: '3.0′', est: '~15s', label: '0.05° (3.0′ · Fast ~15s)' },
  { value: 0.1, short: '0.10°', arcmin: '6.0′', est: '~25s', label: '0.10° (6.0′ · Standard ~25s)' },
  { value: 0.12, short: '0.12°', arcmin: '7.2′', est: '~28s', label: '0.12° (7.2′ · Binary Wide ~28s)' },
  { value: 0.15, short: '0.15°', arcmin: '9.0′', est: '~35s', label: '0.15° (9.0′ · Fast Movers ~35s)' },
  { value: 0.25, short: '0.25°', arcmin: '15.0′', est: '~55s', label: '0.25° (15.0′ · Wide Field ~55s)' },
] as const;

function pathFrom(m: Manifest, positions: Record<string, EpochPosition>): PathPoint[] {
  const out: PathPoint[] = [];
  for (const e of m.epochs_summary) {
    const p = positions[e.epoch_id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out.push({ epochIndex: e.epoch_index, iso: e.mean_iso, x: p.x, y: p.y, ra: p.ra, dec: p.dec });
    }
  }
  return out;
}

const drift = (p: PathPoint[]) =>
  p.length < 2 ? 0 : Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y);

export function buildMarkers(m: Manifest): Marker[] {
  const markers: Marker[] = [];
  const t = m.target;

  const targetPath = pathFrom(m, m.target_positions);
  if (t.is_named_target && targetPath.length) {
    const d = drift(targetPath);
    markers.push({
      id: 'target',
      kind: 'target',
      name: t.name,
      subtitle: t.category ?? 'Known object',
      moves: d >= MOVE_PX,
      drift: d,
      path: targetPath,
    });
  }

  const movers: Marker[] = [];
  for (const g of m.gaia_dr3_sources) {
    const path = pathFrom(m, g.epoch_positions);
    const d = drift(path);
    if (d < MOVE_PX) continue;
    const first = path[0];
    if (markers[0] && Math.hypot(first.x - markers[0].path[0].x, first.y - markers[0].path[0].y) < 1.6) continue;
    movers.push({
      id: `gaia-${g.source_id}`,
      kind: 'gaia',
      name: `Gaia DR3 ${g.source_id.slice(-6)}`,
      subtitle: g.gmag !== null ? `Known star, magnitude ${g.gmag.toFixed(1)}` : 'Known star',
      moves: true,
      drift: d,
      path,
    });
  }
  movers.sort((a, b) => b.drift - a.drift);
  return markers.concat(movers.slice(0, 5));
}

export function positionAt(marker: Marker, epochIndex: number): PathPoint {
  return (
    marker.path.find((p) => p.epochIndex === epochIndex) ??
    marker.path.reduce((best, p) => (Math.abs(p.epochIndex - epochIndex) < Math.abs(best.epochIndex - epochIndex) ? p : best))
  );
}

/** Where catalogues put the target at their reference epoch, if that is still inside the field and clearly elsewhere. */
export function catalogueGhost(m: Manifest): { x: number; y: number; year: number } | null {
  const ref = m.target_positions.reference;
  const first = m.target_positions[m.epochs_summary[0]?.epoch_id];
  if (!ref || !first || !m.target.is_named_target) return null;
  const inside = ref.x >= 0 && ref.y >= 0 && ref.x <= m.wcs.width - 1 && ref.y <= m.wcs.height - 1;
  if (!inside || Math.hypot(ref.x - first.x, ref.y - first.y) < 3) return null;
  return { x: ref.x, y: ref.y, year: Math.round(ref.epoch_jyear ?? m.target.ref_epoch_jyear) };
}

export function properMotionArcsecPerYear(m: Manifest): number {
  return Math.hypot(m.target.pmra_mas_yr, m.target.pmdec_mas_yr) / 1000;
}

const MOON_WIDTH_ARCSEC = 1800;
export const yearsToCrossMoon = (arcsecPerYear: number) => MOON_WIDTH_ARCSEC / arcsecPerYear;

export function defaultBand(m: Manifest): BandKey {
  const wanted = m.target.recommended_detector;
  if (wanted && m.detectors[wanted]?.epochs?.length) return wanted;
  return m.detectors.ALL?.epochs?.length ? 'ALL' : (Object.keys(m.detectors) as BandKey[]).find((b) => m.detectors[b].epochs.length) ?? 'ALL';
}

export const BAND_ORDER: BandKey[] = ['ALL', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'RGB'];

export function parseUrlBand(raw: string | null): BandKey | undefined {
  if (!raw) return undefined;
  const up = raw.toUpperCase() as BandKey;
  return BAND_ORDER.includes(up) ? up : undefined;
}

export function parseUrlMode(raw: string | null): Mode | undefined {
  if (!raw) return undefined;
  const low = raw.toLowerCase();
  if (low === 'blink') return 'blink';
  if (low === 'changes' || low === 'diff') return 'changes';
  if (low === 'sum' || low === 'stack') return 'sum';
  if (low === 'side') return 'side';
  return undefined;
}

/** A round scale-bar length (in arcsec) that is 70–150 px wide at the current zoom. */
export function niceScale(pxPerArcsec: number): { arcsec: number; px: number; label: string } {
  const candidates = [5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600];
  const pick = candidates.find((c) => c * pxPerArcsec >= 70) ?? candidates[candidates.length - 1];
  const label = pick >= 60 ? `${pick / 60}′` : `${pick}″`;
  return { arcsec: pick, px: pick * pxPerArcsec, label };
}

export function urlParamsForState(m: Manifest, band: BandKey, epoch: number, mode: Mode): URLSearchParams {
  const q = new URLSearchParams();
  q.set('f', m.target_key);
  if (m.target.id && (m.target.is_named_target || !m.target.id.startsWith('coord_'))) {
    q.set('target', m.target.id);
  }
  const raVal = m.target.ra_obs ?? m.target.ra_ref;
  const decVal = m.target.dec_obs ?? m.target.dec_ref;
  q.set('ra', raVal.toFixed(5));
  q.set('dec', decVal.toFixed(5));
  q.set('b', band);
  q.set('detector', band);
  q.set('e', String(epoch));
  q.set('m', mode);
  q.set('mode', mode === 'changes' ? 'diff' : mode);
  q.set('fov', m.wcs.fov_deg.toFixed(2));
  return q;
}

export function urlForState(m: Manifest, band: BandKey, epoch: number, mode: Mode): string {
  const q = urlParamsForState(m, band, epoch, mode);
  return `${window.location.origin}${window.location.pathname}?${q}`;
}
