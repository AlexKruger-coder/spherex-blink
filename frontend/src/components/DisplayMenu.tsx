import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { bandColor } from '../lib/colors';
import { BAND_ORDER, FOV_OPTIONS } from '../lib/field';
import { containScale, coverScale } from '../lib/view';
import { useStore } from '../store';
import type { BandKey, ColormapMode, Manifest, ObserveBody } from '../types';

const Row = ({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <div className="mt-4 first:mt-0">
    <div className="mb-2 flex items-center justify-between text-[12px] uppercase tracking-[0.14em] text-haze/80">
      <span>{label}</span>
      {right}
    </div>
    {children}
  </div>
);

const PALETTES: { id: ColormapMode; label: string }[] = [
  { id: 'observatory', label: 'Observatory' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'grayscale', label: 'Grayscale' },
  { id: 'inverted_wiseview', label: 'WiseView Inverted' },
];

export function DisplayMenu({
  manifest,
  busy = false,
  onObserve,
}: {
  manifest: Manifest;
  busy?: boolean;
  onObserve: (body: ObserveBody, preferBand?: BandKey) => void;
}) {
  const {
    band,
    brightness,
    colormap,
    pixelMode,
    style,
    showMarkers,
    showAllGaia,
    gaiaMagLimit,
    showFlagsOverlay,
    showCoreLoupe,
    targets,
    patch,
  } = useStore();
  const [local, setLocal] = useState(brightness);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setLocal(brightness);
  }, [brightness]);

  useEffect(() => {
    if (local === brightness) return;
    const t = setTimeout(() => patch({ brightness: local }), 100);
    return () => clearTimeout(t);
  }, [local, brightness, patch]);

  const fit = () => {
    const r = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    patch({
      view: {
        zoom: containScale(r, manifest.wcs.width, manifest.wcs.height) / coverScale(r, manifest.wcs.width, manifest.wcs.height),
        dx: 0,
        dy: 0,
      },
    });
  };

  const currentFov = manifest.wcs.fov_deg;
  const activeFovOpt =
    FOV_OPTIONS.reduce((best, opt) => (Math.abs(opt.value - currentFov) < Math.abs(best.value - currentFov) ? opt : best), FOV_OPTIONS[1]);

  const handleFovChange = (newFov: number) => {
    if (busy) return;
    patch({ fovDeg: newFov });
    if (manifest.target.is_named_target && manifest.target.id) {
      onObserve({ target: manifest.target.id, fov_deg: newFov }, band);
    } else {
      onObserve(
        {
          ra: manifest.target.ra_obs ?? manifest.target.ra_ref,
          dec: manifest.target.dec_obs ?? manifest.target.dec_ref,
          fov_deg: newFov,
        },
        band,
      );
    }
  };

  const totalGaia = manifest.gaia_dr3_sources?.length ?? 0;
  const shownGaia = manifest.gaia_dr3_sources?.filter((s) => (s.gmag ?? 20) <= gaiaMagLimit).length ?? 0;

  const bandInfo = manifest.detectors[band] ?? manifest.detectors.ALL ?? Object.values(manifest.detectors)[0];
  const flagStats = bandInfo?.flag_stats ?? bandInfo?.epochs?.[0]?.flag_stats;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.24 } }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
      className="pointer-events-auto absolute right-5 top-16 z-30 max-h-[calc(100vh-140px)] w-[min(350px,calc(100vw-40px))] overflow-y-auto border border-ash/80 bg-void/95 p-5 text-[14px] backdrop-blur-[2px] md:right-10"
    >
      <Row label="Target & sky search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (!query.trim()) {
              patch({ error: 'Please enter a target name or sky coordinates (RA, Dec).', toast: 'Please enter a target name or sky coordinates (RA, Dec).' });
              setTimeout(() => patch({ toast: null }), 2600);
              return;
            }
            onObserve({ target: query.trim(), fov_deg: currentFov });
            setQuery('');
          }}
          className="flex items-center gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
            placeholder="Name or RA, Dec (e.g. 269.45, 4.69)…"
            aria-label="Quick search target or coordinates"
            className="w-full border-0 border-b border-ash bg-transparent pb-1.5 text-[14px] text-white outline-none transition-colors placeholder:text-haze/70 focus:border-fog"
          />
          <button type="submit" disabled={busy} className="link shrink-0 text-[13px] text-fog disabled:opacity-40">
            Go
          </button>
        </form>
        {targets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[13px]">
            {targets.map((t) => {
              const active = manifest.target.id === t.id;
              return (
                <button
                  key={t.id}
                  disabled={busy}
                  onClick={() => onObserve({ target: t.id, fov_deg: t.default_fov_deg }, t.recommended_detector)}
                  className={`transition-colors ${active ? 'link text-white' : 'text-haze hover:text-fog'} disabled:opacity-40`}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        )}
      </Row>

      <Row
        label="Field of view (FOV)"
        right={<span className="num lowercase tracking-normal text-haze">{activeFovOpt.arcmin} · {activeFovOpt.est}</span>}
      >
        <div className="flex flex-wrap gap-2">
          {FOV_OPTIONS.map((opt) => {
            const active = Math.abs(opt.value - currentFov) < 0.005;
            return (
              <button
                key={opt.value}
                disabled={busy}
                onClick={() => handleFovChange(opt.value)}
                title={opt.label}
                className={`num border px-2 py-0.5 text-[13px] transition-colors ${
                  active ? 'border-fog text-white' : 'border-ash/70 text-haze hover:border-haze hover:text-fog'
                } disabled:opacity-40`}
              >
                {opt.short}
              </button>
            );
          })}
        </div>
      </Row>

      <Row label="Infrared band">
        <div className="flex flex-col">
          {BAND_ORDER.filter((b) => manifest.detectors[b]?.epochs?.length).map((b) => {
            const info = manifest.detectors[b];
            const active = b === band;
            const isRec = manifest.target.recommended_detector === b;
            return (
              <button
                key={b}
                onClick={() => patch({ band: b })}
                className={`flex items-center gap-3 py-[4px] text-left transition-colors ${active ? 'text-white' : 'text-haze hover:text-fog'}`}
                aria-pressed={active}
              >
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-full"
                  style={{
                    background: b === 'RGB' ? 'conic-gradient(#6C8EBF, #D9D2C0, #E2602F, #6C8EBF)' : bandColor(info.measured_central_wavelength_um),
                    opacity: active ? 1 : 0.6,
                  }}
                />
                <span className="w-9 num">{b}</span>
                <span className="flex-1 truncate text-[13px] text-haze">
                  {b === 'RGB' ? 'false colour (D6/D4/D2)' : b === 'ALL' ? '0.75 – 5.00 µm, all detectors' : info.label}
                </span>
                {isRec && <span className="text-[11px] text-ember">rec</span>}
              </button>
            );
          })}
        </div>
      </Row>

      <Row
        label="Color palette"
        right={
          (colormap !== 'observatory' || brightness !== 1) && (
            <button
              onClick={() => {
                setLocal(1);
                patch({ colormap: 'observatory', brightness: 1 });
              }}
              className="link lowercase tracking-normal text-haze hover:text-white"
            >
              reset
            </button>
          )
        }
      >
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
          {PALETTES.map((p) => {
            const active = colormap === p.id && band !== 'RGB';
            return (
              <button
                key={p.id}
                disabled={band === 'RGB'}
                onClick={() => patch({ colormap: p.id })}
                className={`${active ? 'link text-white' : 'text-haze hover:text-fog'} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {band === 'RGB' && (
          <div className="mt-1 text-[12px] text-haze">3-band chromatic RGB composite (R=D6 4.7µm, G=D4 3.1µm, B=D2 1.3µm)</div>
        )}
      </Row>

      <Row label="Brightness & pixel rendering" right={<span className="num text-haze">{local.toFixed(2)}×</span>}>
        <input
          type="range"
          className="slider w-full"
          min={0.5}
          max={3}
          step={0.05}
          value={local}
          onChange={(e) => setLocal(parseFloat(e.target.value))}
          aria-label="Brightness"
        />
        <div className="mt-2 flex gap-5 text-[13px]">
          <button
            onClick={() => patch({ pixelMode: 'smooth' })}
            className={pixelMode === 'smooth' ? 'link text-white' : 'text-haze hover:text-fog'}
          >
            Smooth (Bicubic)
          </button>
          <button
            onClick={() => patch({ pixelMode: 'native' })}
            className={pixelMode === 'native' ? 'link text-white' : 'text-haze hover:text-fog'}
          >
            Native Pixels (6.2″/px)
          </button>
        </div>
      </Row>

      <Row label="Transition">
        <div className="flex gap-6 text-[13px]">
          {(['fade', 'hard'] as const).map((s) => (
            <button key={s} onClick={() => patch({ style: s })} className={style === s ? 'link text-white' : 'text-haze hover:text-fog'}>
              {s === 'fade' ? 'Crossfade' : 'Hard cut'}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Scientific overlays & view">
        <div className="flex flex-col gap-2 text-[13px]">
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <button onClick={() => patch({ showMarkers: !showMarkers })} className={showMarkers ? 'link text-white' : 'text-haze hover:text-fog'}>
              Markers {showMarkers ? 'on' : 'off'}
            </button>
            <button onClick={() => patch({ showAllGaia: !showAllGaia })} className={showAllGaia ? 'link text-white' : 'text-haze hover:text-fog'}>
              All Gaia DR3 stars {showAllGaia ? 'on' : 'off'}
            </button>
            <button
              onClick={() => patch({ showFlagsOverlay: !showFlagsOverlay })}
              className={showFlagsOverlay ? 'link text-white' : 'text-haze hover:text-fog'}
            >
              Contamination / FLAGS {showFlagsOverlay ? 'on' : 'off'}
            </button>
            <button
              onClick={() => patch({ showCoreLoupe: !showCoreLoupe })}
              className={showCoreLoupe ? 'link text-white' : 'text-haze hover:text-fog'}
            >
              Core Loupe (9×9 px) {showCoreLoupe ? 'on' : 'off'}
            </button>
          </div>

          {showAllGaia && (
            <div className="mt-1 border-l border-ash/80 pl-3">
              <div className="flex items-center justify-between text-[12px] text-haze">
                <span>Gaia Mag Limit (G ≤ {gaiaMagLimit.toFixed(1)})</span>
                <span className="num text-fog">
                  {shownGaia} / {totalGaia} stars
                </span>
              </div>
              <input
                type="range"
                className="slider mt-1 w-full"
                min={11.0}
                max={20.5}
                step={0.5}
                value={gaiaMagLimit}
                onChange={(e) => patch({ gaiaMagLimit: parseFloat(e.target.value) })}
                aria-label="Gaia Magnitude Limit"
              />
            </div>
          )}

          {flagStats && (
            <div className="num text-[12px] text-haze">
              Bitmask px: {flagStats.saturated_pixels} sat · {flagStats.bad_pixels} bad/CR · {flagStats.contaminated_pixels} ghost
            </div>
          )}

          <div className="mt-1 flex gap-6">
            <button onClick={fit} className="text-haze hover:text-fog">
              Show whole field
            </button>
            <button onClick={() => patch({ view: { zoom: 1, dx: 0, dy: 0 } })} className="text-haze hover:text-fog">
              Fill screen
            </button>
          </div>
        </div>
      </Row>
    </motion.div>
  );
}
