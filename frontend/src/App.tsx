import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, pollJob } from './api';
import { Landing } from './components/Landing';
import { Telescope } from './components/Telescope';
import { Viewer } from './components/Viewer';
import { defaultBand, parseUrlBand, parseUrlMode } from './lib/field';
import { prefersReducedMotion } from './lib/format';
import { getFrameSet, type FrameSet } from './lib/frames';
import { useFrameSet } from './lib/hooks';
import { DEFAULT_VIEW, eyepieceGeometry, landingView, type View } from './lib/view';
import { useStore } from './store';
import type { BandKey, Manifest, Mode, ObserveBody, TargetInfo } from './types';

interface Scope {
  kind: 'intro' | 'loading';
  ra: number;
  dec: number;
  name: string;
  frame: HTMLCanvasElement | null;
  ready: boolean;
  progress: { label: string; ratio: number | null } | null;
}

/** The view in which the whole field exactly fills the eyepiece circle, so the iris can open seamlessly. */
function eyepieceView(m: Manifest): View {
  const { radius, cy } = eyepieceGeometry(window.innerWidth, window.innerHeight);
  const sEye = (2 * radius) / m.wcs.width;
  const zoom = (2 * radius) / Math.max(window.innerWidth, window.innerHeight);
  return { zoom, dx: 0, dy: (window.innerHeight / 2 - cy) / sEye };
}

const homeView = (m: Manifest) => landingView(window.innerWidth, window.innerHeight, m.wcs.width, m.wcs.height);

const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));

function tweenView(from: View, to: View, ms: number) {
  const t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / ms);
    const e = easeOutExpo(u);
    useStore.getState().patch({
      view: { zoom: from.zoom + (to.zoom - from.zoom) * e, dx: from.dx + (to.dx - from.dx) * e, dy: from.dy + (to.dy - from.dy) * e },
    });
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.');

function searchErrorText(e: unknown, query?: string): string {
  if (e instanceof ApiError && e.status === 400) {
    return `We could not find ${query ? `“${query}”` : 'that place'}. Try a name such as Barnard's Star, or coordinates such as 08h55m10.8s −07d14m43s, or 133.79 −7.25.`;
  }
  return errorText(e);
}

interface ViewerEnterOpts {
  band?: BandKey;
  epoch?: number;
  mode?: Mode;
  measure?: boolean;
  view?: View;
}

