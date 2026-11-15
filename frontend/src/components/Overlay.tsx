import { useEffect, useRef } from 'react';
import type { Probe } from '../store';
import { EMBER } from '../lib/colors';
import { ARCSEC_PER_PIXEL, catalogueGhost, positionAt, type Marker } from '../lib/field';
import { fmtDate } from '../lib/format';
import type { FrameSet } from '../lib/frames';
import { makeTransform, type View } from '../lib/view';
import type { Manifest, Mode } from '../types';
import type { StageInfo } from './SkyStage';

interface Props {
  manifest: Manifest;
  frames: FrameSet;
  info: StageInfo;
  view: View;
  mode?: Mode;
  markers: Marker[];
  showMarkers: boolean;
  showAllGaia?: boolean;
  gaiaMagLimit?: number;
  showCoreLoupe?: boolean;
  ringReady: boolean;
  showTrail: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  measure?: boolean;
  probe?: Probe | null;
  cursor?: { x: number; y: number } | null;
}

const FOG = '#C9D3DB';
const HAZE = '#8FA0AE';
const ICE = '#82B4EB';

function CoreLoupe({
  manifest,
  frames,
  mode,
  epochIdx,
}: {
  manifest: Manifest;
  frames: FrameSet;
  mode: Mode;
  epochIdx: number;
}) {
  const cvsRef = useRef<HTMLCanvasElement>(null);
  const plate = frames.meta[epochIdx] ?? frames.meta[0];

  const epKeys = Object.keys(manifest.target_positions ?? {})
    .filter((k) => k.startsWith('epoch_'))
    .sort((a, b) => parseInt(a.replace('epoch_', ''), 10) - parseInt(b.replace('epoch_', ''), 10));

  const e1Pos = manifest.target_positions?.[epKeys[0] ?? 'epoch_0'] ?? {
    x: frames.w / 2,
    y: frames.h / 2,
    ra: manifest.target.ra_obs,
    dec: manifest.target.dec_obs,
  };
  const curPos = manifest.target_positions?.[plate?.epoch_id ?? 'epoch_0'] ?? e1Pos;

  const shiftArcsec =
    curPos.shift_arcsec !== undefined
      ? curPos.shift_arcsec.toFixed(1)
      : (Math.hypot(curPos.x - e1Pos.x, curPos.y - e1Pos.y) * ARCSEC_PER_PIXEL).toFixed(1);

  useEffect(() => {
    const cvs = cvsRef.current;
    if (!cvs) return;
    const boxSize = 144;
    const patchPx = 9;
    cvs.width = boxSize;
    cvs.height = boxSize;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const src =
      mode === 'changes'
        ? frames.nativePairDiff
        : mode === 'sum'
          ? frames.nativePairSum
          : (frames.nativeEpochs[epochIdx] ?? frames.nativeEpochs[0]);

    ctx.fillStyle = '#080A0D';
    ctx.fillRect(0, 0, boxSize, boxSize);

    const sxCenter = e1Pos.x + 0.5;
    const syCenter = frames.h - 0.5 - e1Pos.y;
    const sx0 = Math.min(Math.max(0, sxCenter - patchPx / 2), Math.max(0, frames.w - patchPx));
    const sy0 = Math.min(Math.max(0, syCenter - patchPx / 2), Math.max(0, frames.h - patchPx));

    if (src) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, sx0, sy0, patchPx, patchPx, 0, 0, boxSize, boxSize);
    }

    // Subtle 9x9 native pixel grid lines
    ctx.strokeStyle = 'rgba(201, 211, 219, 0.1)';
    ctx.lineWidth = 1;
    for (let k = 1; k < patchPx; k++) {
      const pos = Math.round((k / patchPx) * boxSize) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, boxSize);
      ctx.moveTo(0, pos);
      ctx.lineTo(boxSize, pos);
      ctx.stroke();
    }

    // Fixed E1 reference crosshair
    const lcx = ((sxCenter - sx0) / patchPx) * boxSize;
    const lcy = ((syCenter - sy0) / patchPx) * boxSize;
    ctx.strokeStyle = ICE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(lcx - 13, lcy);
    ctx.lineTo(lcx - 4, lcy);
    ctx.moveTo(lcx + 4, lcy);
    ctx.lineTo(lcx + 13, lcy);
    ctx.moveTo(lcx, lcy - 13);
    ctx.lineTo(lcx, lcy - 4);
    ctx.moveTo(lcx, lcy + 4);
    ctx.lineTo(lcx, lcy + 13);
    ctx.stroke();

    // Current epoch position & shift vector
    const curSx = curPos.x + 0.5;
    const curSy = frames.h - 0.5 - curPos.y;
    const lCurX = ((curSx - sx0) / patchPx) * boxSize;
    const lCurY = ((curSy - sy0) / patchPx) * boxSize;

    if (Math.hypot(lCurX - lcx, lCurY - lcy) > 1.2) {
      ctx.beginPath();
      ctx.moveTo(lcx, lcy);
      ctx.lineTo(lCurX, lCurY);
      ctx.strokeStyle = EMBER;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(lCurX, lCurY, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = EMBER;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }, [frames, mode, epochIdx, e1Pos.x, e1Pos.y, curPos.x, curPos.y]);

  return (
    <div className="pointer-events-none absolute bottom-[154px] left-6 z-10 border border-ash/80 bg-void/90 p-2.5 text-[11px] backdrop-blur-[2px] md:left-12">
      <div className="mb-1.5 flex items-center justify-between gap-3 tracking-wide text-fog">
        <span className="uppercase tracking-[0.12em] text-haze">Core Loupe (9×9 px)</span>
        <span className="num text-white">Δ = {shiftArcsec}″</span>
      </div>
      <canvas ref={cvsRef} className="block h-[144px] w-[144px] border border-ash/60" />
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-haze">
        <span style={{ color: ICE }}>+ E1 ref</span>
        <span style={{ color: EMBER }}>○ Plate {epochIdx + 1}</span>
      </div>
    </div>
  );
}

