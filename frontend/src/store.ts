import { create } from 'zustand';
import type { BandKey, BlinkStyle, ColormapMode, DetectorRange, Manifest, Mode, PixelMode, TargetInfo } from './types';
import { DEFAULT_VIEW, type View } from './lib/view';

export type Stage = 'landing' | 'viewer';

export interface Probe {
  x: number;
  y: number;
}

interface State {
  stage: Stage;
  targets: TargetInfo[];
  detectors: Record<string, DetectorRange>;
  manifest: Manifest | null;
  band: BandKey;
  epoch: number;
  epochA: number;
  epochB: number;
  fovDeg: number;

  mode: Mode;
  playing: boolean;
  speed: number;
  style: BlinkStyle;
  brightness: number;
  colormap: ColormapMode;
  pixelMode: PixelMode;
  view: View;

  measure: boolean;
  probe: Probe | null;
  selectedId: string | null;
  showTrail: boolean;
  showMarkers: boolean;
  showAllGaia: boolean;
  gaiaMagLimit: number;
  showFlagsOverlay: boolean;
  showCoreLoupe: boolean;

  aboutOpen: boolean;
  displayOpen: boolean;
  toast: string | null;
  error: string | null;

  patch: (p: Partial<State>) => void;
  resetView: () => void;
}

export const useStore = create<State>((set) => ({
  stage: 'landing',
  targets: [],
  detectors: {},
  manifest: null,
  band: 'ALL',
  epoch: 0,
  epochA: 0,
  epochB: 1,
  fovDeg: 0.1,

  mode: 'blink',
  playing: true,
  speed: 0.8,
  style: 'fade',
  brightness: 1,
  colormap: 'observatory',
  pixelMode: 'smooth',
  view: DEFAULT_VIEW,

  measure: false,
  probe: null,
  selectedId: null,
  showTrail: false,
  showMarkers: true,
  showAllGaia: false,
  gaiaMagLimit: 18.0,
  showFlagsOverlay: false,
  showCoreLoupe: false,

  aboutOpen: false,
  displayOpen: false,
  toast: null,
  error: null,

  patch: (p) => set(p),
  resetView: () => set({ view: DEFAULT_VIEW }),
}));

export const MAX_SPEED = 2.5;
export const MIN_SPEED = 0.2;
