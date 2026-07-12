# Changelog

All notable changes to this project are documented in this file.

## 0.6.0

- **Added** `FallbackOptions.gatewayToken` — first-class Cloudflare AI Gateway
  "Authenticated Gateway" support. When set, sends
  `cf-aig-authorization: Bearer <token>` on steps that actually route through
  the gateway (`gatewayBase` set for that step **and** the provider is
  gateway-supported). Never attached to a step that bypasses the gateway
  (zai-glm always bypasses it; any provider bypasses it when `gatewayBase`
  is unset), so the token can't leak to third-party endpoints or direct
  provider calls. The package adds the `Bearer ` prefix (no double-prefix if
  already present); if `extraHeaders['cf-aig-authorization']` is also set,
  `gatewayToken`'s computed header wins.
- **Added** `buildAigAuthHeader(token)` — exported pure, zero-dependency
  helper that builds the same `cf-aig-authorization` header, for callers
  using their own SDK/fetch calls against a CF AI Gateway without going
  through `runWithFallback`.

## 0.5.0 and earlier

No changelog kept prior to 0.6.0 — see git history.
