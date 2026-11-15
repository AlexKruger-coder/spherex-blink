"""SPHEREx Core Astronomy & Cutout Engine."""

from __future__ import annotations

import concurrent.futures
import gzip
import hashlib
import json
import logging
import re
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

import astropy.units as u
import matplotlib
import numpy as np
import requests
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.utils.data import conf
from astropy.visualization import AsinhStretch, ImageNormalize, MinMaxInterval
from astropy.wcs import WCS
from astroquery.ipac.irsa import Irsa
from photutils.centroids import (
    centroid_2dg,
    centroid_com,
    centroid_quadratic,
    centroid_sources,
)
from PIL import Image
from reproject import reproject_interp
from scipy.ndimage import maximum_filter, median_filter

import backend.spectra as _spectra

matplotlib.use("Agg")

logging.getLogger("astropy").setLevel(logging.ERROR)
conf.remote_timeout = 120

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_ROOT = BASE_DIR / "cache"
CACHE_ROOT.mkdir(parents=True, exist_ok=True)

DETECTORS = ["D1", "D2", "D3", "D4", "D5", "D6"]
BANDPASS_NAMES = [f"SPHEREx-{d}" for d in DETECTORS]

DETECTOR_WAVELENGTH_RANGES: Dict[str, Dict[str, Any]] = {
    "D1": {"min_um": 0.75, "max_um": 1.09, "R": 39, "label": "0.75 - 1.09 µm"},
    "D2": {"min_um": 1.10, "max_um": 1.62, "R": 41, "label": "1.10 - 1.62 µm"},
    "D3": {"min_um": 1.63, "max_um": 2.41, "R": 41, "label": "1.63 - 2.41 µm"},
    "D4": {"min_um": 2.42, "max_um": 3.82, "R": 35, "label": "2.42 - 3.82 µm"},
    "D5": {"min_um": 3.83, "max_um": 4.41, "R": 112, "label": "3.83 - 4.41 µm"},
    "D6": {"min_um": 4.42, "max_um": 5.00, "R": 128, "label": "4.42 - 5.00 µm"},
    "ALL": {"min_um": 0.75, "max_um": 5.00, "R": None, "label": "0.75 - 5.00 µm (All Detectors)"},
    "RGB": {"min_um": 1.10, "max_um": 5.00, "R": None, "label": "False-Color IR RGB (R=D6, G=D4, B=D2)"},
}

# Bitmask flags in SPHEREx Level 2 MEF FLAGS extension (default MSKN* definitions)
FLAG_BITS = {
    "TRANSIENT": 1 << 0,       # 1: Transient detected during SUR
    "OVERFLOW": 1 << 1,        # 2: Overflow / saturation detected during SUR
    "SUR_ERROR": 1 << 2,       # 4: Error in onboard processing
    "NONFUNC": 1 << 6,         # 64: Permanently unusable
    "DICHROIC": 1 << 7,        # 128: Low efficiency due to dichroic
    "MISSING_DATA": 1 << 9,    # 512: Onboard data lost
    "HOT": 1 << 10,            # 1024: Hot pixel
    "COLD": 1 << 11,           # 2048: Anomalously low signal
    "FULLSAMPLE": 1 << 12,     # 4096: Pixel full sample history is available
    "PHANMISS": 1 << 14,       # 16384: Phantom correction was not applied
    "NONLINEAR": 1 << 15,      # 32768: Nonlinearity correction cannot be applied reliably
    "PERSIST": 1 << 17,        # 131072: Persistent charge above threshold
    "OUTLIER": 1 << 19,        # 524288: Pixel flagged by Detect Outliers
    "CROSSTALK": 1 << 20,      # 1048576: Pixel affected by crosstalk
    "SOURCE": 1 << 21,         # 2097152: Pixel mapped to a known source
    "GHOST": 1 << 22,          # 4194304: Affected by a bright source inside exposure
    "GHOST_FPA": 1 << 23,      # 8388608: Affected by a bright source on another detector
    "GHOST_EXT": 1 << 24,      # 16777216: Affected by a bright source outside FOV
    "STREAK": 1 << 25,         # 33554432: Pixel affected by a streak
    "BLOOM": 1 << 26,          # 67108864: Pixel part of a bloom artifact
    "SNOWBALL": 1 << 27,       # 134217728: Pixel part of a snowball artifact
    "HALO": 1 << 28,           # 268435456: Pixel part of a transient halo
}

BAD_COADD_MASK = (
    FLAG_BITS["TRANSIENT"]
    | FLAG_BITS["SUR_ERROR"]
    | FLAG_BITS["NONFUNC"]
    | FLAG_BITS["MISSING_DATA"]
    | FLAG_BITS["HOT"]
    | FLAG_BITS["COLD"]
    | FLAG_BITS["PERSIST"]
    | FLAG_BITS["OUTLIER"]
    | FLAG_BITS["STREAK"]
    | FLAG_BITS["SNOWBALL"]
)

SATURATED_MASK = (
    FLAG_BITS["OVERFLOW"]
    | FLAG_BITS["NONLINEAR"]
    | FLAG_BITS["BLOOM"]
)

CONTAMINATED_MASK = (
    FLAG_BITS["CROSSTALK"]
    | FLAG_BITS["GHOST"]
    | FLAG_BITS["GHOST_FPA"]
    | FLAG_BITS["GHOST_EXT"]
    | FLAG_BITS["HALO"]
    | FLAG_BITS["DICHROIC"]
)

OFFICIAL_TARGETS: Dict[str, Dict[str, Any]] = {
    "barnards_star": {
        "id": "barnards_star",
        "name": "Barnard's Star",
        "aliases": ["barnard's star", "barnards star", "barnard", "gj 699", "hip 87937"],
        "category": "High Proper Motion Red Dwarf",
        "description": "Fastest-moving star in the sky (~10.4 arcsec/yr northward). Propagated from J2000 to SPHEREx observation epoch.",
        "ra_ref": 269.45207696,
        "dec_ref": 4.69336497,
        "ref_epoch_jyear": 2000.0,
        "pmra_mas_yr": -801.551,
        "pmdec_mas_yr": 10362.394,
        "distance_pc": 1.828,
        "default_fov_deg": 0.10,
        "recommended_detector": "D2",
        "scientific_notes": "At ~10.4\"/yr, Barnard's Star shifts ~4.4 arcmin between J2000 and 2025.8, and ~0.84 SPHEREx pixels per 6 months (~2.5 pixels over 1.5 years), creating a clear dipole in the difference image.",
    },
    "epsilon_indi_b": {
        "id": "epsilon_indi_b",
        "name": "Epsilon Indi B",
        "aliases": ["epsilon indi b", "eps indi b", "eps ind b", "eps indi ba/bb", "epsilon indi ba"],
        "category": "Binary Brown Dwarf (T1 + T6)",
        "description": "Closest binary brown dwarf pair (Eps Indi Ba/Bb), located ~6.7 arcmin from bright star Epsilon Indi A, moving at ~4.7 arcsec/yr.",
        "ra_ref": 331.04414659,
        "dec_ref": -56.78284420,
        "ref_epoch_jyear": 2000.0,
        "pmra_mas_yr": 3981.977,
        "pmdec_mas_yr": -2466.832,
        "distance_pc": 3.638,
        "default_fov_deg": 0.12,
        "recommended_detector": "D2",
        "scientific_notes": "Targeted directly on the brown dwarf binary component Eps Indi Ba/Bb (~6.7' away from Eps Indi A) and propagated to the SPHEREx observation epoch.",
    },
    "wise_0855": {
        "id": "wise_0855",
        "name": "WISE 0855",
        "aliases": [
            "wise 0855",
            "wise 0855-0714",
            "wise j085510.83-071442.5",
            "08h55m10.831s -7d14m42.53s",
        ],
        "category": "Coldest Known Sub-Brown Dwarf (Y4)",
        "description": "250 K free-floating planetary-mass Y dwarf at 2.28 pc with extreme proper motion (~8.1 arcsec/yr westward). Faint below 3.5 µm; thermally bright in 4-5 µm (D5/D6).",
        "ra_ref": 133.79512917,
        "dec_ref": -7.24514722,
        "ref_epoch_jyear": 2010.5,
        "pmra_mas_yr": -8123.7,
        "pmdec_mas_yr": 673.2,
        "distance_pc": 2.28,
        "default_fov_deg": 0.15,
        "recommended_detector": "D6",
        "scientific_notes": "Discovery coordinates 08h55m10.831s -7d14m42.53s (2010.5) propagated with pmra=-8123.7 mas/yr, pmdec=+673.2 mas/yr to 2025.8. Default FOV 0.15° keeps both discovery and 2025-2026 positions well inside the frame.",
    },
    "rw_aurigae": {
        "id": "rw_aurigae",
        "name": "RW Aurigae",
        "aliases": ["rw aurigae", "rw aur"],
        "category": "Classical T Tauri Variable Star",
        "description": "Young pre-main-sequence star with a dusty circumstellar disk exhibiting strong irregular optical and infrared brightness variations.",
        "ra_ref": 76.95652603,
        "dec_ref": 30.40143817,
        "ref_epoch_jyear": 2000.0,
        "pmra_mas_yr": 7.23,
        "pmdec_mas_yr": -20.33,
        "distance_pc": 163.0,
        "default_fov_deg": 0.10,
        "recommended_detector": "D3",
        "scientific_notes": "Demonstrates multi-epoch infrared variability and strong disk excess across D1-D6.",
    },
    "r_draconis": {
        "id": "r_draconis",
        "name": "R Draconis",
        "aliases": ["r draconis", "r dra"],
        "category": "Mira Variable AGB Star (Near NEP)",
        "description": "Pulsating asymptotic giant branch variable star (period ~245.6 days) located ~8.6° from the North Ecliptic Pole with dense SPHEREx coverage.",
        "ra_ref": 248.16761083,
        "dec_ref": 66.75350000,
        "ref_epoch_jyear": 2000.0,
        "pmra_mas_yr": -20.643,
        "pmdec_mas_yr": 6.149,
        "distance_pc": 230.0,
        "default_fov_deg": 0.10,
        "recommended_detector": "D4",
        "scientific_notes": "Located near the North Ecliptic Pole where SPHEREx visits are dense and near-continuous; calendar windowing partitions coverage into clean epochs.",
    },
}


def _write_json_atomic(path: Path, payload: Any) -> None:
    """Write JSON payload atomically via a temporary file and rename."""
    tmp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    tmp_path.replace(path)


def parse_flag_bits_from_header(flags_header: Any) -> Dict[str, int]:
    """Parse MSKNxxxx and MSKMxxxx bit definitions from a SPHEREx FLAGS FITS header."""
    bits = dict(FLAG_BITS)
    if flags_header is None:
        return bits
    for key, val in flags_header.items():
        if key.startswith("MSKN") and len(key) == 8 and key[4:].isdigit():
            plane_str = key[4:]
            bit_idx = int(plane_str)
            mask_key = f"MSKM{plane_str}"
            try:
                mask_val = int(flags_header.get(mask_key, 1 << bit_idx))
            except Exception:
                mask_val = 1 << bit_idx
            name = str(val).strip().upper()
            if name:
                bits[name] = mask_val
    return bits


