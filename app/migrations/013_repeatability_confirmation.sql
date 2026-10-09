ALTER TABLE evaluation_runs ADD COLUMN execution_configuration jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE FUNCTION guard_evaluation_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_configuration IS DISTINCT FROM OLD.execution_configuration AND
   (OLD.execution_configuration <> '{}'::jsonb OR OLD.status <> 'queued') THEN
   RAISE EXCEPTION 'Evaluation execution configuration is immutable once captured' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_configuration_guard BEFORE UPDATE ON evaluation_runs FOR EACH ROW EXECUTE FUNCTION guard_evaluation_configuration();
CREATE TABLE repair_confirmations (
 workflow_id uuid NOT NULL REFERENCES workflows(id),
 attempt_id uuid NOT NULL,
 round integer NOT NULL CHECK(round BETWEEN 1 AND 3),
 evaluation_run_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(attempt_id,round),
 FOREIGN KEY(workflow_id,attempt_id) REFERENCES repair_attempts(workflow_id,id),
 FOREIGN KEY(workflow_id,evaluation_run_id) REFERENCES evaluation_runs(workflow_id,id)
);
CREATE FUNCTION guard_repair_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Confirmation identity is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id JOIN evaluation_runs e ON e.id=NEW.evaluation_run_id
   WHERE a.id=NEW.attempt_id AND a.status='running' AND e.job_id=s.job_id AND e.suite_version_id=s.suite_version_id AND e.implementation_version_id=a.candidate_version_id) THEN
   RAISE EXCEPTION 'Confirmation must evaluate its active candidate and locked suite' USING ERRCODE='23514';
 END IF;
 IF NEW.round>1 AND NOT EXISTS(SELECT 1 FROM repair_confirmations c JOIN evaluation_runs e ON e.id=c.evaluation_run_id
   WHERE c.attempt_id=NEW.attempt_id AND c.round=NEW.round-1 AND e.status='completed' AND e.verdict='passed' AND e.execution_configuration<>'{}'::jsonb) THEN
   RAISE EXCEPTION 'A fresh confirmation requires the previous complete pass' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON repair_confirmations FOR EACH ROW EXECUTE FUNCTION guard_repair_confirmation();
ALTER TABLE repair_confirmations ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION guard_confirmed_repair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='passed' AND OLD.status<>'passed' AND NOT EXISTS(
   SELECT a.id FROM repair_attempts a JOIN repair_confirmations c ON c.attempt_id=a.id JOIN evaluation_runs e ON e.id=c.evaluation_run_id
   WHERE a.session_id=NEW.id AND a.candidate_version_id=NEW.baseline_version_id AND e.implementation_version_id=NEW.baseline_version_id AND e.suite_version_id=NEW.suite_version_id
   GROUP BY a.id HAVING count(*)=3 AND bool_and(e.status='completed' AND e.verdict='passed' AND e.execution_configuration<>'{}'::jsonb) AND count(DISTINCT e.execution_configuration)=1
 ) THEN RAISE EXCEPTION 'A confirmed repair requires three matching complete passes' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmed_repair_guard BEFORE UPDATE ON repair_sessions FOR EACH ROW EXECUTE FUNCTION guard_confirmed_repair();
