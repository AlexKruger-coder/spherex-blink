import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDec, fmtRa, prefersReducedMotion } from '../lib/format';
import { useElementSize } from '../lib/hooks';
import { eyepieceGeometry } from '../lib/view';

interface Props {
  kind: 'intro' | 'loading';
  ra: number;
  dec: number;
  name: string;
  /** First plate of the field, once it exists. */
  frame: HTMLCanvasElement | null;
  /** The field is loaded and mounted underneath, so the iris may open. */
  ready: boolean;
  progress: { label: string; ratio: number | null } | null;
  onOpenStart: () => void;
  onDone: () => void;
}

const K = prefersReducedMotion() ? 0.02 : 1;
const SLEW = 2.2 * K;
const FOCUS = 2.0 * K;
const HOLD = 1.7 * K;
const OPEN = 1.6 * K;

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const easeInOut = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_TINTS = ['#9db7e0', '#d8dce0', '#efe6d2', '#f0d2a8', '#e8a98a'];

function paintStars(cvs: HTMLCanvasElement, d: number, seed: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = d * 3;
  cvs.width = Math.round(w * dpr);
  cvs.height = Math.round(d * dpr);
  const ctx = cvs.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const rnd = seeded(seed);
  const haze = ctx.createRadialGradient(w / 2, d / 2, 0, w / 2, d / 2, d * 0.9);
  haze.addColorStop(0, '#171d25');
  haze.addColorStop(1, '#0a0d11');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, d);
  for (let i = 0; i < 520; i++) {
    const x = rnd() * w;
    const y = rnd() * d;
    const m = Math.pow(rnd(), 5);
    const r = 0.5 + m * 3.2;
    const c = STAR_TINTS[Math.floor(rnd() * STAR_TINTS.length)];
    if (m > 0.25) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      g.addColorStop(0, c + 'aa');
      g.addColorStop(1, c + '00');
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    }
    ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, m * 3 + 0.2);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Digits roll like an instrument settling. The leading pair is already right, and tens of minutes/seconds stay below 6. */
function scramble(final: string, t: number, jitter: number) {
  const settle = SLEW * 0.45;
  let rank = -1;
  return [...final]
    .map((ch, i) => {
      if (!/\d/.test(ch)) return ch;
      rank += 1;
      if (rank < 2) return ch;
      const at = settle + (i / final.length) * SLEW * 0.75;
      if (t >= at) return ch;
      const r = Math.abs(Math.sin(jitter * 12.9898 + i * 78.233) * 43758.5453) % 1;
      return String(Math.floor(r * (rank === 2 || rank === 4 ? 6 : 10)));
    })
    .join('');
}

