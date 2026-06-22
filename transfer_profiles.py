"""
Transfer custom filament and process profiles from Creality Slicer (Creality Print 7.0)
to Orca Slicer. Both slicers are BambuStudio forks with compatible JSON profile formats.

Creates a timestamped backup of Orca's Custom directory before making changes.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def get_paths():
    """Build and validate all required paths."""
    appdata = Path(os.environ["APPDATA"])

    paths = {
        "creality_custom_dir": appdata / "Creality" / "Creality Print" / "7.0" / "system" / "Custom",
        "creality_custom_json": appdata / "Creality" / "Creality Print" / "7.0" / "system" / "Custom.json",
        "orca_custom_dir": appdata / "OrcaSlicer" / "system" / "Custom",
        "orca_custom_json": appdata / "OrcaSlicer" / "system" / "Custom.json",
        "orca_system_dir": appdata / "OrcaSlicer" / "system",
    }

    missing = []
    for key, path in paths.items():
        if not path.exists():
            missing.append(f"  {key}: {path}")

    if missing:
        print("ERROR: The following paths do not exist:")
        print("\n".join(missing))
        sys.exit(1)

    return paths


def check_orca_running():
    """Warn if Orca Slicer is currently running."""
    try:
        result = subprocess.run(["tasklist"], capture_output=True, text=True)
        if "orca-slicer" in result.stdout.lower() or "orcaslicer" in result.stdout.lower():
            print("WARNING: Orca Slicer appears to be running.")
            print("It is recommended to close it before transferring profiles.")
            response = input("Continue anyway? [y/N]: ").strip().lower()
            if response != "y":
                print("Aborted.")
                sys.exit(0)
    except Exception:
        pass  # If tasklist fails, proceed anyway


def backup_orca(paths):
    """Create a timestamped backup of Orca's Custom directory and Custom.json."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = paths["orca_system_dir"] / f"backup_{timestamp}"
    backup_dir.mkdir(parents=True)

    shutil.copytree(paths["orca_custom_dir"], backup_dir / "Custom")
    shutil.copy2(paths["orca_custom_json"], backup_dir / "Custom.json")

    print(f"Backup created: {backup_dir}")
    return backup_dir


def copy_profiles(src_dir, dst_dir, category):
    """Copy all .json files from src to dst. Returns (new, overwritten, errors) counts."""
    new_count = 0
    overwritten_count = 0
    errors = []

    src_files = sorted(src_dir.glob("*.json"))
    if not src_files:
        print(f"  No {category} profiles found in source.")
        return 0, 0, []

    for src_file in src_files:
        dst_file = dst_dir / src_file.name
        try:
            existed = dst_file.exists()
            shutil.copy2(src_file, dst_file)
            if existed:
                overwritten_count += 1
            else:
                new_count += 1
        except Exception as e:
            errors.append(f"  {src_file.name}: {e}")

    return new_count, overwritten_count, errors


def merge_custom_json(creality_json_path, orca_json_path):
    """Merge Creality's profile entries into Orca's Custom.json index.

    For filament_list and process_list: upsert Creality entries (replace on name match).
    Leaves machine_model_list and machine_list untouched.
    """
    with open(creality_json_path, "r", encoding="utf-8") as f:
        creality_data = json.load(f)

    with open(orca_json_path, "r", encoding="utf-8") as f:
        orca_data = json.load(f)

    stats = {}

    for list_key in ("filament_list", "process_list"):
        # Build name-keyed dict from Orca's existing entries
        orca_entries = {entry["name"]: entry for entry in orca_data.get(list_key, [])}
        before_count = len(orca_entries)

        # Upsert Creality entries
        for entry in creality_data.get(list_key, []):
            orca_entries[entry["name"]] = entry

        after_count = len(orca_entries)

        # Sort: base profiles (fdm_*) first, then alphabetical
        sorted_entries = sorted(
            orca_entries.values(),
            key=lambda e: (0 if e["name"].startswith("fdm_") else 1, e["name"]),
        )
        orca_data[list_key] = sorted_entries

        stats[list_key] = {
            "before": before_count,
            "after": after_count,
            "added": after_count - before_count,
        }

    # Write back, preserving Orca's version and other top-level fields
    with open(orca_json_path, "w", encoding="utf-8") as f:
        json.dump(orca_data, f, indent=4, ensure_ascii=False)

    return stats


def main():
    print("=== Creality Slicer -> Orca Slicer Profile Transfer ===\n")

    paths = get_paths()
    check_orca_running()

    # Show what will happen
    creality_filaments = list((paths["creality_custom_dir"] / "filament").glob("*.json"))
    creality_processes = list((paths["creality_custom_dir"] / "process").glob("*.json"))

    print(f"Source:  {paths['creality_custom_dir']}")
    print(f"Dest:    {paths['orca_custom_dir']}")
    print()
    print(f"Filament profiles to copy: {len(creality_filaments)} files")
    print(f"Process profiles to copy:  {len(creality_processes)} files")
    print()

    response = input("Proceed? [y/N]: ").strip().lower()
    if response != "y":
        print("Aborted.")
        sys.exit(0)

    print()

    # Step 1: Backup
    backup_orca(paths)
    print()

    # Step 2: Copy filament profiles
    fil_new, fil_over, fil_errors = copy_profiles(
        paths["creality_custom_dir"] / "filament",
        paths["orca_custom_dir"] / "filament",
        "filament",
    )
    print(f"Filament: copied {fil_new + fil_over} files ({fil_new} new, {fil_over} overwritten)")
    for err in fil_errors:
        print(f"  ERROR: {err}")

    # Step 3: Copy process profiles
    proc_new, proc_over, proc_errors = copy_profiles(
        paths["creality_custom_dir"] / "process",
        paths["orca_custom_dir"] / "process",
        "process",
    )
    print(f"Process:  copied {proc_new + proc_over} files ({proc_new} new, {proc_over} overwritten)")
    for err in proc_errors:
        print(f"  ERROR: {err}")

    print()

    # Step 4: Merge Custom.json index
    stats = merge_custom_json(paths["creality_custom_json"], paths["orca_custom_json"])
    print("Custom.json updated:")
    for list_key, s in stats.items():
        label = list_key.replace("_", " ")
        print(f"  {label}: {s['after']} entries (was {s['before']}, added {s['added']})")
    print()

    total_errors = len(fil_errors) + len(proc_errors)
    if total_errors:
        print(f"Completed with {total_errors} error(s). Check messages above.")
    else:
        print("Transfer complete!")


if __name__ == "__main__":
    main()
