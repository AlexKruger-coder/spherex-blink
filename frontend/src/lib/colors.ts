export const EMBER = '#F0A04B';

/** Infrared logic: the longer the wavelength, the warmer the colour. */
const STOPS: [number, [number, number, number]][] = [
  [0.75, [108, 142, 191]],
  [1.9, [217, 210, 192]],
  [3.2, [232, 172, 112]],
  [5.0, [226, 96, 47]],
];

export function bandRgb(um: number): [number, number, number] {
  if (um <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [u1, c1] = STOPS[i];
    if (um <= u1) {
      const [u0, c0] = STOPS[i - 1];
      const t = (um - u0) / (u1 - u0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function bandColor(um: number, alpha = 1): string {
  const [r, g, b] = bandRgb(um);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}
