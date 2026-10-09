-- A grouped operation owns one top-level slot; its execution/recovery jobs are
-- bounded children of that same operation, not competing independent requests.
ALTER TABLE workflow_jobs ADD COLUMN parent_job_id uuid;
ALTER TABLE workflow_jobs ADD FOREIGN KEY(workflow_id,parent_job_id) REFERENCES workflow_jobs(workflow_id,id);
ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_kind_check;
ALTER TABLE workflow_jobs ADD CHECK(kind IN ('generation','evaluation','repair','execution','grouped'));
DROP INDEX one_active_workflow_job;
CREATE UNIQUE INDEX one_active_workflow_job ON workflow_jobs(workflow_id)
 WHERE parent_job_id IS NULL AND status IN ('queued','running','waiting_for_human','cancel_requested');
CREATE INDEX workflow_jobs_children ON workflow_jobs(parent_job_id,created_at,id) WHERE parent_job_id IS NOT NULL;

CREATE FUNCTION guard_owned_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent workflow_jobs;
BEGIN
 IF TG_OP='UPDATE' AND NEW.parent_job_id IS DISTINCT FROM OLD.parent_job_id THEN
  RAISE EXCEPTION 'Operation ownership cannot change' USING ERRCODE='23514'; END IF;
 IF NEW.parent_job_id IS NOT NULL THEN
  SELECT * INTO parent FROM workflow_jobs WHERE id=NEW.parent_job_id;
  IF parent.id IS NULL OR parent.kind<>'grouped' OR parent.parent_job_id IS NOT NULL OR parent.workflow_id<>NEW.workflow_id OR parent.plan_version_id<>NEW.plan_version_id OR NEW.kind NOT IN ('execution','repair') THEN
   RAISE EXCEPTION 'Child operations must belong to the same grouped approved plan' USING ERRCODE='23514'; END IF;
  IF (TG_OP='INSERT' OR NEW.status IN ('queued','running','waiting_for_human','succeeded')) AND parent.status NOT IN ('queued','running','waiting_for_human') THEN
   RAISE EXCEPTION 'Stopped parent operation cannot accept child work' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owned_job_guard BEFORE INSERT OR UPDATE ON workflow_jobs FOR EACH ROW EXECUTE FUNCTION guard_owned_job();

CREATE TABLE grouped_executions (
 job_id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL,
 input_bundle_id uuid,
 limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,job_id),
 FOREIGN KEY(workflow_id,job_id) REFERENCES workflow_jobs(workflow_id,id),
 FOREIGN KEY(workflow_id,input_bundle_id) REFERENCES input_bundles(workflow_id,id)
);
CREATE TABLE grouping_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 parent_job_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 source_run_id uuid NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(parent_job_id,sequence), UNIQUE(source_run_id), UNIQUE(workflow_id,id),
 FOREIGN KEY(workflow_id,parent_job_id) REFERENCES grouped_executions(workflow_id,job_id),
 FOREIGN KEY(workflow_id,source_run_id) REFERENCES workflow_runs(workflow_id,id)
);
CREATE TABLE grouped_children (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 parent_job_id uuid NOT NULL,
 decision_id uuid NOT NULL,
 group_key text NOT NULL CHECK(length(group_key) BETWEEN 1 AND 200),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 input_bundle_id uuid NOT NULL,
 job_id uuid NOT NULL UNIQUE,
 supersedes_child_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(decision_id,group_key), UNIQUE(workflow_id,id),
 FOREIGN KEY(workflow_id,parent_job_id) REFERENCES grouped_executions(workflow_id,job_id),
 FOREIGN KEY(workflow_id,decision_id) REFERENCES grouping_decisions(workflow_id,id),
 FOREIGN KEY(workflow_id,input_bundle_id) REFERENCES input_bundles(workflow_id,id),
 FOREIGN KEY(workflow_id,job_id) REFERENCES workflow_jobs(workflow_id,id),
 FOREIGN KEY(workflow_id,supersedes_child_id) REFERENCES grouped_children(workflow_id,id)
);
CREATE INDEX grouped_children_parent ON grouped_children(parent_job_id,created_at,id);
CREATE TABLE grouping_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 parent_job_id uuid NOT NULL,
 decision_id uuid NOT NULL,
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
 scope text NOT NULL,
 question text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','cancelled')),
 answer text,
 answer_key uuid,
 answered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(decision_id,source_id),
 FOREIGN KEY(workflow_id,parent_job_id) REFERENCES grouped_executions(workflow_id,job_id),
 FOREIGN KEY(workflow_id,decision_id) REFERENCES grouping_decisions(workflow_id,id),
 CHECK((status='answered' AND answer IS NOT NULL AND answer_key IS NOT NULL AND answered_at IS NOT NULL) OR (status IN ('open','cancelled') AND answer IS NULL AND answer_key IS NULL AND answered_at IS NULL))
);
CREATE INDEX grouping_questions_pending ON grouping_questions(parent_job_id,status);
CREATE TABLE grouped_inference_charges (
 id uuid PRIMARY KEY,
 parent_job_id uuid NOT NULL REFERENCES grouped_executions(job_id),
 provider text NOT NULL,
 reserved_usd numeric NOT NULL CHECK(reserved_usd>0 AND reserved_usd<1000000),
 actual_usd numeric CHECK(actual_usd>=0 AND actual_usd<1000000),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled')),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='reserved' AND actual_usd IS NULL) OR (state='settled' AND actual_usd IS NOT NULL))
);
CREATE INDEX grouped_charges_parent ON grouped_inference_charges(parent_job_id);
ALTER TABLE grouped_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grouping_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grouped_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE grouping_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grouped_inference_charges ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION guard_group_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Grouping decisions and child provenance are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER grouping_decision_immutable BEFORE UPDATE OR DELETE ON grouping_decisions FOR EACH ROW EXECUTE FUNCTION guard_group_history();
CREATE TRIGGER grouped_child_immutable BEFORE UPDATE OR DELETE ON grouped_children FOR EACH ROW EXECUTE FUNCTION guard_group_history();

