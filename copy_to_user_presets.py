"""
Copy Creality Slicer filament profiles into Orca Slicer's user presets directory
so they appear for the K1C printer.

User presets require:
1. A .json file with "from": "User" and a "version" field
2. A companion .info file with sync metadata
"""

import json
import os
import time
from pathlib import Path

APPDATA = Path(os.environ["APPDATA"])
CREALITY_FILAMENT = APPDATA / "Creality" / "Creality Print" / "7.0" / "system" / "Custom" / "filament"
ORCA_USER_FILAMENT = APPDATA / "OrcaSlicer" / "user" / "default" / "filament"
ORCA_USER_PROCESS = APPDATA / "OrcaSlicer" / "user" / "default" / "process"

K1C_PRINTERS = [
    "Creality K1C 0.4 nozzle",
    "Creality K1C 0.6 nozzle",
    "Creality K1C 0.8 nozzle",
]

# Only transfer actual user filament profiles (not base fdm_filament_* ones)
SKIP_PREFIXES = ("fdm_filament_", "CR-ABS")


def create_info_file(path, setting_id=""):
    """Create the companion .info file for a user preset."""
    info_content = (
        f"sync_info = create\n"
        f"user_id = \n"
        f"setting_id = \n"
        f"base_id = {setting_id}\n"
        f"updated_time = {int(time.time())}\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(info_content)


def transfer_filament_profiles():
    count = 0
    for src_file in sorted(CREALITY_FILAMENT.glob("*.json")):
        if any(src_file.stem.startswith(p) for p in SKIP_PREFIXES):
            continue

        with open(src_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Convert to user preset format
        data["from"] = "User"
        data["version"] = "2.3.2.60"
        data["compatible_printers"] = K1C_PRINTERS

        # Remove system-only fields
        data.pop("instantiation", None)

        name = data["name"]
        setting_id = data.get("setting_id", "")

        # Write the profile
        dst_json = ORCA_USER_FILAMENT / src_file.name
        with open(dst_json, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

        # Write companion .info file
        dst_info = ORCA_USER_FILAMENT / (src_file.stem + ".info")
        create_info_file(dst_info, setting_id)

        print(f"  Created: {name}")
        count += 1

    return count


def main():
    print("=== Copying filament profiles to Orca user presets ===\n")

    filament_count = transfer_filament_profiles()

    print(f"\nDone: {filament_count} filament profiles created in user presets")
    print(f"Location: {ORCA_USER_FILAMENT}")
    print("\nRestart Orca Slicer to see the new profiles.")


if __name__ == "__main__":
    main()
