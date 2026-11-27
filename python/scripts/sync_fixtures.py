"""Copies fixtures/v1 into the SDK, so an installed bridge carries its own checks.

    python scripts/sync_fixtures.py          copy them
    python scripts/sync_fixtures.py --check  fail if the copy is out of date
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "fixtures" / "v1"
TARGET = HERE.parent / "src" / "kedi_bridge" / "fixtures" / "v1"


def main() -> int:
    wanted = {file.name: file.read_bytes() for file in sorted(SOURCE.glob("*.json"))}
    present = {file.name: file.read_bytes() for file in sorted(TARGET.glob("*.json"))} if TARGET.exists() else {}
    if "--check" in sys.argv[1:]:
        if wanted != present:
            print("src/kedi_bridge/fixtures/v1 is out of date: run python scripts/sync_fixtures.py", file=sys.stderr)
            return 1
        return 0
    TARGET.mkdir(parents=True, exist_ok=True)
    for name in set(present) - set(wanted):
        (TARGET / name).unlink()
    for name, content in wanted.items():
        (TARGET / name).write_bytes(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
