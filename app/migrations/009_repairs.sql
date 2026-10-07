CREATE TABLE repair_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  plan_version_id uuid NOT NULL,
  suite_version_id uuid NOT NULL,
  initial_version_id uuid NOT NULL,
  initial_evaluation_id uuid NOT NULL,
  baseline_version_id uuid NOT NULL,
  baseline_evaluation_id uuid NOT NULL,
  attempt_limit integer NOT NULL DEFAULT 3 CHECK (attempt_limit=3),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','needs_attention','failed','cancelled')),
  stop_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id,id),
  FOREIGN KEY (workflow_id,job_id) REFERENCES workflow_jobs(workflow_id,id),
  FOREIGN KEY (workflow_id,plan_version_id) REFERENCES implementation_plan_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,suite_version_id) REFERENCES evaluation_suite_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,initial_version_id) REFERENCES implementation_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,initial_evaluation_id) REFERENCES evaluation_runs(workflow_id,id),
  FOREIGN KEY (workflow_id,baseline_version_id) REFERENCES implementation_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,baseline_evaluation_id) REFERENCES evaluation_runs(workflow_id,id),
  CHECK ((status NOT IN ('queued','running'))=(finished_at IS NOT NULL))
);
CREATE INDEX repairs_by_workflow ON repair_sessions(workflow_id,created_at DESC,id DESC);

CREATE TABLE repair_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  session_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  baseline_version_id uuid NOT NULL,
  baseline_evaluation_id uuid NOT NULL,
  candidate_version_id uuid UNIQUE,
  evaluation_run_id uuid UNIQUE,
  diagnosis jsonb,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','accepted','rejected','failed','cancelled')),
  decision_reason text,
  error_code text,
  error_message text,
  invocation_count integer NOT NULL DEFAULT 0 CHECK (invocation_count BETWEEN 0 AND 2),
  attempt_token uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id,id),
  UNIQUE (session_id,attempt_number),
  FOREIGN KEY (workflow_id,session_id) REFERENCES repair_sessions(workflow_id,id),
  FOREIGN KEY (workflow_id,baseline_version_id) REFERENCES implementation_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,baseline_evaluation_id) REFERENCES evaluation_runs(workflow_id,id),
  FOREIGN KEY (workflow_id,candidate_version_id) REFERENCES implementation_versions(workflow_id,id),
  FOREIGN KEY (workflow_id,evaluation_run_id) REFERENCES evaluation_runs(workflow_id,id),
  CHECK ((status<>'running')=(finished_at IS NOT NULL)),
  CHECK (evaluation_run_id IS NULL OR candidate_version_id IS NOT NULL),
  CHECK (status NOT IN ('accepted','rejected') OR evaluation_run_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_running_repair_attempt ON repair_attempts(session_id) WHERE status='running';

CREATE FUNCTION guard_repair_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.status NOT IN ('queued','running') THEN
      RAISE EXCEPTION 'Finished repairs are immutable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF (NEW.workflow_id,NEW.job_id,NEW.plan_version_id,NEW.suite_version_id,NEW.initial_version_id,NEW.initial_evaluation_id,NEW.attempt_limit)
       IS DISTINCT FROM (OLD.workflow_id,OLD.job_id,OLD.plan_version_id,OLD.suite_version_id,OLD.initial_version_id,OLD.initial_evaluation_id,OLD.attempt_limit) THEN
      RAISE EXCEPTION 'Repair scope is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workflow_jobs j
    WHERE j.id=NEW.job_id AND j.kind='repair' AND j.workflow_id=NEW.workflow_id
      AND j.plan_version_id=NEW.plan_version_id AND j.suite_version_id=NEW.suite_version_id
      AND j.input_version_id=NEW.initial_version_id
  ) OR NOT EXISTS (
    SELECT 1 FROM evaluation_runs e JOIN implementation_versions v ON v.id=e.implementation_version_id
    WHERE e.id=NEW.initial_evaluation_id AND e.implementation_version_id=NEW.initial_version_id
      AND e.suite_version_id=NEW.suite_version_id AND v.plan_version_id=NEW.plan_version_id
  ) OR NOT EXISTS (
    SELECT 1 FROM evaluation_runs e JOIN implementation_versions v ON v.id=e.implementation_version_id
    WHERE e.id=NEW.baseline_evaluation_id AND e.implementation_version_id=NEW.baseline_version_id
      AND e.suite_version_id=NEW.suite_version_id AND v.plan_version_id=NEW.plan_version_id
  ) THEN
    RAISE EXCEPTION 'Repair evidence must use its fixed code, plan and suite' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_session_guard BEFORE INSERT OR UPDATE OR DELETE ON repair_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_repair_session();

CREATE FUNCTION guard_repair_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session repair_sessions;
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.status<>'running' THEN
      RAISE EXCEPTION 'Finished attempts are immutable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF (NEW.workflow_id,NEW.session_id,NEW.attempt_number,NEW.baseline_version_id,NEW.baseline_evaluation_id)
       IS DISTINCT FROM (OLD.workflow_id,OLD.session_id,OLD.attempt_number,OLD.baseline_version_id,OLD.baseline_evaluation_id) THEN
      RAISE EXCEPTION 'Attempt starting evidence is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO session FROM repair_sessions WHERE id=NEW.session_id;
  IF NOT EXISTS (
    SELECT 1 FROM evaluation_runs e JOIN implementation_versions v ON v.id=e.implementation_version_id
    WHERE e.id=NEW.baseline_evaluation_id AND e.implementation_version_id=NEW.baseline_version_id
      AND e.suite_version_id=session.suite_version_id AND v.plan_version_id=session.plan_version_id
  ) THEN RAISE EXCEPTION 'Attempt baseline must use the fixed suite and plan' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (session.status<>'running' OR session.baseline_version_id<>NEW.baseline_version_id OR session.baseline_evaluation_id<>NEW.baseline_evaluation_id) THEN
    RAISE EXCEPTION 'New attempt must start from the current baseline' USING ERRCODE='23514';
  END IF;
  IF NEW.candidate_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM implementation_versions v WHERE v.id=NEW.candidate_version_id
      AND v.workflow_id=NEW.workflow_id AND v.plan_version_id=session.plan_version_id
      AND v.parent_version_id=NEW.baseline_version_id AND v.created_by_job_id=session.job_id
  ) THEN RAISE EXCEPTION 'Candidate must descend from this attempt baseline' USING ERRCODE='23514'; END IF;
  IF NEW.evaluation_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evaluation_runs e WHERE e.id=NEW.evaluation_run_id AND e.job_id=session.job_id
      AND e.implementation_version_id=NEW.candidate_version_id AND e.suite_version_id=session.suite_version_id
  ) THEN RAISE EXCEPTION 'Attempt evaluation must test its candidate on the fixed suite' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repair_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON repair_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_repair_attempt();
ALTER TABLE repair_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_attempts ENABLE ROW LEVEL SECURITY;
