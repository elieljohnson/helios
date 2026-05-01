"""Diagnostic: list ALL visible BLE devices for ~10 seconds.
Helps confirm:
  - Bluetooth is actually working (we should see SOMETHING — your phone,
    AirPods, neighbors' devices)
  - Whether the car broadcasts under a name we can match
  - What name the car uses (might not be exactly "Rivian Phone Key")

Run: python3 scan-all.py
"""

import asyncio
from bleak import BleakScanner

SCAN_DURATION = 10.0


async def main() -> None:
    print(f"Scanning for {SCAN_DURATION}s — listing every BLE device the laptop can see...")
    print("(If you see nothing here, BLE is broken at the OS level.)")
    print("---")

    devices = await BleakScanner.discover(timeout=SCAN_DURATION)

    if not devices:
        print("No devices found at all. Bluetooth is on but discovery returned empty.")
        print("Try: toggle Bluetooth off/on in the menu bar, then re-run.")
        return

    print(f"Found {len(devices)} BLE device(s):")
    print("---")
    for d in devices:
        name = d.name or "(no name)"
        # Highlight Rivian-related entries
        marker = "  *** RIVIAN ***" if "rivian" in name.lower() else ""
        print(f"  {d.address}  {name}{marker}")


if __name__ == "__main__":
    asyncio.run(main())
