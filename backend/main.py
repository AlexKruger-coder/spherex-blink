"""FastAPI Server for SPHEREx Multi-Epoch Blinking & Spectral Discovery Engine."""

from __future__ import annotations

import concurrent.futures
import gzip
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.spectra import extract_spectrum_and_lightcurve
from backend.spherex_core import (
    CACHE_ROOT,
    DETECTOR_WAVELENGTH_RANGES,
    OFFICIAL_TARGETS,
    fetch_and_cache_sky_context_jpg,
    make_target_cache_key,
    propagate_coords,
    resolve_target_input,
    run_spherex_pipeline,
)

app = FastAPI(
    title="SPHEREx Multi-Epoch Sky Blinker & On-the-Fly Spectrophotometry API",
    description="Real NASA/IPAC IRSA TAP & MEF Cutout Engine across all 6 SPHEREx Detectors (D1-D6).",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE_ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/cache", StaticFiles(directory=str(CACHE_ROOT)), name="cache")

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

_JOB_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4)
_JOBS_LOCK = threading.Lock()
_JOBS: Dict[str, Dict[str, Any]] = {}


def _validate_safe_segment(segment: str, label: str = "target_key") -> str:
    s = (segment or "").strip()
    if not s or ".." in s or "/" in s or "\\" in s:
        raise HTTPException(status_code=400, detail=f"Invalid {label}.")
    resolved_dir = (CACHE_ROOT / s).resolve()
    if not resolved_dir.is_relative_to(CACHE_ROOT.resolve()):
        raise HTTPException(status_code=400, detail=f"Invalid {label} path.")
    return s


class ObserveRequest(BaseModel):
    target: Optional[str] = Field(
        default=None,
        description="Official target ID/name, SIMBAD object name, sexagesimal string ('08h55m10.831s -7d14m42.53s'), or 'ra, dec'",
    )
    ra: Optional[float] = Field(default=None, description="Right Ascension in decimal degrees (ICRS)")
    dec: Optional[float] = Field(default=None, description="Declination in decimal degrees (ICRS)")
    fov_deg: Optional[float] = Field(default=None, ge=0.04, le=0.5, description="Field of view in degrees")
    max_visits_per_epoch_per_detector: int = Field(
        default=4, ge=1, le=20, description="Max visits sampled per epoch per detector for co-adding"
    )
    force_refresh: bool = Field(default=False, description="Force re-download and re-computation")


@app.get("/api/health")
def health_check() -> Dict[str, Any]:
    return {"status": "ok", "cache_root": str(CACHE_ROOT)}


@app.get("/api/targets")
def list_official_targets() -> Dict[str, Any]:
    """List the 5 official NASA SPHEREx challenge targets with metadata and cache status."""
    targets_out: List[Dict[str, Any]] = []
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
        resolved_preview = {
            "id": tid,
            "ra_obs": ra_2025,
            "dec_obs": dec_2025,
            "fov_deg": tinfo["default_fov_deg"],
        }
        cache_key = make_target_cache_key(resolved_preview, max_visits_per_epoch_per_detector=4)
        manifest_path = CACHE_ROOT / cache_key / "manifest.json"
        targets_out.append(
            {
                **tinfo,
                "ra_2025_8": round(ra_2025, 6),
                "dec_2025_8": round(dec_2025, 6),
                "target_key": cache_key,
                "is_cached": manifest_path.exists(),
            }
        )
    return {
        "targets": targets_out,
        "detectors_info": DETECTOR_WAVELENGTH_RANGES,
    }


def _run_background_job(job_id: str, req: ObserveRequest) -> None:
    def progress_cb(update: Dict[str, Any]) -> None:
        with _JOBS_LOCK:
            if job_id in _JOBS:
                safe_update = {k: v for k, v in update.items() if k != "status"}
                _JOBS[job_id].update(safe_update)

    try:
        manifest = run_spherex_pipeline(
            target_or_coords=req.target or "",
            ra=req.ra,
            dec=req.dec,
            fov_deg=req.fov_deg,
            max_visits_per_epoch_per_detector=req.max_visits_per_epoch_per_detector,
            force_refresh=req.force_refresh,
            progress_callback=progress_cb,
        )
        with _JOBS_LOCK:
            _JOBS[job_id]["manifest"] = manifest
            _JOBS[job_id]["target_key"] = manifest["target_key"]
            _JOBS[job_id]["current_step"] = "Observation pipeline complete"
            _JOBS[job_id]["status"] = "completed"
    except Exception as exc:
        with _JOBS_LOCK:
            _JOBS[job_id]["status"] = "failed"
            _JOBS[job_id]["current_step"] = f"Error: {exc}"
            _JOBS[job_id]["error"] = str(exc)


@app.post("/api/observe")
def observe_target(req: ObserveRequest) -> Dict[str, Any]:
    """
    If target+FOV is already in disk cache, return manifest.json immediately (status='completed').
    If not cached (or force_refresh=True), launch background job and return job_id.
    """
    if not (req.target and req.target.strip()) and (req.ra is None or req.dec is None):
        raise HTTPException(
            status_code=400,
            detail="Provide either a target name/coordinate string (`target`) or numeric `ra` and `dec`.",
        )

    try:
        resolved = resolve_target_input(req.target or "", ra=req.ra, dec=req.dec, fov_deg=req.fov_deg)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not resolve target/coordinates: {exc}")

    target_key = make_target_cache_key(resolved, req.max_visits_per_epoch_per_detector)
    manifest_path = CACHE_ROOT / target_key / "manifest.json"

    if manifest_path.exists() and not req.force_refresh:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        return {
            "status": "completed",
            "cached": True,
            "target_key": target_key,
            "manifest": manifest,
        }

    with _JOBS_LOCK:
        for existing_id, jinfo in _JOBS.items():
            if jinfo.get("target_key") == target_key and jinfo.get("status") == "running":
                return {
                    "status": "running",
                    "cached": False,
                    "job_id": existing_id,
                    "target_key": target_key,
                    "resolved_target": resolved,
                }

        job_id = str(uuid.uuid4())
        _JOBS[job_id] = {
            "job_id": job_id,
            "target_key": target_key,
            "resolved_target": resolved,
            "status": "running",
            "current_step": "Queued for IRSA TAP query...",
            "total_cutouts": 0,
            "downloaded": 0,
            "created_at": time.time(),
        }

    _JOB_EXECUTOR.submit(_run_background_job, job_id, req)
    return {
        "status": "running",
        "cached": False,
        "job_id": job_id,
        "target_key": target_key,
        "resolved_target": resolved,
    }


