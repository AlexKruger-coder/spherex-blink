import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ARCSEC_PER_PIXEL, buildMarkers, defaultBand, niceScale, positionAt, urlForState, urlParamsForState } from '../lib/field';
import { fmtDate, fmtDec, fmtRa, prefersReducedMotion } from '../lib/format';
import type { FrameSet } from '../lib/frames';
import { useVisits } from '../lib/hooks';
import { makeTransform, MAX_ZOOM } from '../lib/view';
import { MAX_SPEED, MIN_SPEED, useStore } from '../store';
import type { BandKey, Manifest, Mode, ObserveBody } from '../types';
import { AboutSheet } from './AboutSheet';
import { Brackets } from './Brackets';
import { DisplayMenu } from './DisplayMenu';
import { MeasurePanel } from './MeasurePanel';
import { ObjectCard } from './ObjectCard';
import { Overlay } from './Overlay';
import { Ruler } from './Ruler';
import { SkyStage } from './SkyStage';

interface Props {
  manifest: Manifest;
  frames: FrameSet | null;
  loading: boolean;
  frameError: string | null;
  develop: boolean;
  busy?: boolean;
  onObserve: (body: ObserveBody, preferBand?: BandKey) => void;
  onBack: () => void;
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'blink', label: 'Blink' },
  { id: 'changes', label: 'Changes only' },
  { id: 'sum', label: 'Deep sum' },
  { id: 'side', label: 'Side by side' },
];

