# Drag-to-scrub chart pattern (React + Pointer Events)

A portable spec for the touch-and-drag scrubber over a discrete bar / list chart, with optional haptics. Lifted from `rauno.me/craft/graph-slider` and adapted for bar charts in Helios. This document is structured as a self-contained brief for a fresh Claude Code session — paste it whole.

---

## The goal

Build a chart (bar chart, line chart, list of dots, whatever discretely-indexed visual you have) where the user can:

1. **Tap** a single item → pins a tooltip showing that item's value.
2. **Touch-and-drag** across the chart → the tooltip follows the finger in real time, snapping bar-by-bar. Visual feedback (dim non-active items, optional guideline) makes the scrub feel locked-on.
3. **Tap outside** → dismiss. Including tap on the tooltip itself or on any reserved whitespace around the chart.
4. **Tap the currently-pinned item** → toggle off.
5. On platforms that support it: **one haptic tap per item** crossed during drag.

Works for mouse on desktop (hover-to-preview + click-and-drag-to-scrub) and touch on mobile, via the unified Pointer Events API.

---

## The honest constraint: iOS haptics

`navigator.vibrate()` — the Web Vibration API — **does not work in iOS Safari or iOS PWAs**. Apple has never shipped it. As of iOS 26 there's still no Web API to drive the Taptic Engine from a PWA. On Android Chrome the same API works.

You have three choices:

1. **Ship the visual-only scrubber.** Haptics no-op on iOS, work on Android. The motion + visual feedback alone feel great — this is what Helios shipped.
2. **The hidden `<input type="range">` shim.** Stack an invisible range slider over the chart with `step="1"`. iOS triggers Taptic when the slider crosses each step. The chart renders normally; you read the slider value to drive the highlight. **This is the only known way to get iOS Taptic in a PWA.** It works but is fragile across iOS versions and the hidden thumb is awkward to style.
3. **Skip the scrubber entirely** if haptics are non-negotiable. Not recommended.

**Recommended path: option 1.** Ship the clean version first, use it for a day on iOS, and only consider option 2 if the lack of buzz is a real problem in practice.

---

## Architecture (the why behind each choice)

### Use Pointer Events, not Touch Events

Pointer Events unify mouse + touch + pen into one event model. Touch Events are legacy on iOS and Android, fragmented, and don't play well with mouse on desktop. A single `onPointerDown/Move/Up/Cancel` set handles every input device.

### Use `setPointerCapture` after pointerdown

Without capture, if the user's finger drifts a few pixels outside the chart's bounding box during a scrub, `pointermove` stops firing. With capture, the chart "owns" that pointer for the duration of the drag and continues to receive move events even if the finger leaves the element. This is the single change that makes the scrub feel solid instead of fragile.

```ts
e.currentTarget.setPointerCapture(e.pointerId);
```

Release on `pointerup` and `pointercancel`.

### Use `touch-action: none` on the scrub surface

Without this, a vertical finger movement during a horizontal scrub will scroll the page. `touch-action: none` tells the browser "this element handles all touch gestures itself — don't try to scroll." Apply it only to the scrub surface (the SVG overlay, ~120px tall), not the whole page — otherwise you've taken page scroll hostage.

```css
touch-action: none;
```

### Tap-vs-drag heuristic: 4px dead zone

A "tap" that drifts 1-2px on a high-DPI screen is still semantically a tap. A "drag" deliberately moves the finger. Distinguish them with a small dead zone — if the pointer moves >4px from where it landed, treat as drag. Otherwise it's a tap.

```ts
const dx = Math.abs(e.clientX - start.x);
const dy = Math.abs(e.clientY - start.y);
if (dx > 4 || dy > 4) setIsDragging(true);
```

Tap behavior: pin (or toggle off if already pinned). Drag behavior: scrub through items.

### Dismiss handler must scope to the visible chart surface, not the wrapper

