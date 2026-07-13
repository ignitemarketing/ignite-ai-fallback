/**
 * @module gateway
 * Cloudflare AI Gateway auth-header helper.
 *
 * Zero dependencies, pure function — safe to use standalone from raw-SDK or
 * raw-fetch callers (in other repos) that don't go through runWithFallback.
 */

/**
 * Builds the `cf-aig-authorization` header for a Cloudflare AI Gateway
 * "Authenticated Gateway" token.
 *
 * - Falsy `token` (undefined, null, '') → `{}` (no header), so this can be
 *   spread unconditionally into a headers object.
 * - Otherwise → `{ 'cf-aig-authorization': 'Bearer <token>' }`. The `Bearer `
 *   prefix is added for you; if `token` already starts with `Bearer `
 *   (case-insensitive), it is used as-is (no double prefix).
 *
 * This is the same logic runWithFallback applies internally (via
 * `opts.gatewayToken`) when a step routes through the gateway — exported
 * separately so callers using their own fetch/SDK calls against a CF AI
 * Gateway can build the header themselves.
 */
export function buildAigAuthHeader(
  token: string | undefined | null,
): Record<string, string> {
  const trimmed = token?.trim();
  if (!trimmed || /^bearer\s*$/i.test(trimmed)) return {};
  const value = /^bearer\s/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  return { 'cf-aig-authorization': value };
}
