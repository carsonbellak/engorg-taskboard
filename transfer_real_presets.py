"""
Transfer the user's actual presets from Creality Slicer to Orca Slicer.

- 2 filament presets (CR-TPU 240C, ERYONE PP-CF)
- 4 process presets (PLA, PETG, PP-CF, TPU speed profiles)

Filament presets need parent profile remapping since Orca doesn't have
CR-TPU or Generic PP for K1C. Process presets work directly since
'0.20mm Standard @Creality K1C 0.4 nozzle' exists in Orca.
"""

import json
import os
import shutil
from pathlib import Path

APPDATA = Path(os.environ["APPDATA"])
CREALITY_USER = APPDATA / "Creality" / "Creality Print" / "7.0" / "user" / "5391862493"
ORCA_USER = APPDATA / "OrcaSlicer" / "user" / "default"

# Filament inherits remapping
FILAMENT_INHERITS_MAP = {
    "CR-TPU @Creality K1C 0.4 nozzle": "Creality Generic TPU @K1-all",
    "Generic PP @Creality K1C 0.4 nozzle": "Creality Generic TPU @K1-all",  # No PP in Orca, use TPU as closest flexible base
}


def transfer_process_presets():
    """Process presets can be copied directly - their parent exists in Orca."""
    src_dir = CREALITY_USER / "process"
    dst_dir = ORCA_USER / "process"
    count = 0

    for src_file in sorted(src_dir.glob("*.json")):
        # Copy JSON
        shutil.copy2(src_file, dst_dir / src_file.name)
        # Copy .info
        info_file = src_file.with_suffix(".info")
        if info_file.exists():
            shutil.copy2(info_file, dst_dir / info_file.name)

        with open(src_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"  Process: {data['name']}")
        count += 1

    return count


def transfer_filament_presets():
    """Filament presets need inherits remapping."""
    src_dir = CREALITY_USER / "filament"
    dst_dir = ORCA_USER / "filament"
    count = 0

    for src_file in sorted(src_dir.glob("*.json")):
        with open(src_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        old_inherits = data.get("inherits", "")
        if old_inherits in FILAMENT_INHERITS_MAP:
            data["inherits"] = FILAMENT_INHERITS_MAP[old_inherits]
            print(f"  Filament: {data['name']} (remapped inherits: {old_inherits} -> {data['inherits']})")
        else:
            print(f"  Filament: {data['name']} (inherits unchanged: {old_inherits})")

        # Write modified JSON
        dst_json = dst_dir / src_file.name
        with open(dst_json, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

        # Copy .info
        info_file = src_file.with_suffix(".info")
        if info_file.exists():
            shutil.copy2(info_file, dst_dir / info_file.name)

        count += 1

    return count


def clean_previous_generics():
    """Remove the generic profiles from previous attempts."""
    dst_dir = ORCA_USER / "filament"
    removed = 0
    for f in list(dst_dir.glob("My Generic*")):
        f.unlink()
        removed += 1
    if removed:
        print(f"  Cleaned up {removed} old generic files from previous attempts\n")


def main():
    print("=== Transferring your actual user presets ===\n")

    clean_previous_generics()

    fil_count = transfer_filament_presets()
    print()
    proc_count = transfer_process_presets()

    print(f"\nDone: {fil_count} filament + {proc_count} process presets transferred")
    print(f"Location: {ORCA_USER}")
    print("\nRestart Orca Slicer to see them.")


if __name__ == "__main__":
    main()
