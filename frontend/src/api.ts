import type {
  GridData,
  JobState,
  Manifest,
  ObserveBody,
  ObserveResponse,
  SpectrumResult,
  TargetsResponse,
  Visit,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "Can't reach the SPHEREx server. Is the backend running on port 8000?");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') {
        detail = body.detail;
      } else if (Array.isArray(body?.detail)) {
        detail = body.detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join('; ');
      }
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  targets: () => request<TargetsResponse>('/api/targets'),

  observe: (body: ObserveBody) =>
    request<ObserveResponse>('/api/observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_visits_per_epoch_per_detector: 4,
        ...body,
      }),
    }),

  job: (id: string) => request<JobState>(`/api/jobs/${encodeURIComponent(id)}`),

  manifest: (key: string) => request<Manifest>(`/api/manifest/${encodeURIComponent(key)}`),

  grid: (key: string, name: string) =>
    request<GridData>(`/api/grid/${encodeURIComponent(key)}/${encodeURIComponent(name)}`),

  spectrum: (key: string, ra: number, dec: number, aperturePx = 2.5, fetchMore = 0) =>
    request<SpectrumResult>(
      `/api/spectrum?target_key=${encodeURIComponent(key)}&ra=${ra}&dec=${dec}&aperture_radius_px=${aperturePx}&fetch_more=${fetchMore}`,
    ),

  async visits(key: string): Promise<Visit[]> {
    const data = await request<{ visits: Visit[] }>(`/cache/${encodeURIComponent(key)}/all_visits.json`);
    return data.visits.filter((v) => !v.status || v.status === 'ok');
  },
};

const TIMEOUT_MS = 6 * 60 * 1000;

export async function pollJob(
  id: string,
  onUpdate: (job: JobState) => void,
  signal?: AbortSignal,
): Promise<JobState> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const job = await api.job(id);
    onUpdate(job);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new ApiError(500, job.error ?? 'The pipeline failed.');
    if (Date.now() - started > TIMEOUT_MS) throw new ApiError(504, 'This is taking too long. Please try again.');
    await new Promise((r) => setTimeout(r, 900));
  }
}
