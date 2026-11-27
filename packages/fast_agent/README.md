# fast_agent Kedi Package

`> import: fast_agent`, then `> agent: fast_agent`, runs Kedi on [fast-agent](https://fast-agent.ai)
(evalstate/fast-agent, Apache-2.0) through the [fast-agent bridge](../../python/fast-agent):

```kedi
> import: fast_agent
> agent: fast_agent
> model: google/gemini-3.1-flash-lite-preview
[answer] << Reply with exactly one word: ready
= <answer>
```

This package is not maintained. 0.1.0 is its one release, tested with fast-agent 0.10.69; it
gets no updates for later fast-agent or Kedi versions.

`> model:` names a fast-agent provider and model as `provider/model`
(`google/gemini-3.1-flash-lite-preview`, `anthropic/claude-haiku-4-5`, ...). fast-agent reads the
provider's credentials from its environment variables (`GOOGLE_API_KEY`, `OPENAI_API_KEY`, ...). See the
[bridge README](../../python/fast-agent/README.md) for providers, the model gate, tools, MCP and
limits.

## How it installs

fast-agent pins its dependencies exactly, so it runs in a Python environment of the package's
own. The package's source holds that environment's uv project (`pyproject.toml`, `uv.lock`, with
fast-agent 0.10.69). The manifest says `environment: uv`, and `kedi install` or `kedi add`:

1. runs `uv sync --frozen --no-dev --no-install-project` into the installed package's
   `.kedi-env/venv/`, with a Python 3.13 that uv manages in `.kedi-env/python/`;
2. runs `python bridge.py` from that environment. Nothing is installed into the Python running
   Kedi.

fast-agent's home lives in the package's `.kedi-runtime/`, not `~/.fast-agent`. `kedi remove
fast_agent` takes all of it with the package. It needs:

- Kedi 0.1.7 or newer: `pip install -U kedi`; code mode (`> codemode: enabled`) needs
  Kedi 0.1.8;
- uv: `kedi python install uv`;
- about 0.3 GB of disk.

The first install takes a few minutes.

## The bridge files

`bridge.py`, `convert.py` and the Python bridge SDK (`kedi_bridge`) are not kept on `main`. The
[release workflow](../../.github/workflows/fast-agent-release.yml) adds them to a release commit
tagged `fast_agent-v<version>`. To install from a checkout, add them yourself:

```sh
./assemble.sh
kedi install package.kedi
```
