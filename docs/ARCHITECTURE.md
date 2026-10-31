# Architecture

**English** | [Espanol](es/architecture.md)

## Module map

```
index.ts                     entrypoint: `export default { id, setup, server }`
src/index.ts                 registration of hooks, model catalog, tool and command
src/auth/resolver.ts         credential cascade (pure I/O, no network)
src/auth/pool.ts             multi-key pool, cooldowns and state persistence
src/client/api.ts            Command Code API client + on-disk catalog cache
src/hooks/resilience.ts      pure helpers (no side effects except a sentinel check)
src/hooks/zdr.ts             zero data retention policy (CMD_ZDR)
src/hooks/errors.ts          actionable JSON error decoration
src/tools/quota.ts           quota payload formatting
```

`src/hooks/resilience.ts` is intentionally dependency-free and side-effect-free so
every rule that guards a request or a credential can be unit tested without a
running OpenCode instance.

## Lifecycle

```
OpenCode start
      |
      v
plugin.setup(ctx)
      |
      +-- ctx.session.hook("http.request")   -> connection hygiene
      |                                      -> ZDR policy (opt-in)
      |                                      -> credential injection / key rotation
      |                                      -> payload sanitizer
      +-- ctx.session.hook("http.response")  -> key cooldown + actionable errors
      |                                      -> SSE inactivity watchdog
      +-- ctx.session.hook("retry")          -> retry telemetry (Command Code only)
      +-- ctx.model.transform()              -> catalog registration + promo badges
      +-- ctx.tool.transform()               -> commandcode_quota
      +-- ctx.command.transform()            -> /commandcode-quota
```

Hooks and transforms are registered once. The model transform reads the catalog
that was resolved before registration, so `setup` performs at most one network
call and it is bounded by `AbortSignal.timeout(10s)` with a disk fallback.

## Request path

```
OpenCode -> model request
      |
      v
[http.request hook]
      |
      |-- is it Command Code?
      |     no  -> return untouched (early exit)
      |     yes -> continue
      |
      |-- A. connection hygiene
      |     set `connection: close` in place on the existing Request
      |     (preserves AbortSignal, body and headers; never rebuilds)
      |
      |-- B. zero data retention
      |     CMD_ZDR=1 -> `x-cmd-zdr: 1`; otherwise strip a caller-supplied header
      |
      |-- C. credential injection / rotation
      |     exact host only. With one key: inject only when no header is present.
      |     With a pool of >=2 keys: the plugin owns the header and picks the
      |     first key that is not cooling down.
      |
      |-- D. payload sanitizer
      |     read a clone of the body, repair it, and rebuild the Request
      |     ONLY when something actually changed
      |
      v
Command Code
      |
      v
[http.response hook]
      |
      |-- JSON error? -> append a resolution hint (status and envelope kept)
      |-- key rotation? -> record a cooldown from 402/401/403/429
      |-- SSE and Command Code? -> wrap in the inactivity watchdog
      |-- otherwise            -> return untouched
      |
      v
OpenCode session
```

### Why the sanitizer rebuilds conditionally

Rebuilding a `Request` discards nothing explicitly, but it is still a new object
and a new body stream. Doing it on every request would be wasteful and would drop
body-level state that OpenCode may have attached. The sanitizer therefore returns
`modified: false` for clean input and the original `Request` travels untouched.
The rebuild path preserves method, url, signal and headers, and deliberately drops
`content-length` so the runtime recomputes it from the new body.

### Why the credential guard parses the URL

The plugin attaches a secret. A substring check such as
`url.includes("api.commandcode.ai")` is satisfied by
`https://api.commandcode.ai.attacker.com/` and by `https://evil.com/?next=api.commandcode.ai`,
and a path check such as `url.includes("/provider/v1/chat/completions")` is
satisfied by any self-hosted or proxied endpoint. Either mistake turns the plugin
into a credential exfiltration primitive. `isCommandCodeHost()` parses the URL and
compares the hostname exactly; `COMMANDCODE_ALLOWED_HOSTS` is the only sanctioned
escape hatch.

The broad matcher `isCommandCodeRequest()` still exists, because repairing a
payload carries no secret, but it is never used on the injection path.

## Sanitizer rules

Applied in order. Any rule that fires sets `modified: true` and is recorded in
`commandcode-sanitizer.log`.

| # | Rule | Trigger |
| --- | --- | --- |
| 1 | Remove malformed `tool_call` entries | entry is `null` or not an object |
| 2 | Add a missing `tool_call.id` | assistant call without id |
| 3 | Deduplicate `tool_call.id` | two calls share an id |
| 4 | Stringify `function.arguments` | arguments are not a string |
| 5 | Drop orphan / out-of-order tool responses | `tool` message whose `tool_call_id` was not declared by an assistant message **before** it |
| 6 | Normalize `null` / empty tool content | tool response content is `null`, `undefined` or `""` -> `"{}"` |
| 7 | Inject a synthetic tool response | assistant `tool_calls` not answered inside their contiguous block |

Rule 5 is order-sensitive on purpose. The field failure it was written for is a
history slice that starts in the middle of a tool group, leaving a leading `tool`
message with no declaring call; Command Code answers the whole request with a
generic `HTTP 400 invalid request error`. Keeping the check order-sensitive also
covers the sibling case where a tool result arrives before its call.

Rule input is shallow-cloned: the caller's payload is never mutated.

## Watchdog semantics

```
chunk 1 arrives            60s inactivity window armed
    |                             |
    |<-------- chunks keep coming -------->
                                  |
                          no chunk within 60s
                                  |
                                  +-> onTimeout() -> <state>/commandcode-watchdog.log
                                  +-> controller.error(...) -> turn fails fast
                                  +-> reader.cancel()
```

- The window is armed **after** the first chunk, so a slow first token is not
  penalized.
- Consumer cancellation clears the timer, so no stray abort fires on a healthy
  stream that the user interrupted.
- Upstream errors propagate unchanged.
- The timer callback and the abort are each wrapped: an error while logging can
  never leave the stream open.

## Model catalog rules

```
/latest catalog (network, 10s timeout)
        |
        +-- ok --------> filter -> register -> write cache (6h TTL)
        |
        +-- fail ------> read cache -> register
                              |
                              +-- empty -> skip registration (curated config wins)
```

Registration filters and annotations:

| Rule | Reason |
| --- | --- |
| Skip models without `/chat/completions` | the provider is OpenAI-compatible; Anthropic-shaped models answer `400 unsupported_model` |
| Badge `[FREE PROMO]` when free/promo is detected | free tiers rotate often and are easy to miss in the selector |
| Preserve `context_length` | prevents silent truncation surprises per model |
| Add `image` input when the model looks multimodal | capability metadata drives the UI and input validation |

A cache miss is not an error: when both the network call and the cache are empty,
the plugin registers nothing and the statically configured models keep working.

## Failure model

| Situation | Behaviour |
| --- | --- |
| Command Code unreachable at startup | cached catalog, or nothing registered |
| API key missing | sanitizer and watchdog still work; injection is skipped |
| Sanitizer throws | original request proceeds untouched |
| Watchdog logging throws | stream is still aborted cleanly |
| `retry` hook unsupported by the build | registration is caught and ignored |
| Model editor throws per model | that model is skipped, others register |
| OpenCode v1 | `server()` exposes the quota tool only |
