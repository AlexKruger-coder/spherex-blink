import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { BlinkClock } from '../lib/clock';
import { getFlagImage, type FrameSet } from '../lib/frames';
import { useElementSize } from '../lib/hooks';
import { MAX_ZOOM, makeTransform, minZoomFor, type Rect, type View } from '../lib/view';
import type { BlinkStyle, Mode, PixelMode } from '../types';

export interface StageInfo {
  w: number;
  h: number;
  panes: Rect[];
  /** Index (into frames.meta) of the plate shown in each pane. */
  paneIndex: number[];
}

interface Props {
  frames: FrameSet | null;
  mode: Mode;
  playing: boolean;
  speed: number;
  style: BlinkStyle;
  pixelMode?: PixelMode;
  showFlagsOverlay?: boolean;
  bandFlagsUrl?: string;
  breath?: boolean;
  epoch: number;
  onEpoch: (i: number) => void;
  view: View;
  onViewChange?: (v: View) => void;
  interactive?: boolean;
  parallax?: boolean;
  onTap?: (hit: { x: number; y: number } | null) => void;
  /** Pointer position in screen px (sx, sy) and in field pixel coordinates (x, y). */
  onCursor?: (c: { sx: number; sy: number; x: number; y: number } | null) => void;
  children?: (info: StageInfo) => ReactNode;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function SkyStage({
  frames,
  mode,
  playing,
  speed,
  style,
  pixelMode = 'smooth',
  showFlagsOverlay = false,
  bandFlagsUrl,
  breath = false,
  epoch,
  onEpoch,
  view,
  onViewChange,
  interactive = false,
  parallax = false,
  onTap,
  onCursor,
  children,
}: Props) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shiftRef = useRef<HTMLDivElement>(null);
  const clock = useMemo(() => new BlinkClock(), []);
  const reported = useRef(-1);
  const dirty = useRef(true);
  const live = useRef({ frames, mode, view, size, onEpoch, pixelMode, showFlagsOverlay, bandFlagsUrl });
  live.current = { frames, mode, view, size, onEpoch, pixelMode, showFlagsOverlay, bandFlagsUrl };

  const n = frames?.epochs.length ?? 0;
  const panes = useMemo<Rect[]>(
    () =>
      mode === 'side'
        ? [
            { x: 0, y: 0, w: size.w / 2, h: size.h },
            { x: size.w / 2, y: 0, w: size.w / 2, h: size.h },
          ]
        : [{ x: 0, y: 0, w: size.w, h: size.h }],
    [mode, size.w, size.h],
  );

  useEffect(() => {
    clock.setCount(n);
    reported.current = -1;
    dirty.current = true;
  }, [clock, n, frames]);

  useEffect(() => {
    clock.speed = speed;
    clock.style = style;
    clock.breath = breath;
  }, [clock, speed, style, breath]);

  useEffect(() => {
    clock.setPlaying(playing, performance.now());
  }, [clock, playing]);

  useEffect(() => {
    if (epoch !== reported.current && n > 0) {
      reported.current = epoch;
      clock.seek(epoch, performance.now());
      dirty.current = true;
    }
  }, [clock, epoch, n, frames]);

  useEffect(() => {
    dirty.current = true;
  }, [view, size.w, size.h, mode, pixelMode, showFlagsOverlay, bandFlagsUrl]);

