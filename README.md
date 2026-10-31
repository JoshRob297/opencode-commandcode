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
- **Offline-safe.** The catalog is cached on disk (6h TTL). If Command Code is
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

### Multi-key rotation (opt-in)

Several Command Code keys can be pooled so a dead account does not end the turn.
Two or more keys enable rotation; one key keeps the single-key path untouched.

```sh
# inline
export COMMANDCODE_API_KEYS="key_one,key_two"

# or a file, one per line (`label=key` or bare key, `#` comments)
export COMMANDCODE_KEYS_FILE="$HOME/.config/commandcode/keys.txt"
```

Cooldowns are recorded per key from the response that blamed the credential:
`402` (insufficient credits) and `401`/`403` block for 24h, `429` honours
`Retry-After` up to 6h (5m by default), and `5xx` never blames the key. When all
keys are cooling down the soonest recovery wins. State is labels-only
(`<state>/commandcode-keys-state.json`, mode 0600) and every cooldown is logged
to `<state>/commandcode-rotation.log`.
| `<state>/commandcode-errors.log` | Decorated failures: status, upstream code, message and the hint shown to the user |

In rotation mode the plugin owns the `Authorization` header for
`api.commandcode.ai`, because the key that the host config injected may be the
one that just returned `402`. Single-key mode keeps the previous rule: inject
only when the request has no header.

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

### Zero data retention (opt-in)

Command Code exposes ZDR as a request header (`x-cmd-zdr: 1`), the same opt-in
its CLI reads from `CMD_ZDR=1`. The plugin mirrors it:

- `CMD_ZDR=1` - every request to `api.commandcode.ai` carries `x-cmd-zdr: 1`.
- Otherwise - any caller-supplied `x-cmd-zdr` header is stripped, so a session
  that never opted in cannot emit the flag by accident.

The header is applied only on the strict Command Code host, never on a lookalike
that merely shares `/provider/v1/...` in its path.

### Quota telemetry

- Tool `commandcode_quota` and command `/commandcode-quota`: plan, status,
  remaining monthly credit, 5h and weekly rate-limit windows with reset timers,
  plus cycle totals (requests, tokens, spend).

### Actionable errors

Command Code failures keep their HTTP status and JSON envelope, but the message
gains a resolution hint:

| Failure | Hint appended |
| --- | --- |
| `402` insufficient credits | add credits or another account to `COMMANDCODE_API_KEYS` |
| `MODEL_NOT_IN_PLAN` | pick another model or upgrade the plan |
| `401` / `403` | replace the key or rotate the pool |
| `429` / plan window | wait for the reset or rotate to another key |
| `unsupported_model` | the model is Anthropic-shaped and only served on `/messages` |

Only JSON error bodies are touched, the status is never rewritten (OpenCode's
retry classification depends on it) and every decoration is logged to
`<state>/commandcode-errors.log`.

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

## Model Ordering and Foreign Models

The selector order is driven by the plugin, not by the catalog order:

1. **Promo / free models first**, rendered with the runtime's `Free` badge. The plugin
   writes a `cost` entry with zeroed input for those models, which both grants the badge
   and reports their real cost as zero.
2. **Grouped by family** (Claude, GPT, Gemini, DeepSeek, Kimi, GLM, MiniMax, Qwen, ...).
3. **Newest version first inside each family** (`gpt-6.1-sol` before `gpt-6-sol` before
   `gpt-5.6-sol`), derived from the version in the model id.

This is encoded in each model's `time.released`, so it survives catalog refreshes and new
releases are placed correctly without editing the plugin.

`models.dev` also publishes its own `commandcode` provider, which OpenCode merges with the
configured one. The merge brings in Anthropic-shaped `claude-*` models that answer
`400 unsupported_model` on the OpenAI-compatible transport, so the plugin disables every
provider model that is not part of its curated catalog.

---

## Configuration

Every setting is an environment variable with a safe default. Full reference:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMAND_CODE_API_KEY` | - | Key resolution, highest priority |
| `COMMANDCODE_KEY_FILE` | - | Absolute path to a key file |
| `COMMANDCODE_API_KEYS` | - | Pool of keys; two or more enable rotation |
| `COMMANDCODE_KEYS_FILE` | - | Pool file (`label=key` or bare key per line) |
| `CMD_ZDR` | - | Set to `1` for zero data retention (`x-cmd-zdr: 1`) |
| `COMMANDCODE_ALLOWED_HOSTS` | - | Comma-separated extra hosts allowed to receive the key |
| `CC_NO_CONNECTION_CLOSE` | `0` | Set to `1` to stop injecting `Connection: close` |
| `COMMANDCODE_STATE_DIR` | `$XDG_STATE_HOME/opencode` | Where logs and the model cache live |
| `COMMANDCODE_LIVE_TESTS` | `0` | Set to `1` to run the network test suite |
| `COMMANDCODE_OUTPUT_TOKENS` | `32768` | Output token limit declared per model (OpenCode sends it as `max_completion_tokens`). Raise it for models that support more |

Runtime kill switch for connection hygiene: create a sentinel file named
`.disable-connection-close` inside the plugin directory.

---

## Telemetry files

| File | Contents |
| --- | --- |
| `<state>/commandcode-sanitizer.log` | Every in-flight payload repair, with the fixes applied |
| `<state>/commandcode-watchdog.log` | Aborted stalled SSE streams |
| `<state>/commandcode-retries.log` | Command Code transport retries: session, agent, provider, model, error type, HTTP status, attempt number, backoff delay and message |
| `<state>/commandcode-rotation.log` | Key cooldowns: label, HTTP status, reason and reset time |
| `<state>/commandcode-keys-state.json` | Per-key cooldown state (labels only, 0600) |
| `<state>/commandcode-models-cache.json` | Last known good model catalog (6h TTL) |

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
