import type { ReactNode } from "react";

export type CardProps = {
  signal: string;
  label: string;
  title?: string;
  spark?: string;
  children: ReactNode;
};

export function Card({ signal, label, title, spark, children }: CardProps) {
  return (
    <div className="h-card">
      <div className="h-card-head">
        <span className="label">{label}</span>
        {title && (
          <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 6 }}>
            · {title}
          </span>
        )}
        {spark && <span className="spark">{spark}</span>}
      </div>
      {children}
    </div>
  );
}
