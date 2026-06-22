"""
Recreate user filament presets that properly inherit from Creality K1-all profiles.
"""

import json
import os
import time
from pathlib import Path

APPDATA = Path(os.environ["APPDATA"])
CREALITY_FILAMENT = APPDATA / "Creality" / "Creality Print" / "7.0" / "system" / "Custom" / "filament"
ORCA_USER_FILAMENT = APPDATA / "OrcaSlicer" / "user" / "default" / "filament"

# Map Creality custom base profile -> Creality K1-all system profile
INHERIT_MAP = {
    "fdm_filament_pla": "Creality Generic PLA @K1-all",
    "fdm_filament_abs": "Creality Generic ABS @K1-all",
    "fdm_filament_pet": "Creality Generic PETG @K1-all",
    "fdm_filament_tpu": "Creality Generic TPU @K1-all",
    "fdm_filament_asa": "Creality Generic ASA @K1-all",
    "fdm_filament_pc":  "Creality Generic PC @K1-all",
    "fdm_filament_pva": "Creality Generic PLA @K1-all",  # No PVA K1-all, use PLA as base
    "fdm_filament_pa":  "Creality Generic PA-CF @K1-all",  # No plain PA K1-all, use PA-CF
}

# Fields that are custom user settings (not metadata)
METADATA_FIELDS = {"type", "filament_id", "setting_id", "name", "from", "instantiation", "inherits", "compatible_printers"}

# Profiles to skip (base definitions, not user materials)
SKIP_PREFIXES = ("fdm_filament_", "CR-ABS")


def create_info_file(path, setting_id=""):
    content = (
        f"sync_info = create\n"
        f"user_id = \n"
        f"setting_id = \n"
        f"base_id = {setting_id}\n"
        f"updated_time = {int(time.time())}\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def main():
    print("=== Fixing user filament presets ===\n")

    # First clean out previous attempt
    for f in ORCA_USER_FILAMENT.glob("My Generic*"):
        f.unlink()
        print(f"  Removed old: {f.name}")

    print()
    count = 0

    for src_file in sorted(CREALITY_FILAMENT.glob("*.json")):
        if any(src_file.stem.startswith(p) for p in SKIP_PREFIXES):
            continue

        with open(src_file, "r", encoding="utf-8") as f:
            src_data = json.load(f)

        old_inherits = src_data.get("inherits", "")
        new_inherits = INHERIT_MAP.get(old_inherits)
        if not new_inherits:
            print(f"  SKIP (no K1 base): {src_data['name']} (inherits {old_inherits})")
            continue

        name = src_data["name"]

        # Build user preset: only include overridden settings
        preset = {
            "type": "filament",
            "name": name,
            "inherits": new_inherits,
            "from": "User",
            "filament_settings_id": [name],
            "version": "2.3.2.60",
        }

        # Copy all custom settings (non-metadata fields)
        for key, val in src_data.items():
            if key not in METADATA_FIELDS:
                preset[key] = val

        # Write JSON
        dst_json = ORCA_USER_FILAMENT / f"{name}.json"
        with open(dst_json, "w", encoding="utf-8") as f:
            json.dump(preset, f, indent=4, ensure_ascii=False)

        # Write .info
        dst_info = ORCA_USER_FILAMENT / f"{name}.info"
        create_info_file(dst_info, src_data.get("setting_id", ""))

        print(f"  Created: {name} (inherits {new_inherits})")
        count += 1

    print(f"\nDone: {count} filament presets created")
    print(f"Location: {ORCA_USER_FILAMENT}")
    print("\nRestart Orca Slicer and check the filament dropdown.")


if __name__ == "__main__":
    main()
