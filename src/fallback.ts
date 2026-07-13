import type {
  ProviderStep,
  ChatRequest,
  ChatResult,
  FallbackOptions,
  GatewayByokOptions,
  Provider,
} from './types.js';
import { readEnv } from './env.js';
import { buildAigAuthHeader } from './gateway.js';
import { buildAnthropicByokRequest, buildAnthropicRequest, parseAnthropicResponse } from './adapters/anthropic.js';
import { buildOpenAIByokRequest, buildOpenAIRequest, parseOpenAIResponse } from './adapters/openai.js';
import { buildGoogleByokRequest, buildGoogleRequest, parseGoogleResponse } from './adapters/google.js';

// ---------------------------------------------------------------------------
// Provider constants
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'zai-glm': 'ZAI_API_KEY',
};

/**
 * Direct (non-gateway) base URLs per provider.
 *
 * zai-glm: https://api.z.ai/api/paas/v4 — z.ai's OpenAI-compatible PAYG endpoint
 * (Bearer auth, ZAI_API_KEY). Requires a FUNDED z.ai pay-as-you-go account/key.
 * Override with the ZAI_BASE_URL env var if you move endpoints, e.g. the Coding
 * Plan path https://api.z.ai/api/coding/paas/v4 (subscription quota, but z.ai's
 * TOS scopes that plan to coding tools, not app backends).
 */
const PROVIDER_BASE: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com',
  'zai-glm': 'https://api.z.ai/api/paas/v4',
};

/**
 * CF AI Gateway provider slugs used to build the routed URL:
 *   {gatewayBase}/{slug}/...
 *
 * zai-glm is intentionally absent — CF has no native z.ai provider,
 * so zai-glm always calls its direct base URL regardless of gatewayBase.
 */
const GATEWAY_SLUGS: Partial<Record<Provider, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-ai-studio',
};

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

type BuildFn = (
  req: ChatRequest,
  model: string,
  key: string,
  base: string,
) => { url: string; init: RequestInit };

type BuildByokFn = (
  req: ChatRequest,
  model: string,
  base: string,
) => { url: string; init: RequestInit };

type ParseFn = (data: unknown, provider: Provider, model: string) => ChatResult;

