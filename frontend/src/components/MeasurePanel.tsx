import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { bandColor } from '../lib/colors';
import { fmtDate, fmtDec, fmtRa, fmtSci, fmtUm } from '../lib/format';
import { valueAt, type FrameSet } from '../lib/frames';
import { useSpectrum } from '../lib/hooks';
import { Wcs } from '../lib/wcs';
import { useStore, type Probe } from '../store';
import type { BandKey, FluxUnit, Manifest, Mode, SpectrumPoint } from '../types';
import { LightCurveChart, SpectrumChart } from './Charts';

interface Props {
  manifest: Manifest;
  frames: FrameSet;
  band: BandKey;
  mode: Mode;
  index: number;
  cursor: { x: number; y: number } | null;
  probe: Probe | null;
  onClose: () => void;
}

const SURVEYS = [
  { id: 'allwise', aladinId: 'P/allWISE/color', label: 'AllWISE' },
  { id: '2mass', aladinId: 'P/2MASS/color', label: '2MASS' },
  { id: 'dss2', aladinId: 'P/DSS2/color', label: 'DSS2' },
] as const;

const DET_LIST: BandKey[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const DET_UM: Record<string, number> = {
  D1: 0.92,
  D2: 1.36,
  D3: 2.02,
  D4: 3.12,
  D5: 4.12,
  D6: 4.71,
};

function downloadCsv(key: string, ra: number, dec: number, pts: SpectrumPoint[]) {
  const head =
    'visit_index,epoch_index,detector,mjd,date,wavelength_um,bandwidth_um,flux_mjy_sr,flux_err_mjy_sr,flux_mjy,flux_err_mjy,flagged';
  const rows = pts.map((p) =>
    [
      p.visit_index,
      p.epoch_index,
      p.detector,
      p.mjd ?? '',
      p.iso_date,
      p.wavelength_um,
      p.bandwidth_um,
      p.flux_mjy_sr,
      p.flux_err,
      p.flux_mjy ?? '',
      p.flux_err_mjy ?? '',
      p.is_saturated_or_flagged,
    ].join(','),
  );
  const url = URL.createObjectURL(new Blob([[head, ...rows].join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `spherex_${key}_${ra.toFixed(4)}_${dec.toFixed(4)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 py-[2.5px]">
    <span className="text-haze">{k}</span>
    <span className="num text-right text-fog">{v}</span>
  </div>
);

export function MeasurePanel({ manifest, frames, band, mode, index, cursor, probe, onClose }: Props) {
  const patch = useStore((s) => s.patch);
  const wcs = useMemo(() => new Wcs(manifest.wcs), [manifest]);
  const plate = frames.meta[index] ?? frames.meta[0];
  const sky = cursor ? wcs.pixelToWorld(cursor.x, cursor.y) : null;
  const probeSky = probe ? wcs.pixelToWorld(probe.x, probe.y) : null;
  const value = cursor ? valueAt(frames, index, cursor.x, cursor.y, mode, frames.epochA, frames.epochB) : null;
  const spec = useSpectrum(manifest.target_key, probeSky?.ra ?? null, probeSky?.dec ?? null);

  const [unit, setUnit] = useState<FluxUnit>('MJy/sr');
  const [showFeatures, setShowFeatures] = useState(true);
  const [hideSaturated, setHideSaturated] = useState(false);
  const [colorByEpoch, setColorByEpoch] = useState(false);
  const [lcDetectors, setLcDetectors] = useState<BandKey[]>(DET_LIST);
  const [survey, setSurvey] = useState<'allwise' | '2mass' | 'dss2'>('allwise');
  const [atlasZoomed, setAtlasZoomed] = useState(false);

  useEffect(() => {
    setHideSaturated(false);
  }, [manifest.target_key]);

  const detector: BandKey = band.startsWith('D') ? band : (manifest.target.recommended_detector ?? 'D2');
  const curve = spec.data?.light_curves[detector] ?? [];
  const change = spec.data?.variability_summary[detector];
  const links = manifest.external_links ?? {};

  const rawPts = spec.data?.spectrum ?? [];
  const saturatedCount = rawPts.filter((p) => p.is_saturated).length;
  const hasUnsaturated = rawPts.some((p) => !p.is_saturated);
  const anySaturatedLc = spec.data
    ? Object.values(spec.data.variability_summary ?? {}).some((v) => v?.any_saturated)
    : false;

  const toggleLcDet = (d: BandKey) => {
    setLcDetectors((prev) => (prev.includes(d) ? (prev.length > 1 ? prev.filter((x) => x !== d) : prev) : [...prev, d]));
  };

  const centerRa = probeSky?.ra ?? manifest.target.ra_obs ?? manifest.target.ra_ref;
  const centerDec = probeSky?.dec ?? manifest.target.dec_obs ?? manifest.target.dec_ref;
  const fovDeg = manifest.wcs.fov_deg;
  const activeSurvey = SURVEYS.find((s) => s.id === survey) ?? SURVEYS[0];
  const skyContextUrl = `/api/sky-context?target_key=${encodeURIComponent(
    manifest.target_key,
  )}&ra=${centerRa.toFixed(6)}&dec=${centerDec.toFixed(6)}&fov=${fovDeg.toFixed(4)}&survey=${survey}`;
  const aladinUrl = `https://aladin.cds.unistra.fr/AladinLite/?target=${centerRa}%20${centerDec}&fov=${fovDeg}&survey=${activeSurvey.aladinId}`;

  const detInfo = manifest.detectors[band] ?? manifest.detectors.ALL ?? Object.values(manifest.detectors)[0];
  const rgbInfo = manifest.detectors.RGB ?? detInfo;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
      exit={{ opacity: 0, x: 10, transition: { duration: 0.18 } }}
      className="pointer-events-auto absolute bottom-44 right-5 top-20 z-20 w-[min(376px,calc(100vw-40px))] overflow-y-auto border border-ash/80 bg-void/90 p-5 text-[13.5px] backdrop-blur-[2px] md:right-10"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[24px] font-light text-white">Measure</h2>
        <button aria-label="Close measure" onClick={onClose} className="text-haze hover:text-white">
          ✕
        </button>
      </div>

      <section className="mt-3">
        <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-haze/80">Cursor</div>
        <Row k="RA" v={sky ? fmtRa(sky.ra) : '—'} />
        <Row k="Dec" v={sky ? fmtDec(sky.dec) : '—'} />
        <Row k="Pixel" v={cursor ? `${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)}` : '—'} />
        <Row
          k={mode === 'changes' ? 'Δ Signal' : mode === 'sum' ? 'Sum Signal' : 'Signal'}
          v={value === null ? '—' : `${fmtSci(value)} MJy/sr`}
        />
      </section>

      <section className="mt-4">
        <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-haze/80">Plate</div>
        <Row k="Number" v={`${index + 1} of ${frames.meta.length}`} />
        <Row k="Mean date" v={plate ? fmtDate(plate.mean_iso, true) : '—'} />
        <Row k="Visits span" v={plate ? `${fmtDate(plate.min_iso)} – ${fmtDate(plate.max_iso)}` : '—'} />
        <Row k="Coadded" v={plate ? `${plate.visits_coadded} of ${plate.total_visits_in_epoch} visits` : '—'} />
        <Row k="Band" v={band === 'RGB' ? 'RGB composite' : `${band} · ${fmtUm(manifest.detectors[band].measured_central_wavelength_um)}`} />
        {plate && (
          <Row
            k="Flagged px"
            v={`${plate.flag_stats.saturated_pixels} sat · ${plate.flag_stats.bad_pixels} bad · ${plate.flag_stats.contaminated_pixels} ghost`}
          />
        )}
      </section>

      <section className="mt-4">
        <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-haze/80">
          <span>Selected point</span>
          {spec.data && (
            <button
              onClick={() => setUnit((u) => (u === 'MJy/sr' ? 'mJy' : 'MJy/sr'))}
              className="link num lowercase tracking-normal text-fog hover:text-white"
              title="Toggle surface brightness (MJy/sr) vs aperture flux density (mJy)"
            >
              unit: {unit}
            </button>
          )}
        </div>
        {!probe && <p className="text-haze">Click anywhere on the sky to read its spectrum and brightness history.</p>}
        {probe && probeSky && (
          <>
            <Row k="RA" v={fmtRa(probeSky.ra)} />
            <Row k="Dec" v={fmtDec(probeSky.dec)} />
            {spec.loading && (
              <p className="mt-3 text-haze" style={{ animation: 'fade-in .6s ease-out both' }}>
                Measuring this point in every cached visit. This takes a few seconds…
              </p>
            )}
            {spec.error && <p className="mt-2 text-fog">{spec.error}</p>}
            {spec.data && (
              <>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-haze">
                  <span>
                    Spectrum · <span className="num text-fog">{spec.data.extracted_visits_count}/{spec.data.total_overlapping_visits}</span> visits ·{' '}
                    {spec.data.aperture_radius_arcsec}″
                  </span>
                  {(spec.data.uncached_visits_remaining ?? 0) > 0 && (
                    <button
                      onClick={() => spec.densify()}
                      disabled={spec.densifying}
                      className="link text-[12px] text-ember hover:text-white disabled:opacity-50"
                      title="Download additional uncached LVF exposures from NASA IRSA on the fly"
                    >
                      {spec.densifying ? 'Downloading…' : '+Densify (+24 visits)'}
                    </button>
                  )}
                </div>

                {/* Minimalist Spectrum Toggles */}
                <div className="mt-1.5 mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                  <button
                    onClick={() => setShowFeatures((v) => !v)}
                    className={showFeatures ? 'link text-white' : 'text-haze hover:text-fog'}
                  >
                    Spectral lines {showFeatures ? 'on' : 'off'}
                  </button>
                  <button
                    onClick={() => setColorByEpoch((v) => !v)}
                    className={colorByEpoch ? 'link text-white' : 'text-haze hover:text-fog'}
                  >
                    {colorByEpoch ? 'Color: by epoch' : 'Color: by band'}
                  </button>
                  <button
                    onClick={() => setHideSaturated((v) => !v)}
                    disabled={saturatedCount === 0 || !hasUnsaturated}
                    title={
                      !hasUnsaturated && saturatedCount > 0
                        ? 'All channels have saturated cores (wing photometry shown)'
                        : 'Hide saturated channels'
                    }
                    className={`${
                      hideSaturated && hasUnsaturated ? 'link text-white' : 'text-haze hover:text-fog'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    Hide saturated ({saturatedCount})
                  </button>
                </div>

                <SpectrumChart
                  points={spec.data.spectrum}
                  unit={unit}
                  showFeatures={showFeatures}
                  features={spec.data.reference_features}
                  colorByEpoch={colorByEpoch}
                  hideSaturated={hideSaturated}
                />
                <div className="mt-1 text-[11.5px] text-haze">
                  Hollow dots are flagged in the pipeline (saturated, bad or contaminated).
                </div>

                {/* Multi-Epoch Light Curve with Detector Pills */}
                <div className="mt-4">
                  <div className="flex items-center justify-between text-[12.5px] text-haze">
                    <span>Brightness on each plate</span>
                    <span className="num text-[11.5px]">Active: {detector}</span>
                  </div>
                  <div className="mt-1.5 mb-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    {DET_LIST.map((d) => {
                      const on = lcDetectors.includes(d);
                      const vInfo = spec.data?.variability_summary?.[d];
                      return (
                        <button
                          key={d}
                          onClick={() => {
                            toggleLcDet(d);
                            patch({ band: d });
                          }}
                          className={`num flex items-center gap-1 border px-1.5 py-0.5 transition-colors ${
                            on ? 'border-fog/80 text-white' : 'border-ash/50 text-haze/60 hover:text-fog'
                          }`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: bandColor(DET_UM[d]) }} />
                          <span>{d}</span>
                          {vInfo && (
                            <span className="text-[10px] text-haze">
                              {vInfo.fractional_change_pct >= 0 ? '+' : ''}
                              {vInfo.fractional_change_pct.toFixed(0)}%
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <LightCurveChart
                    points={curve}
                    curves={spec.data.light_curves}
                    selectedDetectors={lcDetectors}
                    activeDetector={detector}
                    unit={unit}
                  />
                </div>

                {change && (
                  <Row
                    k={`First → last (${detector})`}
                    v={`${change.fractional_change_pct > 0 ? '+' : ''}${change.fractional_change_pct.toFixed(1)}% · ${change.significance_sigma.toFixed(0)}σ`}
                  />
                )}

                {anySaturatedLc && (
                  <p className="mt-1.5 border-l border-ember/70 pl-2.5 text-[11.5px] leading-snug text-haze">
                    Saturation flag (<code className="text-fog">OVERFLOW</code>): core pixels exceed SUR linearity in one or more bands; curve tracks relative PSF-wing brightness across epochs.
                  </p>
                )}

                <button
                  className="link mt-3 text-[13px] text-fog"
                  onClick={() => downloadCsv(manifest.target_key, probeSky.ra, probeSky.dec, spec.data!.spectrum)}
                >
                  Export spectrum as CSV
                </button>
              </>
            )}
          </>
        )}
      </section>

      {/* Multi-Epoch Plate Filmstrip Thumbnails (E1..En, DIFF, SUM, RGB) */}
      {detInfo && (
        <section className="mt-5 border-t border-ash/60 pt-3.5">
          <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-haze/80">Plates & composites</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {detInfo.epochs.map((ep, idx) => {
              const active = mode === 'blink' && index === idx;
              return (
                <button
                  key={ep.epoch_id}
                  onClick={() => patch({ mode: 'blink', playing: false, epoch: idx })}
                  className={`shrink-0 border p-1 text-left transition-colors ${
                    active ? 'border-fog text-white' : 'border-ash/70 text-haze hover:border-haze'
                  }`}
                  title={`Plate ${idx + 1} (${ep.mean_iso})`}
                >
                  <div className="num mb-1 flex items-center justify-between gap-2 text-[10px]">
                    <span className="text-fog">E{idx + 1}</span>
                    <span>{ep.mean_iso.slice(5)}</span>
                  </div>
                  <img
                    src={ep.image_url}
                    alt={`Plate ${idx + 1}`}
                    className="h-12 w-12 object-cover"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </button>
              );
            })}
            <button
              onClick={() =>
                patch({
                  mode: 'changes',
                  epochA: 0,
                  epochB: Math.max(0, detInfo.epochs.length - 1),
                })
              }
              className={`shrink-0 border p-1 text-left transition-colors ${
                mode === 'changes' ? 'border-ember text-white' : 'border-ash/70 text-haze hover:border-haze'
              }`}
              title="Changes only (Dipole difference)"
            >
              <div className="num mb-1 flex items-center justify-between gap-1 text-[10px]">
                <span className="text-ember">DIFF</span>
                <span>E{detInfo.epochs.length}−E1</span>
              </div>
              <img
                src={detInfo.diff_image_url}
                alt="Difference"
                className="h-12 w-12 object-cover"
                style={{ imageRendering: 'pixelated' }}
              />
            </button>
            {detInfo.sum_image_url && (
              <button
                onClick={() =>
                  patch({
                    mode: 'sum',
                    epochA: 0,
                    epochB: Math.max(0, detInfo.epochs.length - 1),
                  })
                }
                className={`shrink-0 border p-1 text-left transition-colors ${
                  mode === 'sum' ? 'border-fog text-white' : 'border-ash/70 text-haze hover:border-haze'
                }`}
                title="Deep sum (Stacked epochs)"
              >
                <div className="num mb-1 flex items-center justify-between gap-1 text-[10px]">
                  <span className="text-fog">SUM</span>
                  <span>E{detInfo.epochs.length}+E1</span>
                </div>
                <img
                  src={detInfo.sum_image_url}
                  alt="Deep sum"
                  className="h-12 w-12 object-cover"
                  style={{ imageRendering: 'pixelated' }}
                />
              </button>
            )}
            {rgbInfo && (
              <button
                onClick={() => patch({ band: 'RGB' })}
                className={`shrink-0 border p-1 text-left transition-colors ${
                  band === 'RGB' ? 'border-fog text-white' : 'border-ash/70 text-haze hover:border-haze'
                }`}
                title="False-colour IR RGB (D6 / D4 / D2)"
              >
                <div className="num mb-1 flex items-center justify-between gap-1 text-[10px]">
                  <span className="text-fog">RGB</span>
                  <span>D6/4/2</span>
                </div>
                <img
                  src={rgbInfo.epochs?.[0]?.image_url ?? rgbInfo.diff_image_url}
                  alt="RGB composite"
                  className="h-12 w-12 object-cover"
                  style={{ imageRendering: 'pixelated' }}
                />
              </button>
            )}
          </div>
        </section>
      )}

      {/* Sky Atlas Context (AllWISE / 2MASS / DSS2) */}
      <section className="mt-4 border-t border-ash/60 pt-3.5">
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-haze/80">
          <span>Sky Atlas Context</span>
          <a href={aladinUrl} target="_blank" rel="noreferrer" className="link lowercase tracking-normal text-fog">
            Open in CDS Aladin ↗
          </a>
        </div>
        <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
          <div className="flex gap-3">
            {SURVEYS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSurvey(s.id)}
                className={survey === s.id ? 'link text-white' : 'text-haze hover:text-fog'}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setAtlasZoomed((z) => !z)}
            className="num text-[11.5px] text-haze hover:text-fog"
          >
            {atlasZoomed ? 'Zoom 2×' : 'Zoom 1×'}
          </button>
        </div>
        <div className="relative h-28 w-full overflow-hidden border border-ash/70 bg-void">
          <img
            src={skyContextUrl}
            alt={`Sky Atlas Context (${activeSurvey.label})`}
            className={`h-full w-full object-cover opacity-90 transition-transform duration-200 ${
              atlasZoomed ? 'scale-150' : 'scale-100'
            }`}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-4 w-4 rounded-full border border-fog/80" />
          </div>
        </div>
      </section>

      {/* All 4 External Archive Links */}
      {Object.keys(links).length > 0 && (
        <section className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-ash/60 pt-3 text-[13px]">
          {links.wiseview && (
            <a className="link text-fog" href={links.wiseview} target="_blank" rel="noreferrer">
              WiseView
            </a>
          )}
          {links.irsa_spherex && (
            <a className="link text-fog" href={links.irsa_spherex} target="_blank" rel="noreferrer">
              NASA IRSA
            </a>
          )}
          {links.gaia_dr3 && (
            <a className="link text-fog" href={links.gaia_dr3} target="_blank" rel="noreferrer">
              Gaia DR3
            </a>
          )}
          {links.cadc && (
            <a className="link text-fog" href={links.cadc} target="_blank" rel="noreferrer">
              CSA CADC
            </a>
          )}
        </section>
      )}
    </motion.aside>
  );
}
