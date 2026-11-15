interface Props {
  /** Inset from the viewport edge, in px. */
  inset?: number;
  size?: number;
  color?: string;
  crosses?: boolean;
}

/** Thin corner brackets: the field-of-view frame of an instrument. */
export function Brackets({ inset = 28, size = 26, color = 'rgba(201,211,219,0.55)', crosses = false }: Props) {
  const corner = (pos: React.CSSProperties, path: string) => (
    <svg width={size} height={size} className="absolute" style={pos} fill="none" stroke={color} strokeWidth="1">
      <path d={path} />
    </svg>
  );
  const e = size - 0.5;
  return (
    <div className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden>
      {corner({ left: inset, top: inset }, `M0.5 ${e}V0.5H${e}`)}
      {corner({ right: inset, top: inset }, `M0.5 0.5H${e}V${e}`)}
      {corner({ left: inset, bottom: inset }, `M0.5 0.5V${e}H${e}`)}
      {corner({ right: inset, bottom: inset }, `M${e} 0.5V${e}H0.5`)}
      {crosses && (
        <>
          <span className="absolute top-1/2 text-[18px] font-light leading-none text-fog/45" style={{ left: inset - 8 }}>+</span>
          <span className="absolute top-1/2 text-[18px] font-light leading-none text-fog/45" style={{ right: inset - 8 }}>+</span>
        </>
      )}
    </div>
  );
}
