"""V6 feasibility spike: BLE-pair the already-enrolled "Helios"
phone-key with the Rivian R1S.

Hypothesis being tested: BLE pairing is a one-time trust-establishment
act. After pairing, Helios's existing v5 cloud-side sendVehicleCommand
(which returned state:4/responseCode:1047 last night) starts working
because the car now recognizes our keypair as paired.

If true: v6 collapses to "run the BLE pair once" — no daemon needed.
If false: we'd need to send commands over BLE too, which requires
more lib-wrapping than bretterer ships out of the box.

Setup (one-time):
    cd app/scripts/v6-spike
    python3 -m venv .venv
    source .venv/bin/activate
    pip install 'rivian-python-client[ble]'

Run:
    cd app/scripts/v6-spike
    source .venv/bin/activate
    python3 spike.py

Pre-requisites:
    1. Run dump-creds.ts first to populate creds.json.
    2. Be physically near the car (~3m, line of sight).
    3. Car AWAKE (open the Rivian app to wake it).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("rivian").setLevel(logging.DEBUG)

CREDS_PATH = os.path.join(os.path.dirname(__file__), "creds.json")


def banner(text: str) -> None:
    bar = "=" * 70
    print(f"\n{bar}\n{text}\n{bar}\n")


def pause(prompt: str) -> None:
    input(f"\n>>> {prompt}\n>>> Press Enter when ready... ")


async def main() -> None:
    banner("Stage 0 — Load creds")
    if not os.path.exists(CREDS_PATH):
        print(f"creds.json not found at {CREDS_PATH}")
        print("Run first: cd app && npx tsx --env-file=.env.local scripts/v6-spike/dump-creds.ts")
        sys.exit(1)

    with open(CREDS_PATH) as f:
        creds = json.load(f)
    print(f"  vasPhoneId:    {creds['vas_phone_id']}")
    print(f"  vasVehicleId:  {creds['vas_vehicle_id']}")
    print(f"  identityId:    {creds['identity_id']}")
    print(f"  vehiclePubKey: {creds['vehicle_public_key'][:16]}...{creds['vehicle_public_key'][-8:]}")

    try:
        from rivian.ble import find_phone_key, pair_phone
    except ImportError as e:
        print("\nFAIL: rivian-python-client not installed.")
        print("Run: source .venv/bin/activate && pip install 'rivian-python-client[ble]'")
        print(f"({e})")
        sys.exit(1)

    banner("Stage 1 — Scan for the car's BLE peripheral")
    print("Scanning for 'Rivian Phone Key' BLE peripheral (up to ~10s)...")
    print("Needs car AWAKE and within ~3m of the laptop.")
    device = await find_phone_key()
    if device is None:
        print("\nFAIL: No 'Rivian Phone Key' device found in BLE scan.")
        print("Possible causes:")
        print("  - Car is asleep — open the Rivian app to wake it, retry")
        print("  - Out of BLE range — move within ~3m, line of sight")
        print("  - macOS Bluetooth permission for Terminal not granted —")
        print("    System Settings → Privacy & Security → Bluetooth")
        sys.exit(1)
    print(f"FOUND device: {device.name} @ {device.address}")

    banner("Stage 2 — In the Rivian app, tap 'Set Up' on Helios")
    print("In the Rivian app right NOW:")
    print("  1. Open Account / Settings → Phone Keys")
    print("  2. Find the 'Helios' entry")
    print("  3. Tap 'Set Up' on it (NOT 'Remove')")
    print("  4. App will prompt you to bring the device close — that's the cue.")
    print("")
    print("Don't dismiss the app prompt. Keep it on screen.")
    pause("Tap 'Set Up' in the Rivian app, then press Enter here.")

    banner("Stage 3 — BLE pair_phone()")
    print("Initiating BLE pairing handshake...")
    try:
        ok = await pair_phone(
            device=device,
            phone_id=creds["vas_phone_id"],
            vas_vehicle_id=creds["vas_vehicle_id"],
            vehicle_key=creds["vehicle_public_key"],
            private_key=creds["private_key_b64"],
        )
    except Exception as e:
        print(f"\nFAIL: pair_phone raised: {e}")
        print("Common causes:")
        print("  - 'Set Up' wasn't active when we tried to handshake — re-tap and retry")
        print("  - Vehicle ID mismatch in creds.json — re-run dump-creds.ts")
        print("  - macOS BLE caching weirdness — toggle Bluetooth off/on, retry")
        sys.exit(1)
    if not ok:
        print("\nFAIL: pair_phone() returned False.")
        print("Connection succeeded but the cryptographic handshake didn't validate.")
        print("Most likely cause: keypair / vehicle-id mismatch.")
        sys.exit(1)
    print("\n✓ BLE PAIRED. The car now trusts our keypair.")
    print("  In the Rivian app, the 'Helios' entry should now show as paired")
    print("  (no longer offering 'Set Up').")

    banner("Stage 4 — VERIFY the cloud command path now works")
    print("Up to now we proved BLE pairing works. The bigger question:")
    print("does pairing make Helios's existing v5 cloud-side STOP_CHARGING")
    print("start working? (Last night it returned state:4/responseCode:1047.)")
    print("")
    print("MAKE SURE the car is plugged in and actively drawing > 1 kW.")
    print("If it's not, plug in / start charging via the Rivian app first.")
    print("")
    print("Then in a SECOND terminal (keep this one open), run:")
    print("")
    print("    cd ~/Projects/Helios/app")
    print("    npx tsx --env-file=.env.local scripts/test-rivian-stop.ts")
    print("")
    print("Then watch the Rivian app or run:")
    print("")
    print("    npx tsx scripts/test-rivian-watch.ts")
    print("")
    print("Expected if hypothesis holds: stopCharging returns success: true")
    print("AND ev_w drops to ~0 within ~10s. Earlier today it returned")
    print("success but ev_w stayed at 11.4 kW — that's the comparison.")
    print("")
    pause("Run the test-rivian-stop.ts in another terminal, watch result, then come back.")

    banner("Tell me what you saw")
    print("Three possible outcomes:")
    print("")
    print("  GO++  stopCharging returned success: true AND the car physically stopped")
    print("        within ~10s. → BLE pairing carries over to cloud commands.")
    print("        v6 collapses to just this pairing step + push v5. WIN.")
    print("")
    print("  GO    stopCharging returned success but ev_w didn't drop. Same as")
    print("        last night. → Pairing alone isn't enough; cloud commands still")
    print("        require something more. v6 needs BLE-command-send too.")
    print("        Harder, but still buildable.")
    print("")
    print("  NO-GO Pairing failed (we wouldn't have reached this stage), OR")
    print("        the cloud command returned a new error class. Document &")
    print("        re-evaluate.")
    print("")
    print("After this: tell Claude what you saw, and we plan accordingly.")


if __name__ == "__main__":
    asyncio.run(main())
