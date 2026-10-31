/**
 * Zero data retention (ZDR) passthrough.
 *
 * Command Code exposes ZDR as a request header (`x-cmd-zdr: 1`), the same
 * opt-in its CLI reads from `CMD_ZDR=1`. The header is only emitted when the
 * user explicitly opts in:
 *
 *   - `CMD_ZDR=1` -> every Command Code request carries `x-cmd-zdr: 1`
 *   - anything else -> any caller-supplied `x-cmd-zdr` header is stripped, so
 *     a session that did not opt in can never emit it by accident
 *
 * Stripping (instead of ignoring) matters because the header is a policy
 * control: a lookalike client or a stale config must not be able to turn it on
 * for a user who never asked for it.
 */

export const ZDR_HEADER = "x-cmd-zdr";

/** True only for the explicit opt-in value documented by the CLI. */
export function isZdrEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CMD_ZDR === "1";
}

/**
 * Applies the ZDR policy to a request's headers.
 *
 * Headers is case-insensitive, so `get`/`delete`/`set` cover every casing the
 * caller may have used.
 */
export function applyZdrHeader(
  headers: Headers,
  env: Record<string, string | undefined> = process.env
): void {
  if (headers.get(ZDR_HEADER) !== null) {
    headers.delete(ZDR_HEADER);
  }
  if (isZdrEnabled(env)) {
    headers.set(ZDR_HEADER, "1");
  }
}
