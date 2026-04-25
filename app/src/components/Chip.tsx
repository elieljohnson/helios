export type ChipProps = {
  color: string;
  label: string;
  value?: string;
};

export function Chip({ color, label, value }: ChipProps) {
  return (
    <span className="chip">
      <span className="dot" style={{ background: color }} />
      <span>{label}</span>
      {value && <span className="val">{value}</span>}
    </span>
  );
}