def propagate_coords(
    ra_deg: float,
    dec_deg: float,
    pmra_mas_yr: float,
    pmdec_mas_yr: float,
    ref_epoch_jyear: float,
    target_epoch_jyear: float,
    distance_pc: Optional[float] = None,
) -> Tuple[float, float]:
    """Propagate sky coordinates from ref_epoch_jyear to target_epoch_jyear using Astropy SkyCoord."""
    if abs(pmra_mas_yr) < 1e-6 and abs(pmdec_mas_yr) < 1e-6:
        return float(ra_deg), float(dec_deg)
    try:
        kwargs: Dict[str, Any] = {
            "ra": ra_deg * u.deg,
            "dec": dec_deg * u.deg,
            "pm_ra_cosdec": pmra_mas_yr * u.mas / u.yr,
            "pm_dec": pmdec_mas_yr * u.mas / u.yr,
            "obstime": Time(ref_epoch_jyear, format="jyear"),
            "frame": "icrs",
        }
        if distance_pc and distance_pc > 0:
            kwargs["distance"] = distance_pc * u.pc
        c0 = SkyCoord(**kwargs)
        c1 = c0.apply_space_motion(new_obstime=Time(target_epoch_jyear, format="jyear"))
        return float(c1.ra.deg), float(c1.dec.deg)
    except Exception:
        dt = target_epoch_jyear - ref_epoch_jyear
        dec_rad = np.deg2rad(dec_deg)
        dra_deg = (pmra_mas_yr * dt / 3600000.0) / max(np.cos(dec_rad), 1e-4)
        ddec_deg = pmdec_mas_yr * dt / 3600000.0
        return float((ra_deg + dra_deg) % 360.0), float(np.clip(dec_deg + ddec_deg, -90.0, 90.0))


def _parse_numeric_or_sexagesimal_coords(query_str: str) -> Optional[Tuple[float, float]]:
    """Try to parse raw numeric decimal degrees, coord_{ra}_{dec}, or sexagesimal coordinates."""
    s = query_str.strip()
    s_lower = s.lower()
    for tinfo in OFFICIAL_TARGETS.values():
        if s_lower == tinfo["id"] or s_lower == tinfo["name"].lower() or s_lower in tinfo["aliases"]:
            return None

    m_coord_id = re.match(r"^\s*coord_([+-]?\d+(?:\.\d+)?)_([+-]?\d+(?:\.\d+)?)\s*$", s, re.IGNORECASE)
    if m_coord_id:
        ra_val = float(m_coord_id.group(1))
        dec_val = float(m_coord_id.group(2))
        if 0.0 <= ra_val <= 360.0 and -90.0 <= dec_val <= 90.0:
            return ra_val, dec_val

    m_dec = re.match(r"^\s*([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)\s*$", s)
    if m_dec:
        ra_val = float(m_dec.group(1))
        dec_val = float(m_dec.group(2))
        if 0.0 <= ra_val <= 360.0 and -90.0 <= dec_val <= 90.0:
            return ra_val, dec_val

    if any(ch in s for ch in ["h", "d", ":"]) or re.match(r"^\d{1,2}\s+\d{1,2}\s+\d", s):
        try:
            if ":" in s or re.match(r"^\d{1,2}\s+\d{1,2}\s+\d", s):
                c = SkyCoord(s, unit=(u.hourangle, u.deg), frame="icrs")
            else:
                c = SkyCoord(s, frame="icrs")
            return float(c.ra.deg), float(c.dec.deg)
        except Exception:
            pass
    return None


def _resolve_sesame_with_pm(name: str) -> Dict[str, Any]:
    """Resolve an arbitrary object name via CDS Sesame XML (SIMBAD/Gaia) including proper motion."""
    url = f"https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?{quote(name)}"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        ra_el = root.find(".//jradeg")
        dec_el = root.find(".//jdedeg")
        if ra_el is not None and dec_el is not None:
            ra_deg = float(ra_el.text)
            dec_deg = float(dec_el.text)
            pmra_el = root.find(".//pmRA")
            pmdec_el = root.find(".//pmDE")
            oname_el = root.find(".//oname")
            otype_el = root.find(".//otype")
            pmra = float(pmra_el.text) if pmra_el is not None and pmra_el.text else 0.0
            pmdec = float(pmdec_el.text) if pmdec_el is not None and pmdec_el.text else 0.0
            return {
                "name": oname_el.text if oname_el is not None else name,
                "category": f"SIMBAD ({otype_el.text})" if otype_el is not None else "Resolved Astronomical Target",
                "ra_ref": ra_deg,
                "dec_ref": dec_deg,
                "ref_epoch_jyear": 2000.0,
                "pmra_mas_yr": pmra,
                "pmdec_mas_yr": pmdec,
                "distance_pc": None,
                "is_named_target": True,
            }
    except Exception:
        pass

    c = SkyCoord.from_name(name)
    return {
        "name": name,
        "category": "Resolved Astronomical Target",
        "ra_ref": float(c.ra.deg),
        "dec_ref": float(c.dec.deg),
        "ref_epoch_jyear": 2000.0,
        "pmra_mas_yr": 0.0,
        "pmdec_mas_yr": 0.0,
        "distance_pc": None,
        "is_named_target": True,
    }


def _match_cached_official_target(
    ra_val: float,
    dec_val: float,
    fov_deg: Optional[float] = None,
    max_sep_deg: float = 0.025,
) -> Optional[Dict[str, Any]]:
    """
    If raw coordinates lie within max_sep_deg (90 arcsec = 0.025 deg) of any official target's
    propagated ra_obs/dec_obs or catalog ra_ref/dec_ref and a cached manifest exists on disk,
    return the resolved official target dictionary so it loads immediately from disk cache.
    """
    try:
        query_coord = SkyCoord(ra=float(ra_val) * u.deg, dec=float(dec_val) * u.deg, frame="icrs")
    except Exception:
        return None

    for tid, tinfo in OFFICIAL_TARGETS.items():
        ra_2025, dec_2025 = propagate_coords(
            tinfo["ra_ref"],
            tinfo["dec_ref"],
            tinfo["pmra_mas_yr"],
            tinfo["pmdec_mas_yr"],
            tinfo["ref_epoch_jyear"],
            2025.8,
            tinfo.get("distance_pc"),
        )
        obs_coord = SkyCoord(ra=ra_2025 * u.deg, dec=dec_2025 * u.deg, frame="icrs")
        ref_coord = SkyCoord(ra=float(tinfo["ra_ref"]) * u.deg, dec=float(tinfo["dec_ref"]) * u.deg, frame="icrs")
        sep_deg = min(
            float(query_coord.separation(obs_coord).deg),
            float(query_coord.separation(ref_coord).deg),
        )
        if sep_deg <= max_sep_deg:
            default_fov = float(tinfo["default_fov_deg"])
            req_fov = float(fov_deg) if fov_deg is not None else default_fov
            candidate_fovs = [req_fov] if abs(req_fov - default_fov) < 1e-6 else [req_fov, default_fov]
            matched_fov: Optional[float] = None
            for cand_fov in candidate_fovs:
                fov_str = f"fov{cand_fov:.3f}".replace(".", "p")
                if (CACHE_ROOT / f"{tid}_{fov_str}_v4" / "manifest.json").exists():
                    matched_fov = cand_fov
                    break
            if matched_fov is not None:
                return {
                    "id": tid,
                    "name": tinfo["name"],
                    "category": tinfo["category"],
                    "description": tinfo["description"],
                    "ra_ref": float(tinfo["ra_ref"]),
                    "dec_ref": float(tinfo["dec_ref"]),
                    "ra_obs": ra_2025,
                    "dec_obs": dec_2025,
                    "ref_epoch_jyear": float(tinfo["ref_epoch_jyear"]),
                    "obs_epoch_jyear": 2025.8,
                    "pmra_mas_yr": float(tinfo["pmra_mas_yr"]),
                    "pmdec_mas_yr": float(tinfo["pmdec_mas_yr"]),
                    "distance_pc": tinfo.get("distance_pc"),
                    "fov_deg": matched_fov,
                    "recommended_detector": tinfo["recommended_detector"],
                    "is_named_target": True,
                    "scientific_notes": tinfo["scientific_notes"],
                }
    return None