export default function App() {
  const { stage, manifest, band, brightness, colormap, pixelMode, epochA, epochB, targets, error, patch } = useStore();
  const [hero, setHero] = useState<Manifest | null>(null);
  const [heroFrames, setHeroFrames] = useState<FrameSet | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const [develop, setDevelop] = useState(false);
  const booted = useRef(false);
  const reduced = prefersReducedMotion();

  const viewer = useFrameSet(stage === 'viewer' ? manifest : null, band, brightness, colormap, pixelMode, epochA, epochB);

  const enterViewer = useCallback(
    async (m: Manifest, opts: ViewerEnterOpts = {}) => {
      const b = opts.band && m.detectors[opts.band]?.epochs?.length ? opts.band : defaultBand(m);
      const epCount = m.detectors[b]?.epochs?.length ?? m.epochs_summary?.length ?? 1;
      const initA = 0;
      const initB = Math.max(0, epCount - 1);
      const st = useStore.getState();
      const frames = await getFrameSet(m, b, {
        brightness: st.brightness,
        colormap: st.colormap,
        pixelMode: st.pixelMode,
        epochA: initA,
        epochB: initB,
      });
      const firstEpId = m.epochs_summary?.[0]?.epoch_id ?? 'epoch_0';
      const firstPos = m.target_positions?.[firstEpId];
      const defaultProbe =
        firstPos && Number.isFinite(firstPos.x) && Number.isFinite(firstPos.y)
          ? { x: firstPos.x, y: firstPos.y }
          : { x: m.wcs.width / 2, y: m.wcs.height / 2 };
      const nextMeasure = opts.measure ?? st.measure;
      patch({
        manifest: m,
        band: b,
        epoch: opts.epoch ?? 0,
        epochA: initA,
        epochB: initB,
        fovDeg: m.wcs.fov_deg,
        mode: opts.mode ?? 'blink',
        playing: !reduced,
        view: opts.view ?? DEFAULT_VIEW,
        measure: nextMeasure,
        probe: nextMeasure ? defaultProbe : null,
        selectedId: null,
        showTrail: false,
        displayOpen: false,
        aboutOpen: false,
        error: null,
        stage: 'viewer',
      });
      return frames;
    },
    [patch, reduced],
  );

  const search = useCallback(
    async (body: ObserveBody, viewerOpts: ViewerEnterOpts = {}) => {
      setBusy(true);
      patch({ error: null });
      try {
        const res = await api.observe(body);
        if (res.status === 'completed') {
          await enterViewer(res.manifest, viewerOpts);
          setDevelop(true);
          return;
        }
        const rt = res.resolved_target;
        setScope({
          kind: 'loading',
          ra: rt.ra_obs,
          dec: rt.dec_obs,
          name: rt.name,
          frame: null,
          ready: false,
          progress: { label: 'Queued', ratio: null },
        });
        const job = await pollJob(res.job_id, (j) =>
          setScope(
            (s) =>
              s && {
                ...s,
                progress: {
                  label: j.total_cutouts > 0 ? `${j.current_step} · ${j.downloaded} of ${j.total_cutouts}` : j.current_step,
                  ratio: j.total_cutouts > 0 ? j.downloaded / j.total_cutouts : null,
                },
              },
          ),
        );
        const m = job.manifest ?? (await api.manifest(job.target_key));
        const frames = await enterViewer(m, { ...viewerOpts, view: eyepieceView(m) });
        setDevelop(false);
        setScope((s) => s && { ...s, frame: frames.epochs[0], ready: true });
      } catch (e) {
        setScope(null);
        patch({ error: searchErrorText(e, body.target), stage: 'landing' });
      } finally {
        setBusy(false);
      }
    },
    [enterViewer, patch],
  );

  /* Boot: official targets, then either a shared/coordinate link or the hero field with the telescope intro. */
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      let list: TargetInfo[] = [];
      try {
        const res = await api.targets();
        list = res.targets;
        patch({ targets: list, detectors: res.detectors_info });
      } catch (e) {
        patch({ error: errorText(e) });
        return;
      }

      const preloadHero = () => {
        const pick = list.find((t) => t.is_cached && t.id === 'barnards_star') ?? list.find((t) => t.is_cached);
        if (!pick) return;
        api
          .manifest(pick.target_key)
          .then(async (m) => {
            const frames = await getFrameSet(m, defaultBand(m), 1);
            setHero(m);
            setHeroFrames(frames);
          })
          .catch(() => undefined);
      };

      const q = new URLSearchParams(window.location.search);
      const shared = q.get('f');
      const urlTarget = q.get('target');
      const urlRa = q.get('ra');
      const urlDec = q.get('dec');
      const urlBand = parseUrlBand(q.get('b') ?? q.get('detector'));
      const urlMode = parseUrlMode(q.get('m') ?? q.get('mode'));
      const urlEpoch = Number(q.get('e') ?? 0) || 0;
      const urlFovRaw = q.get('fov');
      const urlFov = urlFovRaw && Number.isFinite(parseFloat(urlFovRaw)) ? parseFloat(urlFovRaw) : undefined;

      if (shared) {
        try {
          const m = await api.manifest(shared);
          await enterViewer(m, {
            band: urlBand,
            epoch: urlEpoch,
            mode: urlMode ?? 'blink',
          });
          setDevelop(true);
          preloadHero();
          return;
        } catch (e) {
          if (!urlTarget && !(urlRa && urlDec)) {
            patch({ error: `This link could not be opened. ${errorText(e)}` });
          }
        }
      }

      if (urlTarget) {
        preloadHero();
        await search({ target: urlTarget, fov_deg: urlFov }, { band: urlBand, mode: urlMode ?? 'blink', epoch: urlEpoch });
        return;
      }

      if (urlRa && urlDec) {
        const raNum = parseFloat(urlRa);
        const decNum = parseFloat(urlDec);
        if (Number.isFinite(raNum) && Number.isFinite(decNum)) {
          preloadHero();
          await search({ ra: raNum, dec: decNum, fov_deg: urlFov }, { band: urlBand, mode: urlMode ?? 'blink', epoch: urlEpoch });
          return;
        }
      }

      const pick = list.find((t) => t.is_cached && t.id === 'barnards_star') ?? list.find((t) => t.is_cached);
      if (!pick) return;
      try {
        const m = await api.manifest(pick.target_key);
        const frames = await getFrameSet(m, defaultBand(m), 1);
        setHero(m);
        setHeroFrames(frames);
      } catch (e) {
        patch({ error: errorText(e) });
      }
    })();
  }, [enterViewer, patch, search]);

  /* Telescope intro over the hero field. */
  const introStarted = useRef(false);
  useEffect(() => {
    if (!hero || introStarted.current || stage !== 'landing') return;
    introStarted.current = true;
    if (reduced) {
      patch({ view: homeView(hero) });
      return;
    }
    patch({ view: eyepieceView(hero) });
    setScope({ kind: 'intro', ra: hero.target.ra_obs, dec: hero.target.dec_obs, name: hero.target.name, frame: null, ready: false, progress: null });
  }, [hero, stage, reduced, patch]);

  useEffect(() => {
    if (heroFrames) setScope((s) => (s && s.kind === 'intro' ? { ...s, frame: heroFrames.epochs[0], ready: true } : s));
  }, [heroFrames]);

  const onPick = (t: TargetInfo) => search({ target: t.id, fov_deg: t.default_fov_deg }, { band: t.recommended_detector });

  const openHero = async (measure = false) => {
    if (!hero) return;
    try {
      await enterViewer(hero, { measure });
      setDevelop(true);
    } catch (e) {
      patch({ error: errorText(e) });
    }
  };

  const back = () => {
    window.history.replaceState(null, '', window.location.pathname);
    patch({ stage: 'landing', view: hero ? homeView(hero) : DEFAULT_VIEW, measure: false, selectedId: null, displayOpen: false });
  };

  const replay = () => {
    if (!hero) return;
    patch({ view: eyepieceView(hero) });
    setScope({
      kind: 'intro',
      ra: hero.target.ra_obs,
      dec: hero.target.dec_obs,
      name: hero.target.name,
      frame: heroFrames?.epochs[0] ?? null,
      ready: !!heroFrames,
      progress: null,
    });
  };

  const openScope = () => {
    const s = useStore.getState();
    const to = s.stage === 'viewer' || !hero ? DEFAULT_VIEW : homeView(hero);
    tweenView(s.view, to, reduced ? 10 : 1700);
  };

  return (
    <>
      {stage === 'landing' || !manifest ? (
        <Landing
          manifest={hero}
          frames={heroFrames}
          targets={targets}
          busy={busy}
          error={error}
          onSearch={(q, fovDeg) => search({ target: q, fov_deg: fovDeg })}
          onPick={onPick}
          onOpenHero={openHero}
          onReplay={replay}
        />
      ) : (
        <Viewer
          manifest={manifest}
          frames={viewer.frames}
          loading={viewer.loading}
          frameError={viewer.error}
          develop={develop}
          busy={busy}
          onObserve={(body, preferBand) => search(body, { band: preferBand, mode: useStore.getState().mode })}
          onBack={back}
        />
      )}

      {scope && (
        <div style={scope.kind === 'loading' ? { animation: 'fade-in .7s ease-out both' } : undefined}>
          <Telescope
            kind={scope.kind}
            ra={scope.ra}
            dec={scope.dec}
            name={scope.name}
            frame={scope.frame}
            ready={scope.ready}
            progress={scope.progress}
            onOpenStart={openScope}
            onDone={() => setScope(null)}
          />
        </div>
      )}
    </>
  );
}
