import { useMemo, useState } from 'react';
import { bandColor, EMBER } from '../lib/colors';
import { fmtDate, fmtSci, isoToMs } from '../lib/format';
import type { BandKey, FluxUnit, LightCurvePoint, ReferenceFeature, SpectrumPoint } from '../types';

const W = 328;
const AXIS = '#4A5560';
const TXT = '#8FA0AE';
const ICE = '#82B4EB';

const EPOCH_COLORS = ['#82B4EB', '#F0A04B', '#8CC5A3', '#D4A5C9', '#E2602F'];

const DET_CENTERS: Record<string, number> = {
  D1: 0.92,
  D2: 1.36,
  D3: 2.02,
  D4: 3.12,
  D5: 4.12,
  D6: 4.71,
};

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? 0.5 * (s[mid - 1] + s[mid]) : s[mid];
}

export interface SpectrumChartProps {
  points: SpectrumPoint[];
  unit?: FluxUnit;
  showFeatures?: boolean;
  features?: ReferenceFeature[];
  colorByEpoch?: boolean;
  hideSaturated?: boolean;
}

export function SpectrumChart({
  points,
  unit = 'MJy/sr',
  showFeatures = true,
  features = [],
  colorByEpoch = false,
  hideSaturated = false,
}: SpectrumChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (!points.length) return null;
    const hasUnsat = points.some((p) => !p.is_saturated);
    const pts = hideSaturated && hasUnsat ? points.filter((p) => !p.is_saturated) : points;
    if (!pts.length) return null;

    const H = 152;
    const pad = { l: 10, r: 10, t: 18, b: 22 };
    const getVal = (p: SpectrumPoint) => (unit === 'mJy' ? (p.flux_mjy ?? p.flux_mjy_sr) : p.flux_mjy_sr);
    const getErr = (p: SpectrumPoint) => (unit === 'mJy' ? (p.flux_err_mjy ?? p.flux_err) : p.flux_err);

    const ys = pts.map(getVal);
    const errs = pts.map(getErr);
    const loRaw = Math.min(...ys.map((v, i) => v - Math.max(0, errs[i] || 0)));
    const hiRaw = Math.max(...ys.map((v, i) => v + Math.max(0, errs[i] || 0)));
    const minPos = Math.min(...ys.filter((v) => v > 0));
    const log = loRaw > 0 && hiRaw / Math.max(loRaw, 1e-6) > 40;
    const clampVal = (v: number) => (log ? Math.max(v, (minPos || 1e-4) * 0.5) : v);
    const f = (v: number) => (log ? Math.log10(clampVal(v)) : v);

    const lo = log ? clampVal(loRaw) : loRaw - (hiRaw - loRaw || 1) * 0.06;
    const hi = log ? Math.max(hiRaw, lo * 1.5) : hiRaw + (hiRaw - loRaw || 1) * 0.12;
    const a = f(lo);
    const b = f(hi);
    const span = b - a || 1;
    const x = (um: number) => pad.l + ((um - 0.7) / (5.1 - 0.7)) * (W - pad.l - pad.r);
    const y = (v: number) => {
      const py = pad.t + (1 - (f(v) - a) / span) * (H - pad.t - pad.b);
      return Math.max(pad.t, Math.min(H - pad.b, py));
    };

    // 14-bin wavelength-binned median SED trend (excluding saturated channels when possible)
    const numBins = 14;
    const sedTrend: { wl: number; flux: number }[] = [];
    for (let k = 0; k < numBins; k++) {
      const w0 = 0.75 + (k * (5.0 - 0.75)) / numBins;
      const w1 = 0.75 + ((k + 1) * (5.0 - 0.75)) / numBins;
      const inBin = pts.filter((p) => p.wavelength_um >= w0 && p.wavelength_um < w1);
      if (!inBin.length) continue;
      const unsat = inBin.filter((p) => !p.is_saturated);
      const grp = unsat.length ? unsat : inBin;
      sedTrend.push({
        wl: median(grp.map((p) => p.wavelength_um)),
        flux: median(grp.map(getVal)),
      });
    }

    return { H, pad, pts, ys, errs, lo: loRaw, hi: hiRaw, log, x, y, sedTrend };
  }, [points, unit, hideSaturated]);

  if (!layout) return null;
  const { H, pad, pts, ys, errs, lo, hi, log, x, y, sedTrend } = layout;
  const hovered = hoverIdx !== null && pts[hoverIdx] ? { pt: pts[hoverIdx], val: ys[hoverIdx], err: errs[hoverIdx] } : null;

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spectrum at the selected point" className="overflow-visible">
        <path d={`M${pad.l} ${H - pad.b}H${W - pad.r}`} stroke={AXIS} />
        {[1, 2, 3, 4, 5].map((u) => (
          <g key={u}>
            <path d={`M${x(u)} ${H - pad.b}v4`} stroke={AXIS} />
            <text x={x(u)} y={H - 5} fontSize="10.5" fill={TXT} textAnchor="middle">
              {u} µm
            </text>
          </g>
        ))}

        {/* Reference molecular & atomic spectral features */}
        {showFeatures &&
          features.map((feat, idx) => {
            const px = x(feat.wavelength_um);
            if (px < pad.l || px > W - pad.r) return null;
            return (
              <g key={`${feat.label}-${idx}`}>
                <line
                  x1={px}
                  x2={px}
                  y1={pad.t}
                  y2={H - pad.b}
                  stroke={EMBER}
                  strokeOpacity="0.26"
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
                {idx % 2 === 0 && (
                  <text x={px} y={pad.t - 3} fontSize="8.5" fill={EMBER} fillOpacity="0.8" textAnchor="middle">
                    {feat.label.split(' ')[0]}
                  </text>
                )}
              </g>
            );
          })}

        {/* Smooth wavelength-binned median SED curve */}
        {sedTrend.length >= 2 && (
          <polyline
            fill="none"
            stroke={ICE}
            strokeOpacity="0.72"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={sedTrend.map((b) => `${x(b.wl).toFixed(1)},${y(b.flux).toFixed(1)}`).join(' ')}
          />
        )}

        {/* Individual visits with horizontal Δλ bandwidth bars and vertical ±1σ error bars */}
        {pts.map((p, i) => {
          const cx = x(p.wavelength_um);
          const cy = y(ys[i]);
          const bw = p.bandwidth_um || 0.03;
          const x0 = x(p.wavelength_um - bw / 2);
          const x1 = x(p.wavelength_um + bw / 2);
          const y0 = y(ys[i] - errs[i]);
          const y1 = y(ys[i] + errs[i]);
          const c = colorByEpoch ? EPOCH_COLORS[p.epoch_index % EPOCH_COLORS.length] : bandColor(p.wavelength_um);
          const isHov = hoverIdx === i;

          return (
            <g
              key={`${p.visit_index}-${i}`}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Horizontal bandwidth bar (Δλ) */}
              <line x1={x0} x2={x1} y1={cy} y2={cy} stroke={c} strokeOpacity="0.6" strokeWidth="1.1" />
              {/* Vertical variance error bar (±1σ) */}
              <line x1={cx} x2={cx} y1={y1} y2={y0} stroke={c} strokeOpacity="0.6" strokeWidth="1.1" />
              {p.is_saturated_or_flagged ? (
                <circle cx={cx} cy={cy} r={isHov ? 3.8 : 2.5} fill="#080A0D" stroke={c} strokeWidth="1.3" strokeOpacity="0.9" />
              ) : (
                <circle cx={cx} cy={cy} r={isHov ? 3.8 : 2.3} fill={c} fillOpacity="0.95" />
              )}
            </g>
          );
        })}

        <text x={pad.l} y={pad.t + 7} fontSize="10" fill={TXT} className="num">
          {fmtSci(hi)} {unit}
        </text>
        <text x={pad.l} y={H - pad.b - 4} fontSize="10" fill={TXT} className="num">
          {fmtSci(lo)}
        </text>
        {log && (
          <text x={W - pad.r} y={pad.t + 7} fontSize="10" fill={TXT} textAnchor="end">
            log scale
          </text>
        )}
      </svg>

      <div className="num mt-1 min-h-[18px] text-[11px] text-haze">
        {hovered ? (
          <span className="text-fog">
            {hovered.pt.detector} · E{hovered.pt.epoch_index + 1} · λ={hovered.pt.wavelength_um.toFixed(3)}±
            {((hovered.pt.bandwidth_um || 0.03) / 2).toFixed(3)} µm · {fmtSci(hovered.val)}±{fmtSci(hovered.err)} {unit}
            {hovered.pt.is_saturated ? ' (sat)' : ''}
          </span>
        ) : (
          <span>Blue curve: median SED · Bars: Δλ & ±1σ · Hover point for readout</span>
        )}
      </div>
    </div>
  );
}

