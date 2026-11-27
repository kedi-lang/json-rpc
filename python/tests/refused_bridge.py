"""A bridge whose handshake breaks a dependency rule: serve() refuses it at initialize."""

from bridges import Minimal

from kedi_bridge import serve

if __name__ == "__main__":
    raise SystemExit(serve(Minimal({"governed": True, "liveInput": True, "testModel": True})))