def resolve_target_input(
    target_or_coords: str,
    ra: Optional[float] = None,
    dec: Optional[float] = None,
    fov_deg: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Resolve target name, official target ID, sexagesimal string, or raw numeric RA/Dec.
    Initial catalog proper-motion propagation is used to point the cutout window at the
    2025-2026 observation window when resolving a named target, while raw coordinate inputs
    remain centered at the requested coordinates (unless matching a pre-cached official target).
    """
    if (not target_or_coords or not target_or_coords.strip()) and ra is not None and dec is not None:
        matched_official = _match_cached_official_target(float(ra), float(dec), fov_deg=fov_deg)
        if matched_official is not None:
            return matched_official
        fov_val = float(fov_deg) if fov_deg is not None else 0.10
        return {
            "id": f"coord_{ra:.5f}_{dec:.5f}",
            "name": f"RA {ra:.5f}°, Dec {dec:+.5f}°",
            "category": "Custom Sky Coordinates",
            "description": "User-specified sky coordinates (fixed center, no proper motion shift applied).",
            "ra_ref": float(ra),
            "dec_ref": float(dec),
            "ra_obs": float(ra),
            "dec_obs": float(dec),
            "ref_epoch_jyear": 2025.8,
            "obs_epoch_jyear": 2025.8,
            "pmra_mas_yr": 0.0,
            "pmdec_mas_yr": 0.0,
            "distance_pc": None,
            "fov_deg": fov_val,
            "recommended_detector": "D2",
            "is_named_target": False,
            "scientific_notes": "Raw numeric coordinates queried directly without proper-motion center shifting.",
        }

    q = (target_or_coords or "").strip()
    q_lower = q.lower()

    for tid, tinfo in OFFICIAL_TARGETS.items():
        if q_lower == tid or q_lower == tinfo["name"].lower() or q_lower in tinfo["aliases"]:
            fov_val = float(fov_deg) if fov_deg is not None else float(tinfo["default_fov_deg"])
            ra_2025, dec_2025 = propagate_coords(
                tinfo["ra_ref"],
                tinfo["dec_ref"],
                tinfo["pmra_mas_yr"],
                tinfo["pmdec_mas_yr"],
                tinfo["ref_epoch_jyear"],
                2025.8,
                tinfo.get("distance_pc"),
            )
            return {
                "id": tid,
                "name": tinfo["name"],
                "category": tinfo["category"],
                "description": tinfo["description"],
                "ra_ref": float(tinfo["ra_ref"]),
                "dec_ref": float(tinfo["dec_ref"]),
                "ra_obs": ra_2025,
                "dec_obs": dec_2025,
                "ref_epoch_jyear": float(tinfo["ref_epoch_jyear"]),
                "obs_epoch_jyear": 2025.8,
                "pmra_mas_yr": float(tinfo["pmra_mas_yr"]),
                "pmdec_mas_yr": float(tinfo["pmdec_mas_yr"]),
                "distance_pc": tinfo.get("distance_pc"),
                "fov_deg": fov_val,
                "recommended_detector": tinfo["recommended_detector"],
                "is_named_target": True,
                "scientific_notes": tinfo["scientific_notes"],
            }

    parsed = _parse_numeric_or_sexagesimal_coords(q)
    if parsed is not None:
        ra_val, dec_val = parsed
        matched_official = _match_cached_official_target(ra_val, dec_val, fov_deg=fov_deg)
        if matched_official is not None:
            return matched_official
        fov_val = float(fov_deg) if fov_deg is not None else 0.10
        return {
            "id": f"coord_{ra_val:.5f}_{dec_val:.5f}",
            "name": f"RA {ra_val:.5f}°, Dec {dec_val:+.5f}° ({q})",
            "category": "Custom Sky Coordinates",
            "description": f"User-specified coordinates '{q}' (fixed center, no proper motion shift applied).",
            "ra_ref": ra_val,
            "dec_ref": dec_val,
            "ra_obs": ra_val,
            "dec_obs": dec_val,
            "ref_epoch_jyear": 2025.8,
            "obs_epoch_jyear": 2025.8,
            "pmra_mas_yr": 0.0,
            "pmdec_mas_yr": 0.0,
            "distance_pc": None,
            "fov_deg": fov_val,
            "recommended_detector": "D2",
            "is_named_target": False,
            "scientific_notes": "Direct coordinate input; center held fixed at exact input coordinates.",
        }

    resolved = _resolve_sesame_with_pm(q)
    fov_val = float(fov_deg) if fov_deg is not None else 0.10
    ra_2025, dec_2025 = propagate_coords(
        resolved["ra_ref"],
        resolved["dec_ref"],
        resolved["pmra_mas_yr"],
        resolved["pmdec_mas_yr"],
        resolved["ref_epoch_jyear"],
        2025.8,
        resolved.get("distance_pc"),
    )
    matched_official = _match_cached_official_target(ra_2025, dec_2025, fov_deg=fov_deg)
    if matched_official is not None:
        return matched_official
    slug = re.sub(r"[^a-z0-9]+", "_", q_lower).strip("_") or "target"
    return {
        "id": slug,
        "name": resolved["name"],
        "category": resolved["category"],
        "description": f"Resolved via SIMBAD/Sesame from '{q}'.",
        "ra_ref": resolved["ra_ref"],
        "dec_ref": resolved["dec_ref"],
        "ra_obs": ra_2025,
        "dec_obs": dec_2025,
        "ref_epoch_jyear": resolved["ref_epoch_jyear"],
        "obs_epoch_jyear": 2025.8,
        "pmra_mas_yr": resolved["pmra_mas_yr"],
        "pmdec_mas_yr": resolved["pmdec_mas_yr"],
        "distance_pc": resolved.get("distance_pc"),
        "fov_deg": fov_val,
        "recommended_detector": "D2",
        "is_named_target": True,
        "scientific_notes": f"Propagated with proper motion ({resolved['pmra_mas_yr']:.1f}, {resolved['pmdec_mas_yr']:.1f}) mas/yr to SPHEREx observation window.",
    }


def make_target_cache_key(resolved_target: Dict[str, Any], max_visits_per_epoch_per_detector: int = 4) -> str:
    """Create a deterministic disk cache folder name for a target + FOV."""
    fov_str = f"fov{resolved_target['fov_deg']:.3f}".replace(".", "p")
    if resolved_target["id"] in OFFICIAL_TARGETS:
        return f"{resolved_target['id']}_{fov_str}_v{max_visits_per_epoch_per_detector}"
    h = hashlib.md5(
        f"{resolved_target['ra_obs']:.5f}_{resolved_target['dec_obs']:.5f}_{resolved_target['fov_deg']:.4f}_{max_visits_per_epoch_per_detector}".encode()
    ).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "_", resolved_target["id"].lower()).strip("_")[:24]
    return f"{slug}_{fov_str}_{h}"


def query_spherex_tap_all_detectors(ra_deg: float, dec_deg: float, fov_deg: float) -> List[Dict[str, Any]]:
    """Query IRSA TAP across all 6 SPHEREx detectors (SPHEREx-D1..SPHEREx-D6) with 3-attempt retry."""
    query = f"""
SELECT
    'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra_deg},{dec_deg}d&size={fov_deg}' AS uri,
    a.uri AS artifact_uri,
    p.time_bounds_lower,
    p.energy_bandpassname
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra_deg}, {dec_deg}), p.poly)
    AND p.energy_bandpassname IN ('SPHEREx-D1','SPHEREx-D2','SPHEREx-D3','SPHEREx-D4','SPHEREx-D5','SPHEREx-D6')
