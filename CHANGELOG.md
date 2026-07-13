# Changelog

All notable changes to this project are documented in this file.

## 0.7.0

- **Added** `FallbackOptions.gatewayByok` for Cloudflare AI Gateway provider
  keys stored in Secrets Store. `true` uses Cloudflare's default alias;
  `{ alias: 'name' }` sends `cf-aig-byok-alias: name`.
- **Security boundary:** provider credentials are omitted only when the step is
  gateway-routed and both `gatewayBase` and `gatewayToken` are present. Direct
  calls and gateway-bypassing fallbacks still require and send their provider
  key. Gateway auth and BYOK alias headers never attach without gateway routing.
- **Changed** adapter builders to accept an omitted provider key so the BYOK
  route can intentionally leave out Anthropic `x-api-key`, OpenAI
  `Authorization`, and Google's `?key=` while preserving existing keyed calls.

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
