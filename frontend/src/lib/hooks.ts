import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getFrameSet, peekFrameSet, type FrameOptions, type FrameSet } from './frames';
import type { BandKey, ColormapMode, Manifest, PixelMode, SpectrumResult, Visit } from '../types';

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function useFrameSet(
  manifest: Manifest | null,
  band: BandKey,
  brightness: number,
  colormap: ColormapMode = 'observatory',
  pixelMode: PixelMode = 'smooth',
  epochA = 0,
  epochB = 1,
) {
  const [state, setState] = useState<{ frames: FrameSet | null; loading: boolean; error: string | null }>({
    frames: null,
    loading: false,
    error: null,
  });
  const opts: FrameOptions = { brightness, colormap, pixelMode, epochA, epochB };

  useEffect(() => {
    if (!manifest) {
      setState({ frames: null, loading: false, error: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getFrameSet(manifest, band, opts)
      .then((frames) => live && setState({ frames, loading: false, error: null }))
      .catch((e: Error) => live && setState((s) => ({ frames: s.frames, loading: false, error: e.message })));
    return () => {
      live = false;
    };
  }, [manifest, band, brightness, colormap, pixelMode, epochA, epochB]);

  const hit = manifest ? peekFrameSet(manifest, band, opts) : null;
  return hit ? { frames: hit, loading: false, error: null } : state;
}

const visitCache = new Map<string, Promise<Visit[]>>();

export function removeCachedVisits(key: string) {
  visitCache.delete(key);
}

export function useVisits(key: string | undefined) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    let p = visitCache.get(key);
    if (!p) {
      p = api.visits(key);
      p.catch(() => visitCache.delete(key));
      visitCache.set(key, p);
    }
    p.then((v) => live && setVisits(v)).catch(() => live && setVisits(null));
    return () => {
      live = false;
    };
  }, [key]);
  return visits;
}

const spectrumCache = new Map<string, Promise<SpectrumResult>>();

export function useSpectrum(key: string | undefined, ra: number | null, dec: number | null) {
  const [state, setState] = useState<{
    data: SpectrumResult | null;
    loading: boolean;
    densifying: boolean;
    error: string | null;
  }>({
    data: null,
    loading: false,
    densifying: false,
    error: null,
  });

  useEffect(() => {
    if (!key || ra === null || dec === null) {
      setState({ data: null, loading: false, densifying: false, error: null });
      return;
    }
    let live = true;
    const id = `${key}|${ra.toFixed(5)}|${dec.toFixed(5)}`;
    let p = spectrumCache.get(id);
    if (!p) {
      p = api.spectrum(key, ra, dec);
      p.catch(() => spectrumCache.delete(id));
      spectrumCache.set(id, p);
    }
    setState((s) => ({ data: s.data, loading: true, densifying: false, error: null }));
    p.then((data) => live && setState({ data, loading: false, densifying: false, error: null })).catch(
      (e: Error) => live && setState({ data: null, loading: false, densifying: false, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key, ra, dec]);

  const densify = useCallback(async () => {
    if (!key || ra === null || dec === null) return;
    const id = `${key}|${ra.toFixed(5)}|${dec.toFixed(5)}`;
    setState((s) => ({ ...s, densifying: true, error: null }));
    try {
      const p = api.spectrum(key, ra, dec, 2.5, 4);
      spectrumCache.set(id, p);
      removeCachedVisits(key);
      const data = await p;
      setState({ data, loading: false, densifying: false, error: null });
    } catch (e: unknown) {
      spectrumCache.delete(id);
      setState((s) => ({
        ...s,
        densifying: false,
        error: e instanceof Error ? e.message : 'Failed to fetch additional visits.',
      }));
    }
  }, [key, ra, dec]);

  return { ...state, densify };
}
