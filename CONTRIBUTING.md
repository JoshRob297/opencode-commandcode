# Contributing

**English** | [Espanol](CONTRIBUTING.es.md)

Thanks for taking the time to improve this plugin. It runs inside every model
request of an OpenCode session, so the bar for changes is: predictable, fail-open,
and testable without a network.

## Setup

```bash
git clone git@github.com:JoshRob297/opencode-commandcode.git
cd opencode-commandcode
bun install
bun test          # offline suite, no network, no quota consumed
bun run typecheck # strict tsc, no emit
```

The live suite is opt-in and calls the real API (it consumes a negligible amount
of quota):

```bash
COMMANDCODE_LIVE_TESTS=1 bun test
```

## Ground rules

These are not style preferences; they protect the plugin's guarantees. A change
that breaks one of them will be sent back.

1. **Fail-open.** Any plugin error must leave the original request untouched. Never
   let a hook throw into the OpenCode session.
2. **Credentials only after an exact host match.** Never introduce a substring,
   prefix or path-based check on the injection path. New trusted hosts go through
   `COMMANDCODE_ALLOWED_HOSTS`.
3. **Never overwrite a caller's `authorization` header.**
4. **No secrets in logs.** The plugin writes session ids, model ids, status codes
   and error messages. Never bodies, headers or the key.
5. **Catalog accuracy over catalog size.** Do not register models the
   OpenAI-compatible transport cannot serve. A model that fails when selected is
   worse than a model that is absent.
6. **No hardcoded user paths.** Use `XDG` and `os.homedir()`; tests must pass for
   any user.
7. **Pure helpers stay pure.** `src/hooks/resilience.ts` has no network access and
   only one filesystem check (the kill-switch sentinel), so its rules can be unit
   tested in isolation.
8. **Rebuild the Request only when the body actually changed.** Return
   `modified: false` for clean payloads.

## Commit messages

Conventional Commits, imperative, lowercase subject:

```
<type>(<scope>): <subject>

<body: what and why, wrapped at 72 columns>

<footer: refs, breaking changes>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `security`.
Scopes: `auth`, `catalog`, `sanitizer`, `watchdog`, `quota`, `telemetry`, `docs`.

Examples:

```
fix(auth): require an exact hostname match before injecting the API key
feat(catalog): tag free and promo tiers in the model selector
docs(troubleshooting): document the retired free-tier 403 payload
```

Keep commits atomic: one logical change plus its tests. Every commit must pass
`bun test` and `bun run typecheck`.

## Pull requests

- Fill in the pull request template. State the failure mode you observed, not only
  the change you made.
- Add or update tests. Bug fixes need a regression test that fails before the fix.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Docs live in two languages: `README.md` + `docs/*.md` (English) and
  `README.es.md` + `docs/es/*.md` (Spanish), plus the community file pairs
  (`SECURITY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`). Behaviour changes must be reflected
  in both, or say so explicitly in the PR so it can be tracked.

## Adding a new hook or rule

1. Put the pure logic in `src/hooks/resilience.ts` and export it.
2. Unit test it in `tests/` (no network, no OpenCode instance).
3. Document the rule in `docs/ARCHITECTURE.md` (rule table) and, if configurable,
   in `docs/CONFIGURATION.md`.
4. Wire it in `src/index.ts` behind a capability check
   (`typeof ctx.x?.transform === "function"`) and wrap it so it cannot throw.

## Reporting bugs

Open an issue using the bug report template. Include the OpenCode version, the
plugin commit, the model id, and the relevant lines from
`<state>/commandcode-*.log`. Never paste an API key into an issue.
