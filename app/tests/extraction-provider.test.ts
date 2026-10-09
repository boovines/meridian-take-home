import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { validateExtraction, type ExtractionRequest } from '../src/domain/extraction';
const state = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('../src/server/integrations/openai-client', () => ({ runtimeOpenAI: () => state.model }));
import { extractForStep } from '../src/server/integrations/openai-step';
const id = randomUUID();
const request: ExtractionRequest = { kind: 'extract', instructions: 'Return only the requested seller.', data: {}, document_ids: [id], output_schema: { type: 'object', additionalProperties: false, required: ['seller'], properties: { seller: { type: ['string', 'null'] } } }, critical_paths: [['seller']] };
const envelope = { data: { seller: 'Example' }, fields: [{ path: ['seller'], raw_value: 'Example', normalized_value: 'Example', status: 'found', evidence: [{ artifact_id: id, page: 1, text: 'Example', bounding_box: null }], explanation: null }] };
function modelReturning(value: unknown) {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(value) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] }) });
  state.model = model;
  return model;
}
it('requests a structured envelope containing the exact generated data schema', async () => {
  const model = modelReturning(envelope);
  const output = await extractForStep(request, [], AbortSignal.timeout(1000));
  expect(model.doGenerateCalls[0].responseFormat).toMatchObject({ type: 'json', schema: { type: 'object', required: ['data', 'fields'], properties: { data: request.output_schema, fields: { type: 'array' } } } });
  expect(validateExtraction(request, output, [{ artifact_id: id, page_count: 1 }]).data).toEqual(envelope.data);
});
it.each([{ seller: 'Example' }, { ...envelope, fields: {} }, { ...envelope, fields: [{ ...envelope.fields[0], raw_value: {} }] }])('rejects malformed output before postprocessing', async (value) => {
  modelReturning(value);
  await expect(extractForStep(request, [], AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
});
it('still rejects a structurally valid claim about an unavailable source page', async () => {
  modelReturning({ ...envelope, fields: [{ ...envelope.fields[0], evidence: [{ artifact_id: id, page: 2, text: 'Example', bounding_box: null }] }] });
  const output = await extractForStep(request, [], AbortSignal.timeout(1000));
  expect(() => validateExtraction(request, output, [{ artifact_id: id, page_count: 1 }])).toThrow('field evidence');
});

it('rejects unsupported open or optional object schemas before paid inference', async () => {
  const model = modelReturning(envelope);
  await expect(extractForStep({ ...request, output_schema: { type: 'object', properties: { seller: { type: 'string' } } } }, [], AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'EXTRACTION_SCHEMA_INVALID' });
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('preserves the provider response for audit before runtime normalization', async () => {
  const raw = { ...envelope, fields: [{ ...envelope.fields[0], evidence: [{ ...envelope.fields[0].evidence[0], text: '  Example  ' }] }] };
  modelReturning(raw);
  const output = await extractForStep(request, [], AbortSignal.timeout(1000));
  expect(output).toEqual(raw);
  expect(validateExtraction(request, output, [{ artifact_id: id, page_count: 1 }]).fields[0].evidence[0].text).toBe('Example');
});
