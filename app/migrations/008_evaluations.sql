CREATE TABLE evaluation_suite_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL REFERENCES workflows(id),frozen_spec_id uuid NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0),parent_suite_version_id uuid,creation_key uuid NOT NULL,name text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','locked')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),locked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id),UNIQUE(workflow_id,version_number),UNIQUE(workflow_id,creation_key),
 FOREIGN KEY(workflow_id,frozen_spec_id) REFERENCES frozen_specs(workflow_id,id),
 FOREIGN KEY(workflow_id,parent_suite_version_id) REFERENCES evaluation_suite_versions(workflow_id,id),
 CHECK((state='locked')=(locked_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_draft_suite ON evaluation_suite_versions(workflow_id) WHERE state='draft';
CREATE TABLE evaluation_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL,suite_version_id uuid NOT NULL,case_key text NOT NULL,name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('workflow','step')),node_id uuid,input_bundle_id uuid,input_data jsonb,
 human_responses jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(human_responses)='array'),assertions jsonb NOT NULL CHECK(jsonb_typeof(assertions)='array' AND jsonb_array_length(assertions)>0),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id),UNIQUE(suite_version_id,id),UNIQUE(suite_version_id,case_key),
 FOREIGN KEY(workflow_id,suite_version_id) REFERENCES evaluation_suite_versions(workflow_id,id),
 FOREIGN KEY(workflow_id,node_id) REFERENCES nodes(workflow_id,id),
 FOREIGN KEY(workflow_id,input_bundle_id) REFERENCES input_bundles(workflow_id,id),
 CHECK((kind='workflow' AND input_bundle_id IS NOT NULL AND node_id IS NULL AND input_data IS NULL) OR (kind='step' AND input_bundle_id IS NULL AND node_id IS NOT NULL AND input_data IS NOT NULL AND jsonb_typeof(input_data)='object'))
);
ALTER TABLE workflow_jobs ADD COLUMN suite_version_id uuid;
ALTER TABLE workflow_jobs ADD FOREIGN KEY(workflow_id,suite_version_id) REFERENCES evaluation_suite_versions(workflow_id,id);
ALTER TABLE workflow_jobs ADD CHECK(kind NOT IN ('evaluation','repair') OR (input_version_id IS NOT NULL AND suite_version_id IS NOT NULL));
CREATE TABLE evaluation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL,job_id uuid NOT NULL,implementation_version_id uuid NOT NULL,suite_version_id uuid NOT NULL,
 run_key text NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','blocked','cancelled')),
 verdict text CHECK(verdict IN ('passed','failed','inconclusive')),failure_category text,failure_code text,failure_message text,
 started_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id),UNIQUE(id,suite_version_id),UNIQUE(job_id,run_key),
 FOREIGN KEY(workflow_id,job_id) REFERENCES workflow_jobs(workflow_id,id),
 FOREIGN KEY(workflow_id,implementation_version_id) REFERENCES implementation_versions(workflow_id,id),
 FOREIGN KEY(workflow_id,suite_version_id) REFERENCES evaluation_suite_versions(workflow_id,id),
 CHECK((status IN ('completed','blocked','cancelled'))=(finished_at IS NOT NULL)),
 CHECK((status IN ('completed','blocked','cancelled'))=(verdict IS NOT NULL))
);
CREATE INDEX evaluations_by_workflow ON evaluation_runs(workflow_id,created_at DESC,id DESC);
CREATE INDEX evaluations_by_versions ON evaluation_runs(implementation_version_id,suite_version_id,created_at DESC);
CREATE TABLE evaluation_case_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL,evaluation_run_id uuid NOT NULL,suite_version_id uuid NOT NULL,case_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','finished')),outcome text CHECK(outcome IN ('passed','failed','error','not_run')),
 actual_output jsonb,check_results jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(check_results)='array'),
 failure_category text,failure_code text,failure_message text,started_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id),UNIQUE(evaluation_run_id,case_id),
 FOREIGN KEY(workflow_id,evaluation_run_id) REFERENCES evaluation_runs(workflow_id,id),
 FOREIGN KEY(evaluation_run_id,suite_version_id) REFERENCES evaluation_runs(id,suite_version_id),
 FOREIGN KEY(suite_version_id,case_id) REFERENCES evaluation_cases(suite_version_id,id),
 CHECK((status='finished')=(outcome IS NOT NULL AND finished_at IS NOT NULL))
);
ALTER TABLE workflow_runs ADD COLUMN evaluation_case_result_id uuid UNIQUE;
ALTER TABLE workflow_runs ADD FOREIGN KEY(workflow_id,evaluation_case_result_id) REFERENCES evaluation_case_results(workflow_id,id);
ALTER TABLE workflow_runs ADD CHECK((kind='evaluation')=(evaluation_case_result_id IS NOT NULL));
CREATE FUNCTION guard_locked_suite() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; suite_state text;
BEGIN
 IF TG_TABLE_NAME='evaluation_suite_versions' THEN
  IF OLD.state='locked' THEN RAISE EXCEPTION 'Locked suites are immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='DELETE' THEN sid=OLD.suite_version_id; ELSE sid=NEW.suite_version_id; END IF;
  SELECT state INTO suite_state FROM evaluation_suite_versions WHERE id=sid FOR SHARE;
  IF suite_state='locked' THEN RAISE EXCEPTION 'Locked cases are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.workflow_id<>OLD.workflow_id OR NEW.suite_version_id<>OLD.suite_version_id OR NEW.case_key<>OLD.case_key) THEN RAISE EXCEPTION 'Case identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER suite_guard BEFORE UPDATE OR DELETE ON evaluation_suite_versions FOR EACH ROW EXECUTE FUNCTION guard_locked_suite();
CREATE TRIGGER case_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_cases FOR EACH ROW EXECUTE FUNCTION guard_locked_suite();
CREATE FUNCTION guard_evaluation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_TABLE_NAME='evaluation_runs' AND OLD.status IN ('completed','blocked','cancelled')) OR (TG_TABLE_NAME='evaluation_case_results' AND OLD.status='finished') THEN RAISE EXCEPTION 'Completed evaluations are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER evaluation_guard BEFORE UPDATE OR DELETE ON evaluation_runs FOR EACH ROW EXECUTE FUNCTION guard_evaluation_history();
CREATE TRIGGER result_guard BEFORE UPDATE OR DELETE ON evaluation_case_results FOR EACH ROW EXECUTE FUNCTION guard_evaluation_history();
CREATE FUNCTION guard_case_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='evaluation' AND NOT EXISTS(SELECT 1 FROM evaluation_case_results r JOIN evaluation_runs e ON e.id=r.evaluation_run_id JOIN evaluation_cases c ON c.id=r.case_id WHERE r.id=NEW.evaluation_case_result_id AND e.workflow_id=NEW.workflow_id AND e.job_id=NEW.job_id AND e.implementation_version_id=NEW.implementation_version_id AND c.kind='workflow' AND c.input_bundle_id=NEW.input_bundle_id) THEN RAISE EXCEPTION 'Execution must use its evaluated case, code and captured input' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER case_execution_guard BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_case_execution();
ALTER TABLE evaluation_suite_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_case_results ENABLE ROW LEVEL SECURITY;
