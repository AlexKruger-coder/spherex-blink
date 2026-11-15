import { motion } from 'framer-motion';
import { ARCSEC_PER_PIXEL, yearsToCrossMoon, type Marker } from '../lib/field';
import { fmtYears, isoToMs } from '../lib/format';
import { useSpectrum } from '../lib/hooks';
import type { BandKey, Manifest } from '../types';

interface Props {
  manifest: Manifest;
  marker: Marker;
  band: BandKey;
  showTrail: boolean;
  onToggleTrail: () => void;
  onClose: () => void;
}

function measuredSpeed(m: Marker): number {
  const a = m.path[0];
  const b = m.path[m.path.length - 1];
  const years = (isoToMs(b.iso) - isoToMs(a.iso)) / (365.25 * 86_400_000);
  return years > 0 ? (m.drift * ARCSEC_PER_PIXEL) / years : 0;
}

export function ObjectCard({ manifest, marker, band, showTrail, onToggleTrail, onClose }: Props) {
  const isVariableCandidate = marker.kind === 'target' && !marker.moves;
  const p0 = marker.path[0];
  const spec = useSpectrum(isVariableCandidate ? manifest.target_key : undefined, isVariableCandidate ? p0.ra : null, isVariableCandidate ? p0.dec : null);
  const detector: BandKey = band.startsWith('D') ? band : manifest.target.recommended_detector ?? 'D2';
  const change = spec.data?.variability_summary[detector];

  const speed = measuredSpeed(marker);
  const target = marker.kind === 'target' ? manifest.target : null;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0, transition: { duration: 0.28, ease: 'easeOut' } }}
      exit={{ opacity: 0, x: 8, transition: { duration: 0.18 } }}
      className="pointer-events-auto absolute right-5 top-24 z-20 w-[min(340px,calc(100vw-40px))] border border-ash/80 bg-void/70 p-5 backdrop-blur-[2px] md:right-10"
    >
      <div className="flex items-center justify-between text-[14px]" style={{ color: marker.moves ? '#F0A04B' : '#C9D3DB' }}>
        <span className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
            <circle cx="6" cy="6" r="4.8" />
          </svg>
          Known object
        </span>
        <button aria-label="Close" onClick={onClose} className="text-haze hover:text-white">
          ✕
        </button>
      </div>

      <h2 className="mt-3 font-serif text-[32px] font-light leading-none text-white">{marker.name}</h2>
      <p className="mt-1 text-[14px] text-haze">{marker.subtitle}</p>
      {target?.description && <p className="mt-3 text-[15px] leading-snug text-fog/90">{target.description}</p>}

      {marker.moves ? (
        <div className="mt-4 flex items-end gap-3">
          <div className="num text-[52px] font-light leading-none text-white">{speed.toFixed(1)}″</div>
          <div className="pb-1 text-[13px] leading-tight text-haze">
            per year, about {(speed / ARCSEC_PER_PIXEL).toFixed(1)} SPHEREx pixels.
            <br />
            ~{fmtYears(yearsToCrossMoon(speed))} to cross the Moon.
          </div>
        </div>
      ) : (
        <div className="mt-4">
          {change ? (
            <div className="flex items-end gap-3">
              <div className="num text-[52px] font-light leading-none text-white">
                {change.fractional_change_pct > 0 ? '+' : ''}
                {change.fractional_change_pct.toFixed(0)}%
              </div>
              <div className="pb-1 text-[13px] leading-tight text-haze">
                brightness change from the first to the last plate ({detector}, {change.significance_sigma.toFixed(0)}σ).
                <br />
                It does not move. It changes.
              </div>
            </div>
          ) : (
            <p className="text-[14px] text-haze">{spec.loading ? 'Measuring brightness on every plate…' : spec.error ?? 'No measurable motion between plates.'}</p>
          )}
          {change?.any_saturated && <p className="mt-2 text-[12px] text-haze">Some visits are flagged as saturated, so treat the exact number with care.</p>}
        </div>
      )}

      {marker.moves && (
        <button onClick={onToggleTrail} className="link mt-4 text-[15px] text-fog">
          {showTrail ? 'Hide path' : 'Show path'}
        </button>
      )}
    </motion.aside>
  );
}
