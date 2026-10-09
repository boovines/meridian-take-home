-- Run-origin repairs share candidate history and the single workflow operation.
ALTER TABLE repair_sessions ADD COLUMN origin text NOT NULL DEFAULT 'evaluation' CHECK(origin IN ('evaluation','run'));
ALTER TABLE repair_sessions ADD COLUMN source_run_id uuid;
ALTER TABLE repair_sessions ADD COLUMN input_bundle_id uuid;
ALTER TABLE repair_sessions ADD COLUMN execution_configuration jsonb NOT NULL DEFAULT '{}';
ALTER TABLE repair_sessions ADD COLUMN recovery_limits jsonb NOT NULL DEFAULT '{}';
ALTER TABLE repair_sessions ALTER COLUMN suite_version_id DROP NOT NULL;
ALTER TABLE repair_sessions ALTER COLUMN initial_evaluation_id DROP NOT NULL;
ALTER TABLE repair_sessions ALTER COLUMN baseline_evaluation_id DROP NOT NULL;
ALTER TABLE repair_attempts ALTER COLUMN baseline_evaluation_id DROP NOT NULL;
ALTER TABLE repair_attempts ADD COLUMN rerun_id uuid UNIQUE;
ALTER TABLE repair_attempts ADD COLUMN build_result jsonb;
ALTER TABLE repair_sessions ADD FOREIGN KEY(workflow_id,source_run_id) REFERENCES workflow_runs(workflow_id,id);
ALTER TABLE repair_sessions ADD FOREIGN KEY(workflow_id,input_bundle_id) REFERENCES input_bundles(workflow_id,id);
ALTER TABLE repair_attempts ADD FOREIGN KEY(workflow_id,rerun_id) REFERENCES workflow_runs(workflow_id,id);
CREATE UNIQUE INDEX recovery_per_source_run ON repair_sessions(source_run_id) WHERE origin='run';
ALTER TABLE repair_sessions ADD CONSTRAINT repair_origin_scope CHECK(
 (origin='evaluation' AND source_run_id IS NULL AND input_bundle_id IS NULL AND suite_version_id IS NOT NULL AND initial_evaluation_id IS NOT NULL AND baseline_evaluation_id IS NOT NULL)
 OR (origin='run' AND source_run_id IS NOT NULL AND input_bundle_id IS NOT NULL));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='workflow_jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%suite_version_id%' LOOP
  EXECUTE format('ALTER TABLE workflow_jobs DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='workflow_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%manual%' LOOP
  EXECUTE format('ALTER TABLE workflow_runs DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='repair_attempts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%accepted%' LOOP
  EXECUTE format('ALTER TABLE repair_attempts DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='repair_sessions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%passed%' LOOP
  EXECUTE format('ALTER TABLE repair_sessions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE workflow_jobs ADD CHECK(kind NOT IN ('evaluation','repair') OR (input_version_id IS NOT NULL AND (suite_version_id IS NOT NULL OR (kind='repair' AND coalesce(source_request->>'origin'='run',false)))));
ALTER TABLE workflow_runs ADD CHECK(kind IN ('manual','evaluation','recovery'));
ALTER TABLE repair_attempts ADD CHECK(status NOT IN ('accepted','rejected') OR evaluation_run_id IS NOT NULL OR rerun_id IS NOT NULL);
ALTER TABLE repair_sessions ADD CHECK(status IN ('queued','running','passed','recovered','needs_attention','failed','cancelled'));
ALTER TABLE repair_sessions ADD CHECK(status<>'recovered' OR origin='run');
CREATE TABLE workflow_run_defaults (
 workflow_id uuid PRIMARY KEY REFERENCES workflows(id), implementation_version_id uuid NOT NULL,
 recovery_session_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workflow_id,implementation_version_id) REFERENCES implementation_versions(workflow_id,id),
 FOREIGN KEY(workflow_id,recovery_session_id) REFERENCES repair_sessions(workflow_id,id)
);
ALTER TABLE workflow_run_defaults ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION guard_repair_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.origin IS DISTINCT FROM NEW.origin THEN RAISE EXCEPTION 'Repair origin is immutable' USING ERRCODE='23514'; END IF;

  IF (CASE WHEN TG_OP='DELETE' THEN OLD.origin ELSE NEW.origin END)='run' THEN
    IF TG_OP<>'INSERT' THEN
      IF OLD.status NOT IN ('queued','running') OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Finished recovery scope is immutable' USING ERRCODE='23514'; END IF;
      IF (NEW.workflow_id,NEW.job_id,NEW.origin,NEW.source_run_id,NEW.input_bundle_id,NEW.plan_version_id,NEW.suite_version_id,NEW.initial_version_id,NEW.initial_evaluation_id,NEW.attempt_limit,NEW.execution_configuration,NEW.recovery_limits)
       IS DISTINCT FROM (OLD.workflow_id,OLD.job_id,OLD.origin,OLD.source_run_id,OLD.input_bundle_id,OLD.plan_version_id,OLD.suite_version_id,OLD.initial_version_id,OLD.initial_evaluation_id,OLD.attempt_limit,OLD.execution_configuration,OLD.recovery_limits) THEN
       RAISE EXCEPTION 'Recovery starting evidence is immutable' USING ERRCODE='23514'; END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM workflow_runs r JOIN implementation_versions v ON v.id=r.implementation_version_id JOIN workflow_jobs j ON j.id=NEW.job_id
     WHERE r.id=NEW.source_run_id AND r.workflow_id=NEW.workflow_id AND r.kind='manual' AND r.status IN ('failed','needs_attention') AND r.failure_category='implementation'
     AND r.implementation_version_id=NEW.initial_version_id AND r.input_bundle_id=NEW.input_bundle_id AND v.plan_version_id=NEW.plan_version_id
     AND j.kind='repair' AND j.workflow_id=NEW.workflow_id AND j.input_version_id=NEW.initial_version_id AND j.plan_version_id=NEW.plan_version_id AND j.suite_version_id IS NOT DISTINCT FROM NEW.suite_version_id)
     OR NOT EXISTS(SELECT 1 FROM implementation_versions v WHERE v.id=NEW.baseline_version_id AND v.workflow_id=NEW.workflow_id AND v.plan_version_id=NEW.plan_version_id)
     OR (NEW.baseline_evaluation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evaluation_runs e WHERE e.id=NEW.baseline_evaluation_id AND e.workflow_id=NEW.workflow_id AND e.implementation_version_id=NEW.baseline_version_id AND e.suite_version_id=NEW.suite_version_id AND e.execution_configuration=NEW.execution_configuration))
    THEN RAISE EXCEPTION 'Recovery must preserve code, captured input and approved plan' USING ERRCODE='23514'; END IF;
    IF NEW.status='recovered' AND NOT EXISTS(SELECT 1 FROM repair_attempts a JOIN workflow_runs r ON r.id=a.rerun_id WHERE a.session_id=NEW.id AND a.candidate_version_id=NEW.baseline_version_id AND a.status='accepted' AND r.status='completed') THEN
      RAISE EXCEPTION 'Recovery requires an accepted candidate and completed rerun' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
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
CREATE OR REPLACE FUNCTION guard_repair_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session repair_sessions;
BEGIN

  SELECT * INTO session FROM repair_sessions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
  IF session.origin='run' THEN
    IF TG_OP<>'INSERT' THEN
      IF OLD.status<>'running' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Finished attempts are immutable' USING ERRCODE='23514'; END IF;
      IF (OLD.candidate_version_id IS NOT NULL AND OLD.candidate_version_id IS DISTINCT FROM NEW.candidate_version_id)
        OR (OLD.rerun_id IS NOT NULL AND OLD.rerun_id IS DISTINCT FROM NEW.rerun_id)
        OR (OLD.build_result IS NOT NULL AND OLD.build_result IS DISTINCT FROM NEW.build_result)
      THEN RAISE EXCEPTION 'Recorded candidate evidence is immutable' USING ERRCODE='23514'; END IF;
      IF (NEW.workflow_id,NEW.session_id,NEW.attempt_number,NEW.baseline_version_id,NEW.baseline_evaluation_id) IS DISTINCT FROM (OLD.workflow_id,OLD.session_id,OLD.attempt_number,OLD.baseline_version_id,OLD.baseline_evaluation_id) THEN RAISE EXCEPTION 'Attempt baseline is immutable' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.status='accepted' AND (coalesce((NEW.build_result->>'ok')::boolean,false)=false OR NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id=NEW.rerun_id AND r.status='completed')) THEN
      RAISE EXCEPTION 'Accepted recovery requires successful build and rerun' USING ERRCODE='23514'; END IF;
    IF TG_OP='INSERT' AND (session.status<>'running' OR NEW.baseline_version_id<>session.baseline_version_id OR NEW.baseline_evaluation_id IS DISTINCT FROM session.baseline_evaluation_id) THEN RAISE EXCEPTION 'Attempt requires current baseline' USING ERRCODE='23514'; END IF;
    IF NEW.candidate_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM implementation_versions v WHERE v.id=NEW.candidate_version_id AND v.workflow_id=NEW.workflow_id AND v.plan_version_id=session.plan_version_id AND v.parent_version_id=NEW.baseline_version_id AND v.created_by_job_id=session.job_id) THEN RAISE EXCEPTION 'Invalid recovery candidate' USING ERRCODE='23514'; END IF;
    IF NEW.rerun_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id=NEW.rerun_id AND r.workflow_id=NEW.workflow_id AND r.job_id=session.job_id AND r.kind='recovery' AND r.implementation_version_id=NEW.candidate_version_id AND r.input_bundle_id=session.input_bundle_id) THEN RAISE EXCEPTION 'Invalid recovery rerun' USING ERRCODE='23514'; END IF;
    IF NEW.evaluation_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evaluation_runs e WHERE e.id=NEW.evaluation_run_id AND e.job_id=session.job_id AND e.implementation_version_id=NEW.candidate_version_id AND e.suite_version_id=session.suite_version_id) THEN RAISE EXCEPTION 'Invalid recovery regression evaluation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
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
CREATE FUNCTION guard_recovery_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM repair_sessions s WHERE s.id=NEW.recovery_session_id AND s.workflow_id=NEW.workflow_id AND s.origin='run' AND s.status='recovered' AND s.baseline_version_id=NEW.implementation_version_id) THEN
  RAISE EXCEPTION 'Default run version requires accepted recovery evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_default_guard BEFORE INSERT OR UPDATE ON workflow_run_defaults FOR EACH ROW EXECUTE FUNCTION guard_recovery_default();
