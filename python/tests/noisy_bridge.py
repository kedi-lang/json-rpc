"""A bridge whose harness prints to stdout, at import and while it runs."""

import os
import subprocess
import sys

from kedi_bridge import claim_stdout, serve

claim_stdout()
print("harness banner on stdout")
os.write(1, b"raw descriptor write\n")
subprocess.run([sys.executable, "-c", "print('child process output')"], check=True)

from bridges import Minimal  # noqa: E402


class Noisy(Minimal):
    def run(self, run):
        print("harness log during a run")
        return super().run(run)


if __name__ == "__main__":
    raise SystemExit(serve(Noisy({"testModel": True})))