@app.get("/api/jobs/{job_id}")
def get_job_status(job_id: str) -> Dict[str, Any]:
    """Return real-time progress (total_cutouts, downloaded, current_step, status, and manifest when completed)."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
        return dict(job)


@app.get("/api/manifest/{target_key}")
def get_cached_manifest(target_key: str) -> Dict[str, Any]:
    safe_key = _validate_safe_segment(target_key, "target_key")
    manifest_path = CACHE_ROOT / safe_key / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail=f"Manifest for '{safe_key}' not found in cache.")
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/grid/{target_key}/{grid_name}")
def get_float_grid(target_key: str, grid_name: str) -> Dict[str, Any]:
    """Return decompressed 2D float32 science grid and robust stretch stats for client-side LUT rendering."""
    safe_key = _validate_safe_segment(target_key, "target_key")
    safe_grid = _validate_safe_segment(grid_name, "grid_name")
    if not safe_grid.endswith(".npy.gz"):
        safe_grid = f"{safe_grid}.npy.gz"
    grid_path = CACHE_ROOT / safe_key / "grids" / safe_grid
    if not grid_path.exists():
        raise HTTPException(status_code=404, detail=f"Grid '{safe_grid}' not found.")

    with gzip.open(grid_path, "rb") as f:
        arr = np.load(f)

    arr_flipped = np.flipud(np.asarray(arr, dtype=np.float64))
    finite = arr_flipped[np.isfinite(arr_flipped)]
    if len(finite) > 0:
        med = float(np.median(finite))
        mad = float(np.median(np.abs(finite - med)))
        mad_std = max(1.4826 * mad, 1e-4)
        vmin = med - 1.5 * mad_std
        vmax = float(np.percentile(finite, 99.5))
        if vmax <= vmin + 2.0 * mad_std:
            vmax = med + 15.0 * mad_std
        abs_max = float(np.percentile(np.abs(finite), 99.5))
    else:
        med, mad_std, vmin, vmax, abs_max = 0.0, 1.0, -1.0, 10.0, 1.0

    rows_out = [
        [round(float(v), 5) if np.isfinite(v) else None for v in row]
        for row in arr_flipped
    ]
    return {
        "width": int(arr_flipped.shape[1]),
        "height": int(arr_flipped.shape[0]),
        "median": round(med, 5),
        "mad_std": round(mad_std, 5),
        "vmin": round(vmin, 5),
        "vmax": round(vmax, 5),
        "abs_max": round(max(abs_max, 1e-3), 5),
        "data": rows_out,
    }


@app.get("/api/spectrum")
def get_spectrum_and_lightcurve(
    target_key: str = Query(..., description="Cached target_key from manifest"),
    ra: float = Query(..., description="Clicked Right Ascension in decimal degrees"),
    dec: float = Query(..., description="Clicked Declination in decimal degrees"),
    aperture_radius_px: float = Query(2.5, ge=1.0, le=8.0, description="Aperture radius in SPHEREx pixels"),
    fetch_more: int = Query(0, ge=0, le=25, description="Optional additional uncached visits per detector to fetch on the fly"),
) -> Dict[str, Any]:
    """Extract multi-detector spectrum (0.75-5.0 µm) and epoch-by-epoch light curve at clicked (ra, dec)."""
    safe_key = _validate_safe_segment(target_key, "target_key")
    try:
        return extract_spectrum_and_lightcurve(
            target_key=safe_key,
            ra_deg=ra,
            dec_deg=dec,
            r_aperture_px=aperture_radius_px,
            fetch_additional_per_detector=fetch_more,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Spectrum extraction error: {exc}")


@app.get("/api/sky-context")
def get_sky_context_cutout(
    target_key: str = Query(..., description="Cached target_key from manifest"),
    ra: float = Query(..., description="Right Ascension in decimal degrees (ICRS)"),
    dec: float = Query(..., description="Declination in decimal degrees (ICRS)"),
    fov: float = Query(0.10, description="Field of view in degrees"),
    survey: str = Query("allwise", description="Survey identifier: allwise | 2mass | dss2"),
) -> FileResponse:
    """Download, cache in cache/{target_key}/context_{survey}.jpg, and serve sky atlas context cutout."""
    safe_key = _validate_safe_segment(target_key, "target_key")
    try:
        jpg_path = fetch_and_cache_sky_context_jpg(
            target_key=safe_key,
            ra_deg=ra,
            dec_deg=dec,
            fov_deg=fov,
            survey=survey,
        )
        return FileResponse(str(jpg_path), media_type="image/jpeg")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sky context fetch error: {exc}")


@app.get("/")
def serve_spa_index() -> Any:
    index_file = FRONTEND_DIST / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"message": "SPHEREx API running. Start Vite dev server on :5173 or build frontend/dist."}
