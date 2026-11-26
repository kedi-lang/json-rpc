"""Check the protocol schema: valid JSON Schema, every method's shapes defined."""

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA = Path(__file__).parents[1] / "schema" / "v1" / "protocol.json"
DIRECTIONS = {"kedi-to-bridge", "bridge-to-kedi"}
KINDS = {"request", "notification"}


def main() -> int:
    schema = json.loads(SCHEMA.read_text())
    Draft202012Validator.check_schema(schema)
    problems = []
    for name, method in schema["methods"].items():
        if method.get("direction") not in DIRECTIONS or method.get("kind") not in KINDS:
            problems.append(f"{name}: direction and kind must be set")
        if method.get("kind") == "notification" and "result" in method:
            problems.append(f"{name}: a notification has no result")
        if method.get("kind") == "request" and "result" not in method:
            problems.append(f"{name}: a request needs a result")
        for key in ("params", "result"):
            ref = method.get(key)
            if ref is not None and ref.split("/")[-1] not in schema["$defs"]:
                problems.append(f"{name}: {key} {ref} is not defined")
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"{len(schema['methods'])} methods, {len(schema['$defs'])} definitions")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
