# opencode-commandcode

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English** | [Espanol](README.es.md)

Production-grade [OpenCode](https://opencode.ai) plugin for the [Command Code](https://commandcode.ai) provider.

It does four things:

1. **Dynamic model discovery** - registers every Command Code model the
   OpenAI-compatible transport can actually serve, and tags free/promo tiers.
2. **Credential resolution** - finds your API key automatically, from four
   different stores, and injects it only for the real Command Code origin.
3. **Session stability** - repairs the payloads Command Code rejects with
   HTTP 400, and aborts silently dropped SSE streams before they freeze the UI.
4. **Quota telemetry** - a `commandcode_quota` tool and a `/commandcode-quota`
   command for balance and rate-limit windows.

> [!NOTE]
> **Status: private development.** The plugin is verified against
> OpenCode **v2.0.32** and Command Code position **1.73.4** on Bun 1.4.0.
> It is not yet published to a registry; install it from this repository.

---

## Features

### Dynamic model discovery

Command Code exposes roughly 90 models and rotates free tiers frequently, which
makes a hand-written model list in `opencode.json` become wrong on its own. On
startup the plugin queries `/provider/v1/models` and registers the catalog
through the OpenCode v2 model editor:

- **Transport-aware filtering.** Only models advertising `/chat/completions` are
  registered. The `claude-*` line is Anthropic-shaped (`/messages` only) and
  answers `HTTP 400 unsupported_model` on the OpenAI-compatible endpoint, so it is
  skipped instead of being offered as a broken option.
- **Automatic promo badge.** Free and promotional tiers are renamed with a
  `[FREE PROMO]` suffix so they are obvious in the `/model` selector. Detection
  covers `:free`, `-free`, `_free`, `.free` id shapes and `free` / `promo` /
  `trial` in the display name.
- **Advertised context window** is preserved per model, and vision-capable models
  declare `image` input.
- **Offline-safe.** The catalog is cached on disk (12h TTL). If Command Code is
  down or the network is unavailable, OpenCode still starts with the last known
  good catalog instead of an empty provider.

### Credential resolution

First hit wins, all paths home-relative (no hardcoded user paths):

| Order | Source |
| --- | --- |
| 1 | `COMMAND_CODE_API_KEY` environment variable |
| 2 | `COMMANDCODE_KEY_FILE` explicit file override |
| 3 | `$XDG_CONFIG_HOME/commandcode/key.txt` (default `~/.config/commandcode/key.txt`) |
| 4 | `/etc/environment` -> `COMMAND_CODE_API_KEY` |
| 5 | `~/.commandcode/auth.json` (official CLI store) |
| 6 | `~/.commandcode/credentials.json`, then `~/.commandcode/config.json` |

The key is injected as `Authorization: Bearer <key>` **only when the parsed URL
hostname is exactly `api.commandcode.ai`** (or a host explicitly allow-listed via
`COMMANDCODE_ALLOWED_HOSTS`). Substring matching is never used for credentials:
it would leak the key to lookalike hosts such as `api.commandcode.ai.evil.com`
or to any server that merely carries `/provider/v1/chat/completions` in its URL.
An existing `authorization` header is never overwritten.

### Session stability

Four independent hooks, all fail-open (an error in the plugin can never break a
request):

- **Connection hygiene** - OpenCode runs on Bun, which speaks HTTP/1.1 keep-alive
  to Cloudflare. Cloudflare closes idle sockets under load and Bun surfaces the
  stale reuse as `ECONNRESET`. The hook sets `Connection: close` in place on every
  Command Code request (verified: Bun forwards the header and Cloudflare replies
  `connection: close`). It is a request-level fix, not a full guarantee - see
  [TROUBLESHOOTING](docs/TROUBLESHOOTING.md#econnreset-retries).
- **Payload sanitizer** - repairs the message history that triggers
  `HTTP 400 invalid request error`: orphan or out-of-order tool responses,
  dangling tool calls, duplicate or missing `tool_call_id`, non-string
  `function.arguments`, `null` or empty tool content.
- **SSE inactivity watchdog** - the first chunk opens a 60s window; if the stream
  then goes silent without closing, it is aborted and logged instead of freezing
  the turn. Time before the first chunk is left to OpenCode's own provider timeout,
  since models may legitimately think for a long time.
- **Retry logger** - persists transport retries for Command Code only, so an
  upstream outage can be diagnosed after the fact.

### Quota telemetry

- Tool `commandcode_quota` and command `/commandcode-quota`: plan, status,
  remaining monthly credit, 5h and weekly rate-limit windows with reset timers,
  plus cycle totals (requests, tokens, spend).

---

## Requirements

- OpenCode v2.0+ (v1 `server()` export is kept as a compatibility shim).
- Bun runtime (the plugin is loaded from source; no build step, no npm install).
- A Command Code API key in any of the stores listed above.

---

## Installation

### Option A: Direct from GitHub (recommended)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["github:JoshRob297/opencode-commandcode"]
}
```

OpenCode clones, caches and runs the plugin straight from the repository. No npm
publication and no build step: the source is TypeScript executed by Bun.

### Option B: Local clone

```bash
git clone git@github.com:JoshRob297/opencode-commandcode.git
```

```jsonc
{
  "plugins": [
    "/absolute/path/to/opencode-commandcode"
  ]
}
```

### Option C: plugins directory

OpenCode also auto-discovers every directory under `~/.config/opencode/plugins/`, so a
clone placed there loads without touching `opencode.json`. Removal is not symmetric:
deleting the config entry or renaming the directory **does not** unload it - the
directory has to leave `plugins/` entirely. See
[TROUBLESHOOTING](docs/TROUBLESHOOTING.md#plugin-loaded-twice-or-a-removed-plugin-still-runs).

Restart OpenCode. On the next start the model catalog is discovered, the toolbar
tool and the slash command are registered, and the hooks are attached.

> [!IMPORTANT]
> Do not run this plugin alongside a second plugin that registers
> `commandcode_quota`. Duplicate tool ids and competing `http.request` hooks will
> double-sanitize requests. Remove the old plugin entry during the cutover.

### Provider configuration

The plugin does not manage the provider definition. `opencode.json` still needs
the provider block (the model list inside it is optional - discovery adds the
models at runtime):

```jsonc
{
  "providers": {
    "commandcode": {
      "name": "Command Code",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "{file:~/.config/commandcode/key.txt}"
      }
    }
  }
}
```

---

## Configuration

Every setting is an environment variable with a safe default. Full reference:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMAND_CODE_API_KEY` | - | Key resolution, highest priority |
| `COMMANDCODE_KEY_FILE` | - | Absolute path to a key file |
| `COMMANDCODE_ALLOWED_HOSTS` | - | Comma-separated extra hosts allowed to receive the key |
| `CC_NO_CONNECTION_CLOSE` | `0` | Set to `1` to stop injecting `Connection: close` |
| `COMMANDCODE_STATE_DIR` | `$XDG_STATE_HOME/opencode` | Where logs and the model cache live |
| `COMMANDCODE_LIVE_TESTS` | `0` | Set to `1` to run the network test suite |

