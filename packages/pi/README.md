# pi Kedi Package

`> import: pi`, then `> agent: pi`, runs Kedi on the [pi](https://pi.dev) coding agent
through the [pi bridge](../../ts/pi):

```kedi
> import: pi
> agent: pi
> model: google/gemini-3.5-flash-lite
> approval: allow
[summary] << Read README.md and summarize it in one sentence.
= <summary>
```

The manifest declares the adapter as a command (`node bridge.mjs`); Kedi launches the
installed `bridge.mjs` with the program's working directory, where pi's tools then work.
It needs Node 22.18 or newer and Kedi 0.1.6 or newer: `pip install -U kedi`, then `kedi add pi`. Native compaction (`compaction_mode: native`) needs Kedi 0.1.7, and native code mode (`> codemode: native`) Kedi 0.1.8.

`bridge.mjs`, the bridge bundled with the SDK and pi (about 10 MB), is not on `main`: the
[pi release workflow](../../.github/workflows/pi-release.yml) builds it, checks it alone, and
adds it with `photon_rs_bg.wasm` (pi's image converter) and `THIRD_PARTY_LICENSES.txt` to a
release commit tagged `pi-v<version>`. Install
that commit, or build it yourself:

```sh
(cd ../../ts/pi && npm ci && npm run build)
cp ../../ts/pi/dist/{bridge.mjs,photon_rs_bg.wasm,THIRD_PARTY_LICENSES.txt} src/pi/
kedi install package.kedi
```
