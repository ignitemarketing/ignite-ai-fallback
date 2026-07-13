/**
 * Cloudflare AI Gateway BYOK tests.
 *
 * These assert the security boundary: provider credentials are omitted only
 * for authenticated gateway-routed BYOK requests, while every direct request
 * retains the package's existing key requirement and provider auth behavior.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithFallback } from '../dist/index.js';

const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw';
const REQUEST = { messages: [{ role: 'user', content: 'hello' }] };
const ANTHROPIC_OK = { content: [{ type: 'text', text: 'anthropic' }] };
const OPENAI_OK = { choices: [{ message: { content: 'openai' } }] };
const GOOGLE_OK = {
  candidates: [{ content: { parts: [{ text: 'google' }] } }],
};
const ZAI_OK = { choices: [{ message: { content: 'zai' } }] };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Cloudflare AI Gateway BYOK', () => {
  it('strips mixed-case caller gateway headers before adding canonical computed headers', async () => {
    let capturedHeaders;
    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      REQUEST,
      {
        gatewayBase: `  ${GATEWAY}/  `,
        gatewayToken: '  gateway-token  ',
        gatewayByok: { alias: 'canonical-alias' },
        extraHeaders: {
          'CF-AIG-AUTHORIZATION': 'Bearer caller-token',
          'Cf-Aig-Byok-Alias': 'caller-alias',
        },
        fetchImpl: async (_url, init) => {
          capturedHeaders = init.headers;
          return jsonResponse(OPENAI_OK);
        },
      },
    );

    assert.equal(capturedHeaders['CF-AIG-AUTHORIZATION'], undefined);
    assert.equal(capturedHeaders['Cf-Aig-Byok-Alias'], undefined);
    assert.equal(capturedHeaders['cf-aig-authorization'], 'Bearer gateway-token');
    assert.equal(capturedHeaders['cf-aig-byok-alias'], 'canonical-alias');
  });

  it('blocks caller cf-aig-byok-alias when gatewayByok is false', async () => {
    let capturedHeaders;
    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: false,
        keys: { openai: 'provider-key' },
        extraHeaders: { 'CF-Aig-Byok-Alias': 'must-be-blocked' },
        fetchImpl: async (_url, init) => {
          capturedHeaders = init.headers;
          return jsonResponse(OPENAI_OK);
        },
      },
    );

    assert.equal(capturedHeaders['CF-Aig-Byok-Alias'], undefined);
    assert.equal(capturedHeaders['cf-aig-byok-alias'], undefined);
    assert.equal(capturedHeaders['Authorization'], 'Bearer provider-key');
  });

  it('runs an Anthropic gateway step without a local provider key', async () => {
    let captured;
    const result = await runWithFallback(
      [{ provider: 'anthropic', model: 'claude-haiku' }],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: true,
        keys: {},
        fetchImpl: async (url, init) => {
          captured = { url, headers: init.headers };
          return jsonResponse(ANTHROPIC_OK);
        },
      },
    );

    assert.equal(result.provider, 'anthropic');
    assert.ok(captured.url.startsWith(`${GATEWAY}/anthropic`));
    assert.equal(captured.headers['cf-aig-authorization'], 'Bearer gateway-token');
    assert.equal(captured.headers['x-api-key'], undefined);
    assert.equal(captured.headers['cf-aig-byok-alias'], undefined);
  });

  it('omits OpenAI Authorization even when a local key and colliding extra header exist', async () => {
    let capturedHeaders;
    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: true,
        keys: { openai: 'must-not-leak' },
        extraHeaders: { Authorization: 'Bearer extra-header-must-not-leak' },
        fetchImpl: async (_url, init) => {
          capturedHeaders = init.headers;
          return jsonResponse(OPENAI_OK);
        },
      },
    );

    assert.equal(capturedHeaders['Authorization'], undefined);
    assert.equal(capturedHeaders['cf-aig-authorization'], 'Bearer gateway-token');
  });

  it('omits the Google key query parameter on a gateway BYOK request', async () => {
    let capturedUrl;
    await runWithFallback(
      [{ provider: 'google', model: 'gemini-2.5-flash' }],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: true,
        keys: { google: 'must-not-leak' },
        fetchImpl: async (url) => {
          capturedUrl = url;
          return jsonResponse(GOOGLE_OK);
        },
      },
    );

    assert.ok(capturedUrl.startsWith(`${GATEWAY}/google-ai-studio/`));
    assert.equal(new URL(capturedUrl).searchParams.has('key'), false);
  });

  it('uses Cloudflare default BYOK alias when no alias is supplied', async () => {
    let capturedHeaders;
    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: true,
        fetchImpl: async (_url, init) => {
          capturedHeaders = init.headers;
          return jsonResponse(OPENAI_OK);
        },
      },
    );

    assert.equal(capturedHeaders['cf-aig-byok-alias'], undefined);
  });

  it('sends an explicit cf-aig-byok-alias only on the BYOK gateway step', async () => {
    const calls = [];
    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'zai-glm', model: 'glm-4.6' },
      ],
      REQUEST,
      {
        gatewayBase: GATEWAY,
        gatewayToken: 'gateway-token',
        gatewayByok: { alias: '  billing-key-2  ' },
        keys: { 'zai-glm': 'direct-zai-key' },
        fetchImpl: async (url, init) => {
          calls.push({ url, headers: init.headers });
          if (calls.length === 1) return jsonResponse({ error: 'overloaded' }, 503);
          return jsonResponse(ZAI_OK);
        },
      },
    );

    assert.equal(result.provider, 'zai-glm');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['cf-aig-byok-alias'], 'billing-key-2');
    assert.equal(calls[0].headers['x-api-key'], undefined);
    assert.ok(calls[1].url.startsWith('https://api.z.ai/'));
    assert.equal(calls[1].headers['Authorization'], 'Bearer direct-zai-key');
    assert.equal(calls[1].headers['cf-aig-authorization'], undefined);
    assert.equal(calls[1].headers['cf-aig-byok-alias'], undefined);
  });

  it('does not leak gateway auth or enable BYOK when gatewayBase is absent', async () => {
    let captured;
    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      REQUEST,
      {
        gatewayToken: 'must-not-leak',
        gatewayByok: { alias: 'must-not-leak' },
        keys: { openai: 'direct-provider-key' },
        extraHeaders: {
          'CF-AIG-Authorization': 'Bearer extra-header-must-not-leak',
          'CF-AIG-BYOK-ALIAS': 'extra-alias-must-not-leak',
        },
        fetchImpl: async (url, init) => {
          captured = { url, headers: init.headers };
          return jsonResponse(OPENAI_OK);
        },
      },
    );

    assert.ok(captured.url.startsWith('https://api.openai.com/'));
    assert.equal(captured.headers['Authorization'], 'Bearer direct-provider-key');
    assert.equal(captured.headers['cf-aig-authorization'], undefined);
    assert.equal(captured.headers['cf-aig-byok-alias'], undefined);
    assert.equal(captured.headers['CF-AIG-Authorization'], undefined);
    assert.equal(captured.headers['CF-AIG-BYOK-ALIAS'], undefined);
  });

  it('requires a provider key when BYOK is requested without gatewayToken', async () => {
    let callCount = 0;
    await assert.rejects(
      () => runWithFallback(
        [{ provider: 'anthropic', model: 'claude-haiku' }],
        REQUEST,
        {
          gatewayBase: GATEWAY,
          gatewayByok: true,
          keys: {},
          fetchImpl: async () => {
            callCount++;
            return jsonResponse(ANTHROPIC_OK);
          },
        },
      ),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.match(err.message, /API key not configured/);
        return true;
      },
    );
    assert.equal(callCount, 0);
  });

  it('treats whitespace gatewayToken as missing and does not activate BYOK', async () => {
    let callCount = 0;
    await assert.rejects(
      () => runWithFallback(
        [{ provider: 'openai', model: 'gpt-4o' }],
        REQUEST,
        {
          gatewayBase: GATEWAY,
          gatewayToken: '   ',
          gatewayByok: true,
          keys: {},
          fetchImpl: async () => {
            callCount++;
            return jsonResponse(OPENAI_OK);
          },
        },
      ),
      AggregateError,
    );
    assert.equal(callCount, 0);
  });

  it('treats whitespace provider keys as missing on direct requests', async () => {
    let callCount = 0;
    await assert.rejects(
      () => runWithFallback(
        [{ provider: 'openai', model: 'gpt-4o' }],
        REQUEST,
        {
          keys: { openai: '   ' },
          fetchImpl: async () => {
            callCount++;
            return jsonResponse(OPENAI_OK);
          },
        },
      ),
      AggregateError,
    );
    assert.equal(callCount, 0);
  });

  it('requires a provider key when token + BYOK are set without gatewayBase', async () => {
    let callCount = 0;
    await assert.rejects(
      () => runWithFallback(
        [{ provider: 'openai', model: 'gpt-4o' }],
        REQUEST,
        {
          gatewayToken: 'gateway-token',
          gatewayByok: true,
          keys: {},
          fetchImpl: async () => {
            callCount++;
            return jsonResponse(OPENAI_OK);
          },
        },
      ),
      AggregateError,
    );
    assert.equal(callCount, 0);
  });
});
