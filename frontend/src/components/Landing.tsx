import { useEffect, useMemo, useState } from 'react';
import { buildMarkers, FOV_OPTIONS } from '../lib/field';
import { fmtDec, fmtRa, prefersReducedMotion } from '../lib/format';
import type { FrameSet } from '../lib/frames';
import { useVisits } from '../lib/hooks';
import { useStore } from '../store';
import type { Manifest, TargetInfo } from '../types';
import { Brackets } from './Brackets';
import { Overlay } from './Overlay';
import { Ruler } from './Ruler';
import { SkyStage } from './SkyStage';

interface Props {
  manifest: Manifest | null;
  frames: FrameSet | null;
  targets: TargetInfo[];
  busy: boolean;
  error: string | null;
  onSearch: (query: string, fovDeg?: number) => void;
  onPick: (t: TargetInfo) => void;
  onOpenHero: (measure?: boolean) => void;
  onReplay: () => void;
}

export function Landing({ manifest, frames, targets, busy, error, onSearch, onPick, onOpenHero, onReplay }: Props) {
  const { view, fovDeg, patch } = useStore();
  const [epoch, setEpoch] = useState(0);
  const [query, setQuery] = useState('');
  const [ringReady, setRingReady] = useState(false);
  const visits = useVisits(manifest?.target_key);
  const reduced = prefersReducedMotion();
  const markers = useMemo(() => (manifest ? buildMarkers(manifest).filter((m) => m.kind === 'target') : []), [manifest]);

  useEffect(() => {
    setRingReady(false);
    if (!frames) return;
    const t = setTimeout(() => setRingReady(true), reduced ? 300 : 7500);
    return () => clearTimeout(t);
  }, [frames, reduced]);

  const n = frames?.meta.length ?? 0;
  const activeFovOpt =
    FOV_OPTIONS.reduce((best, opt) => (Math.abs(opt.value - fovDeg) < Math.abs(best.value - fovDeg) ? opt : best), FOV_OPTIONS[1]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-void">
      <SkyStage
        frames={frames}
        mode="blink"
        playing={!reduced}
        speed={1}
        style="fade"
        breath
        parallax
        epoch={epoch}
        onEpoch={setEpoch}
        view={view}
      >
        {(info) =>
          manifest && frames ? (
            <Overlay
              manifest={manifest}
              frames={frames}
              info={info}
              view={view}
              markers={markers}
              showMarkers
              ringReady={ringReady}
              showTrail={false}
              selectedId={null}
              onSelect={() => onOpenHero()}
            />
          ) : null
        }
      </SkyStage>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 scrim-top" />
      <div className="pointer-events-none absolute inset-0 scrim-left opacity-80" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] scrim-bottom" />
      <Brackets crosses color="rgba(201,211,219,0.5)" />

      <header className="absolute inset-x-0 top-0 flex items-start justify-between px-6 pt-8 md:px-12 md:pt-10">
        <div className="pointer-events-none">
          {manifest && (
            <>
              <h2 className="font-serif text-[clamp(24px,2.6vw,34px)] font-light leading-none text-white">{manifest.target.name} field</h2>
              <div className="num mt-3 flex gap-5 text-[15px] text-haze">
                <span>RA {fmtRa(manifest.wcs.crval[0], false)}</span>
                <span>Dec {fmtDec(manifest.wcs.crval[1], false)}</span>
              </div>
            </>
          )}
        </div>
        {frames && (
          <div aria-live="polite" className="pointer-events-none absolute left-1/2 top-9 hidden -translate-x-1/2 text-[15px] text-haze md:block">
            Plate {Math.min(epoch, n - 1) + 1} of {n}
          </div>
        )}
        <div className="pointer-events-auto text-right">
          <div className="flex justify-end gap-7 text-[18px]">
            {manifest && (
              <button className="link text-fog" onClick={() => onOpenHero(true)}>
                Measure
              </button>
            )}
            <button className="link text-fog" onClick={onReplay}>
              Replay
            </button>
          </div>
          <div className="mt-3 text-[14px] text-haze">Real SPHEREx data</div>
        </div>
      </header>

      <main className="absolute bottom-[132px] left-6 right-6 md:bottom-[150px] md:left-12">
        <h1
          className="font-serif text-[clamp(42px,7.2vw,92px)] font-light leading-[0.98] tracking-[-0.012em] text-white"
          style={{ textShadow: '0 2px 40px rgba(0,0,0,0.5)' }}
        >
          The same sky,
          <br />
          two different days.
        </h1>

        <form
          className="pointer-events-auto mt-8 w-[min(620px,100%)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (!query.trim()) {
              patch({ error: 'Please enter a target name or sky coordinates (RA, Dec).' });
              return;
            }
            onSearch(query.trim(), fovDeg);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search a place, an object or coordinates"
            placeholder={busy ? 'Asking the archive…' : 'Search a place, an object or coordinates'}
            className="w-full border-0 border-b border-fog/55 bg-transparent pb-3 text-[clamp(18px,1.9vw,24px)] font-light text-white outline-none transition-colors placeholder:text-haze focus:border-white"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-haze">
            <span className="uppercase tracking-[0.12em] text-haze/80">FOV</span>
            {FOV_OPTIONS.map((opt) => {
              const active = Math.abs(opt.value - fovDeg) < 0.005;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={busy}
                  onClick={() => patch({ fovDeg: opt.value })}
                  title={opt.label}
                  className={`num transition-colors ${active ? 'link text-white' : 'text-haze hover:text-fog'} disabled:opacity-40`}
                >
                  {opt.short}
                </button>
              );
            })}
            <span className="num text-haze/75">({activeFovOpt.arcmin} · {activeFovOpt.est})</span>
          </div>
        </form>
        {busy && (
          <p className="mt-3 text-[15px] text-haze" role="status" style={{ animation: 'fade-in .5s ease-out both' }}>
            Looking this up in the archive…
          </p>
        )}
        {error && !busy && (
          <p className="mt-3 max-w-[620px] text-[15px] text-fog" role="alert">
            {error}
          </p>
        )}

        <div className="pointer-events-auto mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[17px]">
          <span className="text-haze">Try</span>
          {targets.map((t) => (
            <button
              key={t.id}
              disabled={busy}
              onClick={() => onPick(t)}
              className="text-fog transition-colors hover:text-white disabled:opacity-50"
              title={t.is_cached ? t.category : `${t.category}. Downloads live from NASA IRSA, up to a couple of minutes.`}
            >
              {t.name}
              {!t.is_cached && <sup className="ml-1 text-[11px] text-haze">live</sup>}
            </button>
          ))}
        </div>
      </main>

      <aside className="pointer-events-none absolute bottom-[132px] right-12 hidden max-w-[300px] text-right text-[15px] leading-snug text-haze lg:block">
        SPHEREx maps the whole sky in infrared light. Each tick on the ruler is one date, coloured by its wavelength.
      </aside>

      {manifest && frames && (
        <footer className="absolute inset-x-6 bottom-6 md:inset-x-12 md:bottom-8">
          <Ruler manifest={manifest} band={frames.band} meta={frames.meta} index={Math.min(epoch, n - 1)} visits={visits} />
        </footer>
      )}
    </div>
  );
}