const ADAPTERS: Record<Provider, { build: BuildFn; buildByok: BuildByokFn; parse: ParseFn }> = {
  anthropic: { build: buildAnthropicRequest, buildByok: buildAnthropicByokRequest, parse: parseAnthropicResponse },
  openai: { build: buildOpenAIRequest, buildByok: buildOpenAIByokRequest, parse: parseOpenAIResponse },
  google: { build: buildGoogleRequest, buildByok: buildGoogleByokRequest, parse: parseGoogleResponse },
  // zai-glm is OpenAI-compatible; reuse the same adapter, only base URL differs
  'zai-glm': { build: buildOpenAIRequest, buildByok: buildOpenAIByokRequest, parse: parseOpenAIResponse },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveKey(
  provider: Provider,
  overrides?: Partial<Record<Provider, string>>,
): string | undefined {
  const value = overrides?.[provider] ?? readEnv(PROVIDER_ENV_KEYS[provider]);
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeGatewayBase(value?: string): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

function getBaseUrl(provider: Provider, gatewayBase?: string): string {
  // zai-glm always bypasses the CF AI Gateway; base URL overridable via ZAI_BASE_URL
  // (e.g. to switch between the PAYG and Coding Plan endpoints without a code change).
  if (provider === 'zai-glm') {
    return normalizeGatewayBase(readEnv('ZAI_BASE_URL')) ?? PROVIDER_BASE['zai-glm'];
  }
  if (!gatewayBase) {
    return PROVIDER_BASE[provider];
  }
  const slug = GATEWAY_SLUGS[provider];
  return slug ? `${gatewayBase}/${slug}` : PROVIDER_BASE[provider];
}

/**
 * True when `provider` actually routes through the CF AI Gateway for the
 * given `gatewayBase` — i.e. `gatewayBase` is set AND the provider has a
 * gateway slug (see GATEWAY_SLUGS; zai-glm never does, since CF has no
 * native z.ai provider).
 *
 * Used to scope `opts.gatewayToken`'s cf-aig-authorization header to only
 * the steps that actually hit the gateway, so the token never leaks to
 * direct provider calls or third-party endpoints (e.g. api.z.ai).
 */
function isGatewayRouted(provider: Provider, gatewayBase?: string): boolean {
  return Boolean(gatewayBase) && GATEWAY_SLUGS[provider] !== undefined;
}

/**
 * BYOK is deliberately stricter than gateway routing alone: an authenticated
 * gateway token must also be present before this package omits a provider key.
 * A partial configuration therefore fails closed to the existing key-required
 * behavior instead of accidentally issuing an unauthenticated request.
 */
function isGatewayByokStep(
  provider: Provider,
  gatewayBase: string | undefined,
  hasGatewayAuth: boolean,
  byok: FallbackOptions['gatewayByok'],
): boolean {
  return Boolean(byok && hasGatewayAuth && isGatewayRouted(provider, gatewayBase));
}

function gatewayByokHeaders(
  byok: boolean | GatewayByokOptions | undefined,
): Record<string, string> {
  if (!byok || typeof byok === 'boolean') return {};
  const alias = byok.alias?.trim();
  return alias ? { 'cf-aig-byok-alias': alias } : {};
}

/** Remove provider credentials supplied through extraHeaders on a BYOK step. */
function stripProviderAuthHeaders(
  provider: Provider,
  headers: Record<string, string>,
): void {
  const blocked = provider === 'anthropic'
    ? new Set(['x-api-key'])
    : provider === 'openai'
      ? new Set(['authorization'])
      : provider === 'google'
        ? new Set(['x-goog-api-key'])
        : new Set<string>();

  for (const name of Object.keys(headers)) {
    if (blocked.has(name.toLowerCase())) delete headers[name];
  }
}

/**
 * Gateway-only headers are credentials/control data and must never be sent to
 * a direct provider, even if a caller accidentally supplied them through
 * extraHeaders.
 */
function stripGatewayOnlyHeaders(headers: Record<string, string>): void {
  const gatewayOnly = new Set(['cf-aig-authorization', 'cf-aig-byok-alias']);
  for (const name of Object.keys(headers)) {
    if (gatewayOnly.has(name.toLowerCase())) delete headers[name];
  }
}

function sanitizedExtraHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  stripGatewayOnlyHeaders(headers);
  return headers;
}

/**
 * Returns true for HTTP status codes that warrant trying the next provider:
 *   - 429  Too Many Requests / rate limit
 *   - 5xx  Server errors (overload, maintenance, transient failures)
 *
 * 4xx errors other than 429 (bad request, invalid auth, etc.) are NOT retryable
 * and are propagated immediately so the caller can fix the underlying issue.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface StepFailure {
  step: ProviderStep;
  reason: string;
}

/**
 * Runs a chain of LLM provider steps in order, returning the first success.
 *
 * Advancement rules (when does it move to the next step?):
 *   - Missing API key        → silently skip (non-fatal, logged in AggregateError)
 *   - Any HTTP error (4xx/5xx) → advance to next step (revoked key, stale model,
 *                                or overload on one provider routes to the next)
 *   - Network / fetch error  → advance to next step
 *   - AbortError             → re-throw immediately (caller cancelled)
 *   - All steps fail/skip    → throw AggregateError listing every step's reason
 *
 * @example
 * ```ts
 * const result = await runWithFallback(
 *   [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
 *     { provider: 'openai',    model: 'gpt-4o' },
 *     { provider: 'zai-glm',  model: 'glm-4-plus' },
 *   ],
 *   { messages: [{ role: 'user', content: 'Hello!' }] },
 *   { gatewayBase: process.env.CF_AI_GATEWAY_BASE },
 * );
 * console.log(result.text, result.provider);
 * ```
 */
export async function runWithFallback(
  chain: ProviderStep[],
  request: ChatRequest,
  opts?: FallbackOptions,
): Promise<ChatResult> {
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const failures: StepFailure[] = [];
  const gatewayBase = normalizeGatewayBase(opts?.gatewayBase);
  const gatewayAuthHeaders = buildAigAuthHeader(opts?.gatewayToken);
  const hasGatewayAuth = gatewayAuthHeaders['cf-aig-authorization'] !== undefined;

  for (const step of chain) {
    const apiKey = resolveKey(step.provider, opts?.keys);
    const gatewayRouted = isGatewayRouted(step.provider, gatewayBase);
    const gatewayByok = isGatewayByokStep(step.provider, gatewayBase, hasGatewayAuth, opts?.gatewayByok);

    if (!apiKey && !gatewayByok) {
      failures.push({
        step,
        reason: `API key not configured (env: ${PROVIDER_ENV_KEYS[step.provider]}) — step skipped`,
      });
      continue;
    }

    const baseUrl = getBaseUrl(step.provider, gatewayBase);
    const { build, buildByok, parse } = ADAPTERS[step.provider];
    const { url, init } = gatewayByok
      ? buildByok(request, step.model, baseUrl)
      : build(request, step.model, apiKey as string, baseUrl);

    // CF AI Gateway auth header — attached ONLY when this specific step
    // routes through the gateway. Never blanket-merged into extraHeaders:
    // that would leak an account-wide gateway token to steps that bypass
    // the gateway entirely (zai-glm → api.z.ai; any provider when
    // gatewayBase is unset).
    const aigHeaders = gatewayRouted
      ? gatewayAuthHeaders
      : {};

    const byokHeaders = gatewayByok
      ? gatewayByokHeaders(opts?.gatewayByok)
      : {};

    // Merge caller-supplied extra headers (e.g. CF AI Gateway metadata tags)
    // UNDER the gateway-token header UNDER the adapter's own headers, so:
    //   - gatewayToken's cf-aig-authorization wins over an extraHeaders
    //     value for the same key (R6 precedence)
    //   - adapter auth/content-type headers always win over both
    const headers = {
      ...sanitizedExtraHeaders(opts?.extraHeaders),
      ...aigHeaders,
      ...byokHeaders,
      ...(init.headers as Record<string, string>),
    };

    if (gatewayByok) stripProviderAuthHeaders(step.provider, headers);
    if (!gatewayRouted) stripGatewayOnlyHeaders(headers);

    let response: Response;
    try {
      response = await fetchFn(url, { ...init, headers, signal: opts?.signal });
    } catch (err) {
      // Re-throw cancellation immediately
      if (err instanceof Error && err.name === 'AbortError') throw err;
      failures.push({
        step,
        reason: `Network error: ${String(err)}`,
      });
      continue;
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => '(unreadable body)');
      }

      // Advance on ANY HTTP error. This is a resilience chain: a revoked key
      // (401), stale model (404), or per-provider bad-request (400) on one
      // provider should route to the next, not kill the whole request. A
      // request malformed for every provider simply exhausts the chain and
      // surfaces all reasons via the AggregateError below. isRetryableStatus
      // only annotates the reason (transient vs config) for debuggability.
      const kind = isRetryableStatus(response.status) ? 'transient' : 'config';
      failures.push({
        step,
        reason: `HTTP ${response.status} (${kind}): ${JSON.stringify(body).slice(0, 300)}`,
      });
      continue;
    }

    const data = (await response.json()) as unknown;
    return parse(data, step.provider, step.model);
  }

  // Every step either failed or was skipped
  const summary = failures
    .map((f) => `  • ${f.step.provider}/${f.step.model}: ${f.reason}`)
    .join('\n');

  throw new AggregateError(
    failures.map(
      (f) => new Error(`${f.step.provider}/${f.step.model}: ${f.reason}`),
    ),
    `All provider steps failed or were skipped:\n${summary}`,
  );
}
