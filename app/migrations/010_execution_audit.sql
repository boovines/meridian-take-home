-- One event belongs to one host invocation of a workflow visit or isolated case.
-- Payloads live in immutable object storage; rows provide bounded indexed provenance.
ALTER TABLE step_executions ADD UNIQUE(workflow_id,id);
CREATE TABLE execution_audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL REFERENCES workflows(id),
 step_execution_id uuid, case_result_id uuid, attempt_token uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 6),
 kind text NOT NULL CHECK(kind IN ('initial_output','model_request','model_response','final_output','failure')),
 artifact_id uuid NOT NULL UNIQUE, summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=16000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(step_execution_id,case_result_id)=1),
 UNIQUE(attempt_token,sequence),
 FOREIGN KEY(workflow_id,step_execution_id) REFERENCES step_executions(workflow_id,id),
 FOREIGN KEY(workflow_id,case_result_id) REFERENCES evaluation_case_results(workflow_id,id),
 FOREIGN KEY(workflow_id,artifact_id) REFERENCES artifacts(workflow_id,id)
);
CREATE INDEX audit_by_step ON execution_audit_events(step_execution_id,created_at,sequence) WHERE step_execution_id IS NOT NULL;
CREATE INDEX audit_by_case ON execution_audit_events(case_result_id,created_at,sequence) WHERE case_result_id IS NOT NULL;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON execution_audit_events FOR EACH ROW EXECUTE FUNCTION guard_frozen_spec();
CREATE FUNCTION guard_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM artifacts WHERE id=NEW.artifact_id AND workflow_id=NEW.workflow_id AND kind='trace' AND state='ready') THEN
  RAISE EXCEPTION 'Audit payload must be a ready execution audit artifact' USING ERRCODE='23514';
 END IF;
 IF NEW.step_execution_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM step_executions s JOIN workflow_runs r ON r.id=s.run_id JOIN workflow_jobs j ON j.id=r.job_id WHERE s.id=NEW.step_execution_id AND s.workflow_id=NEW.workflow_id AND s.attempt_token=NEW.attempt_token AND s.status='running' AND r.status IN ('running','waiting_for_human') AND j.status IN ('running','waiting_for_human')) THEN
   RAISE EXCEPTION 'Audit belongs to an inactive invocation' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM evaluation_case_results c JOIN evaluation_runs e ON e.id=c.evaluation_run_id JOIN workflow_jobs j ON j.id=e.job_id WHERE c.id=NEW.case_result_id AND c.workflow_id=NEW.workflow_id AND c.attempt_token=NEW.attempt_token AND c.status='running' AND j.status='running') THEN
   RAISE EXCEPTION 'Audit belongs to an inactive case invocation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER audit_insert_guard BEFORE INSERT ON execution_audit_events FOR EACH ROW EXECUTE FUNCTION guard_audit_insert();
ALTER TABLE execution_audit_events ENABLE ROW LEVEL SECURITY;
