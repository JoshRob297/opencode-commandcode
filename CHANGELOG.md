# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) - SemVer.

## [Unreleased]

## [1.0.1] - 2026-10-19

### Added

- Installation straight from GitHub with the `github:` plugin specifier, verified end to
  end (clone, cache, load, inference) with no npm publication and no build step.
- Troubleshooting section for the plugins-directory auto-discovery asymmetry: a plugin
  removed from `opencode.json`, or renamed inside `~/.config/opencode/plugins/`, keeps
  loading until the directory leaves `plugins/` (then the watcher drops it live).

### Changed

- README and configuration docs document three installation paths: GitHub specifier
  (recommended), local clone, and the auto-discovered plugins directory.

## [1.0.0] - 2026-10-18

First modular release. Migrates the single-file `commandcode-quota` plugin into a
structured package with dynamic model discovery.

### Added

- Dynamic model discovery from `GET /provider/v1/models` through the OpenCode v2
  model editor, with transport-aware filtering and automatic `[FREE PROMO]`
  badges for free/promo tiers.
- On-disk model catalog cache (12h TTL) so an upstream outage cannot leave the
  provider with an empty model list at startup.
- Multi-source credential resolution: `COMMAND_CODE_API_KEY`, `COMMANDCODE_KEY_FILE`,
  `$XDG_CONFIG_HOME/commandcode/key.txt`, `/etc/environment`, then the official CLI
  stores under `~/.commandcode/`.
- Strict origin guard (`isCommandCodeHost`) for credential injection, plus the
  `COMMANDCODE_ALLOWED_HOSTS` allow-list opt-in.
- Bounded API calls via `AbortSignal.timeout` (10s default).
- Vision capability metadata (`image` input) for multimodal models.
- `applyModelCatalog` exported for testability.
- Offline test suite (58 tests) and an opt-in live suite gated by
  `COMMANDCODE_LIVE_TESTS`.
- Strict typecheck configuration (`allowImportingTsExtensions`, `strict`,
  `noUncheckedIndexedAccess`) with `bun-types`.
- Documentation in English and Spanish: `README.md` / `README.es.md`,
  `docs/{ARCHITECTURE,CONFIGURATION,TROUBLESHOOTING}.md` / `docs/es/*`,
  `SECURITY`, `CONTRIBUTING` and `CODE_OF_CONDUCT` pairs, plus `LICENSE`.

### Changed

- State directory, key paths and the connection-close sentinel are resolved from
  `XDG`/home instead of hardcoded `/root` paths.
- Retry telemetry now ignores non-Command-Code providers, keeping
  `commandcode-retries.log` meaningful.
- The `retry` log records the provider id and degrades gracefully when the hook
  is unsupported by the running build.

### Fixed

- **Security:** credentials were attached based on substring URL matching
  (`api.commandcode.ai` anywhere in the URL, or any URL containing
  `/provider/v1/chat/completions`). That leaked the API key to lookalike hosts
  such as `api.commandcode.ai.evil.com`, to any host carrying the provider path,
  and to values injected in query strings or fragments.
- Anthropic-shaped models (`claude-*`, `/messages` only) were registered under the
  OpenAI-compatible transport and failed with `400 unsupported_model`. They are now
  filtered out.
- Free-model detection missed `-free` / `_free` / `.free` id shapes, so e.g.
  `poolside/laguna-s-2.1-free` was not tagged.
- The sanitizer had regressed relative to the proven v1 implementation: `null` and
  empty tool response content was no longer normalized, orphan detection was no
  longer order-sensitive, and malformed `tool_call` entries were not pruned.
- The sanitizer mutated the caller's message array in place instead of working on
  a shallow clone.
- The watchdog could fire an abort after a consumer cancellation, and a throwing
  logging callback could leave the stream open.
- Quota report rendering crashed on a missing window; it now degrades per field.

### Removed

- Hardcoded user-specific absolute paths removed from the runtime code in favour of
  XDG/home resolution.
- Network calls from the default test suite.
