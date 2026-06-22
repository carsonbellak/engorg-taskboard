"""Fix the inherits field in process presets to match Orca's naming."""

import json
from pathlib import Path
import os

ORCA_USER_PROCESS = Path(os.environ["APPDATA"]) / "OrcaSlicer" / "user" / "default" / "process"

OLD = "0.20mm Standard @Creality K1C 0.4 nozzle"
NEW = "0.20mm Standard @Creality K1C"

for f in sorted(ORCA_USER_PROCESS.glob("*.json")):
    with open(f, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if data.get("inherits") == OLD:
        data["inherits"] = NEW
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=4, ensure_ascii=False)
        print(f"  Fixed: {data['name']}")
    else:
        print(f"  Skipped: {data['name']} (inherits: {data.get('inherits')})")

print("\nDone. Restart Orca Slicer.")