**The bug we hit in Helios:** the tooltip floats in a reserved padding zone above the chart (so finger doesn't occlude). The outer wrapper div spans the padding + the chart. If your dismiss check uses `wrapper.contains(target)`, taps in the padding count as "inside" and don't dismiss. **Scope to the actual visible chart surface** (in our case, the SVG element):

```ts
useEffect(() => {
  if (selected == null) return;
  const handler = (e: PointerEvent) => {
    if (svgRef.current && !svgRef.current.contains(e.target as Node)) {
      setSelected(null);
    }
  };
  document.addEventListener("pointerdown", handler);
  return () => document.removeEventListener("pointerdown", handler);
}, [selected]);
```

The tooltip has `pointer-events: none` so taps on the tooltip pass through to whatever's beneath. If that "beneath" is also outside the chart surface (e.g. the wrapper's padding), the tap correctly dismisses. This matches native iOS popover behavior — tap the popover or anywhere outside to close.

### Unified pointer overlay, not per-item handlers

Old design: each bar gets its own invisible hit target with `onClick` + `onMouseEnter/Leave`. To support continuous scrubbing across all bars, route every pointer event through one big transparent rect that covers the entire plot area. Calculate the active item from `clientX` relative to the overlay's bounding rect:

```ts
function indexFromClientX(clientX: number): number | null {
  const el = overlayRef.current;
  if (!el || items.length === 0) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return null;
  const fraction = (clientX - rect.left) / rect.width;
  const i = Math.floor(fraction * items.length);
  return Math.max(0, Math.min(items.length - 1, i));
}
```

Use the bounding-rect math (CSS pixels), not SVG viewBox units — the math survives any responsive scaling the framework applies.

### Haptic stub on bar-change

```ts
navigator.vibrate?.(8);
```

Eight milliseconds. Optional chaining because iOS Safari doesn't expose `vibrate`. Fire only when the active index changes (not on every pointermove) — track `lastIndexRef` to gate.

### Render a scrub guideline only during active drag

A thin dashed vertical line at the active item's center, fading in on pointerdown-with-drag and out on pointerup. It reads as a "scrub cursor" affordance, not permanent chrome.

```tsx
{isDragging && active != null && (
  <line
    x1={activeXCoordinate}
    x2={activeXCoordinate}
    y1={top}
    y2={bottom}
    stroke="currentColor"
    strokeWidth="1"
    strokeDasharray="2 3"
    opacity={0.45}
    style={{ pointerEvents: "none" }}
  />
)}
```

---

## The complete component (generic version)

Drop-in starting point. Adapt the `Item` type and the chart-specific math to your data.

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

type Item = {
  label: string;
  value: number;
  // ... your fields
};

type Props = { items: Item[] };

