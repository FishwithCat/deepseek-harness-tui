# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run the terminal UI

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh
```

`dsh` with no profile opens the terminal UI in the current directory: one Agent, one session, drawn in the terminal with no server and no port. `Ctrl+D` exits, `/help` lists the commands, `Ctrl+V` attaches an image from the system clipboard, and `--resume <session-id>` continues a stored session. This fork defaults a bare `dsh` to the terminal profile; set `DSH_DEFAULT_PROFILE=web` to make the browser the default again, or pass `--profile web` explicitly.

### Run from `npm`

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh` uses those built artifacts without rebuilding and opens the terminal UI; `pnpm dsh web` opens the browser UI instead.

### Install the `dsh` command on a new machine

On a fresh clone, one command installs the dependencies, runs the complete build, and links `dsh` into a directory on `PATH`:

```sh
pnpm run setup:dsh
```

The complete build matters: `pnpm run build` also builds the native system addon and both compiler faces, and a checkout built without them starts the terminal UI but hangs when the session flushes on exit. The installer then links `apps/cli/lib/bin.js` into `$HOME/.local/bin` (`%APPDATA%\npm` on Windows), so `dsh` — and therefore the terminal UI — runs from any directory. It is idempotent: re-run `pnpm run link:dsh` after a rebuild, or to repair a link left dangling by a moved or cleaned checkout. `pnpm run link:dsh -- --dir <path>` installs elsewhere, and `DSH_LINK_BIN_DIR` sets the target; `pnpm run unlink:dsh` removes a link this checkout installed. An entry owned by another program is refused rather than overwritten.

A registry install (`npx @deepseek-ai/dsh` or `npm install -g`) cannot carry this fork's terminal surface, because `@deepseek-ai/dsh-tui-app` is not published and the launcher's other dependencies would resolve to the upstream packages.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
