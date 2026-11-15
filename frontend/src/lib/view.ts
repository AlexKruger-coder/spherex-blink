export interface View {
  zoom: number;
  /** Offset of the view centre from the field centre, in field pixels (image coordinates, y down). */
  dx: number;
  dy: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_VIEW: View = { zoom: 1, dx: 0, dy: 0 };
export const MAX_ZOOM = 24;

export const coverScale = (r: Rect, W: number, H: number) => Math.max(r.w / W, r.h / H);
export const containScale = (r: Rect, W: number, H: number) => Math.min(r.w / W, r.h / H);
export const minZoomFor = (r: Rect, W: number, H: number) => (containScale(r, W, H) / coverScale(r, W, H)) * 0.9;

/**
 * Maps array pixel coordinates (x right, y up, as produced by the backend WCS) to screen coordinates.
 * The backend flips PNGs and grids vertically so that north is up: image row = H - 1 - y.
 */
export function makeTransform(r: Rect, W: number, H: number, view: View) {
  const s = coverScale(r, W, H) * view.zoom;
  const cx = W / 2 + view.dx;
  const cy = H / 2 + view.dy;
  return {
    s,
    cx,
    cy,
    toScreen: (x: number, y: number) => ({
      sx: r.x + r.w / 2 + (x + 0.5 - cx) * s,
      sy: r.y + r.h / 2 + (H - 0.5 - y - cy) * s,
    }),
    fromScreen: (sx: number, sy: number) => ({
      x: (sx - r.x - r.w / 2) / s + cx - 0.5,
      y: H - 0.5 - ((sy - r.y - r.h / 2) / s + cy),
    }),
  };
}

export function eyepieceGeometry(vw: number, vh: number) {
  const radius = Math.min(vw * 0.27, vh * 0.28);
  return { radius, cx: vw / 2, cy: vh * 0.53 };
}

/**
 * Landing composition: the field is a little larger than the screen and shifted so the target sits to the
 * right of the headline (landscape) or above it (portrait).
 */
export function landingView(vw: number, vh: number, W: number, H: number): View {
  const portrait = vw < 760;
  const zoom = portrait ? 1.15 : 1.3;
  const s = Math.max(vw / W, vh / H) * zoom;
  return portrait ? { zoom, dx: 0, dy: (0.17 * vh) / s } : { zoom, dx: (-0.13 * vw) / s, dy: (0.1 * vh) / s };
}
