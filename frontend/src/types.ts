export type BandKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'ALL' | 'RGB';
export type Mode = 'blink' | 'changes' | 'sum' | 'side';
export type BlinkStyle = 'fade' | 'hard';
export type ColormapMode = 'observatory' | 'inferno' | 'viridis' | 'grayscale' | 'inverted_wiseview';
export type PixelMode = 'smooth' | 'native';
export type FluxUnit = 'MJy/sr' | 'mJy';

export interface TargetInfo {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  description: string;
  ra_ref: number;
  dec_ref: number;
  ref_epoch_jyear: number;
  pmra_mas_yr: number;
  pmdec_mas_yr: number;
  distance_pc?: number | null;
  default_fov_deg: number;
  recommended_detector: BandKey;
  scientific_notes?: string;
  ra_2025_8: number;
  dec_2025_8: number;
  target_key: string;
  is_cached: boolean;
}

export interface DetectorRange {
  min_um: number;
  max_um: number;
  R: number;
  label: string;
}

export interface TargetsResponse {
  targets: TargetInfo[];
  detectors_info: Record<string, DetectorRange>;
}

export interface ResolvedTarget {
  id: string;
  name: string;
  category?: string;
  description?: string;
  ra_ref: number;
  dec_ref: number;
  ra_obs: number;
  dec_obs: number;
  ref_epoch_jyear: number;
  obs_epoch_jyear?: number;
  pmra_mas_yr: number;
  pmdec_mas_yr: number;
  distance_pc?: number | null;
  fov_deg: number;
  recommended_detector?: BandKey;
  is_named_target?: boolean;
  scientific_notes?: string;
}

export interface EpochSummary {
  epoch_index: number;
  epoch_id: string;
  mean_mjd: number;
  mean_iso: string;
  min_iso: string;
  max_iso: string;
  mean_jyear: number;
  total_visits: number;
}

export interface BandEpoch {
  epoch_index: number;
  epoch_id: string;
  mean_mjd?: number;
  mean_iso: string;
  min_iso: string;
  max_iso: string;
  mean_jyear: number;
  visits_coadded: number;
  total_visits_in_epoch: number;
  image_url: string;
  grid_url: string;
  flags_overlay_url: string;
  flag_stats: { saturated_pixels: number; bad_pixels: number; contaminated_pixels: number };
}

export interface BandInfo {
  detector: BandKey;
  wavelength_range_um: [number, number];
  spectral_resolution_R: number | null;
  label: string;
  measured_central_wavelength_um: number;
  norm_vmin: number;
  norm_vmax: number;
  diff_abs_max: number;
  epochs: BandEpoch[];
  diff_image_url: string;
  sum_image_url?: string;
  flags_overlay_url?: string;
  diff_grid_url?: string;
  sum_grid_url?: string;
  flag_stats?: { saturated_pixels: number; bad_pixels: number; contaminated_pixels: number };
}

export interface EpochPosition {
  ra: number;
  dec: number;
  x: number;
  y: number;
  epoch_jyear?: number;
  shift_arcsec?: number;
  shift_arcsec_from_epoch_0?: number;
  step_shift_arcsec?: number;
  measured_from_pixels?: boolean;
  centroid_detector?: string;
}

export interface GaiaSource {
  source_id: string;
  ra_j2016?: number;
  dec_j2016?: number;
  ra: number;
  dec: number;
  x: number;
  y: number;
  pmra_mas_yr: number | null;
  pmdec_mas_yr: number | null;
  gmag: number | null;
  bp_rp: number | null;
  epoch_positions: Record<string, EpochPosition>;
}

export interface WcsInfo {
  crpix: [number, number];
  cdelt: [number, number];
  crval: [number, number];
  ctype?: [string, string];
  pixel_scale_arcsec: number;
  width: number;
  height: number;
  fov_deg: number;
  north_up?: boolean;
  east_left?: boolean;
}

export interface Manifest {
  target_key: string;
  target: ResolvedTarget;
  target_positions: Record<string, EpochPosition>;
  wcs: WcsInfo;
  total_overlapping_visits: number;
  sampled_cutouts_count: number;
  epochs_summary: EpochSummary[];
  detectors: Record<BandKey, BandInfo>;
  flags_overlay_url?: string;
  gaia_dr3_sources: GaiaSource[];
  external_links?: {
    wiseview?: string;
    gaia_dr3?: string;
    cadc?: string;
    irsa_spherex?: string;
    [key: string]: string | undefined;
  };
  generated_at_unix?: number;
  processing_time_sec?: number;
}

export type ObserveBody = {
  target?: string;
  ra?: number;
  dec?: number;
  fov_deg?: number;
  max_visits_per_epoch_per_detector?: number;
  force_refresh?: boolean;
};

export type ObserveResponse =
  | { status: 'completed'; cached: true; target_key: string; manifest: Manifest }
  | { status: 'running'; cached: false; job_id: string; target_key: string; resolved_target: ResolvedTarget };

export interface JobState {
  job_id: string;
  target_key: string;
  resolved_target: ResolvedTarget;
  status: 'running' | 'completed' | 'failed';
  current_step: string;
  total_cutouts: number;
  downloaded: number;
  manifest?: Manifest;
  error?: string;
}

export interface GridData {
  width: number;
  height: number;
  median: number;
  mad_std: number;
  vmin: number;
  vmax: number;
  abs_max: number;
  data: (number | null)[][];
}

export interface SpectrumPoint {
  visit_index: number;
  epoch_index: number;
  detector: BandKey;
  mjd?: number;
  iso_date: string;
  jyear?: number;
  wavelength_um: number;
  bandwidth_um: number;
  flux_mjy_sr: number;
  flux_err: number;
  flux_mjy: number;
  flux_err_mjy: number;
  is_saturated_or_flagged: boolean;
  is_saturated: boolean;
  is_bad: boolean;
  is_contaminated: boolean;
  flag_labels?: string[];
}

export interface LightCurvePoint {
  epoch_index: number;
  epoch_id?: string;
  mean_mjd?: number;
  mean_iso: string;
  mean_jyear?: number;
  flux_mjy_sr: number;
  flux_err: number;
  flux_mjy: number;
  flux_err_mjy?: number;
  mean_wavelength_um: number;
  n_visits: number;
  is_saturated: boolean;
  is_saturated_or_flagged?: boolean;
}

export interface Variability {
  delta_flux_mjy_sr: number;
  fractional_change_pct: number;
  significance_sigma: number;
  any_saturated: boolean;
}

export interface ReferenceFeature {
  wavelength_um: number;
  label: string;
  category: string;
}

export interface SpectrumResult {
  target_key: string;
  query_coord: { ra: number; dec: number };
  aperture_radius_px: number;
  aperture_radius_arcsec: number;
  total_overlapping_visits: number;
  extracted_visits_count: number;
  uncached_visits_remaining?: number;
  spectrum: SpectrumPoint[];
  light_curves: Partial<Record<BandKey, LightCurvePoint[]>>;
  variability_summary: Partial<Record<BandKey, Variability>>;
  reference_features?: ReferenceFeature[];
}

export interface Visit {
  iso_date: string;
  mjd: number;
  detector: BandKey;
  wavelength_um: number;
  status?: string;
}
