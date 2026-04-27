"use client";

import { useState } from "react";
import type { ConfigResponse } from "@/lib/types";

type Props = {
  config: ConfigResponse;
  onChanged: (updated: ConfigResponse) => Promise<void> | void;
};

/**
 * Master pause switch for Helios's actuators. When OFF, the cron loop
 * still observes (snapshots written, decisions logged) but never
 * fires PW reserve writes or Rivian start/stop. Use case: pre-trip,
 * leaving for vacation and want to drain PW + grid-charge the EV
 * without the engine fighting back.
 *
 * Renders prominently at the top of Settings — paused state shifts
 * to an alert color so it's hard to miss.
 */
export function AutomationToggle({ config, onChanged }: Props) {
  const enabled = config.automation_enabled !== false;
  const [busy, setBusy] = useState(false);

  async function flip() {
    if (busy) return;
    setBusy(true);
    try {
      const next = !enabled;
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ automation_enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = (await res.json()) as ConfigResponse;
      await onChanged(updated);
    } catch (err) {
      console.error("[AutomationToggle] flip failed:", err);
    } finally {
      setBusy(false);
    }
  }

  // Visual: when paused, the whole card switches to an alert background
  // so the state is impossible to miss. When active, the card is
  // subdued — automation should be the boring, default-on state.
  const paused = !enabled;

  return (
    <div
      className="h-card flex items-center gap-4"
      style={
        paused
          ? {
              background: "var(--alert-soft)",
              borderColor: "var(--alert)",
              borderWidth: 1,
              borderStyle: "solid",
            }
          : undefined
      }
    >
      <div className="flex-1 min-w-0">
        <div
          className="text-[15px] font-semibold"
          style={{ color: paused ? "var(--alert)" : "var(--text-primary)" }}
        >
          {paused ? "Helios is paused" : "Helios automation"}
        </div>
        <div className="text-[12.5px] text-text-secondary mt-0.5 leading-relaxed">
          {paused
            ? "Engine isn't writing Powerwall reserve or Rivian charge schedules. Manual control until re-enabled."
            : "Engine manages Powerwall reserve and EV charging on a 5-min loop."}
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? "Pause Helios" : "Resume Helios"}
        onClick={flip}
        disabled={busy}
        className="relative shrink-0 w-12 h-7 rounded-full transition-colors disabled:opacity-50"
        style={{
          background: enabled ? "var(--battery)" : "var(--text-tertiary)",
        }}
      >
        <span
          className="absolute top-[3px] left-[3px] w-[22px] h-[22px] rounded-full bg-white transition-transform"
          style={{
            transform: enabled ? "translateX(20px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}