export function ScrubbableChart({ items }: Props) {
  // ---- chart geometry — adapt to your visual ----
  const W = 640;
  const H = 120;
  const padL = 28;
  const padR = 4;
  const padY = 8;
  const usableW = W - padL - padR;
  const usableH = H - padY * 2;
  const itemW = usableW / Math.max(items.length, 1);

  // ---- selection model ----
  // selected   = pinned via tap (sticky until dismiss)
  // hovered    = mouse-only preview (transient)
  // isDragging = currently scrubbing (controls guideline visibility)
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const active = selected ?? hovered;

  // ---- refs ----
  const svgRef = useRef<SVGSVGElement | null>(null);
  const overlayRef = useRef<SVGRectElement | null>(null);
  const prevSelectedRef = useRef<number | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);

  // ---- outside-tap dismiss ----
  // Scoped to the SVG, not any outer wrapper, so taps in reserved
  // padding (where the tooltip floats) correctly count as outside.
  useEffect(() => {
    if (selected == null) return;
    const handler = (e: PointerEvent) => {
      if (svgRef.current && !svgRef.current.contains(e.target as Node)) {
        setSelected(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selected]);

  // ---- pointer → index ----
  function indexFromClientX(clientX: number): number | null {
    const el = overlayRef.current;
    if (!el || items.length === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    const fraction = (clientX - rect.left) / rect.width;
    const i = Math.floor(fraction * items.length);
    return Math.max(0, Math.min(items.length - 1, i));
  }

  // ---- pointer handlers ----
  function onPointerDown(e: React.PointerEvent<SVGRectElement>) {
    if (!e.isPrimary) return; // ignore second finger in multi-touch
    const idx = indexFromClientX(e.clientX);
    if (idx == null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    prevSelectedRef.current = selected;
    tapStartRef.current = { x: e.clientX, y: e.clientY };
    lastIndexRef.current = idx;
    setIsDragging(false);
    setSelected(idx);
  }

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const captured = e.currentTarget.hasPointerCapture(e.pointerId);
    if (!captured) {
      if (e.pointerType === "mouse") setHovered(indexFromClientX(e.clientX));
      return;
    }
    const start = tapStartRef.current;
    if (start && !isDragging) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 4 || dy > 4) setIsDragging(true);
    }
    const idx = indexFromClientX(e.clientX);
    if (idx != null && idx !== lastIndexRef.current) {
      lastIndexRef.current = idx;
      setSelected(idx);
      navigator.vibrate?.(8); // no-op on iOS Safari, tap on Android
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGRectElement>) {
    const wasDrag = isDragging;
    const wasAlreadySelected = prevSelectedRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Tap on already-pinned bar → toggle off. Drag-back-to-same-bar
    // does NOT toggle off (the user just finished scrubbing).
    if (!wasDrag) {
      const idx = indexFromClientX(e.clientX);
      if (idx != null && idx === wasAlreadySelected) setSelected(null);
    }
    setIsDragging(false);
    tapStartRef.current = null;
  }

  function onPointerLeave(e: React.PointerEvent<SVGRectElement>) {
    if (e.pointerType === "mouse") setHovered(null);
  }

  function onPointerCancel(e: React.PointerEvent<SVGRectElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    tapStartRef.current = null;
  }

  // ---- tooltip reserved space ----
  // Above the chart so the user's finger never occludes the value.
  // Tune for your tooltip's height + breathing room.
  const TOOLTIP_RESERVE_PX = 72;

  return (
    <div className="relative" style={{ paddingTop: TOOLTIP_RESERVE_PX }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
      >
        {/* Render your bars / dots / lines here. Each must have
            `pointerEvents: "none"` so events route to the overlay. */}
        {items.map((it, i) => {
          const h = (it.value / 100) * usableH;
          const x = padL + i * itemW + 1;
          const y = padY + (usableH - h);
          const w = Math.max(2, itemW - 2);
          const isActive = active === i;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={Math.max(1, h)}
              rx={2}
              fill="currentColor"
              opacity={active != null && !isActive ? 0.45 : 1}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* Scrub guideline — only during active drag. */}
        {isDragging && active != null && (
          <line
            x1={padL + active * itemW + itemW / 2}
            x2={padL + active * itemW + itemW / 2}
            y1={padY}
            y2={padY + usableH}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity={0.45}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Unified pointer overlay. */}
        <rect
          ref={overlayRef}
          x={padL}
          y={padY}
          width={usableW}
          height={usableH}
          fill="transparent"
          style={{ cursor: "pointer", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onPointerCancel={onPointerCancel}
        />
      </svg>

      {/* Tooltip — HTML, absolutely positioned, pointer-events: none.
          Position math: percentage of the chart width to the active
          bar's CENTER. Translate up so the bottom of the tooltip sits
          ~8px above the SVG's top edge. */}
      {active != null && items[active] && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: `${((padL + active * itemW + itemW / 2) / W) * 100}%`,
            top: TOOLTIP_RESERVE_PX,
            transform: "translate(-50%, calc(-100% - 8px))",
          }}
        >
          {/* Your tooltip markup */}
          <div className="px-2.5 py-1.5 rounded-lg bg-white shadow-sm whitespace-nowrap">
            <div className="text-xs opacity-60">{items[active].label}</div>
            <div className="text-sm font-semibold">{items[active].value}%</div>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Adapting this to your app

Things to swap when porting to a different chart:

1. **Item type and value formatting** — the example uses `{ label, value }` with `value` as a 0–100 percentage. Yours might be currency, distance, wave height, whatever. Update the tooltip render + the y-axis mapping in your render code.
2. **Chart geometry** — `W`, `H`, `padL`, `padR`, `padY`, `usableW`, `usableH`, `itemW` — set to fit your visual. The pointer-to-index math only cares about `items.length` and the overlay's bounding rect.
3. **Bar / dot / line rendering** — replace the `<rect>` per item with whatever your chart needs. Keep `pointerEvents: "none"` on every visual element so events all route to the overlay.
4. **Reserved tooltip space** — `TOOLTIP_RESERVE_PX = 72` fits a 3-line tooltip. If your tooltip is taller / shorter, tune.
5. **Tooltip styling** — generic Tailwind classes in the example. Use your design system tokens.
6. **Outside-tap dismiss target** — `svgRef` works for an SVG chart. For a `<canvas>` or DOM-based chart, use whatever element constitutes "the chart itself" (not the outer wrapper).
7. **Colors / dimming** — the example uses `currentColor` and a 0.45 dim opacity. Match your design system.

---

## Tuning knobs (after first build)

| Knob | Default | Effect |
|---|---|---|
| Dead-zone radius for tap-vs-drag | 4px | Higher = more tolerant of finger jitter on tap. Lower = more sensitive to start scrubbing. 4-8 is the practical range. |
| `navigator.vibrate(X)` duration | 8ms | Higher = stronger buzz on Android. Above ~15ms starts to feel laggy. |
| Guideline opacity | 0.45 | Higher = more visible scrub cursor. Lower = quieter affordance. |
| `TOOLTIP_RESERVE_PX` | 72px | Match your tooltip's actual height + breathing room. |
| Dim opacity on non-active bars | 0.45 | Lower = stronger focus on active bar. 0.3-0.6 is the practical range. |
| Tooltip slide transition | none | Add `transition: left 80ms ease-out` on the tooltip for smoother scrub feel. Can fight responsiveness if user scrubs fast. |

---

## Things to NOT do (lessons from the build)

1. **Don't use Touch Events.** Pointer Events handle mouse + touch + pen with one model. Touch Events are legacy and fragmented across iOS / Android.
2. **Don't forget `setPointerCapture`.** Without it, the scrub falls apart at the edges of the chart — finger drifts a few pixels off and pointermove stops firing.
3. **Don't put `touch-action: none` on a big area.** Scoped to the chart overlay (~120px tall) is fine. On the whole page it would kill all scrolling.
4. **Don't use a wrapper-scoped dismiss handler when your tooltip lives in reserved padding.** The wrapper includes the padding; taps there register as "inside" and skip dismissal. Scope to the actual visible chart surface.
5. **Don't try to engineer iOS haptics via Web APIs.** Apple doesn't ship them. Accept the constraint or use the `<input type="range">` shim as an explicit feature, not a workaround that's expected to "just work."
6. **Don't render per-item hit targets if you want continuous scrubbing.** One overlay rect across the whole plot area is what makes the gesture continuous.
7. **Don't fire `setSelected` on every pointermove.** Only when the active index changes. Track `lastIndexRef` to gate. Reduces React renders during fast scrubs and gates the haptic to one buzz per bar.
8. **Don't ignore `pointercancel`.** OS-level interruptions (notifications, palm rejection, system gestures) fire it. Treat it like pointerup but skip the toggle-off logic.

---

## Test plan

Manual test matrix to run after building:

- [ ] **Desktop mouse hover** previews tooltip without pinning
- [ ] **Desktop mouse click** pins tooltip; click outside dismisses
- [ ] **Desktop mouse click + drag** scrubs across bars
- [ ] **Touch tap** pins; tap outside the chart dismisses
- [ ] **Touch tap on already-pinned bar** toggles off
- [ ] **Touch tap on tooltip itself** dismisses (because tooltip has pointer-events: none)
- [ ] **Touch tap in reserved padding above chart** dismisses
- [ ] **Touch-and-drag** scrubs across bars, tooltip follows
- [ ] **Drag finger off the chart edge mid-scrub** — scrub continues (pointer capture works)
- [ ] **Vertical finger movement on the chart** — does NOT scroll the page (touch-action: none)
- [ ] **Multi-touch (two fingers)** — second finger is ignored (e.isPrimary check)
- [ ] **OS interrupt mid-scrub (notification)** — pointer state cleans up (pointercancel handled)
- [ ] **Android device** — feel the haptic tap per bar crossed
- [ ] **iOS device** — silent scrub, visual feedback still works

---

## Reference

- Rauno's original: https://rauno.me/craft/graph-slider
- W3C Pointer Events spec: https://www.w3.org/TR/pointerevents3/
- MDN Pointer Capture: https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture
- MDN touch-action: https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action

---

## License / attribution

This pattern is not novel — it's a synthesis of Pointer Events best practices, Rauno's craft, and standard mobile-UX conventions. Use freely. Credit Rauno for the canonical reference.
