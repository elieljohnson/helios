"use client";

// Edit form for the sunset-aware EV charging policy. Holds a local draft
// of ConfigResponse, computes a dirty diff vs. server, and POSTs only
// the changed fields. Parent passes mutateConfig + mutatePreview so save
// triggers refresh of both SWR sources.

import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import type { ConfigResponse } from "@/lib/types";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Props = {
  config: ConfigResponse;
  onSaved: (updated: ConfigResponse) => void;
  /** When true, the Save button becomes a "Sign in to save" link. The
   *  inputs themselves stay interactive so portfolio visitors can feel
   *  the form respond to changes — but mutations require admin auth.
   *  Server-side proxy.ts enforces the actual gate. */
  readOnly?: boolean;
};

export function EvPolicyForm({ config, onSaved, readOnly }: Props) {
  const [draft, setDraft] = useState<ConfigResponse>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the upstream config changes (e.g., another tab saved), reset the
  // draft to match — but only when not actively saving.
  useEffect(() => {
    if (!saving) setDraft(config);
  }, [config, saving]);

  const dirty = !shallowEq(draft, config);

  const update = <K extends keyof ConfigResponse>(key: K, value: ConfigResponse[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const toggleDay = (i: number) => {
    const next = [...draft.parked_schedule];
    next[i] = !next[i];
    update("parked_schedule", next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes = diff(draft, config);
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as ConfigResponse;
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(config);
    setError(null);
  };

  return (
    <Card signal="var(--vehicle)" label="EV charging policy">
      {/* Numeric thresholds */}
      <div className="space-y-3">
        <NumberRow
          label="PW target at sunset−buffer"
          help="Battery SoC the engine reserves for overnight. Mill Valley empirics: 80% gets through the night."
          value={draft.pw_sunset_target_pct}
          onChange={(v) => update("pw_sunset_target_pct", v)}
          unit="%"
          min={0}
          max={100}
          step={5}
        />
        <NumberRow
          label="EV minimum SoC"
          help="Floor that triggers the off-peak grid backstop overnight."
          value={draft.ev_min_pct}
          onChange={(v) => update("ev_min_pct", v)}
          unit="%"
          min={0}
          max={100}
          step={5}
        />
        <NumberRow
          label="Sunset buffer"
          help="Hours before sunset at which the cutoff locks."
          value={draft.sunset_buffer_hours}
          onChange={(v) => update("sunset_buffer_hours", v)}
          unit="hours"
          min={0}
          max={6}
          step={0.25}
        />
      </div>

      {/* Parked schedule */}
      <div className="border-t border-hairline mt-5 pt-5">
        <div className="flex items-baseline justify-between mb-2.5">
          <div>
            <div className="text-[15px] font-medium text-text-primary">
              Days parked at home
            </div>
            <div className="text-[11.5px] text-text-tertiary mt-0.5">
              Charging is only possible on parked days. Tue/Wed/Thu off by default.
            </div>
          </div>
        </div>
        <div className="flex gap-1.5">
          {DAYS.map((d, i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleDay(i)}
              aria-label={`${DAY_NAMES[i]} ${draft.parked_schedule[i] ? "parked" : "away"}`}
              aria-pressed={draft.parked_schedule[i]}
              className="w-9 h-9 rounded-full mono text-[12px] font-semibold border transition-colors"
              style={{
                background: draft.parked_schedule[i] ? "var(--text-primary)" : "var(--surface-card)",
                color: draft.parked_schedule[i] ? "var(--surface-card)" : "var(--text-secondary)",
                borderColor: "var(--hairline)",
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Pre-departure charge — relaxation of the parked-day hard-stop */}
      <div className="border-t border-hairline mt-5 pt-5">
        <div className="mb-3">
          <div className="text-[15px] font-medium text-text-primary">
            Pre-departure charge
          </div>
          <div className="text-[11.5px] text-text-tertiary mt-0.5 leading-relaxed">
            On non-parked days, allow morning EV charging if BOTH today&apos;s
            forecast clears the surplus threshold AND PW is above the morning
            floor. Either condition false → existing &quot;not a parked day&quot;
            hard-stop applies.
          </div>
        </div>
        <div className="space-y-3">
          <NumberRow
            label="Surplus forecast threshold"
            help="Today's daily kWh forecast must be at or above this for the pre-departure relaxation. Below = day is too uncertain to spare solar for EV."
            value={draft.surplus_forecast_kwh}
            onChange={(v) => update("surplus_forecast_kwh", v)}
            unit="kWh"
            min={0}
            max={100}
            step={5}
          />
          <NumberRow
            label="Morning PW floor"
            help="PW SoC must be at or above this. Below = refilling PW takes priority over pre-charging the car."
            value={draft.morning_pw_floor_pct}
            onChange={(v) => update("morning_pw_floor_pct", v)}
            unit="%"
            min={0}
            max={100}
            step={5}
          />
        </div>
      </div>

      {/* Backstop */}
      <div className="border-t border-hairline mt-5 pt-5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-medium text-text-primary">
              Off-peak grid backstop
            </div>
            <div className="text-[11.5px] text-text-tertiary mt-0.5 leading-relaxed">
              Allow overnight grid charging when EV is below the floor and tomorrow&apos;s
              solar is also weak. Off-peak only — never during peak.
            </div>
          </div>
          <Toggle
            on={draft.backstop_enabled}
            onChange={(v) => update("backstop_enabled", v)}
            ariaLabel="Backstop enabled"
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11.5px] text-text-secondary flex-1">
            Skip backstop until
          </span>
          <input
            type="date"
            value={draft.backstop_disabled_until ?? ""}
            onChange={(e) => update("backstop_disabled_until", e.target.value || null)}
            className="mono text-[12px] px-2 py-1 rounded-[8px] border bg-surface-card text-text-primary"
            style={{ borderColor: "var(--hairline)" }}
          />
          {draft.backstop_disabled_until && (
            <button
              type="button"
              onClick={() => update("backstop_disabled_until", null)}
              className="text-[11px] uppercase tracking-[0.06em] text-text-tertiary px-2 py-1 hover:text-text-secondary"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Save bar — flips to a "Sign in to save" link in read-only demo. */}
      <div className="border-t border-hairline mt-5 pt-4 flex items-center gap-3">
        {readOnly ? (
          <a
            href="/admin/login?redirect=/settings"
            className="px-4 py-2 rounded-[12px] text-[15px] font-medium transition-colors"
            style={{
              background: "var(--surface-card)",
              color: "var(--text-primary)",
              border: "1px solid var(--hairline)",
            }}
          >
            Sign in to save
          </a>
        ) : (
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-2 rounded-[12px] text-[15px] font-medium transition-colors"
            style={{
              background: "var(--surface-card)",
              color: dirty ? "var(--text-primary)" : "var(--text-tertiary)",
              border: "1px solid var(--hairline)",
              cursor: dirty && !saving ? "pointer" : "not-allowed",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
        {!readOnly && dirty && !saving && (
          <button
            type="button"
            onClick={cancel}
            className="text-[12px] uppercase tracking-[0.06em] text-text-tertiary hover:text-text-secondary"
          >
            cancel
          </button>
        )}
        {error && (
          <span className="text-[12px]" style={{ color: "var(--alert)" }}>
            {error}
          </span>
        )}
        {!readOnly && !dirty && !error && (
          <span className="text-[11px] text-text-tertiary mono">no pending changes</span>
        )}
        {readOnly && dirty && (
          <span className="text-[11px] text-text-tertiary mono">
            preview only — changes won&apos;t persist
          </span>
        )}
      </div>
    </Card>
  );
}

// --- helpers --------------------------------------------------------

function NumberRow({
  label,
  help,
  value,
  onChange,
  unit,
  min,
  max,
  step,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-medium text-text-primary">{label}</div>
        {help && (
          <div className="text-[11.5px] text-text-tertiary mt-0.5 leading-relaxed">
            {help}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n)) onChange(n);
          }}
          className="mono text-[14px] w-[68px] px-2 py-1 rounded-[8px] border text-right bg-surface-card text-text-primary"
          style={{ borderColor: "var(--hairline)" }}
        />
        <span className="text-[11.5px] text-text-tertiary w-[42px]">{unit}</span>
      </div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className="relative w-[40px] h-[22px] rounded-full transition-colors flex-shrink-0 border"
      style={{
        background: on ? "var(--text-primary)" : "var(--surface-inset)",
        borderColor: "var(--hairline)",
      }}
    >
      <span
        className="absolute top-[2px] w-[16px] h-[16px] rounded-full transition-transform"
        style={{
          left: 2,
          background: "var(--surface-card)",
          transform: on ? "translateX(18px)" : "translateX(0)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)",
        }}
      />
    </button>
  );
}

function shallowEq(a: ConfigResponse, b: ConfigResponse): boolean {
  const keys = Object.keys(a) as (keyof ConfigResponse)[];
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

function diff(draft: ConfigResponse, base: ConfigResponse): Partial<ConfigResponse> {
  const out: Partial<ConfigResponse> = {};
  const keys = Object.keys(draft) as (keyof ConfigResponse)[];
  for (const k of keys) {
    const dv = draft[k];
    const bv = base[k];
    if (Array.isArray(dv) && Array.isArray(bv)) {
      const same =
        dv.length === bv.length && dv.every((x, i) => x === bv[i]);
      if (!same) (out as Record<string, unknown>)[k] = dv;
    } else if (dv !== bv) {
      (out as Record<string, unknown>)[k] = dv;
    }
  }
  return out;
}
