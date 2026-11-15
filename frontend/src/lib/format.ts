const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function fmtRa(deg: number, withSeconds = true): string {
  const h = (((deg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60);
  let ss = Math.round(((h - hh) * 60 - mm) * 60);
  if (ss === 60) { ss = 0; mm += 1; }
  if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
  return withSeconds ? `${pad(hh)}h ${pad(mm)}m ${pad(ss)}s` : `${pad(hh)}h ${pad(mm)}m`;
}

export function fmtDec(deg: number, withSeconds = true): string {
  const sign = deg < 0 ? '−' : '+';
  const a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return withSeconds ? `${sign}${pad(d)}° ${pad(m)}′ ${pad(s)}″` : `${sign}${pad(d)}° ${pad(m)}′`;
}

export function isoToMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

export function fmtDate(iso: string, withYear = false): string {
  return new Date(isoToMs(iso)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function fmtDateMs(ms: number, withYear = false): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function fmtUm(um: number): string {
  return `${um.toFixed(um < 2 ? 2 : 1)} µm`;
}

export function fmtSci(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2);
  return v.toFixed(a >= 100 ? 1 : 2);
}

export function fmtYears(y: number): string {
  if (y < 1) return `${Math.round(y * 12)} months`;
  if (y < 20) return `${y.toFixed(1)} years`;
  if (y < 200) return `${Math.round(y / 5) * 5} years`;
  return `${Math.round(y / 10) * 10} years`;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