-- Grouping and aggregation execute an approved primitive with the same sandbox,
-- trace and method gate as child runs. They are explicitly identified, not a
-- silent reinterpretation of ordinary workflow runs.
ALTER TABLE workflow_runs ADD COLUMN execution_mode text NOT NULL DEFAULT 'workflow' CHECK(execution_mode IN ('workflow','grouping','aggregate'));
ALTER TABLE workflow_runs ADD COLUMN phase_node_id uuid;
ALTER TABLE workflow_runs ADD FOREIGN KEY(workflow_id,phase_node_id) REFERENCES nodes(workflow_id,id);
ALTER TABLE workflow_runs ADD CHECK((execution_mode='workflow')=(phase_node_id IS NULL));
CREATE FUNCTION guard_run_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.execution_mode<>OLD.execution_mode OR NEW.phase_node_id IS DISTINCT FROM OLD.phase_node_id) THEN
  RAISE EXCEPTION 'Run invocation mode cannot change' USING ERRCODE='23514'; END IF;
 IF NEW.execution_mode<>'workflow' AND NOT EXISTS(
  SELECT 1 FROM workflow_jobs j JOIN workflow_jobs parent ON parent.id=j.parent_job_id
  JOIN implementation_plan_versions p ON p.id=j.plan_version_id JOIN frozen_specs f ON f.id=p.frozen_spec_id,
  jsonb_array_elements(f.graph->'nodes') n
  WHERE j.id=NEW.job_id AND parent.kind='grouped' AND n->>'id'=NEW.phase_node_id::text
   AND n->>'type'=CASE WHEN NEW.execution_mode='grouping' THEN 'trigger' ELSE 'outcome' END
 ) THEN RAISE EXCEPTION 'Grouped phases must use the approved trigger or outcome' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_mode_guard BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_run_mode();

CREATE FUNCTION guard_group_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Grouped operation history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workflow_jobs WHERE id=NEW.job_id AND workflow_id=NEW.workflow_id AND kind='grouped' AND parent_job_id IS NULL) THEN
  RAISE EXCEPTION 'Grouped capture requires a root grouped operation' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (
   (to_jsonb(NEW)-'input_bundle_id') IS DISTINCT FROM (to_jsonb(OLD)-'input_bundle_id') OR
   (OLD.input_bundle_id IS NOT NULL AND NEW.input_bundle_id IS DISTINCT FROM OLD.input_bundle_id)
 ) THEN RAISE EXCEPTION 'Captured evidence and applied limits cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON grouped_executions FOR EACH ROW EXECUTE FUNCTION guard_group_capture();

CREATE FUNCTION guard_group_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='grouping_decisions' THEN
  IF NOT EXISTS(SELECT 1 FROM workflow_runs r JOIN workflow_jobs j ON j.id=r.job_id JOIN step_executions s ON s.id=r.result_step_id
    WHERE r.id=NEW.source_run_id AND r.workflow_id=NEW.workflow_id AND j.parent_job_id=NEW.parent_job_id
      AND r.execution_mode='grouping' AND r.status='completed' AND s.output_data=NEW.result) THEN
   RAISE EXCEPTION 'Grouping decisions require the exact completed phase output' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM grouping_decisions WHERE id=NEW.decision_id AND parent_job_id=NEW.parent_job_id AND workflow_id=NEW.workflow_id) THEN
   RAISE EXCEPTION 'Grouping evidence must reference its owning decision' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='grouped_children' THEN
   IF NOT EXISTS(SELECT 1 FROM workflow_jobs j JOIN workflow_runs r ON r.job_id=j.id
    WHERE j.id=NEW.job_id AND j.parent_job_id=NEW.parent_job_id AND r.kind='manual'
      AND r.execution_mode='workflow' AND r.input_bundle_id=NEW.input_bundle_id) THEN
    RAISE EXCEPTION 'Group child must reference its owned execution and sealed input' USING ERRCODE='23514'; END IF;
   IF NEW.supersedes_child_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM grouped_children WHERE id=NEW.supersedes_child_id AND parent_job_id=NEW.parent_job_id AND group_key=NEW.group_key) THEN
    RAISE EXCEPTION 'A child can only supersede the same group in its operation' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER grouping_decision_provenance BEFORE INSERT ON grouping_decisions FOR EACH ROW EXECUTE FUNCTION guard_group_provenance();
CREATE TRIGGER grouped_child_provenance BEFORE INSERT ON grouped_children FOR EACH ROW EXECUTE FUNCTION guard_group_provenance();
CREATE TRIGGER grouping_question_provenance BEFORE INSERT ON grouping_questions FOR EACH ROW EXECUTE FUNCTION guard_group_provenance();
CREATE FUNCTION guard_group_question() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Grouping clarification history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','answer','answer_key','answered_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','answer','answer_key','answered_at']) OR
    (OLD.status<>'open' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Questions and submitted clarification answers are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status='answered' AND length(trim(NEW.answer))=0 THEN
  RAISE EXCEPTION 'Clarification requires a nonempty answer' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER grouping_question_guard BEFORE UPDATE OR DELETE ON grouping_questions FOR EACH ROW EXECUTE FUNCTION guard_group_question();
CREATE UNIQUE INDEX one_grouping_phase_per_round ON workflow_jobs(parent_job_id,(source_request->>'phase_sequence'))
 WHERE source_request->>'execution_mode'='grouping';
