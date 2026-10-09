-- A result is finalized only after its bounded infrastructure recovery. Every
-- failed execution and its audit remain immutable, even if recovery succeeds.
ALTER TABLE evaluation_case_results ADD COLUMN recovery_count integer NOT NULL DEFAULT 0 CHECK(recovery_count BETWEEN 0 AND 1);
ALTER TABLE evaluation_case_results ADD COLUMN recovery_pending boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_evaluation_case_result_id_key;
ALTER TABLE workflow_runs ADD COLUMN evaluation_attempt integer NOT NULL DEFAULT 0 CHECK(evaluation_attempt BETWEEN 0 AND 1);
ALTER TABLE workflow_runs ADD UNIQUE(evaluation_case_result_id,evaluation_attempt);
CREATE TABLE evaluation_case_recoveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 case_result_id uuid NOT NULL UNIQUE,
 workflow_run_id uuid,
 attempt_token uuid,
 failure_category text NOT NULL CHECK(failure_category='infrastructure'),
 failure_code text NOT NULL CHECK(failure_code='TOKEN_PREFLIGHT_TRANSIENT'),
 failure_message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workflow_id,case_result_id) REFERENCES evaluation_case_results(workflow_id,id),
 FOREIGN KEY(workflow_run_id,workflow_id) REFERENCES workflow_runs(id,workflow_id)
);
CREATE TRIGGER recovery_immutable BEFORE UPDATE OR DELETE ON evaluation_case_recoveries FOR EACH ROW EXECUTE FUNCTION guard_frozen_spec();
ALTER TABLE evaluation_case_recoveries ENABLE ROW LEVEL SECURITY;
