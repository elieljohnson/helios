# Screenshots

Drop screenshots here using the filenames referenced in the case studies. Suggested captures, in priority order:

## Core dashboard

| Filename | What it should show |
|---|---|
| `01-dashboard-100pct.png` | Home page with "100% self-sufficient today" headline, supply/demand bars visible, cost card showing $0.00. Captured on a sunny day around noon. The supply/demand chart should reconcile (no imbalance warning). |
| `02-recommendation-banner.png` | Dashboard with the RecommendationBanner visible — engine recommending "Stop EV charging" or "Start EV charging" with a one-tap link to the Rivian app. Captured during a real recommendation event. |
| `02-supply-demand-balance.png` | Close-up of the supply/demand bar chart with both halves visibly balancing. Shows House + Rivian + Powerwall on the right sides. Confirms the conservation invariant visually. |
| `04-activity-log.png` | Activity page showing the chronological list of automated decisions — reserve changes, EV recommendations, alarm pushes, with reasoning text visible. Recent entries should include the signature dedup pattern in action (no duplicate adjacent entries). |
| `04-activity-page.png` | Full Activity page with the self-sufficiency chart at top and the action feed below. Captured on a day with at least one Gate 1d alarm or Gate 2.5 limit-raise event in the feed. |

## Interaction details

| Filename | What it should show |
|---|---|
| `05-drag-to-scrub.png` | Self-Sufficiency history chart mid-scrub. Tooltip floating above an interior bar, non-active bars dimmed to 45%, the dashed vertical guideline visible at the active bar's center. iPhone capture preferred — the touch interaction is the point. |
| `05-morning-bridge.png` | Activity log showing the morning bridge engaging (reserve lowered to 10%) and disengaging (reserve back to 20%) within a single morning. The two adjacent reserve-action entries with their reasoning text. |
| `06-tab-bar-elevation.png` | Close-up of the floating tab bar at the bottom of the screen. Shows the 1px stroke at ~18% black and the three-layer drop shadow against the warm cream background. |

## Settings + integrations

| Filename | What it should show |
|---|---|
| `03-pre-departure-settings.png` | Settings page scrolled to the "Pre-departure charge" section, showing the surplus forecast threshold and morning PW floor inputs. |
| `05-settings-notifications.png` | Settings page's Notifications card with the subscribe / test buttons. After subscribe: the success state with the device row visible. |
| `06-integrations-readonly.png` | Integrations card with the "Why read-only" callout visible for the Rivian row (pointing at the Apple Car Key pairing constraint). |

## Mobile / push

| Filename | What it should show |
|---|---|
| `03-iphone-push-notification.png` | iPhone lock screen showing a Helios push notification — title, body, app icon. The "Stop EV charging now" copy with the actionable detail visible. |
| `07-skeleton-loading.png` | Dashboard mid-load with the six-card skeleton silhouette visible. Capture as a still; the diagonal shimmer is more legible frozen than in motion. |
| `08-cost-card-peak.png` | The Cost Today card during peak hours, showing the $0.58/kWh rate and "next transition" countdown. |

## Capture notes

- **Format**: PNG preferred for crisp UI screenshots.
- **Width**: ≤ 1200 px for desktop captures; native iPhone resolution for mobile.
- **Compression**: If over 2 MB, run through TinyPNG before committing.
- **Privacy**: The dashboard sometimes shows the home's precise coords in the System card; either crop those out or capture in incognito mode (public visitor view redacts the coords automatically).
- **Theme**: All captures should be in the production light theme (warm cream background). The app doesn't ship a dark mode yet.

## Current status

As of 2026-05-19, this folder contains only this README. Every `![…](screenshots/…)` reference in the case studies is a placeholder waiting for the actual capture. The case studies link to working diagrams in `docs/diagrams/`; those exist and render. Screenshots are the gap.