  useEffect(() => {
    let raf = 0;
    let last = -1;
    const draw = (f: { from: number; to: number; t: number; index: number }) => {
      const cvs = canvasRef.current;
      const {
        frames: fs,
        mode: md,
        view: vw,
        size: sz,
        pixelMode: pm,
        showFlagsOverlay: showFlags,
        bandFlagsUrl: bFlagsUrl,
      } = live.current;
      if (!cvs || !fs || sz.w === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(sz.w * dpr);
      const ph = Math.round(sz.h * dpr);
      if (cvs.width !== pw || cvs.height !== ph) {
        cvs.width = pw;
        cvs.height = ph;
      }
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#080A0D';
      ctx.fillRect(0, 0, pw, ph);
      const smooth = pm !== 'native';
      ctx.imageSmoothingEnabled = smooth;
      if (smooth) ctx.imageSmoothingQuality = 'high';

      const rects: Rect[] =
        md === 'side'
          ? [
              { x: 0, y: 0, w: sz.w / 2, h: sz.h },
              { x: sz.w / 2, y: 0, w: sz.w / 2, h: sz.h },
            ]
          : [{ x: 0, y: 0, w: sz.w, h: sz.h }];

      rects.forEach((r, i) => {
        const tr = makeTransform(r, fs.w, fs.h, vw);
        let a: HTMLCanvasElement;
        let b: HTMLCanvasElement;
        if (md === 'changes') {
          a = b = fs.pairDiff;
        } else if (md === 'sum') {
          a = b = fs.pairSum;
        } else if (md === 'side') {
          if (i === 0) {
            a = b = fs.epochs[fs.epochA] ?? fs.epochs[0];
          } else {
            a = fs.epochs[Math.max(1, f.from)] ?? fs.epochs[0];
            b = fs.epochs[Math.max(1, f.to)] ?? a;
          }
        } else {
          a = fs.epochs[f.from];
          b = fs.epochs[f.to];
        }
        if (!a) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
        ctx.clip();
        ctx.imageSmoothingEnabled = smooth;
        if (smooth) ctx.imageSmoothingQuality = 'high';
        const k = (dpr * tr.s) / fs.factor;
        ctx.setTransform(k, 0, 0, k, dpr * (r.x + r.w / 2 - tr.cx * tr.s), dpr * (r.y + r.h / 2 - tr.cy * tr.s));
        ctx.globalAlpha = 1;
        ctx.drawImage(a, 0, 0);
        if (f.t > 0 && b && b !== a) {
          ctx.globalAlpha = f.t;
          ctx.drawImage(b, 0, 0);
        }

        if (showFlags) {
          const epIdx = md === 'side' ? (i === 0 ? fs.epochA : Math.max(1, f.index)) : f.index;
          const flagUrl =
            md === 'blink' || md === 'side'
              ? fs.meta[epIdx]?.flags_overlay_url || bFlagsUrl
              : bFlagsUrl || fs.meta[fs.epochB]?.flags_overlay_url;
          const flagImg = getFlagImage(flagUrl, () => {
            dirty.current = true;
          });
          if (flagImg && flagImg.complete && flagImg.naturalWidth > 0) {
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = 0.85;
            ctx.drawImage(flagImg, 0, 0, fs.w * fs.factor, fs.h * fs.factor);
          }
        }

        ctx.restore();
      });
    };

    const loop = (now: number) => {
      const dt = last < 0 ? 0 : Math.min(100, Math.max(0, now - last));
      last = now;
      const f = clock.update(dt, now);
      const animating = clock.playing || f.t < 1;
      if (f.index !== reported.current && clock.count > 0) {
        reported.current = f.index;
        live.current.onEpoch(f.index);
      }
      if (dirty.current || animating) {
        draw(f);
        dirty.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  useEffect(() => {
    dirty.current = true;
  }, [frames]);

  /* Gentle depth: the whole stage (sky and overlay together) drifts a few pixels with the pointer. */
  useEffect(() => {
    if (!parallax) return;
    const el = shiftRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let tx = 0,
      ty = 0,
      cx = 0,
      cy = 0,
      raf = 0;
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * -14;
      ty = (e.clientY / window.innerHeight - 0.5) * -10;
    };
    const tick = () => {
      cx += (tx - cx) * 0.04;
      cy += (ty - cy) * 0.04;
      el.style.transform = `translate3d(${cx.toFixed(2)}px,${cy.toFixed(2)}px,0) scale(1.03)`;
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [parallax]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: 0, startX: 0, startY: 0, startT: 0, pinch: 0 });

  const paneAt = (sx: number): Rect => (live.current.mode === 'side' && sx >= live.current.size.w / 2 ? panes[1] : panes[0]);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    if (!frames || !onViewChange) return;
    const r = paneAt(sx);
    const v = live.current.view;
    const before = makeTransform(r, frames.w, frames.h, v);
    const zoom = clamp(v.zoom * factor, minZoomFor(r, frames.w, frames.h), MAX_ZOOM);
    const px = (sx - r.x - r.w / 2) / before.s + before.cx;
    const py = (sy - r.y - r.h / 2) / before.s + before.cy;
    const s2 = (before.s / v.zoom) * zoom;
    onViewChange({ zoom, dx: px - (sx - r.x - r.w / 2) / s2 - frames.w / 2, dy: py - (sy - r.y - r.h / 2) / s2 - frames.h / 2 });
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = localPoint(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0014)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, frames, onViewChange, panes]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    gesture.current = { moved: 0, startX: p.x, startY: p.y, startT: performance.now(), pinch: 0 };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = localPoint(e);
    if (onCursor && frames) {
      const f = makeTransform(paneAt(p.x), frames.w, frames.h, live.current.view).fromScreen(p.x, p.y);
      onCursor({ sx: p.x, sy: p.y, x: f.x, y: f.y });
    }
    if (!interactive || !pointers.current.has(e.pointerId) || !frames || !onViewChange) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (gesture.current.pinch > 0) zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, d / gesture.current.pinch);
      gesture.current.pinch = d;
      gesture.current.moved = 99;
      return;
    }
    gesture.current.moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
    const r = paneAt(p.x);
    const v = live.current.view;
    const s = makeTransform(r, frames.w, frames.h, v).s;
    onViewChange({ ...v, dx: v.dx - (p.x - prev.x) / s, dy: v.dy - (p.y - prev.y) / s });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!interactive) return;
    const wasTap = gesture.current.moved < 6 && performance.now() - gesture.current.startT < 500 && pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    gesture.current.pinch = 0;
    if (wasTap && frames) {
      const p = localPoint(e);
      const r = paneAt(p.x);
      const hit = makeTransform(r, frames.w, frames.h, live.current.view).fromScreen(p.x, p.y);
      onTap?.(hit);
    }
  };

  const index = clamp(epoch, 0, Math.max(0, n - 1));
  const info: StageInfo = {
    w: size.w,
    h: size.h,
    panes,
    paneIndex: mode === 'side' ? [frames?.epochA ?? 0, Math.max(1, index)] : [index],
  };

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 overflow-hidden bg-void"
      style={{ touchAction: 'none', cursor: interactive ? 'grab' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => onCursor?.(null)}
      onDoubleClick={() => interactive && onViewChange?.({ zoom: 1, dx: 0, dy: 0 })}
    >
      <div ref={shiftRef} className="absolute inset-0 will-change-transform">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {frames && size.w > 0 && children?.(info)}
      </div>
      {mode === 'side' && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-ash/70" />}
    </div>
  );
}
