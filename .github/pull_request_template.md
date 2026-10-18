## What problem does this solve?

<!-- The failure mode you observed (or the gap you are closing), not just the change. -->

## Changes

<!-- Bullet list of the behavioural changes. Mention anything that alters an existing guarantee. -->

## Failure mode reproduced before the fix

<!-- Required for bug fixes: how you reproduced it, and the evidence (log line, HTTP status, payload shape). -->

## Verification

- [ ] `bun test` passes (offline suite)
- [ ] `bun run typecheck` passes
- [ ] Regression test added that fails before this change (bug fixes)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] Docs updated in both languages (`README.md`/`docs/*` and `README.es.md`/`docs/es/*`)
- [ ] No secrets, keys, personal paths or private hosts in code, tests, docs or logs

## Guarantees affected

<!-- Tick only if the change touches one of these, and explain how it stays intact. -->

- [ ] Credential injection path (exact host match)
- [ ] Fail-open behaviour of a hook
- [ ] Payload sanitizer rules
- [ ] Model catalog filtering
- [ ] Nothing above
