"""On-the-Fly Aperture Photometry, Light Curve & Spectral Extractor for SPHEREx."""

from __future__ import annotations

import concurrent.futures
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.stats import SigmaClip
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_area
from photutils.aperture import ApertureStats, CircularAnnulus, CircularAperture
from photutils.centroids import centroid_com, centroid_sources

import backend.spherex_core as _core

logging.getLogger("astropy").setLevel(logging.ERROR)

REFERENCE_SPECTRAL_FEATURES = [
    {"wavelength_um": 1.083, "label": "He I 1.08µm", "category": "atomic"},
    {"wavelength_um": 1.15, "label": "H₂O / CH₄ 1.15µm", "category": "molecular"},
    {"wavelength_um": 1.282, "label": "Pa-β 1.28µm", "category": "hydrogen"},
    {"wavelength_um": 1.40, "label": "H₂O 1.40µm", "category": "molecular"},
    {"wavelength_um": 1.60, "label": "H⁻ 1.6µm Bump / CH₄", "category": "continuum"},
    {"wavelength_um": 1.875, "label": "Pa-α 1.88µm", "category": "hydrogen"},
    {"wavelength_um": 2.166, "label": "Br-γ 2.17µm", "category": "hydrogen"},
    {"wavelength_um": 2.30, "label": "CO 2.3µm Bandhead", "category": "molecular"},
    {"wavelength_um": 2.626, "label": "Br-β 2.63µm", "category": "hydrogen"},
    {"wavelength_um": 3.05, "label": "H₂O Ice 3.05µm", "category": "ice"},
    {"wavelength_um": 3.30, "label": "PAH / CH₄ 3.3µm", "category": "molecular"},
    {"wavelength_um": 4.052, "label": "Br-α 4.05µm", "category": "hydrogen"},
    {"wavelength_um": 4.26, "label": "CO₂ 4.26µm", "category": "ice"},
    {"wavelength_um": 4.67, "label": "CO 4.67µm", "category": "molecular"},
]


