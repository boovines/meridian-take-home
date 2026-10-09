import { expect, it } from 'vitest';
import { repairBlocker } from '../src/domain/repair';
import type { EvaluationRun, CaseResult } from '../src/domain/evaluation';
const run = { status: 'completed', verdict: 'inconclusive' } as EvaluationRun;
const failed = { status: 'finished', outcome: 'failed', check_results: [{ passed: false }] } as CaseResult;
const error = (category: string, code: string) => ({ status: 'finished', outcome: 'error', failure_category: category, failure_code: code, check_results: [] }) as unknown as CaseResult;
it.each(['MODEL_UNAVAILABLE','MODEL_RESPONSE_TIMEOUT','TOKEN_PREFLIGHT_TRANSIENT'])('can repair scored business failures despite independent %s', code => {
  expect(repairBlocker(run, [failed, error('infrastructure', code)])).toBeNull();
});
it.each([['infrastructure','MODEL_UNAVAILABLE'],['infrastructure','MODEL_PROJECT_SPEND_LIMIT'],['input','MISSING_INPUT'],['unknown','UNKNOWN']])('never treats %s %s alone as a code failure', (category,code) => {
  expect(repairBlocker(run,[error(category,code)])).not.toBeNull();
});
it.each([['infrastructure','MODEL_PROJECT_SPEND_LIMIT'],['infrastructure','BUDGET_EXHAUSTED'],['input','MISSING_INPUT'],['unknown','UNKNOWN']])('keeps mixed %s %s blocked', (category,code) => {
  expect(repairBlocker(run,[failed,error(category,code)])).not.toBeNull();
});
it('does not diagnose missing case evidence or a shared service blocker', () => {
  expect(repairBlocker(run,[failed,{...error('infrastructure','MODEL_UNAVAILABLE'),status:'queued'}])).not.toBeNull();
  expect(repairBlocker({...run,status:'blocked',failure_category:'infrastructure'},[failed])).not.toBeNull();
});