ORDER BY p.time_bounds_lower
"""
    results = None
    for attempt in range(3):
        try:
            results = Irsa.query_tap(query).to_table()
            break
        except Exception:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
            else:
                raise
    visits: List[Dict[str, Any]] = []
    for idx, row in enumerate(results):
        mjd = float(row["time_bounds_lower"])
        bandpass = str(row["energy_bandpassname"])
        det = bandpass.replace("SPHEREx-", "")
        t_obj = Time(mjd, format="mjd")
        visits.append(
            {
                "visit_index": idx,
                "uri": str(row["uri"]),
                "artifact_uri": str(row["artifact_uri"]),
                "mjd": mjd,
                "iso_date": t_obj.isot[:10],
                "jyear": float(t_obj.jyear),
                "bandpass": bandpass,
                "detector": det,
            }
        )
    return visits


def partition_visits_into_epochs(
    visits: List[Dict[str, Any]],
    gap_threshold_days: float = 45.0,
    fallback_window_days: float = 120.0,
) -> List[Dict[str, Any]]:
    """
    Partition visits into distinct survey epochs.
    Clusters sorted MJD timestamps by gaps > 45 days, and partitions any continuous
    cluster spanning > 150 days (such as near the North Ecliptic Pole) into 120-day windows.
    """
    if not visits:
        return []

    sorted_visits = sorted(visits, key=lambda v: v["mjd"])
    clusters: List[List[Dict[str, Any]]] = [[sorted_visits[0]]]
    for v in sorted_visits[1:]:
        if (v["mjd"] - clusters[-1][-1]["mjd"]) > gap_threshold_days:
            clusters.append([v])
        else:
            clusters[-1].append(v)

    refined_clusters: List[List[Dict[str, Any]]] = []
    for cluster in clusters:
        c_min = cluster[0]["mjd"]
        c_max = cluster[-1]["mjd"]
        if (c_max - c_min) > 150.0:
            n_windows = max(2, int(np.ceil((c_max - c_min) / fallback_window_days)))
            edges = np.linspace(c_min, c_max + 1e-5, n_windows + 1)
            for w_idx in range(n_windows):
                w_visits = [
                    v for v in cluster if edges[w_idx] <= v["mjd"] < edges[w_idx + 1]
                ]
                if w_visits:
                    refined_clusters.append(w_visits)
        else:
            refined_clusters.append(cluster)

    epochs: List[Dict[str, Any]] = []
    for ep_idx, c_visits in enumerate(refined_clusters):
        ep_mjds = np.array([v["mjd"] for v in c_visits], dtype=float)
        mean_mjd = float(np.mean(ep_mjds))
        min_mjd = float(np.min(ep_mjds))
        max_mjd = float(np.max(ep_mjds))
        t_mean = Time(mean_mjd, format="mjd")
        t_min = Time(min_mjd, format="mjd")
        t_max = Time(max_mjd, format="mjd")
        for v in c_visits:
            v["epoch_index"] = ep_idx
        epochs.append(
            {
                "epoch_index": ep_idx,
                "epoch_id": f"epoch_{ep_idx}",
                "mean_mjd": mean_mjd,
                "min_mjd": min_mjd,
                "max_mjd": max_mjd,
                "mean_iso": t_mean.isot[:10],
                "min_iso": t_min.isot[:10],
                "max_iso": t_max.isot[:10],
                "mean_jyear": float(t_mean.jyear),
                "total_visits": len(c_visits),
                "visits": c_visits,
            }
        )
    return epochs


def sample_visits_for_coadd(
    epochs: List[Dict[str, Any]],
    max_visits_per_epoch_per_detector: int = 4,
) -> List[Dict[str, Any]]:
    """Select up to max_visits_per_epoch_per_detector evenly spaced visits per epoch and detector."""
    selected: List[Dict[str, Any]] = []
    for ep in epochs:
        ep_visits = ep["visits"]
        for det in DETECTORS:
            det_visits = [v for v in ep_visits if v["detector"] == det]
            if not det_visits:
                continue
            n = len(det_visits)
            if n <= max_visits_per_epoch_per_detector:
                chosen = det_visits
            else:
                indices = np.linspace(0, n - 1, max_visits_per_epoch_per_detector, dtype=int)
                seen = set()
                chosen = []
                for i in indices:
                    if int(i) not in seen:
                        seen.add(int(i))
                        chosen.append(det_visits[int(i)])
            for v in chosen:
                v["selected_for_coadd"] = True
                selected.append(v)
    return selected


def resolve_cutout_local_path(visit: Dict[str, Any], raw_dir: Path) -> Path:
    """
    Resolve local FITS path for a visit cutout.
    Uses a stable hash of the artifact URI for new downloads, with fallback to
    cutout_{visit_index:04d}.fits if that file already exists in the cache.
    """
    existing = visit.get("local_path")
    if existing:
        ep = Path(existing)
        if not ep.is_absolute():
            ep = BASE_DIR / ep
        if ep.exists() and ep.stat().st_size > 2880:
            return ep
        by_name = raw_dir / ep.name
        if by_name.exists() and by_name.stat().st_size > 2880:
            return by_name

    idx = int(visit["visit_index"])
    legacy_path = raw_dir / f"cutout_{idx:04d}.fits"
    if legacy_path.exists() and legacy_path.stat().st_size > 2880:
        return legacy_path

    artifact_key = str(visit.get("artifact_uri") or visit.get("uri") or idx)
    uri_hash = hashlib.md5(artifact_key.encode("utf-8")).hexdigest()[:10]
    return raw_dir / f"cutout_{idx:04d}_{uri_hash}.fits"


def download_and_inspect_cutout(
    visit: Dict[str, Any],
    raw_dir: Path,
    target_coord: SkyCoord,
    retries: int = 3,
) -> Dict[str, Any]:
    """
    Thread-safe cutout downloader and FITS header/WCS-WAVE inspector.
    Downloads to a unique temporary file, verifies FITS magic bytes, and opens locally.
    """
    local_path = resolve_cutout_local_path(visit, raw_dir)
    visit_out = dict(visit)
    visit_out["local_path"] = str(local_path)

    need_download = True
    if local_path.exists() and local_path.stat().st_size > 2880:
        need_download = False

    if need_download:
        tmp_path = local_path.with_name(f"{local_path.name}.{uuid.uuid4().hex[:8]}.part")
        for attempt in range(retries):
            try:
                resp = requests.get(visit["uri"], timeout=90)
                resp.raise_for_status()
                if len(resp.content) < 2880 or not resp.content.startswith(b"SIMPLE"):
                    raise ValueError("Cutout response is not a valid FITS file.")
                with open(tmp_path, "wb") as f:
                    f.write(resp.content)
                tmp_path.replace(local_path)
                break
            except Exception as exc:
                tmp_path.unlink(missing_ok=True)
                if attempt == retries - 1:
                    visit_out["status"] = "failed"
                    visit_out["error"] = str(exc)
                    return visit_out
                time.sleep(2 * (attempt + 1))

    try:
        with fits.open(local_path, memmap=False) as hdulist:
            img_hdr = hdulist["IMAGE"].header
            spatial_wcs = WCS(img_hdr)
            x, y = spatial_wcs.world_to_pixel(target_coord)

            spectral_wcs = WCS(header=img_hdr, fobj=hdulist, key="W")
            spectral_wcs.sip = None
            wl, bw = spectral_wcs.pixel_to_world(x, y)

            visit_out["wavelength_um"] = float(wl.to(u.micrometer).value)
            visit_out["bandwidth_um"] = float(bw.to(u.micrometer).value)
            visit_out["target_x"] = float(x)
            visit_out["target_y"] = float(y)
            visit_out["version"] = str(hdulist[0].header.get("VERSION", ""))
            visit_out["obsid"] = str(img_hdr.get("OBSID", ""))
            visit_out["psf_fwhm"] = float(img_hdr.get("PSF_FWHM", 0.0) or 0.0)
            visit_out["status"] = "ok"
    except Exception as exc:
        local_path.unlink(missing_ok=True)
        visit_out["status"] = "failed"
        visit_out["error"] = str(exc)

    return visit_out


def build_common_north_up_wcs(
    ra_deg: float, dec_deg: float, fov_deg: float, pixscale_arcsec: float = 6.2
) -> Tuple[WCS, Tuple[int, int]]:
    """
    Construct a unified North-Up tangent-plane (RA---TAN, DEC--TAN) WCS grid
    covering fov_deg at pixscale_arcsec (6.2 arcsec/pixel native SPHEREx scale).
    East is to the left (CDELT1 < 0), North is up (CDELT2 > 0).
    """
    pixscale_deg = pixscale_arcsec / 3600.0
    npix = int(np.ceil(fov_deg / pixscale_deg))
    if npix % 2 == 0:
        npix += 1
    npix = max(npix, 25)

    w = WCS(naxis=2)
    w.wcs.crpix = [(npix + 1) / 2.0, (npix + 1) / 2.0]
    w.wcs.cdelt = np.array([-pixscale_deg, pixscale_deg])
    w.wcs.crval = [ra_deg, dec_deg]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    return w, (npix, npix)


def reproject_and_clean_visit(
    local_path: str,
    target_wcs: WCS,
    shape_out: Tuple[int, int],
) -> Optional[Dict[str, np.ndarray]]:
    """
    Open a local SPHEREx cutout MEF, subtract ZODI from IMAGE (clean = IMAGE - ZODI),
    parse FLAGS dynamically, and reproject both masked and unmasked clean images and
    flag masks onto the common North-Up WCS grid.
    """
    try:
        with fits.open(local_path, memmap=False) as hdulist:
            img_hdu = hdulist["IMAGE"]
            zodi_hdu = hdulist["ZODI"]
            flags_hdu = hdulist["FLAGS"]

            img_data = np.array(img_hdu.data, dtype=np.float64)
            zodi_data = np.array(zodi_hdu.data, dtype=np.float64)
            flags_data = np.array(flags_hdu.data, dtype=np.int64)
            hdr = img_hdu.header.copy()
            flag_bits = parse_flag_bits_from_header(flags_hdu.header)

            clean_unmasked = img_data - zodi_data

            good_bg = (flags_data == 0) & np.isfinite(clean_unmasked)
            if np.count_nonzero(good_bg) > 25:
                bg_pedestal = float(np.nanmedian(clean_unmasked[good_bg]))
            else:
                bg_pedestal = float(np.nanmedian(clean_unmasked))
            if np.isfinite(bg_pedestal):
                clean_unmasked = clean_unmasked - bg_pedestal

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
            sat_mask_bits = (
                flag_bits["OVERFLOW"]
                | flag_bits["NONLINEAR"]
                | flag_bits["BLOOM"]
            )
            contam_mask_bits = (
                flag_bits["CROSSTALK"]
                | flag_bits["GHOST"]
                | flag_bits["GHOST_FPA"]
                | flag_bits["GHOST_EXT"]
                | flag_bits["HALO"]
                | flag_bits["DICHROIC"]
            )

            overflow_px = (flags_data & flag_bits["OVERFLOW"]) != 0
            bad_px = ((flags_data & bad_mask_bits) != 0) & ~overflow_px
            clean_masked = clean_unmasked.copy()
            clean_masked[bad_px] = np.nan

            nan_core = ~np.isfinite(clean_unmasked) & (
                (flags_data & (sat_mask_bits | flag_bits["SUR_ERROR"])) != 0
            )
            if np.any(nan_core):
                finite_replaced = np.where(np.isfinite(clean_unmasked), clean_unmasked, -1e9)
                local_peak = maximum_filter(finite_replaced, size=5)
                clean_unmasked = np.where(nan_core & (local_peak > -1e8), local_peak, clean_unmasked)

            # Fill masked bad pixels using a 3x3 median_filter of the clean image before bilinear reprojection
            valid_mask_float = np.isfinite(clean_masked).astype(np.float64)
            clean_for_filter = np.where(np.isfinite(clean_masked), clean_masked, 0.0)
            local_med_3x3 = median_filter(clean_for_filter, size=3)
            clean_masked_filled = np.where(np.isfinite(clean_masked), clean_masked, local_med_3x3)

            sat_px = (((flags_data & sat_mask_bits) != 0) | nan_core).astype(np.float64)
            bad_px_float = bad_px.astype(np.float64)
            contam_px = ((flags_data & contam_mask_bits) != 0).astype(np.float64)

            in_wcs = WCS(hdr)

            reproj_masked, footprint = reproject_interp(
                (clean_masked_filled, in_wcs), target_wcs, shape_out=shape_out
            )
            reproj_valid_weight, _ = reproject_interp(
                (valid_mask_float, in_wcs), target_wcs, shape_out=shape_out
            )
            reproj_unmasked, _ = reproject_interp(
                (clean_unmasked, in_wcs), target_wcs, shape_out=shape_out
            )
            reproj_sat, _ = reproject_interp(
                (sat_px, in_wcs), target_wcs, shape_out=shape_out, order="nearest-neighbor"
            )
            reproj_bad, _ = reproject_interp(
                (bad_px_float, in_wcs), target_wcs, shape_out=shape_out, order="nearest-neighbor"
            )
            reproj_contam, _ = reproject_interp(
                (contam_px, in_wcs), target_wcs, shape_out=shape_out, order="nearest-neighbor"
            )

            valid_fp = footprint > 0
            reproj_masked[~valid_fp | (reproj_valid_weight < 0.5)] = np.nan
            reproj_unmasked[~valid_fp] = np.nan

            return {
                "masked": reproj_masked,
                "unmasked": reproj_unmasked,
                "sat": np.nan_to_num(reproj_sat, nan=0.0) > 0.5,
                "bad": np.nan_to_num(reproj_bad, nan=0.0) > 0.5,
                "contam": np.nan_to_num(reproj_contam, nan=0.0) > 0.5,
            }
    except Exception:
        return None


def compute_epoch_coadd_safe_flags(
    reprojected_visits: List[Dict[str, np.ndarray]]
) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    """
    Combine reprojected visits within an epoch:
    - Takes the nanmedian of flag-masked IMAGE - ZODI arrays.
    - Fills any pixel that is NaN across all visits after flag masking with the
      unmasked median of IMAGE - ZODI to preserve continuous PSF profiles.
    """
    stack_masked = np.array([rv["masked"] for rv in reprojected_visits], dtype=np.float64)
    stack_unmasked = np.array([rv["unmasked"] for rv in reprojected_visits], dtype=np.float64)

    with np.errstate(all="ignore"):
        coadd_masked = np.nanmedian(stack_masked, axis=0)
        coadd_unmasked = np.nanmedian(stack_unmasked, axis=0)

    hole_mask = ~np.isfinite(coadd_masked) & np.isfinite(coadd_unmasked)
    coadd_final = np.where(hole_mask, coadd_unmasked, coadd_masked)

    sat_any = np.any([rv["sat"] for rv in reprojected_visits], axis=0) | hole_mask
    bad_any = np.any([rv["bad"] for rv in reprojected_visits], axis=0)
    contam_any = np.any([rv["contam"] for rv in reprojected_visits], axis=0)

    return coadd_final, {
        "saturated": sat_any,
        "bad": bad_any,
        "contaminated": contam_any,
    }


def measure_single_epoch_centroid(
    arr: np.ndarray,
    sat_mask: Optional[np.ndarray],
    seed_x: float,
    seed_y: float,
    search_radius_px: float = 3.8,
) -> Tuple[float, float]:
    """
    Measure the real source centroid directly from a 2D SPHEREx epoch co-add array
    around (seed_x, seed_y) using photutils.centroids.
    """
    finite = arr[np.isfinite(arr)]
    if len(finite) == 0:
        return float(seed_x), float(seed_y)

    med = float(np.median(finite))
    mad = float(np.median(np.abs(finite - med)))
    mad_std = max(1.4826 * mad, 1e-4)

    sub = np.clip(np.nan_to_num(arr - (med + 1.0 * mad_std), nan=0.0), 0.0, None)
    ny, nx = arr.shape
    yy, xx = np.ogrid[:ny, :nx]
    r_mask = ((xx - seed_x) ** 2 + (yy - seed_y) ** 2) <= (search_radius_px ** 2)
    if float(np.nanmax(np.where(r_mask, sub, 0.0))) <= 0.0:
        sub = np.clip(np.nan_to_num(arr - med, nan=0.0), 0.0, None)

    iy0, ix0 = int(round(seed_y)), int(round(seed_x))
    core_sat = (
        bool(np.any(sat_mask[max(0, iy0 - 2) : min(ny, iy0 + 3), max(0, ix0 - 2) : min(nx, ix0 + 3)]))
        if sat_mask is not None
        else False
    )

    if core_sat:
        peak_x, peak_y = float(seed_x), float(seed_y)
        box_size = 7
        func_order = (centroid_com, centroid_quadratic, centroid_2dg)
    else:
        local_sub = np.where(r_mask, sub, -1.0)
        py, px = np.unravel_index(int(np.argmax(local_sub)), arr.shape)
        peak_x, peak_y = float(px), float(py)
        box_size = 5
        func_order = (centroid_2dg, centroid_quadratic, centroid_com)

    for cfunc in func_order:
        try:
            cx_arr, cy_arr = centroid_sources(
                sub, [peak_x], [peak_y], box_size=box_size, centroid_func=cfunc
            )
            cx, cy = float(cx_arr[0]), float(cy_arr[0])
            if np.isfinite(cx) and np.isfinite(cy) and np.hypot(cx - peak_x, cy - peak_y) <= 2.2:
                return cx, cy
        except Exception:
            continue

    return peak_x, peak_y


def measure_epoch_source_centroids(
    resolved: Dict[str, Any],
    common_wcs: WCS,
    epochs_summary: List[Dict[str, Any]],
    detector_coadds: Dict[str, Dict[int, np.ndarray]],
    detector_flags: Dict[str, Dict[int, Dict[str, np.ndarray]]],
) -> Dict[str, Dict[str, Any]]:
    """
    Build target_positions by measuring the real source centroid directly from the
    SPHEREx epoch co-add pixels in each epoch (rather than placing epoch markers at
    formula-predicted proper-motion coordinates).
    """
    target_positions: Dict[str, Dict[str, Any]] = {}
    ref_x, ref_y = common_wcs.world_to_pixel(
        SkyCoord(ra=resolved["ra_ref"] * u.deg, dec=resolved["dec_ref"] * u.deg)
    )
    target_positions["reference"] = {
        "epoch_jyear": resolved["ref_epoch_jyear"],
        "ra": round(float(resolved["ra_ref"]), 6),
        "dec": round(float(resolved["dec_ref"]), 6),
        "x": round(float(ref_x), 4),
        "y": round(float(ref_y), 4),
        "shift_arcsec": 0.0,
        "shift_arcsec_from_epoch_0": 0.0,
        "measured_from_pixels": False,
    }

    cx0 = float(common_wcs.wcs.crpix[0] - 1.0)
    cy0 = float(common_wcs.wcs.crpix[1] - 1.0)
    rec_det = resolved.get("recommended_detector", "D2")

    first_sky: Optional[SkyCoord] = None
    prev_sky: Optional[SkyCoord] = None

    for ep in epochs_summary:
        ep_idx = int(ep["epoch_index"])
        ep_id = str(ep["epoch_id"])

        det_use = rec_det if ep_idx in detector_coadds.get(rec_det, {}) else "ALL"
        arr = detector_coadds.get(det_use, {}).get(ep_idx)
        sat_mask = detector_flags.get(det_use, {}).get(ep_idx, {}).get("saturated")

        if arr is not None:
            mx, my = measure_single_epoch_centroid(arr, sat_mask, cx0, cy0)
        else:
            mx, my = cx0, cy0

        m_sky = common_wcs.pixel_to_world(mx, my)
        if first_sky is None:
            first_sky = m_sky
        shift_from_e0 = float(first_sky.separation(m_sky).arcsec)
        shift_from_prev = float(prev_sky.separation(m_sky).arcsec) if prev_sky is not None else 0.0
        prev_sky = m_sky

        target_positions[ep_id] = {
            "epoch_jyear": ep["mean_jyear"],
            "ra": round(float(m_sky.ra.deg), 6),
            "dec": round(float(m_sky.dec.deg), 6),
            "x": round(float(mx), 4),
            "y": round(float(my), 4),
            "shift_arcsec": round(shift_from_e0, 3),
            "shift_arcsec_from_epoch_0": round(shift_from_e0, 3),
            "step_shift_arcsec": round(shift_from_prev, 3),
            "measured_from_pixels": True,
            "centroid_detector": det_use,
        }

    return target_positions


def compute_sky_stretch_limits(pixels: np.ndarray) -> Tuple[float, float]:
    """
    Compute background-preserving stretch limits:
    vmin = median - 1.5 * mad_std, vmax = 99.5th percentile.
    """
    finite = pixels[np.isfinite(pixels)]
    if len(finite) == 0:
        return -1.0, 10.0
    med = float(np.median(finite))
    mad = float(np.median(np.abs(finite - med)))
    mad_std = max(1.4826 * mad, 1e-4)
    vmin = med - 1.5 * mad_std
    vmax = float(np.percentile(finite, 99.5))
    if vmax <= vmin + 2.0 * mad_std:
        vmax = med + 15.0 * mad_std
    return vmin, vmax


def render_shared_asinh_png(
    data: np.ndarray,
    vmin: float,
    vmax: float,
    out_path: Path,
    cmap_name: str = "inferno",
    is_diff: bool = False,
) -> None:
    """
    Render a 2D science array to PNG (North Up) using a shared AsinhStretch(a=0.05)
    normalization across all epochs of a given detector.
    """
    arr = np.array(data, dtype=np.float64)
    arr_flipped = np.flipud(arr)
    finite_mask = np.isfinite(arr_flipped)

    if is_diff:
        abs_lim = max(abs(vmax), abs(vmin), 1e-3)
        scaled = np.clip(arr_flipped / abs_lim, -1.0, 1.0)
        normed = 0.5 + 0.5 * (np.arcsinh(scaled * 3.5) / np.arcsinh(3.5))
        normed = np.clip(np.nan_to_num(normed, nan=0.5), 0.0, 1.0)
        cmap = matplotlib.colormaps["coolwarm"]
        rgba = (cmap(normed) * 255).astype(np.uint8)
    else:
        norm = ImageNormalize(
            vmin=vmin,
            vmax=vmax,
            interval=MinMaxInterval(),
            stretch=AsinhStretch(a=0.05),
            clip=True,
        )
        filled = np.where(finite_mask, arr_flipped, vmin)
        normed = np.asarray(norm(filled), dtype=np.float64)
        normed = 0.07 + 0.93 * np.clip(np.nan_to_num(normed, nan=0.0), 0.0, 1.0)
        cmap = matplotlib.colormaps[cmap_name]
        rgba = (cmap(normed) * 255).astype(np.uint8)

    rgba[~finite_mask] = [12, 16, 26, 255]
    img = Image.fromarray(rgba, mode="RGBA")
    img.save(out_path, format="PNG")


def render_rgb_composite_png(
    r_data: np.ndarray,
    g_data: np.ndarray,
    b_data: np.ndarray,
    r_lim: Tuple[float, float],
    g_lim: Tuple[float, float],
    b_lim: Tuple[float, float],
    out_path: Path,
    is_diff: bool = False,
) -> None:
    """
    Render a false-color Infrared RGB composite PNG (R=D6 4.4-5.0µm, G=D4 2.4-3.8µm, B=D2 1.1-1.6µm)
    using shared AsinhStretch across epochs.
    """
    def _norm_channel(arr: np.ndarray, vmin: float, vmax: float) -> Tuple[np.ndarray, np.ndarray]:
        flipped = np.flipud(np.array(arr, dtype=np.float64))
        fmask = np.isfinite(flipped)
        if is_diff:
            alim = max(abs(vmax), abs(vmin), 1e-3)
            scaled = np.clip(flipped / alim, -1.0, 1.0)
            n = 0.5 + 0.5 * (np.arcsinh(scaled * 3.0) / np.arcsinh(3.0))
            return np.clip(np.nan_to_num(n, nan=0.5), 0.0, 1.0), fmask
        norm = ImageNormalize(
            vmin=vmin, vmax=vmax, interval=MinMaxInterval(), stretch=AsinhStretch(a=0.05), clip=True
        )
        filled = np.where(fmask, flipped, vmin)
        n = np.asarray(norm(filled), dtype=np.float64)
        return 0.07 + 0.93 * np.clip(np.nan_to_num(n, nan=0.0), 0.0, 1.0), fmask

    r_norm, r_ok = _norm_channel(r_data, r_lim[0], r_lim[1])
    g_norm, g_ok = _norm_channel(g_data, g_lim[0], g_lim[1])
    b_norm, b_ok = _norm_channel(b_data, b_lim[0], b_lim[1])

    ny, nx = r_norm.shape
    rgba = np.zeros((ny, nx, 4), dtype=np.uint8)
    rgba[..., 0] = (r_norm * 255).astype(np.uint8)
    rgba[..., 1] = (g_norm * 255).astype(np.uint8)
    rgba[..., 2] = (b_norm * 255).astype(np.uint8)
    rgba[..., 3] = 255

    any_ok = r_ok | g_ok | b_ok
    rgba[~any_ok] = [10, 12, 18, 255]
    Image.fromarray(rgba, mode="RGBA").save(out_path, format="PNG")


def render_flags_overlay_png(
    flag_masks: Dict[str, np.ndarray],
    out_path: Path,
) -> Dict[str, int]:
    """
    Export a transparent PNG overlay highlighting flagged/contaminated/saturated pixels:
    - Saturated / Overflow / Core-filled: Cyan-Blue (0, 220, 255, 195)
    - Transient / Cosmic Ray / Bad pixel: Red-Magenta (255, 50, 90, 185)
    - Ghost / Crosstalk / Dichroic / Halo: Amber-Yellow (255, 195, 0, 165)
    """
    sat = np.flipud(flag_masks["saturated"])
    bad = np.flipud(flag_masks["bad"])
    contam = np.flipud(flag_masks["contaminated"])

    ny, nx = sat.shape
    rgba = np.zeros((ny, nx, 4), dtype=np.uint8)

    rgba[contam] = [255, 195, 0, 165]
    rgba[bad] = [255, 50, 90, 185]
    rgba[sat] = [0, 220, 255, 195]

    img = Image.fromarray(rgba, mode="RGBA")
    img.save(out_path, format="PNG")

    return {
        "saturated_pixels": int(np.count_nonzero(sat)),
        "bad_pixels": int(np.count_nonzero(bad)),
        "contaminated_pixels": int(np.count_nonzero(contam)),
    }


def save_compressed_float_grid(data: np.ndarray, out_path: Path) -> None:
    """Save float32 2D grid compressed with gzip for client-side dynamic contrast & inspection."""
    arr32 = np.asarray(data, dtype=np.float32)
    with gzip.open(out_path, "wb") as f:
        np.save(f, arr32)


def fetch_and_cache_sky_context_jpg(
    target_key: str,
    ra_deg: float,
    dec_deg: float,
    fov_deg: float,
    survey: str = "allwise",
) -> Path:
    """
    Download and cache an external sky atlas cutout JPEG (allwise, 2mass, or dss2)
    into cache/{target_key}/context_{survey}.jpg. If external fetch fails, serve a
    transient fallback without permanently caching it as context_{survey}.jpg.
    """
    raw_tk = (target_key or "").strip()
    if not raw_tk or ".." in raw_tk or "/" in raw_tk or "\\" in raw_tk:
        raise ValueError("Invalid target_key")

    s_norm = survey.lower().strip()
    if "2mass" in s_norm:
        s_key = "2mass"
    elif "dss" in s_norm:
        s_key = "dss2"
    else:
        s_key = "allwise"

    safe_tk = re.sub(r"[^a-zA-Z0-9_.-]+", "_", raw_tk)
    out_dir = (CACHE_ROOT / safe_tk).resolve()
    if not out_dir.is_relative_to(CACHE_ROOT.resolve()):
        raise ValueError("Invalid target_key path")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"context_{s_key}.jpg"

    if out_path.exists() and out_path.stat().st_size > 2048:
        return out_path

    eff_fov = max(float(fov_deg) * 1.4, 0.08)
    width, height = 640, 220
    pixscale = round((eff_fov * 3600.0) / width, 3)
    size_h = round(eff_fov * (height / width), 4)

    hips_map = {
        "allwise": "CDS/P/allWISE/color",
        "2mass": "CDS/P/2MASS/color",
        "dss2": "CDS/P/DSS2/color",
    }
    hips_id = hips_map[s_key]

    candidate_urls: List[str] = [
        (
            f"https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
            f"?hips={quote(hips_id)}&width={width}&height={height}&fov={eff_fov:.4f}"
            f"&projection=TAN&coordsys=icrs&ra={ra_deg:.6f}&dec={dec_deg:.6f}&format=jpg"
        ),
        (
            f"https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits"
            f"?hips={quote(hips_id)}&width={width}&height={height}&fov={eff_fov:.4f}"
            f"&projection=TAN&coordsys=icrs&ra={ra_deg:.6f}&dec={dec_deg:.6f}&format=jpg"
        ),
    ]

    if s_key == "allwise":
        candidate_urls.append(
            f"https://www.legacysurvey.org/viewer/jpeg-cutout"
            f"?ra={ra_deg:.6f}&dec={dec_deg:.6f}&pixscale={pixscale}&width={width}&height={height}&layer=unwise-neo7"
        )
    elif s_key == "2mass":
        candidate_urls.append(
            f"https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl"
            f"?Position={ra_deg:.6f},{dec_deg:.6f}&Survey=2MASS-K&Pixels={width},{height}"
            f"&Size={eff_fov:.4f},{size_h:.4f}&Return=JPEG"
        )
    else:
        candidate_urls.append(
            f"https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl"
            f"?Position={ra_deg:.6f},{dec_deg:.6f}&Survey=DSS2+Red&Pixels={width},{height}"
            f"&Size={eff_fov:.4f},{size_h:.4f}&Return=JPEG"
        )

    for url in candidate_urls:
        try:
            resp = requests.get(url, timeout=8)
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if resp.status_code == 200 and len(resp.content) > 2048 and (
                "image" in ctype or resp.content[:2] == b"\xff\xd8"
            ):
                tmp_jpg = out_path.with_name(f"{out_path.name}.{uuid.uuid4().hex[:8]}.part")
                with open(tmp_jpg, "wb") as f:
                    f.write(resp.content)
                tmp_jpg.replace(out_path)
                return out_path
        except Exception:
            continue

    # Transient fallback path (not saved as context_{s_key}.jpg so future requests retry external surveys)
    transient_fallback_path = out_dir / f".fallback_{s_key}.jpg"
    fallback_png = out_dir / "images" / "RGB_epoch_0.png"
    if not fallback_png.exists():
        fallback_png = out_dir / "images" / "ALL_epoch_0.png"
    if fallback_png.exists():
        img = Image.open(fallback_png).convert("RGB")
        canvas = Image.new("RGB", (width, height), (8, 12, 22))
        thumb = img.resize((height, height), Image.Resampling.NEAREST)
        canvas.paste(thumb, ((width - height) // 2, 0))
        canvas.save(transient_fallback_path, format="JPEG", quality=90)
        return transient_fallback_path

    canvas = Image.new("RGB", (width, height), (8, 12, 22))
    canvas.save(transient_fallback_path, format="JPEG", quality=85)
    return transient_fallback_path


def build_external_crosscheck_urls(
    ra_deg: float,
    dec_deg: float,
    fov_deg: float,
    pmra_mas_yr: float = 0.0,
    pmdec_mas_yr: float = 0.0,
) -> Dict[str, str]:
    """Build external cross-check URLs for WiseView, Gaia DR3 (VizieR), IRSA, and CADC."""
    fov_arcsec = max(int(round(fov_deg * 3600.0)), 60)
    fov_arcmin = max(round(fov_deg * 60.0, 2), 1.0)
    wiseview_url = (
        f"http://byw.tools/wiseview#ra={ra_deg:.6f}&dec={dec_deg:.6f}"
        f"&size={fov_arcsec}&band=2&speed=500&minbright=-50.0000&maxbright=500.0000"
        f"&window=0.5&diff_window=1&linear=1&color=&zoom=9&border=0&gaia=1&invert=1"
        f"&pmra={pmra_mas_yr:.1f}&pmdec={pmdec_mas_yr:.1f}"
    )
    gaia_dr3_url = (
        f"https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-source=I/355/gaiadr3"
        f"&-c={ra_deg:.6f}{dec_deg:+.6f}&-c.rm={fov_arcmin}"
    )
    cadc_url = (
        f"https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/"
        f"?Plane.position.bounds={ra_deg:.6f}%20{dec_deg:.6f}%20{fov_deg/2.0:.4f}"
    )
    irsa_finder_url = (
        f"https://irsa.ipac.caltech.edu/applications/spherex/"
        f"#id=Hydra_spherex_spherex_1&RequestClass=ServerRequest&DoSearch=true"
        f"&UserTargetWorldPt={ra_deg:.6f};{dec_deg:.6f};EQ_J2000"
    )
    return {
        "wiseview": wiseview_url,
        "gaia_dr3": gaia_dr3_url,
        "cadc": cadc_url,
        "irsa_spherex": irsa_finder_url,
    }


def fetch_gaia_dr3_overlay_sources(
    ra_deg: float,
    dec_deg: float,
    fov_deg: float,
    target_wcs: WCS,
    epochs_meta: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Query Gaia DR3 via NASA IRSA TAP (gaia_dr3_source) for known stars in the FOV,
    including proper motions, and compute their pixel positions at each SPHEREx epoch.
    """
    radius_deg = (fov_deg / 2.0) * 1.35
    adql = f"""
SELECT TOP 80
    source_id, ra, dec, pmra, pmdec, phot_g_mean_mag, bp_rp
FROM gaia_dr3_source
WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_deg}, {dec_deg}, {radius_deg}))
ORDER BY phot_g_mean_mag ASC
"""
    sources: List[Dict[str, Any]] = []
    try:
        tbl = Irsa.query_tap(adql).to_table()
        for row in tbl:
            try:
                s_ra = float(row["ra"])
                s_dec = float(row["dec"])
                gmag = float(row["phot_g_mean_mag"]) if not np.ma.is_masked(row["phot_g_mean_mag"]) else 20.0
                pmra = float(row["pmra"]) if not np.ma.is_masked(row["pmra"]) else 0.0
                pmdec = float(row["pmdec"]) if not np.ma.is_masked(row["pmdec"]) else 0.0
                bp_rp = float(row["bp_rp"]) if ("bp_rp" in row.colnames and not np.ma.is_masked(row["bp_rp"])) else None
                source_id = str(row["source_id"])

                epoch_positions = {}
                for ep in epochs_meta:
                    ep_ra, ep_dec = propagate_coords(
                        s_ra, s_dec, pmra, pmdec, 2016.0, ep["mean_jyear"]
                    )
                    px, py = target_wcs.world_to_pixel(SkyCoord(ra=ep_ra * u.deg, dec=ep_dec * u.deg))
                    epoch_positions[ep["epoch_id"]] = {
                        "ra": ep_ra,
                        "dec": ep_dec,
                        "x": float(px),
                        "y": float(py),
                    }

                mean_jyear = float(np.mean([e["mean_jyear"] for e in epochs_meta])) if epochs_meta else 2025.8
                m_ra, m_dec = propagate_coords(s_ra, s_dec, pmra, pmdec, 2016.0, mean_jyear)
                mx, my = target_wcs.world_to_pixel(SkyCoord(ra=m_ra * u.deg, dec=m_dec * u.deg))

                sources.append(
                    {
                        "source_id": source_id,
                        "ra_j2016": s_ra,
                        "dec_j2016": s_dec,
                        "ra": m_ra,
                        "dec": m_dec,
                        "x": float(mx),
                        "y": float(my),
                        "pmra_mas_yr": pmra,
                        "pmdec_mas_yr": pmdec,
                        "gmag": gmag,
                        "bp_rp": bp_rp,
                        "epoch_positions": epoch_positions,
                    }
                )
            except Exception:
                continue
    except Exception:
        pass
    return sources


