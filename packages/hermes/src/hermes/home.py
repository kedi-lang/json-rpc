"""Hermes's home for the bridge: isolated from the user's ``~/.hermes``.

Hermes reads its profile, config, plugins, skills, memories and sessions from ``HERMES_HOME``, and
some paths from ``HOME``. The bridge gives it a home of its own before Hermes is imported, so no
user plugin, skill, memory or context file reaches a run, and the bridge's config is the one that
applies: no Tool Search bridge (Kedi's tools stay as Kedi rendered them), no automatic
compression (Kedi's policy decides it), and no retries of side calls (each would be a request
Kedi has to admit).

``KEDI_HERMES_PROVIDERS`` names a YAML file with a ``providers:`` mapping, Hermes's named
endpoints (``providers.<name>.api`` and ``api_key``), for local or private models:
``> model: <name>/<model>``.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path

CONFIG = """\
plugins:
  enabled: []
  isolation: in_process
tools:
  tool_search:
    enabled: "off"
compression:
  enabled: false
auxiliary:
  transient_retries: 0
"""

TEST_BASE_URL = "http://kedi-test-model.invalid/v1"


def prepare() -> Path:
    """Creates the home, points ``HOME`` and ``HERMES_HOME`` at it, and returns ``HERMES_HOME``.

    ``KEDI_HERMES_HOME`` names a directory to keep it in. Otherwise it is one per process,
    removed at exit; a killed bridge's home is removed by the next bridge to start. It lives in
    the package's runtime directory when Kedi gives one (``KEDI_PACKAGE_RUNTIME_DIR``), so
    ``kedi remove`` takes it with the package, and in the temporary directory otherwise."""
    kept = os.environ.get("KEDI_HERMES_HOME")
    if kept:
        root = Path(kept)
    else:
        runtime = os.environ.get("KEDI_PACKAGE_RUNTIME_DIR")
        parent = Path(runtime) / "hermes" if runtime else Path(tempfile.gettempdir()) / "kedi-hermes"
        parent.mkdir(parents=True, exist_ok=True)
        _sweep(parent)
        root = parent / str(os.getpid())
        shutil.rmtree(root, ignore_errors=True)
        atexit.register(shutil.rmtree, root, True)
    home = root / "home"
    hermes_home = home / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    config = CONFIG
    providers = os.environ.get("KEDI_HERMES_PROVIDERS")
    if providers:
        # Hermes's named endpoints (a providers: mapping), for local models: the user's own
        # ~/.hermes/config.yaml is not read.
        extra = Path(providers).read_text("utf-8")
        if not extra.lstrip().startswith("providers:"):
            raise SystemExit(f"KEDI_HERMES_PROVIDERS names {providers}, which must hold one providers: mapping")
        config += "\n" + extra
    (hermes_home / "config.yaml").write_text(config, "utf-8")
    os.environ["HOME"] = str(home)
    os.environ["HERMES_HOME"] = str(hermes_home)
    return hermes_home


def _sweep(parent: Path) -> None:
    """Removes the homes of bridges that are no longer running."""
    for child in parent.iterdir():
        if not child.name.isdigit() or int(child.name) == os.getpid():
            continue
        try:
            os.kill(int(child.name), 0)
        except ProcessLookupError:
            shutil.rmtree(child, ignore_errors=True)
        except PermissionError:
            pass  # another user's live process
