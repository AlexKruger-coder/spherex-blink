# SPHEREx Chrono-Spectral Sky Blinker & On-the-Fly Spectrophotometry Engine

**A Public-Facing Multi-Epoch Proper Motion & Variability Discovery Web Application for NASA's SPHEREx Mission**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Data: NASA/IPAC IRSA SPHEREx](https://img.shields.io/badge/Data-NASA%2FIPAC%20IRSA%20SPHEREx-06b6d4.svg)](https://irsa.ipac.caltech.edu/Missions/spherex.html)
[![Spectral Coverage: 0.75-5.0 um](https://img.shields.io/badge/Bands-102%20Channels%20(D1--D6)-10b981.svg)](#scientific-architecture--spherex-lvf-processing)

---

## Overview

Since May 2025, NASA's **SPHEREx** (*Spectro-Photometer for the History of the Universe, Epoch of Reionization, and Ices Explorer*) has been mapping the entire sky every six months across **102 near-infrared spectral bands ($0.75\text{--}5.0\ \mu\text{m}$)** using six Linear Variable Filter (LVF) detector arrays (`D1` through `D6`). Nearby brown dwarfs, high-proper-motion stars, Solar System bodies, and pulsating or accreting variable stars reveal themselves by shifting position or varying in brightness between survey epochs.

**SPHEREx Chrono-Spectral Sky Blinker** is an interactive web platform inspired by *Backyard Worlds / WiseView* and tailored to the 3D chrono-spectral architecture of SPHEREx Level 2 Multi-Extension FITS (MEF) data. Users can enter any sky coordinates or object name, blink multi-epoch co-adds across individual detector arrays or broadband stacks, compute interactive epoch differences (`Epoch B - Epoch A`) and two-epoch deep sums (`Epoch B + Epoch A`) directly in Float32, inspect image-measured source centroids across epochs, and click any pixel or source on the sky canvas to extract its **0.75–5.0 $\mu\text{m}$ LVF spectrum** and **SED-normalized multi-epoch light curve** on the fly.

---

## Key Features

### 1. Multi-Detector & Multi-Epoch Sky Blinker (`D1`–`D6`, `ALL`, `False-Color IR RGB`)
- **6 LVF Detector Arrays + Broadband Stack + Chromatic Composite:** Switch instantaneously between `D1` ($0.75\text{--}1.09\ \mu\text{m}$, $R=39$), `D2` ($1.10\text{--}1.62\ \mu\text{m}$, $R=41$), `D3` ($1.63\text{--}2.41\ \mu\text{m}$, $R=41$), `D4` ($2.42\text{--}3.82\ \mu\text{m}$, $R=35$), `D5` ($3.83\text{--}4.41\ \mu\text{m}$, $R=112$), `D6` ($4.42\text{--}5.00\ \mu\text{m}$, $R=128$), the `ALL (D1–D6 Stack)` broadband mean co-add ($R=\text{—}$), or the `False-Color IR RGB` composite ($R=\text{D6}, G=\text{D4}, B=\text{D2}$, $R=\text{—}$).
- **Interactive Epoch Math (`Blink`, `Subtract Epochs`, `Add / Stack Epochs`):**
  - **Blink Video Loop:** Adjustable frame rate ($0.5\text{--}6.0\text{ FPS}$) and manual epoch stepping (`E1`, `E2`, `E3`...).
  - **Interactive Dipole Subtraction (`Epoch B - Epoch A`):** Select any pair of epochs (`Epoch B` and `Epoch A`) to compute `grid_B - grid_A` in real time using client-side Float32 arrays. Moving objects stand out as blue/red positive-negative dipoles.
  - **Interactive Two-Epoch Deep Sum (`Epoch B + Epoch A`):** Sum any two epochs in Float32 (`grid_B + grid_A`) to inspect combined two-epoch signal.
- **Client-Side Float32 LUT Rendering & Exact Gnomonic (`TAN`) WCS:** Dynamic brightness offset, contrast gain, and scientific colormaps (`Inferno`, `Viridis`, `Grayscale`, and inverted black-on-white `WiseView` mode) computed directly from decompressed 2D Float32 science grids (`/api/grid/...`), paired with exact gnomonic tangent-plane (`RA---TAN`, `DEC--TAN`) forward and inverse spherical trigonometry.
- **Core Loupe (`9x9 px`) & Image-Measured Epoch Centroids:** Measures real source centroids directly from the SPHEREx epoch co-add pixels via `photutils.centroids` (`centroid_2dg`, `centroid_quadratic`, `centroid_com`), displaying a fixed cyan crosshair at the Epoch 1 (`E1`) centroid alongside a moving gold marker and measured shift ($\Delta$ in arcseconds) for the active epoch.

### 2. On-the-Fly 102-Band LVF Spectrophotometry & Variability Light Curves
- **Click-Anywhere & Centroid-Tracking Aperture Extraction:** Clicking any pixel or astronomical source on the SPHEREx canvas converts canvas $(X, Y)$ to ICRS $(\text{RA}, \text{Dec})$ via the gnomonic WCS and extracts background-subtracted circular aperture photometry ($r = 2.5\text{ px} = 15.5''$) with local sigma-clipped sky annulus subtraction ($r_{\text{in}}=5\text{ px}, r_{\text{out}}=9\text{ px}$). For the target source, the photometry aperture tracks the image-measured epoch centroid and refines per-visit sub-pixel centroids.
- **Exact `WCS-WAVE` Spectral & Solid-Angle Evaluation:** Evaluates the 2D tabular spectral WCS (`WCS(header, fobj=hdulist, key="W")`) at the source coordinate in every overlapping cutout to determine central wavelength $\lambda$ ($\mu\text{m}$) and filter bandwidth $\Delta\lambda$ ($\mu\text{m}$), and converts surface brightness ($\text{MJy/sr}$) to integrated flux density ($\text{mJy}$) using the physical pixel solid angle `astropy.wcs.utils.proj_plane_pixel_area(spatial_wcs.celestial)`.
- **Saturation-Aware SED & Light Curves:** Dynamically parses `MSKN*` bit definitions from `hdulist["FLAGS"].header`, flags exposures with `OVERFLOW` / `NONLINEAR` or NaN 3x3 cores, excludes saturated visits from light curve medians and variability metrics (unless all visits in that detector are saturated), and normalizes visit fluxes against a smooth unsaturated wavelength-binned SED template so LVF wavelength drift does not introduce artificial variability.

### 3. Multi-Mode Observatory Workspace & Sky Atlas Context
- **Interactive Viewport Modes:** Switch seamlessly between `Blink` (animated epoch loop), `Changes only` (`Plate B - Plate A` Float32 difference dipole), `Deep sum` (`Plate B + Plate A` Float32 stack), and `Side by side` plate comparison, plus a bottom plate filmstrip for instant epoch selection.
- **Multi-Survey Sky Context & Cross-Archive Verification:** Backend proxy and disk cache (`/api/sky-context`) that downloads and caches reference sky cutouts (`cache/{target_key}/context_{survey}.jpg` for `AllWISE`, `2MASS`, and `DSS2`), paired with live Gaia DR3 proper-motion overlays and 1-click cross-check links to **WiseView**, **NASA/IPAC IRSA**, **ESA Gaia DR3 (VizieR)**, **CDS Aladin Sky Atlas**, and **CSA CADC**.

### 4. Official Pre-Cached NASA Challenge Targets
All five official targets specified in the NASA challenge are pre-processed and cached on disk for instant ($<10\text{ ms}$) loading:
1. **Barnard's Star** (`barnards_star`): Fastest-moving star in the sky ($\sim 10.4''/\text{yr}$ northward; $\sim 0.84$ SPHEREx pixels per 6 months, $\sim 2.5$ pixels over 1.5 years), exhibiting a clear image-measured proper-motion shift and dipole across SPHEREx epochs.
2. **Epsilon Indi B** (`epsilon_indi_b`): Closest binary brown dwarf pair ($\text{T1} + \text{T6}$, $\sim 4.7''/\text{yr}$), showing methane and water absorption features across `D1`–`D4` and measured astrometric motion across epochs.
3. **WISE 0855** (`wise_0855`, `08h55m10.831s -7d14m42.53s`): Coldest known ($\sim 250\text{ K}$) Y4 sub-brown dwarf propagated from its 2010.5 discovery epoch with $\mu_{\alpha}\cos\delta = -8123.7\text{ mas/yr}$, $\mu_{\delta} = +673.2\text{ mas/yr}$ to the 2025–2026 observation window, with epoch centroids measured directly in thermal `D6` ($4.42\text{--}5.00\ \mu\text{m}$).
4. **RW Aurigae** (`rw_aurigae`): Classical T Tauri variable star with dusty circumstellar disk excess and multi-epoch infrared variability.
5. **R Draconis** (`r_draconis`): Mira pulsating AGB variable star near the North Ecliptic Pole (NEP) with dense SPHEREx temporal coverage.

---

## Scientific Architecture & SPHEREx LVF Processing

1. **Unified IRSA TAP Query (`spherex.artifact` $\bowtie$ `spherex.plane`):**
   Queries NASA/IPAC IRSA's Table Access Protocol (TAP) service across all six detector bandpasses (`SPHEREx-D1` through `SPHEREx-D6`) using spatial polygon containment (`CONTAINS(POINT('ICRS', ra, dec), p.poly)`) and server-side FITS cutout parameters (`?center={ra},{dec}d&size={fov}`).
2. **Initial Window Pointing vs. Image-Measured Epoch Centroids:**
   - Catalog proper motion is used only to point the cutout window from the J2000/2010 reference epoch to the 2025–2026 SPHEREx observation window before cutouts are downloaded.
   - Once the SPHEREx epoch co-adds are constructed, the source centroid $(x, y, \text{RA}, \text{Dec})$ and inter-epoch shift ($\text{arcsec}$) are measured directly from the co-added SPHEREx image pixels in each epoch using `photutils.centroids`.
3. **Adaptive Epoch Partitioning (Including NEP Continuous Coverage):**
   Clusters sorted MJD timestamps by survey gaps ($>45\text{ days}$). For targets near the North Ecliptic Pole (such as `R Draconis`) where SPHEREx coverage spans $>150\text{ days}$ continuously, the pipeline partitions visits into fixed 120-day calendar windows so multi-epoch blinking and light curves remain well-defined.
4. **Zodiacal Light Subtraction & Bitmask `FLAGS` Handling:**
   For each Level 2 MEF cutout:
   - Subtracts the empirical zodiacal light model extension from the calibrated surface brightness extension: $\text{Clean} = \text{IMAGE} - \text{ZODI}$, followed by background pedestal removal.
   - Dynamically parses the `MSKN*`/`MSKM*` bit definitions from `hdulist["FLAGS"].header` (`TRANSIENT`, `OVERFLOW`, `SUR_ERROR`, `NONFUNC`, `DICHROIC`, `MISSING_DATA`, `HOT`, `COLD`, `NONLINEAR`, `PERSIST`, `OUTLIER`, `CROSSTALK`, `GHOST`, `STREAK`, `BLOOM`, `SNOWBALL`, `HALO`).
   - Replaces masked transient/bad pixels with a $3\times 3$ `scipy.ndimage.median_filter` prior to bilinear reprojection so isolated bad pixels do not bleed into neighbors, while preserving saturated PSF cores in the unmasked fallback stack.
5. **North-Up Tangent-Plane (`TAN`) Reprojection:**
   Reprojects all exposures onto a unified North-Up, East-Left tangent-plane WCS grid (`RA---TAN`, `DEC--TAN`) at SPHEREx's native $6.2''/\text{pixel}$ scale using `reproject.reproject_interp`.

---

## Project Structure

```text
spherex-app/
├── backend/
│   ├── __init__.py
│   ├── main.py              # FastAPI server, REST API endpoints, & SPA static hosting
│   ├── spherex_core.py      # IRSA TAP query, MEF cutout downloader, ZODI/FLAGS, WCS reprojection & centroiding
│   └── spectra.py           # On-the-fly PhotUtils aperture photometry, SED normalization & WCS-WAVE extractor
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Landing.tsx       # Target selection eyepiece & custom coordinate/SIMBAD entry
│   │   │   ├── Viewer.tsx        # Main observatory workspace, epoch controls & plate filmstrip
│   │   │   ├── SkyStage.tsx      # Interactive Float32 LUT canvas, TAN WCS & Core Loupe (9x9 px)
│   │   │   ├── MeasurePanel.tsx  # 102-band LVF SED, multi-epoch light curves & sky context drawer
│   │   │   ├── Charts.tsx        # SVG spectrophotometry & SED-normalized light-curve plots
│   │   │   ├── DisplayMenu.tsx   # Detector bandpass, stretch, colormap & 32-bit FLAGS controls
│   │   │   ├── Overlay.tsx       # Gaia DR3 epoch-propagated circles & centroid shift markers
│   │   │   ├── Telescope.tsx     # Live IRSA TAP cutout progress monitor
│   │   │   └── AboutSheet.tsx    # Scientific guide & NASA/partner archive acknowledgments
│   │   ├── lib/
│   │   │   ├── wcs.ts            # Exact gnomonic (RA---TAN, DEC--TAN) spherical projection
│   │   │   ├── frames.ts         # Float32 grid math (Changes only, Deep sum, False-Color IR RGB)
│   │   │   └── colors.ts         # Scientific LUT colormaps & AsinhStretch normalization
│   │   ├── App.tsx               # Root application & shareable URL query state synchronization
│   │   ├── store.ts              # Zustand scientific workspace state store
│   │   ├── api.ts                # REST API client for manifests, Float32 grids & spectra
│   │   ├── types.ts              # TypeScript interfaces for manifests, WCS, Gaia DR3 & spectra
│   │   └── main.tsx
│   ├── dist/                     # Production-built frontend bundle served directly by FastAPI at /
│   ├── package.json
│   └── vite.config.ts
├── cache/                   # Pre-computed manifests, PNGs, .npy.gz Float32 grids & spectra for 5 targets
├── requirements.txt         # Python backend dependencies
├── LICENSE                  # Apache-2.0 Open Source License
└── README.md
```

---

## Local Setup & Run Instructions

### Prerequisites
- **Python 3.10+**
- **Node.js 18+** and `npm` (only required if rebuilding the frontend bundle)

### 1. Install Python Dependencies
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. (Optional) Rebuild the Frontend Production Bundle
The production bundle is built in `frontend/dist/`. To rebuild after modifying any `.tsx` files:
```bash
cd frontend
npm install
npm run build
cd ..
```

### 3. Start the Application on a Single Port (`:8000`)
FastAPI serves both the backend REST API (`/api/*`, `/cache/*`) and the built React Single-Page Application (`frontend/dist`) at `/`:
```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser.

---

## REST API Reference & Shareable URL Parameters

### URL Query Parameters (For Direct Sharing & Embedding)
You can link or embed any sky view using URL query parameters:
- `/?target=wise_0855&ra=133.75951&dec=-7.24221&detector=D6&mode=blink&fov=0.15`
- `/?ra=269.44623&dec=4.76870&detector=D2&mode=diff&fov=0.10`

### Backend Endpoints
- `GET /api/health` — Health check and disk cache directory status.
- `GET /api/targets` — Metadata and cache status for the 5 official NASA SPHEREx targets.
- `POST /api/observe` — Resolve target/coordinates, return cached `manifest.json` immediately, or launch an asynchronous IRSA cutout & reprojection pipeline job.
- `GET /api/jobs/{job_id}` — Poll real-time progress (`downloaded`, `total_cutouts`, `current_step`, `status`).
- `GET /api/manifest/{target_key}` — Retrieve cached `manifest.json` for a target key.
- `GET /api/grid/{target_key}/{grid_name}` — Retrieve decompressed 2D Float32 science arrays and robust MAD sky stretch statistics.
- `GET /api/spectrum?target_key=...&ra=...&dec=...` — Extract 0.75–5.0 $\mu\text{m}$ `WCS-WAVE` spectrophotometry and SED-normalized multi-epoch light curves at any clicked coordinate.
- `GET /api/sky-context?target_key=...&ra=...&dec=...&fov=...&survey=allwise|2mass|dss2` — Download, cache in `cache/{target_key}/context_{survey}.jpg`, and serve reference sky atlas cutouts.

---

## Acknowledgments, Data Credits & AI Attribution

### NASA & Partner Space Agency Archives
- **NASA / JPL-Caltech / IPAC Infrared Science Archive (IRSA):** [SPHEREx Mission Archive](https://irsa.ipac.caltech.edu/Missions/spherex.html) and [Official SPHEREx Python Tutorial Notebooks](https://caltech-ipac.github.io/irsa-tutorials/spherex/) for Level 2 Multi-Extension FITS (`IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, `WCS-WAVE`) access via TAP and cutout services.
- **European Space Agency (ESA) / NASA STScI Gaia Mission:** [Gaia Data Release 3 (DR3)](https://archive.stsci.edu/missions-and-data/gaia) astrometric catalog for epoch-propagated star overlays.
- **Strasbourg Astronomical Data Center (CDS) / NASA SkyView:** [Aladin Sky Atlas](https://aladin.cds.unistra.fr/), Sesame name resolver, and reference sky survey cutouts (`AllWISE`, `2MASS`, `DSS2`).
- **Backyard Worlds: Planet 9 / WiseView:** [WiseView](http://byw.tools/wiseview) multi-epoch infrared blinking reference and cross-check integration.
- **Canadian Space Agency (CSA) / CADC:** [Canadian Astronomy Data Centre](https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/) external cross-archive verification.

### Use of Super Intelligence (SI) / AI Tools Disclosure
In compliance with NASA Space Apps Challenge transparency guidelines:
- **LLM Coding & Editing Assistants (Claude / ChatGPT / Gemini):** Used to accelerate React/TypeScript UI component scaffolding, CSS layout styling, English documentation and slide copy-editing, and API reference lookup for `astropy`, `reproject`, and `photutils`.
- **Scientific Data Integrity:** No astronomical images, coordinates, spectra, or measurements are AI-generated. All scientific algorithms (zodiacal light subtraction, 32-bit `FLAGS` bitmask filtering, gnomonic `TAN` WCS reprojection, proper-motion propagation, sub-pixel centroiding, and `WCS-WAVE` aperture photometry) operate strictly on real observational data retrieved from NASA/IPAC IRSA, ESA Gaia DR3, and CDS archives.