def _extract_single_cutout_photometry(
    visit: Dict[str, Any],
    sky_coord: SkyCoord,
    r_aperture_px: float = 2.5,
    r_inner_px: float = 5.0,
    r_outer_px: float = 9.0,
    refine_visit_centroid: bool = True,
) -> Optional[Dict[str, Any]]:
    """
    Extract background-subtracted aperture photometry, uncertainty from VARIANCE,
    exact WCS-WAVE wavelength and bandwidth, and flag status from a single cached cutout MEF.
    """
    local_path = visit.get("local_path")
    if not local_path or not Path(local_path).exists():
        return None

    try:
        with fits.open(local_path, memmap=False) as hdulist:
            img_hdu = hdulist["IMAGE"]
            zodi_hdu = hdulist["ZODI"]
            var_hdu = hdulist["VARIANCE"]
            flags_hdu = hdulist["FLAGS"]

            hdr = img_hdu.header
            spatial_wcs = WCS(hdr)
            x0_px, y0_px = spatial_wcs.world_to_pixel(sky_coord)
            x, y = float(x0_px), float(y0_px)

            ny, nx = img_hdu.data.shape
            if not (1.0 <= x <= nx - 2.0 and 1.0 <= y <= ny - 2.0):
                return None

            clean_img = np.array(img_hdu.data, dtype=np.float64) - np.array(zodi_hdu.data, dtype=np.float64)
            var_img = np.array(var_hdu.data, dtype=np.float64)
            flags_img = np.array(flags_hdu.data, dtype=np.int64)
            flag_bits = _core.parse_flag_bits_from_header(flags_hdu.header)

            bad_mask_bits = (
                flag_bits["TRANSIENT"]
                | flag_bits["SUR_ERROR"]
                | flag_bits["NONFUNC"]
                | flag_bits["MISSING_DATA"]
                | flag_bits["HOT"]
                | flag_bits["COLD"]
                | flag_bits["PERSIST"]
                | flag_bits["OUTLIER"]
                | flag_bits["STREAK"]
                | flag_bits["SNOWBALL"]
            )
            contam_mask_bits = (
                flag_bits["CROSSTALK"]
                | flag_bits["GHOST"]
                | flag_bits["GHOST_FPA"]
                | flag_bits["GHOST_EXT"]
                | flag_bits["HALO"]
                | flag_bits["DICHROIC"]
            )

            sigclip = SigmaClip(sigma=3.0, maxiters=10)
            annulus_clean = clean_img.copy()
            overflow_px = (flags_img & flag_bits["OVERFLOW"]) != 0
            annulus_clean[((flags_img & bad_mask_bits) != 0) & ~overflow_px] = np.nan

            init_annulus = CircularAnnulus((x, y), r_in=r_inner_px, r_out=r_outer_px)
            init_aperstats = ApertureStats(annulus_clean, init_annulus, sigma_clip=sigclip)
            bkg_mean = float(init_aperstats.mean) if np.isfinite(init_aperstats.mean) else 0.0
            bkg_std = float(init_aperstats.std) if np.isfinite(init_aperstats.std) else 0.0

            iy_init, ix_init = int(round(y)), int(round(x))
            cy0_i, cy1_i = max(0, iy_init - 1), min(ny, iy_init + 2)
            cx0_i, cx1_i = max(0, ix_init - 1), min(nx, ix_init + 2)
            core_patch = clean_img[cy0_i:cy1_i, cx0_i:cx1_i]
            core_flags_init = int(np.bitwise_or.reduce(flags_img[cy0_i:cy1_i, cx0_i:cx1_i].ravel()))
            core_has_sat = (
                (core_flags_init & (flag_bits["OVERFLOW"] | flag_bits["NONLINEAR"])) != 0
                or not np.all(np.isfinite(core_patch))
            )

            if (
                refine_visit_centroid
                and not core_has_sat
                and core_patch.size > 0
                and float(np.nanmax(core_patch)) > bkg_mean + max(5.0 * bkg_std, 0.02)
            ):
                try:
                    sub_pos = np.clip(np.nan_to_num(clean_img - bkg_mean, nan=0.0), 0.0, None)
                    rx_arr, ry_arr = centroid_sources(
                        sub_pos, [x], [y], box_size=3, centroid_func=centroid_com
                    )
                    rx, ry = float(rx_arr[0]), float(ry_arr[0])
                    if np.isfinite(rx) and np.isfinite(ry) and np.hypot(rx - x, ry - y) <= 1.2:
                        x, y = rx, ry
                except Exception:
                    pass

            spectral_wcs = WCS(header=hdr, fobj=hdulist, key="W")
            spectral_wcs.sip = None
            wl, bw = spectral_wcs.pixel_to_world(x, y)
            wavelength_um = float(wl.to(u.micrometer).value)
            bandwidth_um = float(bw.to(u.micrometer).value)

            position = (x, y)
            aperture = CircularAperture(position, r=r_aperture_px)
            annulus = CircularAnnulus(position, r_in=r_inner_px, r_out=r_outer_px)
            aperstats = ApertureStats(annulus_clean, annulus, sigma_clip=sigclip)
            bkg_mean = float(aperstats.mean) if np.isfinite(aperstats.mean) else 0.0
            bkg_std = float(aperstats.std) if np.isfinite(aperstats.std) else 0.0
            annulus_area = (
                float(aperstats.sum_aper_area.value)
                if hasattr(aperstats.sum_aper_area, "value")
                else float(aperstats.sum_aper_area)
            )
            if not np.isfinite(annulus_area) or annulus_area <= 0:
                annulus_area = float(annulus.area_overlap(clean_img))

            ap_area = float(aperture.area_overlap(clean_img))
            if ap_area <= 0:
                return None

            # Use ApertureStats with mask=~np.isfinite(clean_img) so saturated stars still yield
            # a finite wing/annular flux measurement (flagged with is_saturated=True)
            var_clean = np.where(np.isfinite(var_img) & (var_img >= 0), var_img, bkg_std ** 2)
            err_img = np.sqrt(var_clean)

            invalid_px = ~np.isfinite(clean_img)
            ap_stats = ApertureStats(clean_img, aperture, error=err_img, mask=invalid_px)
            finite_area = (
                float(ap_stats.sum_aper_area.value)
                if hasattr(ap_stats.sum_aper_area, "value")
                else float(ap_stats.sum_aper_area)
            )
            if not np.isfinite(finite_area) or finite_area <= 0:
                return None

            ap_sum_finite = float(ap_stats.sum)
            ap_sum_err_finite = (
                float(ap_stats.sum_err)
                if np.isfinite(ap_stats.sum_err)
                else bkg_std * np.sqrt(finite_area)
            )

            ap_sum_bkgsub_finite = ap_sum_finite - (bkg_mean * finite_area)
            flux_mjy_sr = ap_sum_bkgsub_finite / finite_area

            var_sum = ap_sum_err_finite ** 2
            ap_flux_var = var_sum + (ap_area ** 2) * (bkg_std ** 2) / max(annulus_area, 1.0)
            flux_err_mjy_sr = np.sqrt(ap_flux_var) / max(finite_area, 1.0)

            ap_sum_bkgsub_full = flux_mjy_sr * ap_area
            pix_area_deg2 = proj_plane_pixel_area(spatial_wcs.celestial) * (u.deg ** 2)
            mjy_per_mjy_sr_pix = float((pix_area_deg2 * (1.0 * u.MJy / u.sr)).to(u.mJy).value)
            flux_mjy = ap_sum_bkgsub_full * mjy_per_mjy_sr_pix
            flux_err_mjy = flux_err_mjy_sr * ap_area * mjy_per_mjy_sr_pix

            iy, ix = int(round(y)), int(round(x))
            y0, y1 = max(0, iy - 2), min(ny, iy + 3)
            x0, x1 = max(0, ix - 2), min(nx, ix + 3)
            patch_flags = int(np.bitwise_or.reduce(flags_img[y0:y1, x0:x1].ravel()))

            cy0, cy1 = max(0, iy - 1), min(ny, iy + 2)
            cx0, cx1 = max(0, ix - 1), min(nx, ix + 2)
            core_flags = int(np.bitwise_or.reduce(flags_img[cy0:cy1, cx0:cx1].ravel()))
            core_nan_count = int(np.count_nonzero(~np.isfinite(clean_img[cy0:cy1, cx0:cx1])))
            center_is_nan = bool(0 <= iy < ny and 0 <= ix < nx and not np.isfinite(clean_img[iy, ix]))

            overflow_or_nonlinear = (
                core_flags & (flag_bits["OVERFLOW"] | flag_bits["NONLINEAR"])
            ) != 0
            is_saturated = bool(
                overflow_or_nonlinear or (center_is_nan and core_nan_count >= 2) or core_nan_count >= 3
            )

            effective_bad_mask = bad_mask_bits
            if (patch_flags & flag_bits["OVERFLOW"]) != 0 or is_saturated:
                effective_bad_mask = effective_bad_mask & ~flag_bits["SUR_ERROR"]

            is_bad = bool((patch_flags & effective_bad_mask) != 0)
            is_contaminated = bool((patch_flags & contam_mask_bits) != 0)
            flag_labels: List[str] = []
            if is_saturated:
                flag_labels.append("SATURATED_OR_NONLINEAR")
            if is_bad:
                flag_labels.append("TRANSIENT_OR_BAD_PIXEL")
            if is_contaminated:
                flag_labels.append("GHOST_OR_CROSSTALK")

            if not np.isfinite(flux_mjy_sr):
                return None

            return {
                "visit_index": visit["visit_index"],
                "epoch_index": visit.get("epoch_index", 0),
                "detector": visit["detector"],
                "mjd": float(visit["mjd"]),
                "iso_date": visit.get("iso_date", ""),
                "jyear": float(visit.get("jyear", 2025.8)),
                "wavelength_um": round(wavelength_um, 4),
                "bandwidth_um": round(bandwidth_um, 4),
                "flux_mjy_sr": round(float(flux_mjy_sr), 4),
                "flux_err": round(float(flux_err_mjy_sr), 4),
                "flux_mjy": round(float(flux_mjy), 4),
                "flux_err_mjy": round(float(flux_err_mjy), 4),
                "is_saturated_or_flagged": bool(is_saturated or is_bad),
                "is_saturated": is_saturated,
                "is_bad": is_bad,
                "is_contaminated": is_contaminated,
                "flag_labels": flag_labels,
            }
    except Exception:
        return None


