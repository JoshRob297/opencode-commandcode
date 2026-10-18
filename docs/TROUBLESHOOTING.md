# Troubleshooting

**English** | [Espanol](es/troubleshooting.md)

## No Command Code models in the selector

1. Check the catalog cache was written:

   ```bash
   ls -la "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-models-cache.json"
   ```

2. If the file is missing, the plugin never reached the API. Verify the key
   resolves and the endpoint answers:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $(cat ~/.config/commandcode/key.txt)" \
     -H 'User-Agent: cli' \
     https://api.commandcode.ai/provider/v1/models
   ```

   `200` means the plugin should populate the cache on the next start.

3. Models you listed manually in `opencode.json` are unaffected: they remain
   registered even when discovery is skipped. A cache miss is not an error.

4. Claude models are deliberately absent. They only expose `/messages` and answer
   `400 unsupported_model` on the OpenAI-compatible endpoint. See below.

## `HTTP 400 unsupported_model` after selecting a Claude model

The `claude-*` family on Command Code is Anthropic-shaped:

```json
{"error":{"message":"Model \"claude-sonnet-5\" must be called via /provider/v1/messages (Anthropic Messages shape).","type":"invalid_request_error","code":"unsupported_model"}}
```

The provider is registered as `@opencode/ai/providers/openai-compatible`, which
speaks `/chat/completions`. Discovery skips these models for that reason. If you
see the error anyway, the model was added manually to `opencode.json`; remove it
there or route it through an Anthropic-shaped provider.

## `HTTP 400 invalid request error`

This is the generic rejection the sanitizer exists for. Check whether it was a
payload problem or something else:

```bash
tail -20 "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-sanitizer.log"
```

- **Entries present around the failure** - the sanitizer repaired the payload and
  the request was rejected for a different reason. The `fixes` array lists exactly
  what was rewritten; a rejection after a repair usually means the upstream error
  is unrelated to tool-call structure.
- **No entries at all** - the request was structurally clean as far as the
  sanitizer is concerned. Common causes: a model that does not exist any more
  (see the retired-tier section), an unsupported field in the body, or a request
  the plugin never saw because another plugin rebuilt it first.

The sanitizer is fail-open: if it throws, the original request is sent unchanged,
so a missing log line can also mean the repair path errored. Enable nothing extra
for that - the design intentionally swallows hook errors.

## `HTTP 403 permission_error` for a free model

Free tiers are retired without notice and the id keeps resolving:

```json
{"error":{"message":"The free Ling 3.1 Flash tier has been retired. Ling 3.1 Flash is now a paid model ...","type":"permission_error","code":"FORBIDDEN"}}
```

The API then exposes the paid id (for example `inclusionai/ling-3.1-flash`), and
discovery picks it up on the next start. Fix a stale entry in `opencode.json` by
aligning it with `/provider/v1/models`:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/commandcode/key.txt)" \
     -H 'User-Agent: cli' https://api.commandcode.ai/provider/v1/models \
  | grep -o '"id": *"[^"]*"' | sort
```

If a model listed there still fails, the promo ended between your request and the
catalog refresh. Reselect and continue.

## `ECONNRESET` retries

The retry log is a forensic trail, not a failure counter:

```bash
grep -c . "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-retries.log"
grep -o '"type":"[^"]*"' "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-retries.log" \
  | sort | uniq -c | sort -rn
```

What the entries mean:

| `type` | Meaning |
| --- | --- |
| `provider.transport` (ECONNRESET) | stale or dropped socket; retried natively |
| `provider.internal` (503) | upstream overload; retried natively |
| `provider.invalid-output` | stream ended without `finish_reason` |
| `provider.invalid-request` | HTTP 400 from the provider |

OpenCode retries transient transport failures itself (10 attempts, 2s to 10s
backoff), so a recovered burst never surfaces to the user. The `Connection: close`
injection removes one specific cause (Bun reusing a socket Cloudflare already
closed); it does not eliminate upstream-side resets during an outage. Measured on
a production host: 99 of 130 logged events were `transport` resets spread over ten
days, concentrated in short upstream bursts, with zero unrecovered sessions.

To measure the injection's effect, disable it and compare:

```bash
export CC_NO_CONNECTION_CLOSE=1   # keep-alive reuse restored
```

## A turn hangs with a tool stuck in `streaming`

The watchdog aborts a silent SSE stream after 60s:

```bash
cat "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-watchdog.log"
```

- **A `watchdog.timeout` entry exists** - the abort fired as designed and the turn
  failed fast instead of freezing.
- **No entry and no file** - the freeze happened before the first chunk, which the
  watchdog deliberately does not police. That window belongs to OpenCode's provider
  timeout. Verify the request actually reached the network, then raise that timeout
  or retry.

## Key not found

The quota tool reports `Error consultando Command Code: No se encontro ...`. Check
which store the resolver sees:

```bash
bun -e 'import { resolveApiKeyWithSource } from "./src/auth/resolver.ts";
console.log(resolveApiKeyWithSource().source);'
```

`none` means all six stores came up empty. The simplest fix is the environment
variable:

```bash
export COMMAND_CODE_API_KEY="your-key"
```

Note the plugin still works without a key: sanitizer, watchdog and catalog cache
all keep running, only credential injection is skipped.

## Quota output is empty or partial

Each field is fetched independently and a failure degrades to `N/D` rather than
killing the report. A report showing plan and windows but no cycle totals means
only `/alpha/usage/summary` failed. Retry; if the account was just created, the
summary endpoint can be empty for the first few minutes.

## Duplicate tool registration

Symptom: OpenCode logs a duplicate plugin id or `commandcode_quota` appears twice.
Cause: a second plugin registering the same tool or hooks (for example the legacy
`commandcode-quota` plugin) is still listed in `opencode.json`. Remove the old
entry - running both means requests are sanitized twice and the second pass sees
an already-repaired payload.

## Logs are not being written

The plugin is fail-open, so telemetry failures are silent. Verify the state
directory is writable:

```bash
mkdir -p "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}" && touch "$_/probe" && rm "$_/probe"
```

An empty sanitizer log is the normal state: it only gets an entry when a payload
actually needed repair.
