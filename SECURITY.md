# Security Policy

**English** | [Espanol](SECURITY.es.md)

## Scope

This plugin is a client-side integration for the Command Code provider. The most
security-relevant property of the code is that it **handles an API key**, so
credential handling defects are treated as vulnerabilities, not bugs.

In scope:

- Credential leakage or misdirected credential injection.
- Request tampering that could alter a payload beyond the documented repairs.
- Any path that lets a third party influence which host receives the API key.
- Telemetry that writes secrets to disk or into a log file.

Out of scope:

- Vulnerabilities in OpenCode itself (report them upstream).
- Vulnerabilities in the Command Code API or service (report them to Command Code).
- Model output quality, pricing, quota policy or catalog changes.
- Anything requiring an already-compromised host, shell access as the user, or
  the ability to edit the plugin's own files.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository
(`Security` tab -> `Report a vulnerability`). Please do not open a public issue.

Include, when possible:

- Affected version or commit sha.
- A minimal reproduction: the Request URL, the payload shape, and what the plugin
  did versus what it should have done.
- Whether a credential, a payload or a stream is affected.

Acknowledgement within 72 hours, and a fix or a mitigation plan within 14 days for
confirmed issues. Credit in the changelog on request.

## Threat model notes

The plugin assumes:

- The host and the user account are trusted. Anyone who can read the API key on
  disk already has it; the plugin does not attempt to protect against that.
- `opencode.json` and the plugin path are trusted configuration.
- The API key is a bearer credential with the account's full privileges. Scope it
  or rotate it if you suspect exposure.

Design rules that exist because of this threat model:

| Rule | Reason |
| --- | --- |
| Credentials are attached only after an exact hostname match | substring matching is trivially exploitable (`api.commandcode.ai.evil.com`, path-based matches, query strings) |
| `COMMANDCODE_ALLOWED_HOSTS` is the only allow-list | an explicit, auditable opt-in instead of a fuzzy match |
| An existing `authorization` header in never overwritten | a caller-provided credential must not be silently replaced |
| Logs never record the key, the `authorization` header or request bodies | `commandcode-*.log` files are plain text on disk |
| The sanitizer never rewrites fields other than `messages` | limits the blast radius of an in-flight payload modification |
| Every hook is fail-open | an attacker must not be able to disable model requests by inducing a plugin error |

## Hardening checklist for deployments

- Keep the key file at mode `600` and out of any synced or backed-up directory.
- Do not enable `COMMANDCODE_ALLOWED_HOSTS` unless a self-hosted gateway genuinely
  terminates your Command Code traffic.
- Treat the state directory as sensitive: it contains request metadata (session
  ids, model ids, error messages) even though it never contains the key.
- Review the diff before updating the plugin: it runs with full access to every
  model request in the OpenCode session.
