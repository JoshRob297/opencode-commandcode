# Configuration

**English** | [Espanol](es/configuration.md)

All settings are environment variables. Defaults are safe: with no configuration
at all, the plugin resolves the key from the standard stores and enables every
hook.

## Credentials

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMAND_CODE_API_KEY` | unset | Highest priority. Used as-is (trimmed, surrounding quotes stripped). |
| `COMMANDCODE_KEY_FILE` | unset | Absolute path to a file containing only the key. Ignored when the file is missing or empty, so the cascade keeps going. |
| `XDG_CONFIG_HOME` | `~/.config` | Base for the third resolution step: `$XDG_CONFIG_HOME/commandcode/key.txt`. |

### Resolution order

```
COMMAND_CODE_API_KEY
      -> COMMANDCODE_KEY_FILE
      -> $XDG_CONFIG_HOME/commandcode/key.txt
      -> /etc/environment (COMMAND_CODE_API_KEY)
      -> ~/.commandcode/auth.json          (apiKey | api_key | token | accessToken)
      -> ~/.commandcode/credentials.json
      -> ~/.commandcode/config.json
      -> none  (injection disabled, everything else keeps working)
```

`resolveApiKeyWithSource()` reports which store was used, which is what the tests
assert on. `resolveApiKey()` returns only the string.

### Host allow-list

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMANDCODE_ALLOWED_HOSTS` | unset | Comma-separated hostnames that may also receive the key, in addition to `api.commandcode.ai`. |

Use this only for a self-hosted gateway that genuinely terminates your Command
Code traffic. Every host added here can read the API key.

```
COMMANDCODE_ALLOWED_HOSTS=gateway.internal,proxy.lan
```

## Transport

| Variable | Default | Meaning |
| --- | --- | --- |
| `CC_NO_CONNECTION_CLOSE` | unset | Set to `1` to stop injecting `Connection: close`. |
| sentinel file `<plugin>/.disable-connection-close` | absent | Same effect as the variable, togglable without a restart. |

Both switches exist so the header can be disabled for measurement without editing
code. Disabling it restores keep-alive reuse, which reintroduces the stale-socket
`ECONNRESET` case if that is what you are hitting.

The watchdog timeout (60s after the first chunk) is a constant in
`src/index.ts` (`WATCHDOG_TIMEOUT_MS`), not an environment variable.

## Telemetry and cache

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMANDCODE_STATE_DIR` | `$XDG_STATE_HOME/opencode` or `~/.local/state/opencode` | Directory for the three logs and the model cache. |

Files written under the state directory:

| File | Append/overwrite | Notes |
| --- | --- | --- |
| `commandcode-sanitizer.log` | append | JSON lines, one per repaired payload |
| `commandcode-watchdog.log` | append | JSON lines, one per aborted stream |
| `commandcode-retries.log` | append | JSON lines, Command Code retries only |
| `commandcode-models-cache.json` | overwrite | `{ at, models[] }`, 12h TTL |

Logs are append-only and never rotated by the plugin. At the observed event rate
(tens of lines per week) this is not a concern; if you want rotation, point
`COMMANDCODE_STATE_DIR` at a directory managed by `logrotate`.

## Timing constants

| Constant | Value | Location |
| --- | --- | --- |
| API request timeout | 10s | `DEFAULT_TIMEOUT_MS` in `src/client/api.ts` |
| Catalog cache TTL | 12h | `CATALOG_TTL_MS` in `src/client/api.ts` |
| SSE inactivity window | 60s | `WATCHDOG_TIMEOUT_MS` in `src/index.ts` |
| Default output limit per model | 16384 | `applyModelCatalog` in `src/index.ts` |

## OpenCode integration

The plugin registers itself; only the provider block belongs in `opencode.json`.

```jsonc
{
  "plugins": [
    "/absolute/path/to/opencode-commandcode"
  ],
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

Notes:

- The `models` map inside the provider is optional. Anything listed there wins for
  the same id; discovery adds the rest at startup.
- Keep `apiKey` in the provider block as a fallback for tooling that bypasses the
  plugin. The plugin resolves the key independently.
- Do not load two plugins that register `commandcode_quota` at the same time.

## Testing switches

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMANDCODE_LIVE_TESTS` | unset | Set to `1` to run `tests/live.test.ts`, which calls the real API. |

```bash
bun test                             # offline, no quota consumed
COMMANDCODE_LIVE_TESTS=1 bun test    # adds the live suite
```