def run_spherex_pipeline(
    target_or_coords: str,
    ra: Optional[float] = None,
    dec: Optional[float] = None,
    fov_deg: Optional[float] = None,
    max_visits_per_epoch_per_detector: int = 4,
    force_refresh: bool = False,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """
    End-to-end NASA SPHEREx multi-detector, multi-epoch cutout, co-add, and centroiding pipeline.
    """
    t_start = time.time()

    def report(step: str, downloaded: int = 0, total: int = 0) -> None:
        if progress_callback is not None:
            progress_callback(
                {
                    "current_step": step,
                    "downloaded": downloaded,
                    "total_cutouts": total,
                    "status": "running",
                    "elapsed_sec": round(time.time() - t_start, 1),
                }
            )

    report("Resolving target coordinates & proper motion...")
    resolved = resolve_target_input(target_or_coords, ra=ra, dec=dec, fov_deg=fov_deg)
    target_key = make_target_cache_key(resolved, max_visits_per_epoch_per_detector)
    target_dir = CACHE_ROOT / target_key
    manifest_path = target_dir / "manifest.json"

    if manifest_path.exists() and not force_refresh:
        with open(manifest_path, "r", encoding="utf-8") as f:
            cached_manifest = json.load(f)
        report(
            "Loaded from disk cache",
            cached_manifest.get("sampled_cutouts_count", 0),
            cached_manifest.get("sampled_cutouts_count", 0),
        )
        return cached_manifest

    raw_dir = target_dir / "raw_cutouts"
    images_dir = target_dir / "images"
    grids_dir = target_dir / "grids"
    raw_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)
    grids_dir.mkdir(parents=True, exist_ok=True)

    prior_gaia_sources: List[Dict[str, Any]] = []
    if manifest_path.exists():
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                prior_gaia_sources = json.load(f).get("gaia_dr3_sources", [])
        except Exception:
            prior_gaia_sources = []

    all_visits_path = target_dir / "all_visits.json"
    report(f"Querying NASA IRSA TAP archive for {resolved['name']} across D1-D6...")
    try:
        visits = query_spherex_tap_all_detectors(
            resolved["ra_obs"], resolved["dec_obs"], resolved["fov_deg"]
        )
    except Exception:
        if all_visits_path.exists():
            with open(all_visits_path, "r", encoding="utf-8") as f:
                cached_v = json.load(f).get("visits", [])
            visits = []
            for v in cached_v:
                v_clean = dict(v)
                v_clean.pop("epoch_index", None)
                v_clean.pop("epoch_id", None)
                v_clean.pop("selected_for_coadd", None)
                visits.append(v_clean)
        else:
            raise
    if not visits:
        raise RuntimeError(
            f"No SPHEREx Level 2 images found overlapping RA={resolved['ra_obs']:.5f}, Dec={resolved['dec_obs']:.5f}."
        )

    mean_mjd_all = float(np.mean([v["mjd"] for v in visits]))
    mean_obs_jyear = float(Time(mean_mjd_all, format="mjd").jyear)
    resolved["obs_epoch_jyear"] = round(mean_obs_jyear, 3)

    if resolved["is_named_target"] and (
        abs(resolved["pmra_mas_yr"]) > 1.0 or abs(resolved["pmdec_mas_yr"]) > 1.0
    ):
        ra_exact, dec_exact = propagate_coords(
            resolved["ra_ref"],
            resolved["dec_ref"],
            resolved["pmra_mas_yr"],
            resolved["pmdec_mas_yr"],
            resolved["ref_epoch_jyear"],
            mean_obs_jyear,
            resolved.get("distance_pc"),
        )
        resolved["ra_obs"] = ra_exact
        resolved["dec_obs"] = dec_exact
        fov_val = resolved["fov_deg"]
        for v in visits:
            v["uri"] = (
                f"https://irsa.ipac.caltech.edu/{v['artifact_uri']}"
                f"?center={ra_exact},{dec_exact}d&size={fov_val}"
            )

    epochs = partition_visits_into_epochs(visits)
    sampled_visits = sample_visits_for_coadd(
        epochs, max_visits_per_epoch_per_detector=max_visits_per_epoch_per_detector
    )
    total_to_download = len(sampled_visits)

    all_visits_path = target_dir / "all_visits.json"
    _write_json_atomic(
        all_visits_path,
        {
            "target": resolved,
            "total_overlapping_visits": len(visits),
            "visits": visits,
        },
    )

    report(f"Downloading {total_to_download} SPHEREx MEF cutouts across D1-D6...", 0, total_to_download)
    target_coord = SkyCoord(ra=resolved["ra_obs"] * u.deg, dec=resolved["dec_obs"] * u.deg, frame="icrs")

    downloaded_visits: List[Dict[str, Any]] = []
    completed_count = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_map = {
            executor.submit(download_and_inspect_cutout, v, raw_dir, target_coord): v
            for v in sampled_visits
        }
        for future in concurrent.futures.as_completed(future_map):
            res = future.result()
            downloaded_visits.append(res)
            completed_count += 1
            report(
                f"Downloaded & inspected cutout {completed_count}/{total_to_download} ({res.get('detector')})",
                completed_count,
                total_to_download,
            )

    dl_by_idx = {v["visit_index"]: v for v in downloaded_visits if v.get("status") == "ok"}
    for v in visits:
        if v["visit_index"] in dl_by_idx:
            v.update(dl_by_idx[v["visit_index"]])

    _write_json_atomic(
        all_visits_path,
        {
            "target": resolved,
            "total_overlapping_visits": len(visits),
            "visits": visits,
        },
    )

    common_wcs, grid_shape = build_common_north_up_wcs(
        resolved["ra_obs"], resolved["dec_obs"], resolved["fov_deg"], pixscale_arcsec=6.2
    )

    report("Reprojecting cutouts to North-Up tangent WCS & subtracting ZODI...", total_to_download, total_to_download)
    reproj_by_visit: Dict[int, Dict[str, np.ndarray]] = {}
    valid_dl = [v for v in downloaded_visits if v.get("status") == "ok"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        f_map = {
            executor.submit(reproject_and_clean_visit, v["local_path"], common_wcs, grid_shape): v["visit_index"]
            for v in valid_dl
        }
        for future in concurrent.futures.as_completed(f_map):
            v_idx = f_map[future]
            r_data = future.result()
            if r_data is not None:
                reproj_by_visit[v_idx] = r_data

    if not reproj_by_visit:
        raise RuntimeError("No usable SPHEREx cutouts retrieved")

    report("Co-adding epochs across D1-D6 and rendering shared AsinhStretch PNGs...", total_to_download, total_to_download)

    detector_coadds: Dict[str, Dict[int, np.ndarray]] = {d: {} for d in DETECTORS}
    detector_flags: Dict[str, Dict[int, Dict[str, np.ndarray]]] = {d: {} for d in DETECTORS}
    detector_visit_counts: Dict[str, Dict[int, int]] = {d: {} for d in DETECTORS}
    detector_wavelengths: Dict[str, List[float]] = {d: [] for d in DETECTORS}

    for v in valid_dl:
        if v.get("wavelength_um") and np.isfinite(v["wavelength_um"]):
            detector_wavelengths[v["detector"]].append(float(v["wavelength_um"]))

    for det in DETECTORS:
        for ep in epochs:
            ep_idx = ep["epoch_index"]
            ep_det_visits = [
                v
                for v in ep["visits"]
                if v["detector"] == det and v["visit_index"] in reproj_by_visit
            ]
            if not ep_det_visits:
                continue
            reproj_list = [reproj_by_visit[v["visit_index"]] for v in ep_det_visits]
            coadd_arr, flag_dict = compute_epoch_coadd_safe_flags(reproj_list)
            detector_coadds[det][ep_idx] = coadd_arr
            detector_flags[det][ep_idx] = flag_dict
            detector_visit_counts[det][ep_idx] = len(ep_det_visits)

    detector_coadds["ALL"] = {}
    detector_flags["ALL"] = {}
    detector_visit_counts["ALL"] = {}
    for ep in epochs:
        ep_idx = ep["epoch_index"]
        avail_det_arrays = [
            detector_coadds[d][ep_idx]
            for d in DETECTORS
            if ep_idx in detector_coadds[d]
        ]
        if not avail_det_arrays:
            continue
        with np.errstate(all="ignore"):
            all_coadd = np.nanmean(np.array(avail_det_arrays, dtype=np.float64), axis=0)
        detector_coadds["ALL"][ep_idx] = all_coadd
        detector_visit_counts["ALL"][ep_idx] = sum(
            detector_visit_counts[d].get(ep_idx, 0) for d in DETECTORS
        )
        sat_all = np.any(
            [detector_flags[d][ep_idx]["saturated"] for d in DETECTORS if ep_idx in detector_flags[d]],
            axis=0,
        )
        bad_all = np.any(
            [detector_flags[d][ep_idx]["bad"] for d in DETECTORS if ep_idx in detector_flags[d]],
            axis=0,
        )
        contam_all = np.any(
            [detector_flags[d][ep_idx]["contaminated"] for d in DETECTORS if ep_idx in detector_flags[d]],
            axis=0,
        )
        detector_flags["ALL"][ep_idx] = {
            "saturated": sat_all,
            "bad": bad_all,
            "contaminated": contam_all,
        }

    detectors_manifest: Dict[str, Any] = {}
    all_band_keys = DETECTORS + ["ALL"]

    for band_key in all_band_keys:
        ep_map = detector_coadds.get(band_key, {})
        if not ep_map:
            continue
        sorted_ep_indices = sorted(ep_map.keys())
        finite_chunks = [
            ep_map[idx][np.isfinite(ep_map[idx])].ravel()
            for idx in sorted_ep_indices
            if np.any(np.isfinite(ep_map[idx]))
        ]
        if not finite_chunks:
            continue
        all_pixels = np.concatenate(finite_chunks)
        vmin, vmax = compute_sky_stretch_limits(all_pixels)

        band_epochs_out: List[Dict[str, Any]] = []
        combined_sat = np.zeros(grid_shape, dtype=bool)
        combined_bad = np.zeros(grid_shape, dtype=bool)
        combined_contam = np.zeros(grid_shape, dtype=bool)

        for ep_idx in sorted_ep_indices:
            ep_info = epochs[ep_idx]
            arr = ep_map[ep_idx]
            fmask = detector_flags[band_key][ep_idx]
            combined_sat |= fmask["saturated"]
            combined_bad |= fmask["bad"]
            combined_contam |= fmask["contaminated"]

            png_name = f"{band_key}_epoch_{ep_idx}.png"
            flag_png_name = f"{band_key}_epoch_{ep_idx}_flags.png"
            grid_name = f"{band_key}_epoch_{ep_idx}.npy.gz"

            render_shared_asinh_png(arr, float(vmin), float(vmax), images_dir / png_name)
            flag_counts = render_flags_overlay_png(fmask, images_dir / flag_png_name)
            save_compressed_float_grid(arr, grids_dir / grid_name)

            band_epochs_out.append(
                {
                    "epoch_index": ep_idx,
                    "epoch_id": ep_info["epoch_id"],
                    "mean_mjd": ep_info["mean_mjd"],
                    "mean_iso": ep_info["mean_iso"],
                    "min_iso": ep_info["min_iso"],
                    "max_iso": ep_info["max_iso"],
                    "mean_jyear": round(ep_info["mean_jyear"], 3),
                    "visits_coadded": detector_visit_counts[band_key].get(ep_idx, 0),
                    "total_visits_in_epoch": len(
                        [
                            v
                            for v in ep_info["visits"]
                            if (band_key == "ALL" or v["detector"] == band_key)
                        ]
                    ),
                    "image_url": f"/cache/{target_key}/images/{png_name}",
                    "flags_overlay_url": f"/cache/{target_key}/images/{flag_png_name}",
                    "grid_url": f"/cache/{target_key}/grids/{grid_name}",
                    "flag_stats": flag_counts,
                }
            )

        first_idx = sorted_ep_indices[0]
        last_idx = sorted_ep_indices[-1]
        arr_first = ep_map[first_idx]
        arr_last = ep_map[last_idx]

        diff_arr = arr_last - arr_first
        sum_arr = arr_last + arr_first

        diff_finite = diff_arr[np.isfinite(diff_arr)]
        if len(diff_finite) > 0:
            diff_lim = float(np.nanpercentile(np.abs(diff_finite), 99.5))
            diff_lim = max(diff_lim, 1e-3)
        else:
            diff_lim = 1.0

        sum_finite = sum_arr[np.isfinite(sum_arr)]
        if len(sum_finite) > 0:
            s_vmin, s_vmax = compute_sky_stretch_limits(sum_finite)
        else:
            s_vmin, s_vmax = vmin * 2, vmax * 2

        diff_png = f"{band_key}_diff.png"
        sum_png = f"{band_key}_sum.png"
        flags_union_png = f"{band_key}_flags_overlay.png"
        diff_grid = f"{band_key}_diff.npy.gz"
        sum_grid = f"{band_key}_sum.npy.gz"

        render_shared_asinh_png(diff_arr, -diff_lim, diff_lim, images_dir / diff_png, is_diff=True)
        render_shared_asinh_png(sum_arr, float(s_vmin), float(s_vmax), images_dir / sum_png)
        union_flag_stats = render_flags_overlay_png(
            {"saturated": combined_sat, "bad": combined_bad, "contaminated": combined_contam},
            images_dir / flags_union_png,
        )
        save_compressed_float_grid(diff_arr, grids_dir / diff_grid)
        save_compressed_float_grid(sum_arr, grids_dir / sum_grid)

        if band_key == "ALL":
            render_flags_overlay_png(
                {"saturated": combined_sat, "bad": combined_bad, "contaminated": combined_contam},
                images_dir / "flags_overlay.png",
            )

        wls = detector_wavelengths.get(band_key, [])
        w_info = DETECTOR_WAVELENGTH_RANGES[band_key]
        detectors_manifest[band_key] = {
            "detector": band_key,
            "wavelength_range_um": [w_info["min_um"], w_info["max_um"]],
            "spectral_resolution_R": w_info["R"],
            "label": w_info["label"],
            "measured_central_wavelength_um": round(float(np.mean(wls)), 4)
            if wls
            else round((w_info["min_um"] + w_info["max_um"]) / 2.0, 3),
            "norm_vmin": round(float(vmin), 4),
            "norm_vmax": round(float(vmax), 4),
            "diff_abs_max": round(float(diff_lim), 4),
            "epochs": band_epochs_out,
            "diff_image_url": f"/cache/{target_key}/images/{diff_png}",
            "sum_image_url": f"/cache/{target_key}/images/{sum_png}",
            "flags_overlay_url": f"/cache/{target_key}/images/{flags_union_png}",
            "diff_grid_url": f"/cache/{target_key}/grids/{diff_grid}",
            "sum_grid_url": f"/cache/{target_key}/grids/{sum_grid}",
            "flag_stats": union_flag_stats,
        }

    if "ALL" in detectors_manifest:
        r_lim = (
            detectors_manifest.get("D6", detectors_manifest["ALL"])["norm_vmin"],
            detectors_manifest.get("D6", detectors_manifest["ALL"])["norm_vmax"],
        )
        g_lim = (
            detectors_manifest.get("D4", detectors_manifest["ALL"])["norm_vmin"],
            detectors_manifest.get("D4", detectors_manifest["ALL"])["norm_vmax"],
        )
        b_lim = (
            detectors_manifest.get("D2", detectors_manifest["ALL"])["norm_vmin"],
            detectors_manifest.get("D2", detectors_manifest["ALL"])["norm_vmax"],
        )
        rgb_epochs_out: List[Dict[str, Any]] = []
        all_ep_indices = sorted(detector_coadds["ALL"].keys())
        for ep_idx in all_ep_indices:
            ep_info = epochs[ep_idx]
            fallback_arr = detector_coadds["ALL"][ep_idx]
            r_arr = detector_coadds.get("D6", {}).get(ep_idx, fallback_arr)
            g_arr = detector_coadds.get("D4", {}).get(ep_idx, fallback_arr)
            b_arr = detector_coadds.get("D2", {}).get(ep_idx, fallback_arr)
            rgb_png = f"RGB_epoch_{ep_idx}.png"
            render_rgb_composite_png(r_arr, g_arr, b_arr, r_lim, g_lim, b_lim, images_dir / rgb_png)
            rgb_epochs_out.append(
                {
                    "epoch_index": ep_idx,
                    "epoch_id": ep_info["epoch_id"],
                    "mean_mjd": ep_info["mean_mjd"],
                    "mean_iso": ep_info["mean_iso"],
                    "min_iso": ep_info["min_iso"],
                    "max_iso": ep_info["max_iso"],
                    "mean_jyear": round(ep_info["mean_jyear"], 3),
                    "visits_coadded": detector_visit_counts["ALL"].get(ep_idx, 0),
                    "total_visits_in_epoch": len(ep_info["visits"]),
                    "image_url": f"/cache/{target_key}/images/{rgb_png}",
                    "flags_overlay_url": f"/cache/{target_key}/images/ALL_epoch_{ep_idx}_flags.png",
                    "grid_url": f"/cache/{target_key}/grids/ALL_epoch_{ep_idx}.npy.gz",
                    "flag_stats": detectors_manifest["ALL"]["epochs"][all_ep_indices.index(ep_idx)]["flag_stats"],
                }
            )
        if all_ep_indices:
            f0, f1 = all_ep_indices[0], all_ep_indices[-1]
            r_diff = detector_coadds.get("D6", {}).get(f1, detector_coadds["ALL"][f1]) - detector_coadds.get("D6", {}).get(f0, detector_coadds["ALL"][f0])
            g_diff = detector_coadds.get("D4", {}).get(f1, detector_coadds["ALL"][f1]) - detector_coadds.get("D4", {}).get(f0, detector_coadds["ALL"][f0])
            b_diff = detector_coadds.get("D2", {}).get(f1, detector_coadds["ALL"][f1]) - detector_coadds.get("D2", {}).get(f0, detector_coadds["ALL"][f0])
            rd_lim = detectors_manifest.get("D6", detectors_manifest["ALL"])["diff_abs_max"]
            gd_lim = detectors_manifest.get("D4", detectors_manifest["ALL"])["diff_abs_max"]
            bd_lim = detectors_manifest.get("D2", detectors_manifest["ALL"])["diff_abs_max"]
            render_rgb_composite_png(
                r_diff, g_diff, b_diff, (-rd_lim, rd_lim), (-gd_lim, gd_lim), (-bd_lim, bd_lim), images_dir / "RGB_diff.png", is_diff=True
            )
            r_sum = detector_coadds.get("D6", {}).get(f1, detector_coadds["ALL"][f1]) + detector_coadds.get("D6", {}).get(f0, detector_coadds["ALL"][f0])
            g_sum = detector_coadds.get("D4", {}).get(f1, detector_coadds["ALL"][f1]) + detector_coadds.get("D4", {}).get(f0, detector_coadds["ALL"][f0])
            b_sum = detector_coadds.get("D2", {}).get(f1, detector_coadds["ALL"][f1]) + detector_coadds.get("D2", {}).get(f0, detector_coadds["ALL"][f0])
            render_rgb_composite_png(
                r_sum, g_sum, b_sum, (r_lim[0] * 2, r_lim[1] * 2), (g_lim[0] * 2, g_lim[1] * 2), (b_lim[0] * 2, b_lim[1] * 2), images_dir / "RGB_sum.png"
            )
            detectors_manifest["RGB"] = {
                "detector": "RGB",
                "wavelength_range_um": [1.10, 5.00],
                "spectral_resolution_R": None,
                "label": "False-Color IR RGB (R=D6, G=D4, B=D2)",
                "measured_central_wavelength_um": 3.05,
                "norm_vmin": r_lim[0],
                "norm_vmax": r_lim[1],
                "diff_abs_max": rd_lim,
                "epochs": rgb_epochs_out,
                "diff_image_url": f"/cache/{target_key}/images/RGB_diff.png",
                "sum_image_url": f"/cache/{target_key}/images/RGB_sum.png",
                "flags_overlay_url": f"/cache/{target_key}/images/ALL_flags_overlay.png",
                "diff_grid_url": f"/cache/{target_key}/grids/ALL_diff.npy.gz",
                "sum_grid_url": f"/cache/{target_key}/grids/ALL_sum.npy.gz",
                "flag_stats": detectors_manifest["ALL"]["flag_stats"],
            }

    report("Measuring epoch source centroids & fetching Gaia DR3 catalog...", total_to_download, total_to_download)
    epochs_summary = [
        {
            "epoch_index": ep["epoch_index"],
            "epoch_id": ep["epoch_id"],
            "mean_mjd": ep["mean_mjd"],
            "mean_iso": ep["mean_iso"],
            "min_iso": ep["min_iso"],
            "max_iso": ep["max_iso"],
            "mean_jyear": round(ep["mean_jyear"], 3),
            "total_visits": ep["total_visits"],
        }
        for ep in epochs
    ]
    gaia_sources = fetch_gaia_dr3_overlay_sources(
        resolved["ra_obs"], resolved["dec_obs"], resolved["fov_deg"], common_wcs, epochs_summary
    )
    if not gaia_sources and prior_gaia_sources:
        reprojected_gaia: List[Dict[str, Any]] = []
        for g in prior_gaia_sources:
            g_copy = dict(g)
            c_mean = SkyCoord(ra=float(g["ra"]) * u.deg, dec=float(g["dec"]) * u.deg, frame="icrs")
            px_m, py_m = common_wcs.world_to_pixel(c_mean)
            g_copy["x"] = round(float(px_m), 3)
            g_copy["y"] = round(float(py_m), 3)
            ep_pos = dict(g.get("epoch_positions", {}))
            for ep_id, ep_entry in ep_pos.items():
                c_ep = SkyCoord(ra=float(ep_entry["ra"]) * u.deg, dec=float(ep_entry["dec"]) * u.deg, frame="icrs")
                px_e, py_e = common_wcs.world_to_pixel(c_ep)
                ep_pos[ep_id] = {
                    "ra": float(ep_entry["ra"]),
                    "dec": float(ep_entry["dec"]),
                    "x": round(float(px_e), 3),
                    "y": round(float(py_e), 3),
                }
            g_copy["epoch_positions"] = ep_pos
            reprojected_gaia.append(g_copy)
        gaia_sources = reprojected_gaia

    target_positions = measure_epoch_source_centroids(
        resolved=resolved,
        common_wcs=common_wcs,
        epochs_summary=epochs_summary,
        detector_coadds=detector_coadds,
        detector_flags=detector_flags,
    )

    manifest = {
        "target_key": target_key,
        "target": resolved,
        "target_positions": target_positions,
        "wcs": {
            "crpix": [float(common_wcs.wcs.crpix[0]), float(common_wcs.wcs.crpix[1])],
            "cdelt": [float(common_wcs.wcs.cdelt[0]), float(common_wcs.wcs.cdelt[1])],
            "crval": [float(common_wcs.wcs.crval[0]), float(common_wcs.wcs.crval[1])],
            "ctype": ["RA---TAN", "DEC--TAN"],
            "pixel_scale_arcsec": 6.2,
            "width": int(grid_shape[1]),
            "height": int(grid_shape[0]),
            "fov_deg": resolved["fov_deg"],
            "north_up": True,
            "east_left": True,
        },
        "total_overlapping_visits": len(visits),
        "sampled_cutouts_count": len(valid_dl),
        "epochs_summary": epochs_summary,
        "detectors": detectors_manifest,
        "flags_overlay_url": f"/cache/{target_key}/images/flags_overlay.png",
        "gaia_dr3_sources": gaia_sources,
        "external_links": build_external_crosscheck_urls(
            resolved["ra_obs"],
            resolved["dec_obs"],
            resolved["fov_deg"],
            resolved["pmra_mas_yr"],
            resolved["pmdec_mas_yr"],
        ),
        "generated_at_unix": time.time(),
        "processing_time_sec": round(time.time() - t_start, 2),
    }

    _write_json_atomic(manifest_path, manifest)

    try:
        center_spec = _spectra.extract_spectrum_and_lightcurve(
            target_key=target_key,
            ra_deg=resolved["ra_obs"],
            dec_deg=resolved["dec_obs"],
            r_aperture_px=2.5,
            fetch_additional_per_detector=0,
            force_recompute=True,
        )
        _write_json_atomic(target_dir / "center_spectrum.json", center_spec)
    except Exception:
        pass

    report("Observation pipeline complete", total_to_download, total_to_download)
    return manifest
