import { useMemo, useRef } from 'react';
import { bandColor, EMBER } from '../lib/colors';
import { fmtDateMs, fmtUm, isoToMs } from '../lib/format';
import type { BandEpoch, BandKey, Manifest, Visit } from '../types';

interface Props {
  manifest: Manifest;
  band: BandKey;
  meta: BandEpoch[];
  index: number;
  onSelect?: (i: number) => void;
  visits: Visit[] | null;
}

const DAY = 86_400_000;
const H = 30;

export function Ruler({ manifest, band, meta, index, onSelect, visits }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const info = manifest.detectors[band];
  const centre = info?.measured_central_wavelength_um ?? 2.9;

  const { t0, t1 } = useMemo(() => {
    const starts = manifest.epochs_summary.map((e) => isoToMs(e.min_iso));
    const ends = manifest.epochs_summary.map((e) => isoToMs(e.max_iso));
    const a = Math.min(...starts);
    const b = Math.max(...ends);
    const pad = Math.max(2 * DAY, (b - a) * 0.03);
    return { t0: a - pad, t1: b + pad };
  }, [manifest]);

  const pct = (ms: number) => ((ms - t0) / (t1 - t0)) * 100;

  const minor = useMemo(() => {
    const span = (t1 - t0) / DAY;
    const step = [1, 2, 3, 7, 10, 14, 30].find((s) => span / s <= 90) ?? 30;
    const out: number[] = [];
    for (let t = t0; t <= t1; t += step * DAY) out.push(t);
    return out;
  }, [t0, t1]);

  const visitTicks = useMemo(() => {
    if (!visits) return [];
    const all = band === 'ALL' || band === 'RGB';
    return visits.filter((v) => all || v.detector === band).map((v) => ({ t: isoToMs(v.iso_date), um: v.wavelength_um }));
  }, [visits, band]);

  const labels = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + (t1 - t0) * f);
  const plate = meta[index];
  const plateMs = plate ? isoToMs(plate.mean_iso) : t0;

  const pick = (clientX: number) => {
    if (!onSelect || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const ms = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    meta.forEach((m, i) => {
      if (Math.abs(isoToMs(m.mean_iso) - ms) < Math.abs(isoToMs(meta[best].mean_iso) - ms)) best = i;
    });
    onSelect(best);
  };

  const labelPct = Math.min(94, Math.max(6, pct(plateMs)));

  return (
    <div className="select-none" aria-label="Timeline of SPHEREx plates">
      <div className="relative h-7">
        <div className="absolute bottom-1 -translate-x-1/2 whitespace-nowrap text-[15px]" style={{ left: `${labelPct}%` }}>
          <span className="font-medium text-white">{plate ? fmtDateMs(plateMs) : ''}</span>
          <span className="ml-3 text-haze">{band === 'ALL' ? '0.75–5 µm' : fmtUm(centre)}</span>
        </div>
      </div>

      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-valuemin={1}
        aria-valuemax={meta.length}
        aria-valuenow={index + 1}
        aria-valuetext={plate ? `Plate ${index + 1} of ${meta.length}, ${fmtDateMs(plateMs, true)}` : undefined}
        className={`relative touch-none ${onSelect ? 'cursor-pointer' : ''}`}
        style={{ height: H + 6 }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      >
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 1000 ${H + 6}`} preserveAspectRatio="none">
          {minor.map((t, i) => (
            <line key={i} x1={pct(t) * 10} x2={pct(t) * 10} y1={H - 9} y2={H} stroke="#8FA0AE" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
          ))}
          {visitTicks.map((v, i) => (
            <line key={`v${i}`} x1={pct(v.t) * 10} x2={pct(v.t) * 10} y1={H - 15} y2={H} stroke={bandColor(v.um)} strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />
          ))}
          {meta.map((m, i) => {
            const a = pct(isoToMs(m.min_iso)) * 10;
            const b = pct(isoToMs(m.max_iso)) * 10;
            return (
              <line key={`s${i}`} x1={a} x2={Math.max(b, a + 2)} y1={H + 3} y2={H + 3} stroke={i === index ? EMBER : bandColor(centre)} strokeOpacity={i === index ? 0.9 : 0.45} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            );
          })}
        </svg>

        {meta.map((m, i) => {
          const active = i === index;
          const color = active ? EMBER : bandColor(centre);
          return (
            <button
              key={m.epoch_id}
              aria-label={`Plate ${i + 1}, ${fmtDateMs(isoToMs(m.mean_iso), true)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSelect?.(i)}
              className="absolute top-0 -translate-x-1/2"
              style={{ left: `${pct(isoToMs(m.mean_iso))}%`, width: 18, height: H }}
            >
              <span
                className="absolute left-1/2 top-0 -translate-x-1/2 transition-all duration-500"
                style={{
                  width: active ? 3 : 2,
                  height: H,
                  background: color,
                  boxShadow: active ? `0 0 14px ${EMBER}` : 'none',
                  opacity: active ? 1 : 0.9,
                }}
              />
            </button>
          );
        })}
      </div>

      <div className="relative mt-1 h-5 text-[13px] text-haze">
        {labels.map((t, i) => (
          <span key={i} className="absolute whitespace-nowrap" style={{ left: `${pct(t)}%`, transform: i === 0 ? 'none' : i === 4 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
            {fmtDateMs(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
