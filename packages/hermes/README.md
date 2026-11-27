# hermes Kedi Package

`> import: hermes`, then `> agent: hermes`, runs Kedi on [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(Nous Research, MIT) through the [Hermes bridge](../../python/hermes):

```kedi
> import: hermes
> agent: hermes
> model: gemini/gemini-3.5-flash-lite
[answer] << Reply with exactly one word: ready
= <answer>
```

`> model:` names a Hermes provider and model as `provider/model`, and Hermes reads the provider's
credentials from its environment variables (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...). See the
[bridge README](../../python/hermes/README.md) for providers, the model gate, tools and limits.

## How it installs

Hermes ships no wheel: it runs from a source checkout, installed editable from its own lock. The
manifest says so (`environment: uv` with `environment_project:`), and `kedi install` or `kedi add`:

1. checks out Hermes at the commit the manifest names (v0.23.4), without history, into the
   installed package's `.kedi-env/project/`;
2. runs `uv sync --frozen --no-dev` there, into `.kedi-env/venv/`, with a Python uv manages in
   `.kedi-env/python/`;
3. runs `python bridge.py` from that environment. Nothing is installed into the Python running
   Kedi.

Hermes's home lives in the package's `.kedi-runtime/`, not `~/.hermes`. `kedi remove hermes` takes
all of it with the package. It needs:

- Kedi with `environment_project`;
- uv: `kedi python install uv`;
- git;
- about 0.5 GB of disk.

The first install takes a few minutes.

## The bridge files

`bridge.py`, its modules and the Python bridge SDK (`kedi_bridge`) are not kept on `main`. The
[release workflow](../../.github/workflows/hermes-release.yml) adds them to a release commit tagged
`hermes-v<version>`. To install from a checkout, add them yourself:

```sh
./assemble.sh
kedi install package.kedi
```
