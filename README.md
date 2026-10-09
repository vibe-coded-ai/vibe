# vibe

The `vibe` command and the coding-agent skill for [vibe-coded.ai](https://vibe-coded.ai): data stores your AI reads and writes through MCP tools, hosted at an address you can open, edit and share.

This repository is the source of what the installer puts on your machine. Each release is tagged with the version in `SKILL.md` and `package.json`, and the zip the installer downloads is built from that tag.

## Install

```sh
curl -fsSL https://vibe-coded.ai/install.sh | sh
```

`install.sh` is in this repository. It downloads `https://vibe-coded.ai/vibe-coded-ai-skill.zip`, unpacks it to `~/.claude/skills/vibe-coded-ai/`, links `vibe` into `~/.local/bin` (or `~/bin` when that is on your `PATH`) and links the skill into `~/.agents/skills/` for agents that look there. It needs `curl`, `unzip`, `bash` and `jq`, and never edits your shell profile. To do the same by hand, see [the CLI docs](https://vibe-coded.ai/docs/cli).

## What is here

| Path | What it is |
|------|------------|
| `SKILL.md` | The skill your coding agent reads: how to build, run, publish and connect a vibe |
| `bin/vibe` | The CLI (bash) |
| `runtime/` | The local dev server and the helpers it uses (Node) |
| `templates/` | Starting points: `tools`, `tools-sql`, `tracker`, `log`, `journal`, `site` |
| `references/` | Platform patterns the skill points the agent at |
| `install.sh` | The installer served at `https://vibe-coded.ai/install.sh` |

## Use

```sh
vibe login
vibe --help
```

Then prompt your coding agent; the skill does the rest. The [quickstart](https://vibe-coded.ai/docs/quickstart) walks through the first vibe.

## Tests

```sh
cd runtime && node --test
```

## License

MIT. See `LICENSE`.