Runtime kill switch for connection hygiene: create a sentinel file named
`.disable-connection-close` inside the plugin directory.

---

## Telemetry files

| File | Contents |
| --- | --- |
| `<state>/commandcode-sanitizer.log` | Every in-flight payload repair, with the fixes applied |
| `<state>/commandcode-watchdog.log` | Aborted stalled SSE streams |
| `<state>/commandcode-retries.log` | Command Code transport retries (type, status, message) |
| `<state>/commandcode-models-cache.json` | Last known good model catalog (12h TTL) |

`<state>` defaults to `~/.local/state/opencode`.

The retry log is a forensic artifact, not a health metric: OpenCode already
retries transient transport failures natively (10 attempts, 2s to 10s backoff),
so a burst of `ECONNRESET` entries usually means an upstream outage that was
recovered transparently. See [TROUBLESHOOTING](docs/TROUBLESHOOTING.md).

---

## Development

```bash
bun install
bun test              # offline suite, no network, no quota consumed
bun run test:live     # network suite, consumes a negligible amount of quota
bun run typecheck     # strict tsc, no emit
```

Layout:

```
index.ts                 plugin entrypoint (v2 setup + v1 server)
src/auth/resolver.ts     multi-source credential resolution
src/client/api.ts        HTTP client, quota payloads, catalog cache
src/hooks/resilience.ts  pure helpers: URL guards, sanitizer, watchdog, classifiers
src/tools/quota.ts       quota report formatting
src/index.ts             hook/model/tool/command registration
tests/                   bun test suites
```

Design rules that must not be broken:

- Fail-open everywhere: a plugin error must never fail a model request.
- Credentials are only ever attached on an exact host match.
- Model catalog accuracy beats catalog size: do not register models the transport
  cannot serve.
- No hardcoded user paths.

Architecture and data flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## License

MIT - see [LICENSE](LICENSE).