CREATE FUNCTION guard_recovery_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='recovery' AND NOT EXISTS(SELECT 1 FROM repair_sessions s JOIN implementation_versions v ON v.id=NEW.implementation_version_id WHERE s.job_id=NEW.job_id AND s.workflow_id=NEW.workflow_id AND s.origin='run' AND s.input_bundle_id=NEW.input_bundle_id AND s.source_run_id=NEW.rerun_of_id AND v.plan_version_id=s.plan_version_id) THEN
  RAISE EXCEPTION 'Internal recovery runs must preserve session input and plan' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_execution_guard BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_recovery_execution();
ALTER TABLE repair_sessions ADD COLUMN paused_at timestamptz;

-- Reservations survive lost provider responses and worker restarts. No customer
-- document text is stored in this ledger; metadata holds usage and request hashes.
CREATE TABLE recovery_inference_charges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES repair_sessions(id),
 provider text NOT NULL,
 reserved_usd numeric NOT NULL CHECK(reserved_usd > 0 AND reserved_usd < 1000000),
 actual_usd numeric CHECK(actual_usd >= 0 AND actual_usd < 1000000),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled')),
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='reserved' AND actual_usd IS NULL) OR (state='settled' AND actual_usd IS NOT NULL))
);
CREATE INDEX recovery_charge_session ON recovery_inference_charges(session_id);
ALTER TABLE recovery_inference_charges ENABLE ROW LEVEL SECURITY;

