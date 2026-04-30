"use client";

import type { StatusResponse } from "@/lib/types";

type Props = {
  sources: StatusResponse["sources"];
  /** Display-only compute paths that threw during status assembly
   *  (self_sufficiency rollup, costs, EV source split, etc). */
  assembly_errors?: string[];
};

/**
 * Trust signal for the dashboard header. Renders nothing in the happy
 * path (every power-flow source is live + no derived-field errors) so
 * it stays out of the way most of the time. When a provider goes
 * "unavailable" (configured + attempted + threw), or a derived-field
 * compute path throws, we show a small alert chip. Hover surfaces the
 * detail; the aria-label dictates the full state for screen readers.
 *
 * We do NOT render for "mock" status — that's the public-demo baseline
 * (no providers connected) and shipping a permanent warning chip on a
 * recruiter-facing dashboard is just noise. Cron + preview-decision
 * still treat mock as untrusted at the engine level; the dashboard is
 * the only place where the "demo viewer with no Tesla" audience exists,
 * and they don't benefit from the alert.
 *
 * Companion to FreshnessIndicator. Freshness = "is the fetch recent."
 * Health = "is the underlying data real." Both can be true, both can be
 * false; pairing them in the header makes the two questions answerable
 * at a glance.
 */
export function DataHealthBadge({ sources, assembly_errors }: Props) {
  const issues = collectIssues(sources, assembly_errors);
  if (issues.length === 0) return null;

  const primary = issues[0];
  const moreCount = issues.length - 1;
  const tooltip = issues.map((i) => i.detail).join("\n");
  const aria = `Data health: ${issues.map((i) => i.label).join(", ")}`;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] font-medium px-2 py-0.5 rounded-full"
      style={{
        background: "color-mix(in srgb, var(--alert) 12%, transparent)",
        color: "var(--alert)",
        border: "0.5px solid color-mix(in srgb, var(--alert) 30%, transparent)",
      }}
      title={tooltip}
      aria-label={aria}
    >
      <span
        className="inline-block w-[6px] h-[6px] rounded-full"
        style={{ background: "var(--alert)" }}
      />
      <span>
        {primary.label}
        {moreCount > 0 ? ` +${moreCount}` : ""}
      </span>
    </span>
  );
}

type Issue = { label: string; detail: string };

/**
 * Group `sources` entries by (provider, status) so a Tesla outage that
 * takes down solar+home+powerwall renders as one chip ("Tesla offline"),
 * not three. Then append one chip for the derived-error list.
 */
function collectIssues(
  sources: StatusResponse["sources"],
  assembly_errors: string[] | undefined,
): Issue[] {
  const out: Issue[] = [];
  const byProvider = new Map<string, string[]>();

  for (const [domain, info] of Object.entries(sources) as Array<
    [string, StatusResponse["sources"][keyof StatusResponse["sources"]]]
  >) {
    if (info.status !== "unavailable") continue;
    const key = info.provider;
    const list = byProvider.get(key) ?? [];
    list.push(domain);
    byProvider.set(key, list);
  }

  for (const [provider, domains] of byProvider) {
    const providerLabel = capitalize(provider);
    out.push({
      label: `${providerLabel} offline`,
      detail: `${providerLabel} unavailable: ${domains.join(", ")}`,
    });
  }

  if (assembly_errors && assembly_errors.length > 0) {
    out.push({
      label: `${assembly_errors.length} calc error${assembly_errors.length > 1 ? "s" : ""}`,
      detail: `Failed compute paths: ${assembly_errors.join(", ")}`,
    });
  }

  return out;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