export function Overlay({
  manifest,
  frames,
  info,
  view,
  mode = 'blink',
  markers,
  showMarkers,
  showAllGaia = false,
  gaiaMagLimit = 18.0,
  showCoreLoupe = false,
  ringReady,
  showTrail,
  selectedId,
  onSelect,
  measure,
  probe,
  cursor,
}: Props) {
  const ghost = catalogueGhost(manifest);
  const trailMarker = (selectedId ? markers.find((m) => m.id === selectedId) : markers.find((m) => m.kind === 'target')) ?? null;

  const visibleGaiaStars = showAllGaia
    ? (manifest.gaia_dr3_sources ?? []).filter((s) => (s.gmag ?? 20) <= gaiaMagLimit)
    : [];

  return (
    <>
      {info.panes.map((r, i) => {
        const plate = frames.meta[info.paneIndex[i]] ?? frames.meta[0];
        const tr = makeTransform(r, frames.w, frames.h, view);
        const at = (x: number, y: number) => {
          const p = tr.toScreen(x, y);
          return { x: p.sx - r.x, y: p.sy - r.y };
        };
        return (
          <div key={i} className="pointer-events-none absolute overflow-hidden" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
            {info.panes.length === 2 && (
              <div className="absolute left-0 right-0 top-24 text-center text-[13px] tracking-wide text-haze">
                <span className="text-fog">Plate {info.paneIndex[i] + 1}</span> · {fmtDate(plate.mean_iso)}
              </div>
            )}
            <svg width={r.w} height={r.h} className="absolute inset-0 overflow-visible">
              <defs>
                <radialGradient id={`halo-${i}`}>
                  <stop offset="0%" stopColor={EMBER} stopOpacity="0.32" />
                  <stop offset="100%" stopColor={EMBER} stopOpacity="0" />
                </radialGradient>
              </defs>

              {showAllGaia &&
                visibleGaiaStars.map((star) => {
                  const epPos = star.epoch_positions?.[plate.epoch_id] ?? { x: star.x, y: star.y };
                  if (epPos.x < 0.2 || epPos.x > frames.w - 1.2 || epPos.y < 0.2 || epPos.y > frames.h - 1.2) {
                    return null;
                  }
                  const p = at(epPos.x, epPos.y);
                  const gmag = star.gmag ?? 18;
                  const rad = Math.max(4.5, Math.min(10.5, 17.2 - gmag * 0.68));
                  const highPm = Math.hypot(star.pmra_mas_yr ?? 0, star.pmdec_mas_yr ?? 0) > 250;
                  return (
                    <g key={`gaia-cat-${star.source_id}`} opacity="0.88">
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={rad}
                        fill="none"
                        stroke={highPm ? EMBER : ICE}
                        strokeWidth={highPm ? '1.5' : '1.1'}
                        strokeOpacity={highPm ? '0.9' : '0.72'}
                      />
                      {(highPm || gmag <= 14.5) && (
                        <text
                          x={p.x + rad + 4}
                          y={p.y + 3}
                          fill={highPm ? EMBER : ICE}
                          fontSize="10"
                          className="num"
                          stroke="#080A0D"
                          strokeWidth="2.5"
                          paintOrder="stroke"
                        >
                          G={gmag.toFixed(1)}
                        </text>
                      )}
                    </g>
                  );
                })}

              {showMarkers && ghost && (() => {
                const g = at(ghost.x, ghost.y);
                const first = markers.find((m) => m.kind === 'target')?.path[0];
                const f = first ? at(first.x, first.y) : null;
                return (
                  <g opacity="0.75">
                    {f && <line x1={g.x} y1={g.y} x2={f.x} y2={f.y} stroke={HAZE} strokeOpacity="0.45" strokeDasharray="2 5" />}
                    <circle cx={g.x} cy={g.y} r="9" fill="none" stroke={HAZE} strokeDasharray="2 3" />
                    <text x={g.x + 16} y={g.y + 4} fill={HAZE} fontSize="12">
                      Catalogue position, {ghost.year}
                    </text>
                  </g>
                );
              })()}

              {showTrail && trailMarker?.moves && (() => {
                const pts = trailMarker.path.map((p) => at(p.x, p.y));
                const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
                const last = pts.length - 1;
                const dir = { x: pts[last].x - pts[0].x, y: pts[last].y - pts[0].y };
                const len = Math.hypot(dir.x, dir.y) || 1;
                const nx = dir.x / len;
                const ny = dir.y / len;
                return (
                  <g key={`${trailMarker.id}-${selectedId}`}>
                    <path
                      d={d}
                      pathLength={1}
                      fill="none"
                      stroke={EMBER}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeDasharray="1"
                      strokeDashoffset="1"
                      style={{ animation: 'draw 1.8s cubic-bezier(.45,0,.55,1) forwards' }}
                    />
                    {pts.map((p, k) => (
                      <circle
                        key={k}
                        cx={p.x}
                        cy={p.y}
                        r="3"
                        fill={EMBER}
                        style={{ opacity: 0, animation: `fade-in .5s ease-out ${(k / Math.max(1, last)) * 1.6}s forwards` }}
                      />
                    ))}
                    {[0, last].map((k) => (
                      <text
                        key={k}
                        x={pts[k].x - nx * (k === 0 ? 14 : -14)}
                        y={pts[k].y - ny * (k === 0 ? 14 : -14) + 4}
                        textAnchor={(k === 0 ? -nx : nx) < 0 ? 'end' : 'start'}
                        fill={HAZE}
                        fontSize="12"
                        style={{ opacity: 0, animation: `fade-in .6s ease-out ${k === 0 ? 0.2 : 1.7}s forwards` }}
                      >
                        {fmtDate(trailMarker.path[k].iso, true)}
                      </text>
                    ))}
                  </g>
                );
              })()}

              {showMarkers &&
                markers.map((m) => {
                  const pos = positionAt(m, plate.epoch_index);
                  const p = at(pos.x, pos.y);
                  const selected = m.id === selectedId;
                  const isTarget = m.kind === 'target';
                  const color = m.moves ? EMBER : FOG;
                  const visible = !isTarget || ringReady || selected;
                  return (
                    <g
                      key={m.id}
                      style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: 'transform 700ms cubic-bezier(.16,1,.3,1)' }}
                    >
                      {visible && (
                        <g style={{ animation: isTarget ? 'ring-in .7s ease-out both' : 'fade-in .8s ease-out both', transformOrigin: '0 0' }}>
                          {isTarget && m.moves && <circle r="34" fill={`url(#halo-${i})`} />}
                          <circle r={isTarget ? 13 : 8} fill="none" stroke={color} strokeWidth="1.2" strokeOpacity={isTarget ? 1 : selected ? 1 : 0.55} />
                          {isTarget && <circle r="2.2" fill={color} />}
                          {(isTarget || selected) && (
                            <text x={isTarget ? 24 : 16} y="4" fill={color} fontSize="14" stroke="#080A0D" strokeWidth="3.5" strokeOpacity="0.8" paintOrder="stroke" strokeLinejoin="round">
                              {m.name}
                            </text>
                          )}
                        </g>
                      )}
                      <circle
                        r="22"
                        fill="transparent"
                        pointerEvents="all"
                        style={{ cursor: 'pointer' }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(m.id);
                        }}
                      />
                    </g>
                  );
                })}

              {measure && probe && (() => {
                const p = at(probe.x, probe.y);
                return (
                  <g stroke={FOG} strokeOpacity="0.85">
                    <circle cx={p.x} cy={p.y} r="9" fill="none" />
                    <path d={`M${p.x - 15} ${p.y}H${p.x - 5}M${p.x + 5} ${p.y}H${p.x + 15}M${p.x} ${p.y - 15}V${p.y - 5}M${p.x} ${p.y + 5}V${p.y + 15}`} />
                  </g>
                );
              })()}

              {measure && cursor && cursor.x >= r.x && cursor.x <= r.x + r.w && (
                <g stroke={FOG} strokeOpacity="0.22">
                  <line x1={0} x2={r.w} y1={cursor.y} y2={cursor.y} />
                  <line y1={0} y2={r.h} x1={cursor.x - r.x} x2={cursor.x - r.x} />
                </g>
              )}
            </svg>
          </div>
        );
      })}

      {showCoreLoupe && (
        <CoreLoupe manifest={manifest} frames={frames} mode={mode} epochIdx={info.paneIndex[0] ?? 0} />
      )}

      <ul className="sr-only">
        {markers.map((m) => (
          <li key={m.id}>
            <button onClick={() => onSelect(m.id)}>
              {m.name}, {m.subtitle}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
