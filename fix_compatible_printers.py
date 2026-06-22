"""
Update compatible_printers in transferred Creality profiles to reference K1C printers
instead of MyKlipper/MyMarlin/MyRRF.
"""

import json
from pathlib import Path
import os

ORCA_CUSTOM = Path(os.environ["APPDATA"]) / "OrcaSlicer" / "system" / "Custom"

K1C_PRINTERS = [
    "Creality K1C 0.4 nozzle",
    "Creality K1C 0.6 nozzle",
    "Creality K1C 0.8 nozzle",
]

# Only update profiles that came from Creality Slicer (have MyKlipper/MyMarlin/MyRRF)
OLD_PRINTER_PREFIXES = ("MyKlipper", "MyMarlin", "MyRRF")

updated = 0
skipped = 0

for subdir in ("filament", "process"):
    folder = ORCA_CUSTOM / subdir
    for json_file in sorted(folder.glob("*.json")):
        with open(json_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        printers = data.get("compatible_printers", [])
        if not printers:
            skipped += 1
            continue

        # Check if this profile references old printers
        has_old = any(p.startswith(OLD_PRINTER_PREFIXES) for p in printers)
        if not has_old:
            skipped += 1
            continue

        # Replace with K1C printers
        data["compatible_printers"] = K1C_PRINTERS

        with open(json_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

        updated += 1
        print(f"  Updated: {subdir}/{json_file.name}")

print(f"\nDone: {updated} profiles updated, {skipped} skipped")
