import type { Recipe } from '../types.ts';

/**
 * Self-hosted System One (Jev-compatible) decision server, e.g. Cloudflare
 * Clef / Clef-flash (Apache-2.0) served from the operator's own GPU box.
 * The wire is TypeSafe's System One surface — POST {base}/systemone with
 * `{model, state, questions}` — so the decide runner reuses the TypeSafe
 * request builder and response parser unchanged. What differs is ownership:
 * the operator owns the server, so the decide egress gate treats the provider
 * id as local (no data-class consent, no private-egress rules; only
 * `decide.egress.deny_sources` applies) and no key is required.
 * `SYSTEMONE_API_KEY` is sent as a bearer when the operator sets one.
 *
 * The base URL MUST be configured, there is intentionally no
 * `base_url_default`: a misconfigured `systemone:<model>` id must fail with
 * `provider_error`, never silently fall back to TypeSafe's cloud endpoint.
 *
 *   gbrain config set provider_base_urls.systemone http://<host>:<port>/v1
 *   gbrain decide enable <slot> --provider systemone:<model>
 */
export const systemone: Recipe = {
  id: 'systemone',
  name: 'Self-hosted System One (Jev-compatible)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  auth_env: {
    required: [],
    optional: ['SYSTEMONE_API_KEY'],
  },
  touchpoints: {
    decide: {
      // Any Jev-compatible decision model the operator serves (e.g. clef-flash).
      // The id is the model string sent on the wire; the response's `model`
      // field is the drift identity.
      models: [],
      default_model: '',
      aliases: [],
      path: '/systemone',
      max_payload_bytes: 1_000_000,
      // Conservative planner estimates (about 2x the real token count) for a
      // server that refuses anything above 32,768 real tokens with HTTP 413
      // (the reference Clef-flash deployment). Keeps every planned batch well
      // under that cap, including schema and prompt overhead.
      max_request_tokens: 40_000,
      max_state_question_tokens: 24_000,
      // Local inference: electricity, not tokens. Zero-priced in
      // src/core/budget/reservation-cost.ts (FREE_LOCAL_SYSTEMONE_PROVIDERS).
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-10-02',
    },
  },
  setup_hint:
    'Point the recipe at your own Jev-compatible server: ' +
    '`gbrain config set provider_base_urls.systemone http://<host>:<port>/v1` ' +
    '(or set SYSTEMONE_BASE_URL), then `gbrain decide enable <slot> --provider systemone:<model>`. ' +
    'Optional bearer: set SYSTEMONE_API_KEY.',
};