export function Telescope({ kind, ra, dec, name, frame, ready, progress, onOpenStart, onDone }: Props) {
  const [rootRef, size] = useElementSize<HTMLDivElement>();
  const { radius: R, cx, cy } = eyepieceGeometry(size.w || 1, size.h || 1);
  const D = R * 2;

  const starsRef = useRef<HTMLCanvasElement>(null);
  const realRef = useRef<HTMLCanvasElement>(null);
  const dialRef = useRef<SVGGElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);

  const [ui, setUi] = useState({ focus: 0, phase: 'Pointing', caption: false, ra: '', dec: '' });
  const finalRa = fmtRa(ra);
  const finalDec = fmtDec(dec);

  const live = useRef({ ready, progress, frame, kind, onOpenStart, onDone, finalRa, finalDec });
  live.current = { ready, progress, frame, kind, onOpenStart, onDone, finalRa, finalDec };
  const skip = useRef(false);

  const seed = useMemo(() => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7), [name]);

  useEffect(() => {
    if (D > 10 && starsRef.current) paintStars(starsRef.current, D, seed);
  }, [D, seed]);

  useEffect(() => {
    const cvs = realRef.current;
    if (!cvs || !frame || D < 10) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = Math.round(D * dpr);
    cvs.height = Math.round(D * dpr);
    const ctx = cvs.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0, cvs.width, cvs.height);
  }, [frame, D]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['Escape', 'Enter', ' '].includes(e.key)) {
        skip.current = true;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || size.w === 0) return;
    const geo = eyepieceGeometry(size.w, size.h);
    const maxR = Math.hypot(size.w, size.h) * 0.62;
    const t0 = performance.now();
    let last = t0;
    let focus = 0;
    let real = 0;
    let phase: 'slew' | 'focus' | 'hold' | 'open' = 'slew';
    let holdStart = 0;
    let openStart = 0;
    let lastUi = 0;
    let raf = 0;
    let shown = { focus: -1, phase: '', caption: false };

    const loop = (now: number) => {
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      const t = Math.max(0, (now - t0) / 1000);
      const L = live.current;

      let target = 0;
      if (t >= SLEW) target = L.kind === 'intro' ? (L.ready ? 100 : 88) : L.ready ? 100 : Math.min(88, (L.progress?.ratio ?? 0) * 88);
      if (skip.current && L.ready) target = 100;
      focus = Math.min(target, focus + (dt * 100) / FOCUS);
      real += (dt / 1.2) * (L.frame && focus >= 15 ? 1 : -1);
      real = Math.min(1, Math.max(0, real));

      if (phase === 'slew' && t >= SLEW) phase = 'focus';
      if (phase === 'focus' && focus >= 100 && real >= 0.98) {
        phase = 'hold';
        holdStart = now;
      }
      if (phase === 'hold' && ((now - holdStart) / 1000 >= HOLD || skip.current)) {
        phase = 'open';
        openStart = now;
        L.onOpenStart();
      }
      if (skip.current && L.ready && phase !== 'open' && phase !== 'hold' && focus >= 100) {
        phase = 'hold';
        holdStart = now - HOLD * 1000;
      }

      const slew = 1 - easeOut(t / SLEW);
      const focusBlur = 20 * Math.pow(1 - focus / 100, 1.6);
      const blur = 0.6 + 9 * slew * slew + focusBlur;
      if (dialRef.current) dialRef.current.style.transform = `rotate(${(620 * (1 - easeOut(t / (SLEW + 0.9)))).toFixed(2)}deg)`;
      if (starsRef.current) {
        starsRef.current.style.transform = `translateX(${(-D * 1.1 * slew).toFixed(1)}px)`;
        starsRef.current.style.filter = `blur(${blur.toFixed(1)}px)`;
        starsRef.current.style.opacity = String(1 - real);
      }
      if (realRef.current) {
        realRef.current.style.filter = `blur(${focusBlur.toFixed(1)}px) brightness(${(0.55 + 0.45 * (focus / 100)).toFixed(2)})`;
        realRef.current.style.opacity = String(real);
      }

      let hud = 1;
      if (phase === 'open') {
        const u = (now - openStart) / 1000 / OPEN;
        const r = easeInOut(u) * maxR;
        const m = `radial-gradient(circle at ${geo.cx}px ${geo.cy}px, transparent ${r}px, #000 ${r + 48}px)`;
        root.style.webkitMaskImage = m;
        root.style.maskImage = m;
        hud = Math.max(0, 1 - u * 3.5);
        if (u >= 1) {
          L.onDone();
          return;
        }
      }
      if (hudRef.current) hudRef.current.style.opacity = String(hud);

      const label = phase === 'slew' ? 'Pointing' : focus >= 100 ? 'Locked' : 'Focusing';
      const caption = t >= SLEW + 0.9 * K && phase !== 'open';
      const fi = Math.round(focus);
      if (now - lastUi > 45 || fi !== shown.focus || label !== shown.phase || caption !== shown.caption) {
        lastUi = now;
        shown = { focus: fi, phase: label, caption };
        setUi({ focus: fi, phase: label, caption, ra: scramble(L.finalRa, t, now), dec: scramble(L.finalDec, t, now + 99) });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w > 0, size.h > 0]);

  const ticks = useMemo(() => {
    const S = R + 70;
    const minor: string[] = [];
    const labels: { x: number; y: number; text: string }[] = [];
    for (let a = 0; a < 360; a += 3) {
      const major = a % 30 === 0;
      const mid = a % 15 === 0;
      const len = major ? 15 : mid ? 10 : 5;
      const rad = (a * Math.PI) / 180;
      const r0 = R + 8;
      minor.push(`M${S + Math.cos(rad) * r0} ${S + Math.sin(rad) * r0}L${S + Math.cos(rad) * (r0 + len)} ${S + Math.sin(rad) * (r0 + len)}`);
      if (major) labels.push({ x: S + Math.cos(rad) * (R + 36), y: S + Math.sin(rad) * (R + 36) + 4, text: String(a) });
    }
    return { S, path: minor.join(''), labels };
  }, [R]);

  const half = Math.min(R + 78, cx - 18, cy - 18);
  const bl = 24;
  const lx = 80 + ((180 - ra) / 180) * 70 * Math.sqrt(1 - Math.pow(dec / 90, 2));
  const ly = 42 - (dec / 90) * 30;

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 cursor-pointer overflow-hidden bg-void" onClick={() => (skip.current = true)} role="status">
      <span className="sr-only">{ui.phase} the telescope at {name}</span>

      <div className="absolute overflow-hidden rounded-full" style={{ left: cx - R, top: cy - R, width: D, height: D, background: '#07090c' }}>
        <canvas ref={starsRef} className="absolute top-0" style={{ left: -D, width: D * 3, height: D }} />
        <canvas ref={realRef} className="absolute inset-0" style={{ width: D, height: D, opacity: 0 }} />
        <div className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 0 70px 14px rgba(5,7,9,0.85)' }} />
        <svg className="pointer-events-none absolute inset-0" width={D} height={D}>
          <path d={`M${R - 11} ${R}H${R + 11}M${R} ${R - 11}V${R + 11}`} stroke="#C9D3DB" strokeOpacity="0.5" />
        </svg>
      </div>

      <svg className="pointer-events-none absolute" width={ticks.S * 2} height={ticks.S * 2} style={{ left: cx - ticks.S, top: cy - ticks.S }}>
        <g ref={dialRef} style={{ transformOrigin: `${ticks.S}px ${ticks.S}px` }}>
          <circle cx={ticks.S} cy={ticks.S} r={R + 1} fill="none" stroke="#C9D3DB" strokeOpacity="0.55" />
          <path d={ticks.path} stroke="#8FA0AE" strokeOpacity="0.8" fill="none" />
        </g>
        <g fill="#8FA0AE" fontSize="14" textAnchor="middle">
          {ticks.labels.map((l) => (
            <text key={l.text} x={l.x} y={l.y} className="num">
              {l.text}
            </text>
          ))}
        </g>
      </svg>

      <div ref={hudRef}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full" fill="none" stroke={'#F0A04B'} strokeWidth="1.5">
          <path d={`M${cx - half} ${cy - half + bl}V${cy - half}H${cx - half + bl}`} />
          <path d={`M${cx + half - bl} ${cy - half}H${cx + half}V${cy - half + bl}`} />
          <path d={`M${cx - half} ${cy + half - bl}V${cy + half}H${cx - half + bl}`} />
          <path d={`M${cx + half - bl} ${cy + half}H${cx + half}V${cy + half - bl}`} />
        </svg>

        <div className="absolute left-5 top-6 md:left-10 md:top-9">
          <div className="text-[15px] text-haze">
            {ui.phase}
            {kind === 'loading' && progress ? <span className="ml-3 text-haze/80">· {progress.label}</span> : null}
          </div>
          <div className="mt-2 flex gap-5 md:gap-12">
            <Readout label="RA" value={ui.ra || finalRa} />
            <Readout label="Dec" value={ui.dec || finalDec} />
            <Readout label="Focus" value={`${ui.focus}%`} />
          </div>
        </div>

        <button
          className="link absolute right-5 top-6 text-[16px] text-fog md:right-10 md:top-9"
          onClick={(e) => {
            e.stopPropagation();
            skip.current = true;
          }}
        >
          Skip
        </button>

        <div className="absolute bottom-6 right-5 hidden text-center text-[13px] text-haze md:block md:right-10">
          <svg width="160" height="84" viewBox="0 0 160 84" fill="none" stroke="#8FA0AE" strokeOpacity="0.7">
            <ellipse cx="80" cy="42" rx="74" ry="32" />
            <ellipse cx="80" cy="42" rx="34" ry="32" />
            <path d="M6 42H154" />
            <circle cx={lx} cy={ly} r="3.2" fill="#F0A04B" stroke="none" />
          </svg>
          Where on the sky
        </div>

        {ui.caption && (
          <div className="absolute max-w-[min(440px,86vw)] border-l border-ash pl-5" style={{ left: Math.max(20, cx - 190), top: cy + R + 62, animation: 'fade-in 1s ease-out both' }}>
            <div className="font-serif text-[clamp(22px,2.4vw,29px)] italic leading-tight text-fog">1930. Clyde Tombaugh finds Pluto.</div>
            <p className="mt-2 text-[15px] leading-snug text-haze">He flipped between two photographic plates of the same sky. This is the same trick.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[14px] text-haze">{label}</div>
      <div className="num glow whitespace-nowrap text-[clamp(24px,2.9vw,40px)] font-light leading-tight text-[#dfe7ee]">{value}</div>
    </div>
  );
}