def _build_detector_sed_template(
    pts: List[Dict[str, Any]], key_field: str
) -> Tuple[np.ndarray, np.ndarray, float]:
    """
    Build a smooth wavelength-binned SED template (bin_wls, bin_fluxes, median_flux)
    across a detector's visits so LVF wavelength drift does not create fake epoch variability.
    """
    wls = np.array([p["wavelength_um"] for p in pts], dtype=float)
    vals = np.array([p[key_field] for p in pts], dtype=float)
    order = np.argsort(wls)
    wls_s = wls[order]
    vals_s = vals[order]
    det_med = float(np.median(vals_s))
    n_bins = min(4, max(1, len(wls_s) // 2))
    w_chunks = np.array_split(wls_s, n_bins)
    v_chunks = np.array_split(vals_s, n_bins)
    bin_w = np.array([float(np.median(c)) for c in w_chunks], dtype=float)
    bin_v = np.array([float(np.median(c)) for c in v_chunks], dtype=float)
    return bin_w, bin_v, det_med


def extract_spectrum_and_lightcurve(
    target_key: str,
    ra_deg: float,
    dec_deg: float,
    r_aperture_px: float = 2.5,
    fetch_additional_per_detector: int = 0,
    force_recompute: bool = False,
) -> Dict[str, Any]:
    """
    Given any sky coordinate (ra, dec) inside a cached field:
    1. Optionally downloads additional uncached cutouts from all_visits.json for denser wavelength sampling.
    2. Centers the aperture on the image-measured epoch centroids when querying the target source.
    3. Extracts background-subtracted flux and variance across all cached cutouts.
    4. Computes SED-normalized epoch light curves and variability metrics excluding saturated visits.
    """
    target_dir = _core.CACHE_ROOT / target_key
    all_visits_path = target_dir / "all_visits.json"
    manifest_path = target_dir / "manifest.json"

    if not all_visits_path.exists() or not manifest_path.exists():
        raise FileNotFoundError(f"Cached target '{target_key}' not found.")

    with open(all_visits_path, "r", encoding="utf-8") as f:
        visits_data = json.load(f)
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    center_spec_path = target_dir / "center_spectrum.json"
    t_meta = manifest.get("target", {})
    ra_center = float(t_meta.get("ra_obs", t_meta.get("ra_ref", -999.0)))
    dec_center = float(t_meta.get("dec_obs", t_meta.get("dec_ref", -999.0)))
    cos_dec = max(0.05, float(np.cos(np.deg2rad(dec_deg))))
    dist_center_arcsec = float(
        np.hypot((ra_deg - ra_center) * cos_dec, dec_deg - dec_center) * 3600.0
    )
    near_any_target_epoch = False
    for ep_pos in (manifest.get("target_positions") or {}).values():
        if isinstance(ep_pos, dict) and "ra" in ep_pos and "dec" in ep_pos:
            d_ep = float(
                np.hypot(
                    (ra_deg - float(ep_pos["ra"])) * cos_dec,
                    dec_deg - float(ep_pos["dec"]),
                )
                * 3600.0
            )
            if d_ep <= 6.0:
                near_any_target_epoch = True
                break
    is_center_query = (
        abs(r_aperture_px - 2.5) < 0.05
        and (dist_center_arcsec <= 12.0 or near_any_target_epoch)
    )

    if (
        not force_recompute
        and fetch_additional_per_detector == 0
        and is_center_query
        and center_spec_path.exists()
    ):
        with open(center_spec_path, "r", encoding="utf-8") as f:
            return json.load(f)

    visits: List[Dict[str, Any]] = visits_data.get("visits", [])
    raw_dir = target_dir / "raw_cutouts"
    sky_coord = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg, frame="icrs")

    # Check if the query coordinate corresponds to the target star so the aperture tracks
    # the image-measured epoch centroids across epochs
    target_positions = manifest.get("target_positions", {})
    epoch_sky_coords: Dict[int, SkyCoord] = {}
    center_sky = SkyCoord(ra=ra_center * u.deg, dec=dec_center * u.deg, frame="icrs")
    e0_pos = target_positions.get("epoch_0")
    e0_sky = (
        SkyCoord(ra=float(e0_pos["ra"]) * u.deg, dec=float(e0_pos["dec"]) * u.deg, frame="icrs")
        if e0_pos and "ra" in e0_pos and "dec" in e0_pos
        else center_sky
    )
    track_epoch_centroids = bool(
        sky_coord.separation(center_sky).arcsec <= 15.0
        or sky_coord.separation(e0_sky).arcsec <= 15.0
    )
    if track_epoch_centroids:
        for ep in manifest.get("epochs_summary", []):
            ep_idx = int(ep["epoch_index"])
            ep_id = str(ep["epoch_id"])
            pos_info = target_positions.get(ep_id)
            if pos_info and "ra" in pos_info and "dec" in pos_info:
                epoch_sky_coords[ep_idx] = SkyCoord(
                    ra=float(pos_info["ra"]) * u.deg,
                    dec=float(pos_info["dec"]) * u.deg,
                    frame="icrs",
                )

    for v in visits:
        p = _core.resolve_cutout_local_path(v, raw_dir)
        if p.exists() and p.stat().st_size > 2880:
            v["local_path"] = str(p)
            v["status"] = "ok"
        else:
            v["local_path"] = None

    if not any(v.get("local_path") for v in visits) and fetch_additional_per_detector == 0:
        fetch_additional_per_detector = 2

    downloaded_any_new = False
    if fetch_additional_per_detector > 0:
        to_fetch: List[Dict[str, Any]] = []
        for det in _core.DETECTORS:
            uncached = [
                v for v in visits if v["detector"] == det and not v.get("local_path")
            ]
            if uncached:
                step = max(1, len(uncached) // fetch_additional_per_detector)
                to_fetch.extend(uncached[::step][:fetch_additional_per_detector])

        if to_fetch:
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
                futs = [
                    executor.submit(
                        _core.download_and_inspect_cutout,
                        v,
                        raw_dir,
                        epoch_sky_coords.get(int(v.get("epoch_index", 0)), sky_coord),
                    )
                    for v in to_fetch
                ]
                for fut in concurrent.futures.as_completed(futs):
                    res = fut.result()
                    if res.get("status") == "ok":
                        downloaded_any_new = True
                        for v in visits:
                            if v["visit_index"] == res["visit_index"]:
                                v.update(res)

            if downloaded_any_new:
                _core._write_json_atomic(
                    all_visits_path,
                    {
                        "target": visits_data.get("target", t_meta),
                        "total_overlapping_visits": len(visits),
                        "visits": visits,
                    },
                )

    cached_visits = [v for v in visits if v.get("local_path") and Path(v["local_path"]).exists()]

    spectrum_points: List[Dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                _extract_single_cutout_photometry,
                v,
                epoch_sky_coords.get(int(v.get("epoch_index", 0)), sky_coord),
                r_aperture_px=r_aperture_px,
                refine_visit_centroid=track_epoch_centroids,
            )
            for v in cached_visits
        ]
        for future in concurrent.futures.as_completed(futures):
            pt = future.result()
            if pt is not None:
                spectrum_points.append(pt)

    spectrum_points.sort(key=lambda p: p["wavelength_um"])

    epochs_summary = manifest.get("epochs_summary", [])
    light_curves: Dict[str, List[Dict[str, Any]]] = {d: [] for d in _core.DETECTORS}

    for det in _core.DETECTORS:
        det_pts = [p for p in spectrum_points if p["detector"] == det]
        if not det_pts:
            continue

        unsat_det_pts = [p for p in det_pts if not p["is_saturated"] and not p["is_bad"]]
        if not unsat_det_pts:
            unsat_det_pts = [p for p in det_pts if not p["is_saturated"]]
        all_det_saturated = len(unsat_det_pts) == 0
        template_source_pts = det_pts if all_det_saturated else unsat_det_pts

        bin_w_sr, bin_v_sr, det_med_sr = _build_detector_sed_template(
            template_source_pts, "flux_mjy_sr"
        )
        bin_w_mjy, bin_v_mjy, det_med_mjy = _build_detector_sed_template(
            template_source_pts, "flux_mjy"
        )

        for ep in epochs_summary:
            ep_idx = ep["epoch_index"]
            ep_all_pts = [p for p in det_pts if p["epoch_index"] == ep_idx]
            if not ep_all_pts:
                continue

            ep_unsat = [p for p in ep_all_pts if not p["is_saturated"] and not p["is_bad"]]
            if not ep_unsat:
                ep_unsat = [p for p in ep_all_pts if not p["is_saturated"]]

            if not all_det_saturated and not ep_unsat:
                # Exclude completely saturated epoch when other epochs in this detector have unsaturated data
                continue

            ep_pts = ep_all_pts if all_det_saturated else ep_unsat
            fluxes = np.array([p["flux_mjy_sr"] for p in ep_pts], dtype=float)
            errs = np.array([p["flux_err"] for p in ep_pts], dtype=float)
            fluxes_mjy = np.array([p["flux_mjy"] for p in ep_pts], dtype=float)
            errs_mjy = np.array([p["flux_err_mjy"] for p in ep_pts], dtype=float)
            wls = np.array([p["wavelength_um"] for p in ep_pts], dtype=float)

            # Normalize visit fluxes by the smooth unsaturated SED template at each visit's wavelength
            expected_sr = np.interp(wls, bin_w_sr, bin_v_sr)
            norm_fluxes_sr = det_med_sr + (fluxes - expected_sr)
            expected_mjy = np.interp(wls, bin_w_mjy, bin_v_mjy)
            norm_fluxes_mjy = det_med_mjy + (fluxes_mjy - expected_mjy)

            mean_flux = float(np.median(norm_fluxes_sr))
            mean_flux_mjy = float(np.median(norm_fluxes_mjy))
            comb_err = float(np.sqrt(np.sum(errs ** 2)) / len(errs))
            comb_err_mjy = float(np.sqrt(np.sum(errs_mjy ** 2)) / len(errs_mjy))
            any_sat = bool(all_det_saturated and any(p["is_saturated"] for p in ep_pts))
            any_flag = any(p["is_saturated_or_flagged"] for p in ep_pts)

            light_curves[det].append(
                {
                    "epoch_index": ep_idx,
                    "epoch_id": ep["epoch_id"],
                    "mean_mjd": ep["mean_mjd"],
                    "mean_iso": ep["mean_iso"],
                    "mean_jyear": ep["mean_jyear"],
                    "flux_mjy_sr": round(mean_flux, 4),
                    "flux_err": round(comb_err, 4),
                    "flux_mjy": round(mean_flux_mjy, 4),
                    "flux_err_mjy": round(comb_err_mjy, 4),
                    "mean_wavelength_um": round(float(np.mean(wls)), 4),
                    "n_visits": len(ep_pts),
                    "is_saturated": any_sat,
                    "is_saturated_or_flagged": any_flag,
                }
            )

    variability_summary: Dict[str, Any] = {}
    for det in _core.DETECTORS:
        lc = light_curves[det]
        if len(lc) >= 2:
            unsat_lc = [pt for pt in lc if not pt["is_saturated"]]
            use_lc = unsat_lc if len(unsat_lc) >= 2 else lc
            f_vals = np.array([pt["flux_mjy_sr"] for pt in use_lc], dtype=float)
            f_errs = np.array([pt["flux_err"] for pt in use_lc], dtype=float)
            delta_flux = float(f_vals[-1] - f_vals[0])
            frac_change = float(delta_flux / max(abs(np.mean(f_vals)), 1e-3))
            snr_change = float(abs(delta_flux) / max(np.sqrt(f_errs[0] ** 2 + f_errs[-1] ** 2), 1e-4))
            variability_summary[det] = {
                "delta_flux_mjy_sr": round(delta_flux, 4),
                "fractional_change_pct": round(frac_change * 100.0, 2),
                "significance_sigma": round(snr_change, 2),
                "any_saturated": any(pt["is_saturated"] for pt in use_lc),
            }

    result_payload = {
        "target_key": target_key,
        "query_coord": {"ra": round(ra_deg, 6), "dec": round(dec_deg, 6)},
        "aperture_radius_px": r_aperture_px,
        "aperture_radius_arcsec": round(r_aperture_px * 6.2, 2),
        "total_overlapping_visits": len(visits),
        "extracted_visits_count": len(spectrum_points),
        "uncached_visits_remaining": max(0, len(visits) - len(cached_visits)),
        "spectrum": spectrum_points,
        "light_curves": light_curves,
        "variability_summary": variability_summary,
        "reference_features": REFERENCE_SPECTRAL_FEATURES,
    }

    if is_center_query and (force_recompute or downloaded_any_new or not center_spec_path.exists()):
        try:
            _core._write_json_atomic(center_spec_path, result_payload)
        except Exception:
            pass

    return result_payload