export function LightCurveChart({
  points,
  curves,
  selectedDetectors,
  activeDetector,
  unit = 'MJy/sr',
}: {
  points?: LightCurvePoint[];
  curves?: Partial<Record<BandKey, LightCurvePoint[]>>;
  selectedDetectors?: BandKey[];
  activeDetector?: BandKey;
  unit?: FluxUnit;
}) {
  const series = useMemo(() => {
    const out: { det: BandKey; pts: LightCurvePoint[] }[] = [];
    if (curves && selectedDetectors?.length) {
      for (const d of selectedDetectors) {
        const arr = curves[d];
        if (arr && arr.length >= 2) out.push({ det: d, pts: arr });
      }
    }
    if (!out.length && points && points.length >= 2) {
      out.push({ det: activeDetector ?? 'D2', pts: points });
    }
    return out;
  }, [points, curves, selectedDetectors, activeDetector]);

  if (!series.length) return null;

  const H = 112;
  const pad = { l: 10, r: 10, t: 12, b: 22 };
  const getVal = (p: LightCurvePoint) => (unit === 'mJy' ? (p.flux_mjy ?? p.flux_mjy_sr) : p.flux_mjy_sr);
  const getErr = (p: LightCurvePoint) =>
    unit === 'mJy' ? (p.flux_err_mjy ?? p.flux_err * 0.9) : p.flux_err;

  const allPts = series.flatMap((s) => s.pts);
  const ts = allPts.map((p) => isoToMs(p.mean_iso));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const vals = allPts.flatMap((p) => [getVal(p) - getErr(p), getVal(p) + getErr(p)]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);

  const firstIso = series[0].pts[0].mean_iso;
  const lastIso = series[0].pts[series[0].pts.length - 1].mean_iso;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Brightness of the selected point on each plate" className="overflow-visible">
      <path d={`M${pad.l} ${H - pad.b}H${W - pad.r}`} stroke={AXIS} />

      {series.map(({ det, pts }) => {
        const isPrimary = det === activeDetector || series.length === 1;
        const c = isPrimary ? EMBER : bandColor(DET_CENTERS[det] ?? 2.2);
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(isoToMs(p.mean_iso)).toFixed(1)} ${y(getVal(p)).toFixed(1)}`).join('');
        return (
          <g key={det}>
            <path d={line} fill="none" stroke={c} strokeWidth={isPrimary ? '1.6' : '1.1'} strokeOpacity={isPrimary ? '0.9' : '0.65'} />
            {pts.map((p, i) => {
              const tx = x(isoToMs(p.mean_iso));
              const v = getVal(p);
              const e = getErr(p);
              return (
                <g key={`${det}-${i}`}>
                  <path d={`M${tx} ${y(v - e)}V${y(v + e)}`} stroke={c} strokeOpacity="0.65" />
                  <circle
                    cx={tx}
                    cy={y(v)}
                    r={isPrimary ? 3 : 2.3}
                    fill={p.is_saturated ? '#080A0D' : c}
                    stroke={c}
                    strokeWidth="1.2"
                  >
                    <title>{`${det} E${p.epoch_index + 1} (${p.mean_iso}): ${fmtSci(v)} ± ${fmtSci(e)} ${unit}${p.is_saturated ? ' (saturated core)' : ''}`}</title>
                  </circle>
                </g>
              );
            })}
          </g>
        );
      })}

      <text x={pad.l} y={pad.t + 6} fontSize="10" fill={TXT} className="num">
        {fmtSci(hi)} {unit}
      </text>
      <text x={pad.l} y={H - 5} fontSize="10.5" fill={TXT}>
        {fmtDate(firstIso)}
      </text>
      <text x={W - pad.r} y={H - 5} fontSize="10.5" fill={TXT} textAnchor="end">
        {fmtDate(lastIso)}
      </text>
    </svg>
  );
}
