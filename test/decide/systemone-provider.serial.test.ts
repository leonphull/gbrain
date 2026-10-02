/**
 * The self-hosted System One provider id (`systemone:<model>`, e.g. Cloudflare
 * Clef-flash on the operator's own Jev-compatible server): the provider
 * validator, the shared Jev-wire runner (request shape, answer parsing,
 * optional bearer, drift identity), egress verdicts (operator-owned: no
 * consent / private-egress gate; denied sources still refused) and the
 * no-silent-cloud-fallback contract (missing base URL fails loudly, the
 * transport is never pointed at TypeSafe).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { isValidProvider, providerKind, readDecideConfig, thirdPartyDecideProvider } from '../../src/core/ai/decide/config.ts';
import { checkEgress } from '../../src/core/ai/decide/egress.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { DecideError, type DecideQuestion, type EvidenceItem } from '../../src/core/ai/decide/types.ts';
import { usageCostUsd } from '../../src/core/budget/reservation-cost.ts';

let engine: PGLiteEngine;

const cand = (slug: string, source_id = 'default'): EvidenceItem => ({ text: `text of ${slug}`, class: 'candidates', slug, source_id });
const q = (id: string, input: EvidenceItem): DecideQuestion => ({ id, kind: 'noul', instructions: 'Is `c` evidence?', inputs: { c: input } });
const STATE = { query: { text: 'q', class: 'query' as const } };
const SYSTEMONE_BASE = 'http://localhost:8130/v1';

/** One Jev-wire response for every question in the request. */
function answerAll(model = () => 'clef-flash') {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  __setDecideTransportForTests(async (url, init) => {
    const body = JSON.parse(init.body as string);
    const headers = init.headers as Record<string, string>;
    calls.push({ url, headers, body });
    return new Response(JSON.stringify({
      model: model(), usage: { input_tokens: 200, output_tokens: 5 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.7 }])),
    }));
  });
  return calls;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setDecideTransportForTests(null);
});

async function page(slug: string, visibility?: string, sourceId?: string) {
  const frontmatter: Record<string, unknown> = visibility ? { visibility } : {};
  const r = await importFromContent(engine, slug, serializeMarkdown(frontmatter, `body of ${slug}`, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true, ...(sourceId ? { sourceId } : {}) });
  expect(r.status).toBe('imported');
}

describe('provider id and recipe', () => {
  test('systemone:<model> is a valid decide provider id, parsed by providerKind', () => {
    expect(isValidProvider('systemone:clef-flash')).toBe(true);
    expect(isValidProvider('systemone:clef')).toBe(true);
    expect(isValidProvider('systemone:')).toBe(false);
    expect(isValidProvider('systemone:clef evil')).toBe(false);
    expect(providerKind('systemone:clef-flash')).toBe('systemone');
    expect(thirdPartyDecideProvider('systemone:clef-flash')).toBe(false);
    expect(thirdPartyDecideProvider('typesafe:jev-1.13.0')).toBe(true);
    expect(readDecideConfig({ 'decide.provider': 'systemone:clef-flash' }).provider).toBe('systemone:clef-flash');
    expect(readDecideConfig({ 'decide.provider': 'systemone:clef-flash' }).slots.triage.provider).toBe('systemone:clef-flash');
  });

  test('the systemone recipe has NO default base URL and a decide touchpoint', () => {
    const recipe = getRecipe('systemone');
    expect(recipe?.base_url_default).toBeUndefined();
    expect(recipe?.touchpoints.decide?.path).toBe('/systemone');
    expect(recipe?.auth_env?.required ?? []).toEqual([]); // no key required
    expect(recipe?.auth_env?.optional).toEqual(['SYSTEMONE_API_KEY']);
  });

  test('systemone prices at $0 for the decide kind', () => {
    expect(usageCostUsd('systemone:clef-flash', 100_000, 0, 'decide')).toBe(0);
  });
});