export function Viewer({ manifest, frames, loading, frameError, develop, busy = false, onObserve, onBack }: Props) {
  const s = useStore();
  const {
    epoch,
    epochA,
    epochB,
    mode,
    playing,
    speed,
    style,
    pixelMode,
    view,
    band,
    measure,
    probe,
    selectedId,
    showTrail,
    showMarkers,
    showAllGaia,
    gaiaMagLimit,
    showFlagsOverlay,
    showCoreLoupe,
    aboutOpen,
    displayOpen,
    patch,
  } = s;
  const n = frames?.meta.length ?? 0;
  const index = Math.max(0, Math.min(Number.isFinite(epoch) ? epoch : 0, Math.max(0, n - 1)));
  const safeA = Math.max(0, Math.min(Number.isFinite(epochA) ? epochA : 0, Math.max(0, n - 1)));
  const safeB = Math.max(0, Math.min(Number.isFinite(epochB) ? epochB : Math.max(0, n - 1), Math.max(0, n - 1)));
  const markers = useMemo(() => buildMarkers(manifest), [manifest]);
  const visits = useVisits(manifest.target_key);
  const reduced = prefersReducedMotion();

  const [cursor, setCursor] = useState<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const [ringReady, setRingReady] = useState(false);
  const chrome = true;

  useEffect(() => {
    setRingReady(false);
    if (!frames) return;
    const wait = reduced ? 300 : Math.min(7000, ((2 * n) / Math.max(speed, 0.2)) * 1000);
    const t1 = setTimeout(() => setRingReady(true), wait);
    const target = markers.find((m) => m.kind === 'target');
    const t2 = target?.moves && !reduced ? setTimeout(() => patch({ showTrail: true }), wait + 900) : undefined;
    return () => {
      clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.target_key, frames?.band]);

  /* Everything that is shareable lives in the URL (supporting both ?f/b/e/m and ?target/ra/dec/detector/mode/fov). */
  useEffect(() => {
    const q = urlParamsForState(manifest, band, index, mode);
    window.history.replaceState(null, '', `?${q}`);
  }, [manifest, band, index, mode]);

  const targetPos = useCallback(
    (id: string | null) => {
      const m = markers.find((k) => k.id === id) ?? markers.find((k) => k.kind === 'target');
      if (!m || !frames || !frames.meta[index]) return null;
      const p = positionAt(m, frames.meta[index].epoch_index);
      return { x: p.x, y: p.y };
    },
    [markers, frames, index],
  );

  const toggleMeasure = () => {
    if (!measure) patch({ measure: true, selectedId: null, displayOpen: false, probe: probe ?? targetPos(null) });
    else patch({ measure: false });
  };

  const selectMarker = (id: string) => patch({ selectedId: id, ...(measure ? { probe: targetPos(id) } : {}) });

  const share = async () => {
    const url = urlForState(manifest, band, index, mode);
    try {
      await navigator.clipboard.writeText(url);
      patch({ toast: 'Link copied' });
    } catch {
      patch({ toast: url });
    }
    setTimeout(() => patch({ toast: null }), 2600);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if ((el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range') || el.tagName === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      const count = frames?.meta.length ?? 0;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          patch({ playing: !st.playing });
          break;
        case 'ArrowRight':
          patch({ epoch: Math.min(count - 1, st.epoch + 1), playing: false });
          break;
        case 'ArrowLeft':
          patch({ epoch: Math.max(0, st.epoch - 1), playing: false });
          break;
        case 'b':
          patch({ mode: 'blink' });
          break;
        case 'd':
          if (count > 1) patch({ mode: 'changes' });
          break;
        case 'a':
          if (count > 1) patch({ mode: 'sum' });
          break;
        case 's':
          if (count > 1) patch({ mode: 'side' });
          break;
        case 'm':
          toggleMeasure();
          break;
        case '+':
        case '=':
          patch({ view: { ...st.view, zoom: Math.min(MAX_ZOOM, st.view.zoom * 1.3) } });
          break;
        case '-':
          patch({ view: { ...st.view, zoom: Math.max(0.5, st.view.zoom / 1.3) } });
          break;
        case '0':
          patch({ view: { zoom: 1, dx: 0, dy: 0 } });
          break;
        case 'Escape':
          patch({ aboutOpen: false, displayOpen: false, selectedId: null, measure: false });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, measure, probe, markers, index]);

  const selected = markers.find((m) => m.id === selectedId) ?? null;
  const plateA = frames?.meta[safeA] ?? frames?.meta[0];
  const plateB = frames?.meta[mode === 'side' ? Math.max(1, index) : safeB] ?? frames?.meta[Math.max(1, index)];
  const hud = `transition-opacity duration-[600ms] ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`;
  const bandFlagsUrl = manifest.detectors[band]?.flags_overlay_url ?? manifest.flags_overlay_url;

  return (
    <div className="absolute inset-0 overflow-hidden bg-void" style={develop ? { animation: 'develop 1.4s cubic-bezier(.16,1,.3,1) both' } : undefined}>
      <SkyStage
        frames={frames}
        mode={mode}
        playing={playing}
        speed={speed}
        style={style}
        pixelMode={pixelMode}
        showFlagsOverlay={showFlagsOverlay}
        bandFlagsUrl={bandFlagsUrl}
        epoch={epoch}
        onEpoch={(i) => patch({ epoch: i })}
        view={view}
        onViewChange={(v) => patch({ view: v })}
        interactive
        onCursor={measure ? setCursor : undefined}
        onTap={(hit) => {
          if (measure && hit && frames && hit.x >= -0.5 && hit.y >= -0.5 && hit.x <= frames.w - 0.5 && hit.y <= frames.h - 0.5) patch({ probe: hit });
          else if (!measure) patch({ selectedId: null });
        }}
      >
        {(info) => {
          if (!frames) return null;
          const tr = makeTransform(info.panes[0], frames.w, frames.h, view);
          const scale = niceScale(tr.s / ARCSEC_PER_PIXEL);
          return (
            <>
              <Overlay
                manifest={manifest}
                frames={frames}
                info={info}
                view={view}
                mode={mode}
                markers={markers}
                showMarkers={showMarkers}
                showAllGaia={showAllGaia}
                gaiaMagLimit={gaiaMagLimit}
                showCoreLoupe={showCoreLoupe}
                ringReady={ringReady}
                showTrail={showTrail}
                selectedId={selectedId}
                onSelect={selectMarker}
                measure={measure}
                probe={probe}
                cursor={cursor ? { x: cursor.sx, y: cursor.sy } : null}
              />
              <div className={`pointer-events-none absolute bottom-[158px] right-6 text-right text-[13px] text-fog md:right-12 ${hud}`}>
                <div className="ml-auto h-[7px] border-x border-b border-fog/80" style={{ width: scale.px }} />
                <div className="mt-1 num">{scale.label}</div>
              </div>
            </>
          );
        }}
      </SkyStage>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-36 scrim-top" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 scrim-bottom" />
      <Brackets inset={26} color="rgba(201,211,219,0.42)" />

      <header className={`absolute inset-x-0 top-0 flex items-start justify-between px-6 pt-8 md:px-12 md:pt-9 ${hud}`}>
        <button onClick={onBack} className="pointer-events-auto flex items-start gap-3 text-left" aria-label="Back to start">
          <span className="mt-[7px] text-[20px] leading-none text-haze">‹</span>
          <span>
            <h1 className="font-serif text-[clamp(22px,2.4vw,30px)] font-light leading-none text-white">{manifest.target.name} field</h1>
            <span className="num mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-haze">
              <span>RA {fmtRa(manifest.wcs.crval[0], false)}</span>
              <span>Dec {fmtDec(manifest.wcs.crval[1], false)}</span>
              <span>FOV {(manifest.wcs.fov_deg * 60).toFixed(1)}′</span>
            </span>
          </span>
        </button>

        <nav className="pointer-events-auto relative flex gap-5 text-[17px] md:gap-7">
          <button className={`link ${measure ? 'text-white' : 'text-fog'}`} aria-pressed={measure} onClick={toggleMeasure}>
            Measure
          </button>
          <button
            className={`link ${displayOpen ? 'text-white' : 'text-fog'}`}
            aria-expanded={displayOpen}
            onClick={() => patch({ displayOpen: !displayOpen, measure: false })}
          >
            Display
          </button>
          <button className="link text-fog" onClick={share}>
            Share
          </button>
          <button className="link text-fog" onClick={() => patch({ aboutOpen: true })}>
            About
          </button>
        </nav>
      </header>

      {mode !== 'blink' && frames && plateA && plateB && (
        <div className={`pointer-events-auto absolute left-1/2 top-8 z-20 hidden -translate-x-1/2 text-center text-[13.5px] text-haze md:block ${hud}`}>
          {mode === 'changes' || mode === 'sum' ? (
            <div className="border border-ash/70 bg-void/85 px-4 py-2 backdrop-blur-[2px]">
              <div className="flex items-center justify-center gap-2.5 text-fog">
                <span className="text-haze">{mode === 'changes' ? 'Subtract:' : 'Stack:'}</span>
                <label className="flex items-center gap-1.5">
                  <span className="text-haze">Plate B</span>
                  <select
                    aria-label="Plate B"
                    value={safeB}
                    onChange={(e) => patch({ epochB: parseInt(e.target.value, 10) })}
                    className="num border border-ash bg-void px-1.5 py-0.5 text-[13px] text-white outline-none focus:border-fog"
                  >
                    {frames.meta.map((m, idx) => (
                      <option key={m.epoch_id} value={idx}>
                        Plate {idx + 1} ({fmtDate(m.mean_iso)})
                      </option>
                    ))}
                  </select>
                </label>
                <span className="num text-haze">{mode === 'changes' ? '−' : '+'}</span>
                <label className="flex items-center gap-1.5">
                  <span className="text-haze">Plate A</span>
                  <select
                    aria-label="Plate A"
                    value={safeA}
                    onChange={(e) => patch({ epochA: parseInt(e.target.value, 10) })}
                    className="num border border-ash bg-void px-1.5 py-0.5 text-[13px] text-white outline-none focus:border-fog"
                  >
                    {frames.meta.map((m, idx) => (
                      <option key={m.epoch_id} value={idx}>
                        Plate {idx + 1} ({fmtDate(m.mean_iso)})
                      </option>
                    ))}
                  </select>
                </label>
                {(safeA !== 0 || safeB !== Math.max(0, n - 1)) && (
                  <button
                    onClick={() => patch({ epochA: 0, epochB: Math.max(0, n - 1) })}
                    className="link ml-1 text-[12px] text-haze hover:text-white"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="mt-1 text-[12.5px]">
                {mode === 'changes' ? (
                  <>
                    <span style={{ color: '#E86834' }}>warm: it was here (Plate {safeA + 1})</span> ·{' '}
                    <span style={{ color: '#78B2F0' }}>cool: it is here now (Plate {safeB + 1})</span>
                  </>
                ) : (
                  <span className="text-haze">
                    Deep sum of Plate {safeB + 1} ({fmtDate(plateB.mean_iso)}) + Plate {safeA + 1} ({fmtDate(plateA.mean_iso)})
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="pointer-events-none pt-1">
              {fmtDate(plateA.mean_iso)} next to {fmtDate(plateB.mean_iso)}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {displayOpen && <DisplayMenu manifest={manifest} busy={busy} onObserve={onObserve} />}
        {selected && !measure && !displayOpen && (
          <ObjectCard
            key={selected.id}
            manifest={manifest}
            marker={selected}
            band={band}
            showTrail={showTrail}
            onToggleTrail={() => patch({ showTrail: !showTrail })}
            onClose={() => patch({ selectedId: null })}
          />
        )}
        {measure && frames && (
          <MeasurePanel
            manifest={manifest}
            frames={frames}
            band={band}
            mode={mode}
            index={index}
            cursor={cursor}
            probe={probe}
            onClose={() => patch({ measure: false })}
          />
        )}
      </AnimatePresence>

      <div className={`absolute inset-x-0 bottom-0 px-6 pb-6 md:px-12 md:pb-8 ${hud}`}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <nav className="pointer-events-auto flex flex-wrap gap-6 text-[17px]" aria-label="View mode">
            {MODES.map((m) => {
              const disabled = m.id !== 'blink' && n < 2;
              return (
                <button
                  key={m.id}
                  disabled={disabled}
                  aria-pressed={mode === m.id}
                  onClick={() => patch({ mode: m.id })}
                  className={mode === m.id ? 'link text-white' : 'text-haze transition-colors hover:text-fog disabled:opacity-40'}
                >
                  {m.label}
                </button>
              );
            })}
          </nav>

          <div className="pointer-events-auto flex items-center gap-6">
            <button
              onClick={() => patch({ playing: !playing })}
              aria-label={playing ? 'Pause' : 'Play'}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-full border border-fog/70 text-fog transition-colors hover:border-white hover:text-white"
            >
              {playing ? (
                <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                  <rect x="0" width="4" height="14" />
                  <rect x="8" width="4" height="14" />
                </svg>
              ) : (
                <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                  <path d="M1 0l11 7-11 7z" />
                </svg>
              )}
            </button>
            <label className="flex items-center gap-3 text-[14px] text-haze">
              <span className="num whitespace-nowrap">Speed {speed.toFixed(1)} per sec</span>
              <input
                type="range"
                className="slider w-[120px] md:w-[190px]"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.1}
                value={speed}
                onChange={(e) => patch({ speed: parseFloat(e.target.value) })}
                aria-label="Blink speed, plates per second"
              />
            </label>
          </div>
        </div>
        {frames && (
          <div className="pointer-events-auto">
            <Ruler
              manifest={manifest}
              band={frames.band}
              meta={frames.meta}
              index={index}
              visits={visits}
              onSelect={(i) => {
                if ((mode === 'changes' || mode === 'sum') && i !== safeA) {
                  patch({ epoch: i, epochB: i });
                } else {
                  patch({ epoch: i });
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {frames && frames.meta[index] ? `Plate ${index + 1} of ${n}, ${fmtDate(frames.meta[index].mean_iso, true)}` : ''}
      </div>

      {(loading || frameError || !frames) && (
        <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[16px] text-haze">
          {frameError ? (
            <>
              <p className="text-fog">{frameError}</p>
              <button className="link mt-3 text-fog" onClick={() => patch({ band: defaultBand(manifest) })}>
                Use the recommended band
              </button>
            </>
          ) : (
            'Developing the plates…'
          )}
        </div>
      )}

      {s.toast && (
        <div
          className="pointer-events-none absolute bottom-32 left-1/2 max-w-[90vw] -translate-x-1/2 break-all border border-ash/80 bg-void/90 px-4 py-2 text-[14px] text-fog"
          style={{ animation: 'rise .3s ease-out both' }}
        >
          {s.toast}
        </div>
      )}

      <AnimatePresence>{aboutOpen && <AboutSheet onClose={() => patch({ aboutOpen: false })} />}</AnimatePresence>
    </div>
  );
}
