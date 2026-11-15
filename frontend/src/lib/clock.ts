import type { BlinkStyle } from '../types';

export interface ClockFrame {
  from: number;
  to: number;
  /** 0..1 — how far the crossfade from `from` to `to` has progressed. */
  t: number;
  /** The plate the viewer should consider "current". */
  index: number;
}

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

const BREATH = { hold: 2.6, fade: 0.9 };
const HOLD_SHARE = 0.4;
const SEEK_MS = 160;

/** Drives which two plates are on screen and how far the crossfade has gone. */
export class BlinkClock {
  count = 0;
  playing = false;
  speed = 0.8;
  style: BlinkStyle = 'fade';
  breath = false;

  private phase = 0;
  private from = 0;
  private to = 0;
  private t = 1;
  private seekStart = 0;

  setCount(n: number) {
    this.count = n;
    if (this.from >= n) this.from = 0;
    if (this.to >= n) this.to = 0;
    this.phase = Math.min(this.phase, Math.max(0, n - 1));
  }

  current(): number {
    return this.t >= 0.5 ? this.to : this.from;
  }

  seek(index: number, now: number) {
    if (this.count === 0) return;
    const i = Math.max(0, Math.min(this.count - 1, index));
    this.phase = i;
    this.from = this.current();
    this.to = i;
    this.t = this.from === i ? 1 : 0;
    this.seekStart = now;
  }

  setPlaying(p: boolean, now: number) {
    if (p === this.playing) return;
    this.playing = p;
    if (!p) {
      const i = this.current();
      this.seek(i, now);
    } else {
      this.phase = this.current();
    }
  }

  update(dtMs: number, now: number): ClockFrame {
    dtMs = Math.max(0, dtMs);
    const n = this.count;
    if (n < 2) return { from: 0, to: 0, t: 1, index: 0 };

    if (this.playing) {
      if (this.breath) {
        this.phase += dtMs / 1000;
        const cycle = 2 * (BREATH.hold + BREATH.fade);
        const p = this.phase % cycle;
        const half = BREATH.hold + BREATH.fade;
        const a = p < half ? 0 : n - 1;
        const b = p < half ? n - 1 : 0;
        const local = p % half;
        this.from = a;
        this.to = b;
        this.t = local < BREATH.hold ? 0 : smooth((local - BREATH.hold) / BREATH.fade);
      } else {
        this.phase += (dtMs / 1000) * this.speed;
        const base = Math.floor(this.phase);
        const frac = this.phase - base;
        this.from = ((base % n) + n) % n;
        this.to = (((base + 1) % n) + n) % n;
        this.t = this.style === 'hard' ? 0 : smooth((frac - HOLD_SHARE) / (1 - HOLD_SHARE));
        if (this.phase > 1e6) this.phase = base % n;
      }
    } else if (this.t < 1) {
      this.t = this.style === 'hard' ? 1 : smooth((now - this.seekStart) / SEEK_MS);
      if (this.t >= 1) {
        this.from = this.to;
        this.t = 1;
      }
    }
    return { from: this.from, to: this.to, t: this.t, index: this.current() };
  }
}
