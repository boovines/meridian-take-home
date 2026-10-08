CREATE TABLE repair_replays (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL,attempt_id uuid NOT NULL,
 call_number integer NOT NULL CHECK(call_number BETWEEN 1 AND 3),attempt_token uuid NOT NULL,
 step_execution_id uuid,case_result_id uuid,node_id uuid NOT NULL,
 request_artifact_id uuid,result_artifact_id uuid,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed')),
 summary jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(attempt_id,call_number),
 FOREIGN KEY(workflow_id,attempt_id) REFERENCES repair_attempts(workflow_id,id),
 FOREIGN KEY(workflow_id,node_id) REFERENCES nodes(workflow_id,id),
 FOREIGN KEY(workflow_id,step_execution_id) REFERENCES step_executions(workflow_id,id),
 FOREIGN KEY(workflow_id,case_result_id) REFERENCES evaluation_case_results(workflow_id,id),
 FOREIGN KEY(workflow_id,request_artifact_id) REFERENCES artifacts(workflow_id,id),
 FOREIGN KEY(workflow_id,result_artifact_id) REFERENCES artifacts(workflow_id,id),
 CHECK((step_execution_id IS NULL)<>(case_result_id IS NULL)),
 CHECK((status='completed')=(result_artifact_id IS NOT NULL AND finished_at IS NOT NULL))
);
ALTER TABLE repair_replays ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION guard_replay_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='completed' THEN RAISE EXCEPTION 'Replay history is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.workflow_id<>OLD.workflow_id OR NEW.attempt_id<>OLD.attempt_id OR NEW.attempt_token<>OLD.attempt_token OR NEW.call_number<>OLD.call_number OR NEW.node_id<>OLD.node_id OR NEW.step_execution_id IS DISTINCT FROM OLD.step_execution_id OR NEW.case_result_id IS DISTINCT FROM OLD.case_result_id THEN
  RAISE EXCEPTION 'Replay identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER replay_history BEFORE UPDATE OR DELETE ON repair_replays FOR EACH ROW EXECUTE FUNCTION guard_replay_history();
