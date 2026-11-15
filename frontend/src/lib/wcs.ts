import type { WcsInfo } from '../types';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** TAN (gnomonic) projection matching the backend's common north-up grid. Pixels are 0-indexed array coordinates. */
export class Wcs {
  constructor(private w: WcsInfo) {}

  pixelToWorld(x: number, y: number): { ra: number; dec: number } {
    const { crpix, cdelt, crval } = this.w;
    const xi = cdelt[0] * (x + 1 - crpix[0]) * D2R;
    const eta = cdelt[1] * (y + 1 - crpix[1]) * D2R;
    const ra0 = crval[0] * D2R;
    const dec0 = crval[1] * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return { ra: crval[0], dec: crval[1] };
    const c = Math.atan(rho);
    const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + (eta * Math.sin(c) * Math.cos(dec0)) / rho);
    const ra =
      ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * Math.sin(c));
    return { ra: (((ra * R2D) % 360) + 360) % 360, dec: dec * R2D };
  }

  worldToPixel(raDeg: number, decDeg: number): { x: number; y: number } {
    const { crpix, cdelt, crval } = this.w;
    const ra = raDeg * D2R;
    const dec = decDeg * D2R;
    const ra0 = crval[0] * D2R;
    const dec0 = crval[1] * D2R;
    const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
    const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
    const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
    return {
      x: (xi * R2D) / cdelt[0] + crpix[0] - 1,
      y: (eta * R2D) / cdelt[1] + crpix[1] - 1,
    };
  }
}
