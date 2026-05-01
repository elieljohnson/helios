// Dashboard skeleton. Shown while /api/status is in flight so the
// page paints immediately with the real layout instead of a blank
// "loading…" state.
//
// Each card here mirrors the structure of its real counterpart
// (HeroCard, CostCard, SolarCard, EVCard, PowerwallCard, ForecastCard)
// closely enough that the layout doesn't shift when data arrives —
// signal dot + label header up top, rough silhouette of the body
// below. Header labels are rendered as text (cheap, matches real
// content) while values shimmer.
//
// Why six fixed cards rather than a generic loop: card sizes vary
// (HeroCard's number is huge, ForecastCard has a chart strip), so a
// generic shimmer would either be too uniform (reads as fake) or
// require parameterizing every card's size. Hand-tuning each one
// matches the real grid for free.

import { Skeleton } from "./Skeleton";

export function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <SkeletonCard signal="var(--battery)" label="Optimized · Self-Sufficient Today">
        <Skeleton width={180} height={64} radius={8} />
        <div className="mt-4 space-y-3">
          <SkeletonRow label="Supply" />
          <SkeletonRow label="Demand" />
        </div>
      </SkeletonCard>

      <SkeletonCard signal="var(--alert)" label="Cost Today">
        <Skeleton width={160} height={56} radius={8} />
        <div className="mt-3">
          <Skeleton width={220} height={12} />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div>
            <Skeleton width={70} height={10} />
            <div className="mt-1.5"><Skeleton width={60} height={18} /></div>
          </div>
          <div>
            <Skeleton width={70} height={10} />
            <div className="mt-1.5"><Skeleton width={60} height={18} /></div>
          </div>
        </div>
      </SkeletonCard>

      <SkeletonCard signal="var(--solar)" label="Solar">
        <div className="flex items-baseline gap-2">
          <Skeleton width={90} height={48} radius={8} />
          <Skeleton width={40} height={14} />
        </div>
        <div className="mt-3">
          <Skeleton width={120} height={12} />
        </div>
        {/* Sun-arc histogram silhouette */}
        <div className="mt-5 flex items-end gap-1 h-[64px]">
          {[10, 22, 38, 50, 58, 60, 58, 50, 38, 22, 10].map((h, i) => (
            <Skeleton
              key={i}
              width="100%"
              height={`${h}%`}
              radius={3}
              style={{ flex: 1, minWidth: 0 }}
            />
          ))}
        </div>
      </SkeletonCard>

      <SkeletonCard signal="var(--vehicle)" label="Rivian R1S">
        <div className="flex items-center gap-4">
          {/* Donut silhouette */}
          <Skeleton width={68} height={68} radius={"50%"} />
          <div className="flex-1 space-y-2">
            <Skeleton width={40} height={12} />
            <Skeleton width={90} height={28} radius={6} />
            <Skeleton width={140} height={11} />
          </div>
        </div>
        <div className="mt-4">
          <Skeleton width="100%" height={8} radius={4} />
        </div>
      </SkeletonCard>

      <SkeletonCard signal="var(--battery)" label="Powerwall">
        <div className="flex items-center gap-4">
          <Skeleton width={68} height={68} radius={"50%"} />
          <div className="flex-1 space-y-2">
            <Skeleton width={120} height={12} />
            <Skeleton width={80} height={28} radius={6} />
            <Skeleton width={150} height={11} />
          </div>
        </div>
      </SkeletonCard>

      <SkeletonCard signal="var(--grid)" label="Forecast">
        <div className="space-y-2">
          <Skeleton width="80%" height={12} />
          <Skeleton width="60%" height={12} />
        </div>
        <div className="mt-4 flex gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex-1 space-y-1.5">
              <Skeleton width="100%" height={32} radius={6} />
              <Skeleton width="60%" height={10} />
            </div>
          ))}
        </div>
      </SkeletonCard>
    </div>
  );
}

function SkeletonCard({
  signal,
  label,
  children,
}: {
  signal: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="h-card">
      <div className="h-card-head">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: signal }} />
        <span className="label" style={{ color: signal, opacity: 0.9 }}>
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function SkeletonRow({ label }: { label: string }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span
          className="label"
          style={{ color: "var(--text-tertiary)", fontSize: 11 }}
        >
          {label}
        </span>
        <Skeleton width={50} height={12} />
      </div>
      <div className="mt-1.5">
        <Skeleton width="100%" height={20} radius={6} />
      </div>
    </div>
  );
}