describe('shared Jev-wire runner (transport mocked)', () => {
  beforeEach(() => {
    configureGateway({ env: {}, base_urls: { systemone: SYSTEMONE_BASE } });
  });

  test('request hits {base}/systemone with the model, answers parse, drift identity from the response', async () => {
    const calls = answerAll();
    const cfg = readDecideConfig({});
    const r = await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'systemone:clef-flash', lane: 'background' }, { engine: null, config: cfg });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${SYSTEMONE_BASE}/systemone`);
    expect(calls[0]!.body.model).toBe('clef-flash');
    expect(Object.keys(calls[0]!.body.questions)).toEqual(['a']);
    expect(r.model_resolved).toBe('clef-flash');
    expect(r.answers.a).toEqual({ kind: 'noul', p: 0.7 });
    expect(r.cost_usd).toBe(0); // local: priced at zero
  });

  test('no key behavior: SYSTEMONE_API_KEY rides as the bearer when set, unauthenticated otherwise', async () => {
    let calls = answerAll();
    await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'systemone:clef-flash', lane: 'background' }, { engine: null, config: readDecideConfig({}) });
    expect(calls[0]!.headers.Authorization).toBe('Bearer unauthenticated');
    configureGateway({ env: { SYSTEMONE_API_KEY: 'sk-local' }, base_urls: { systemone: SYSTEMONE_BASE } });
    calls = answerAll();
    await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'systemone:clef-flash', lane: 'background' }, { engine: null, config: readDecideConfig({}) });
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-local');
  });

  test('misconfigured id fails loudly and never falls back to the TypeSafe cloud endpoint', async () => {
    configureGateway({ env: { TYPESAFE_API_KEY: 'sk-cloud' } }); // no base_urls.systemone
    const calls = answerAll();
    const err = await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'systemone:clef-flash', lane: 'background' }, { engine: null, config: readDecideConfig({}) }).catch((e) => e);
    expect(err).toBeInstanceOf(DecideError);
    expect((err as DecideError).reason).toBe('provider_error');
    expect(String(err.message)).toContain('provider_base_urls.systemone');
    expect(calls.length).toBe(0); // transport never pointed at TypeSafe
  });

  test('typesafe:<model> keeps its key gate while systemone:<model> needs none', async () => {
    configureGateway({ env: {}, base_urls: { systemone: SYSTEMONE_BASE } }); // no TYPESAFE_API_KEY
    answerAll();
    const consent = readDecideConfig({ 'decide.egress.typesafe.query': 'allow' }); // consent first, so the runner's key gate is what fires
    const cloud = await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'typesafe:jev-1.13.0', lane: 'background' }, { engine: null, config: consent }).catch((e) => e);
    expect(cloud).toBeInstanceOf(DecideError);
    expect((cloud as DecideError).reason).toBe('no_key');
    const local = await runDecide({ slot: 'evidence', callSite: 'probe', state: STATE, questions: [q('a', { text: 'x', class: 'query' })], provider: 'systemone:clef-flash', lane: 'background' }, { engine: null, config: consent });
    expect(local.model_resolved).toBe('clef-flash');
  });
});

describe('egress: operator-owned vs third-party', () => {
  const CONSENT = { 'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow' };

  beforeEach(async () => {
    await page('notes/world');
    await page('notes/private', 'private');
  });

  test('systemone sends private pages without consent (local data, nothing leaves the infrastructure)', async () => {
    const v = await checkEgress(engine, readDecideConfig(CONSENT), 'systemone:clef-flash', STATE, [q('a', cand('notes/world')), q('p', cand('notes/private'))]);
    expect(v.refused).toEqual({});
  });

  test('typesafe refuses the same private page without decide.egress.private=allow', async () => {
    const v = await checkEgress(engine, readDecideConfig(CONSENT), 'typesafe:jev-1.13.0', STATE, [q('p', cand('notes/private'))]);
    expect(v.refused).toEqual({ p: 'egress_private_denied' });
  });

  test('denied sources apply to systemone too', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    const cfg = readDecideConfig({ ...CONSENT, 'decide.egress.deny_sources': JSON.stringify(['other']) });
    const v = await checkEgress(engine, cfg, 'systemone:clef-flash', STATE, [q('a', cand('notes/world')), q('d', cand('notes/world', 'other'))]);
    expect(v.refused).toEqual({ d: 'denied_source' });
  });
});

describe('systemone batch budgets', () => {
  test('the planner splits under the recipe budget, not the TypeSafe default', async () => {
    const { planBatches, STATE_QUESTION_BUDGET, TOTAL_INPUT_BUDGET } = await import('../../src/core/ai/decide/pack.ts');
    const tp = getRecipe('systemone')!.touchpoints.decide!;
    expect(tp.max_request_tokens).toBeLessThan(TOTAL_INPUT_BUDGET);
    expect(tp.max_state_question_tokens).toBeLessThan(STATE_QUESTION_BUDGET);
    const questions = Array.from({ length: 10 }, () => 5_000);
    const typesafeBatches = planBatches(1_000, questions);
    const localBatches = planBatches(1_000, questions, { stateQuestion: tp.max_state_question_tokens, total: tp.max_request_tokens });
    expect(localBatches.length).toBeGreaterThan(typesafeBatches.length);
    for (const b of localBatches) expect(b.estimatedInputTokens).toBeLessThanOrEqual(tp.max_request_tokens);
    expect(localBatches.flatMap((b) => b.indices)).toEqual(questions.map((_, i) => i));
  });
});
