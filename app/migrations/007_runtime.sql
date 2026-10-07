CREATE TABLE input_bundles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL REFERENCES workflows(id),
 source_kind text NOT NULL CHECK(source_kind IN ('fixture','gmail')), shipment_reference text,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'), manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow_id,id)
);
CREATE TRIGGER bundle_immutable BEFORE UPDATE OR DELETE ON input_bundles FOR EACH ROW EXECUTE FUNCTION guard_frozen_spec();
CREATE TABLE workflow_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL REFERENCES workflows(id), job_id uuid NOT NULL,
 implementation_version_id uuid NOT NULL, input_bundle_id uuid NOT NULL,
 kind text NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','evaluation')), rerun_of_id uuid,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting_for_human','completed','failed','needs_attention','cancelled')),
 limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'), scheduled_step_attempts integer NOT NULL DEFAULT 0 CHECK(scheduled_step_attempts>=0),
 progress_sequence integer NOT NULL DEFAULT 0, active_elapsed_ms bigint NOT NULL DEFAULT 0 CHECK(active_elapsed_ms>=0), active_since timestamptz,
 result_step_id uuid, failure_category text CHECK(failure_category IN ('implementation','input','infrastructure','unknown')),
 failure_code text, failure_message text, started_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id), UNIQUE(id,workflow_id),
 FOREIGN KEY(workflow_id,job_id) REFERENCES workflow_jobs(workflow_id,id),
 FOREIGN KEY(workflow_id,implementation_version_id) REFERENCES implementation_versions(workflow_id,id),
 FOREIGN KEY(workflow_id,input_bundle_id) REFERENCES input_bundles(workflow_id,id),
 FOREIGN KEY(workflow_id,rerun_of_id) REFERENCES workflow_runs(workflow_id,id),
 CHECK((status IN ('completed','failed','needs_attention','cancelled'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX manual_job_run ON workflow_runs(job_id) WHERE kind='manual';
CREATE INDEX runs_by_workflow ON workflow_runs(workflow_id,created_at DESC,id DESC);
CREATE INDEX runs_by_job ON workflow_runs(job_id);
CREATE TABLE step_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL, run_id uuid NOT NULL,
 node_id uuid NOT NULL, occurrence_number integer NOT NULL CHECK(occurrence_number>0), node_visit_number integer NOT NULL CHECK(node_visit_number>0),
 scheduling_key text NOT NULL, branch_ref text,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','waiting_for_human','completed','failed','cancelled')),
 input_step_refs jsonb NOT NULL CHECK(jsonb_typeof(input_step_refs)='object'), output_data jsonb,
 selected_connection_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(selected_connection_ids)='array'),
 invocation_count integer NOT NULL DEFAULT 0 CHECK(invocation_count>=0), attempt_token uuid,
 failure_category text CHECK(failure_category IN ('implementation','input','infrastructure','unknown')), failure_code text, failure_message text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,id), UNIQUE(run_id,occurrence_number), UNIQUE(run_id,node_id,node_visit_number), UNIQUE(run_id,scheduling_key),
 FOREIGN KEY(run_id,workflow_id) REFERENCES workflow_runs(id,workflow_id),
 FOREIGN KEY(workflow_id,node_id) REFERENCES nodes(workflow_id,id),
 CHECK((status IN ('completed','failed','cancelled'))=(finished_at IS NOT NULL))
);
ALTER TABLE workflow_runs ADD FOREIGN KEY(id,result_step_id) REFERENCES step_executions(run_id,id);
CREATE INDEX steps_by_run_state ON step_executions(run_id,status);
CREATE TABLE human_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL, run_id uuid NOT NULL, step_execution_id uuid NOT NULL UNIQUE,
 response_type text NOT NULL CHECK(response_type IN ('text','approval')), prompt text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
 response jsonb, response_source text CHECK(response_source IN ('human','fixture')), response_request_key uuid,
 answered_at timestamptz, cancelled_at timestamptz, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,workflow_id) REFERENCES workflow_runs(id,workflow_id),
 FOREIGN KEY(run_id,step_execution_id) REFERENCES step_executions(run_id,id),
 CHECK((status='answered')=(response IS NOT NULL AND response_source IS NOT NULL AND answered_at IS NOT NULL)),
 CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
);
CREATE INDEX human_pending_workflow ON human_requests(workflow_id,created_at) WHERE status='pending';
CREATE INDEX human_pending_delivery ON human_requests(answered_at,id) WHERE status='answered' AND delivered_at IS NULL;
CREATE FUNCTION guard_runtime_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='workflow_runs' THEN
  IF OLD.status IN ('completed','failed','needs_attention','cancelled') THEN RAISE EXCEPTION 'Finished runs are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.workflow_id<>OLD.workflow_id OR NEW.job_id<>OLD.job_id OR NEW.implementation_version_id<>OLD.implementation_version_id OR NEW.input_bundle_id<>OLD.input_bundle_id OR NEW.limits<>OLD.limits OR NEW.kind<>OLD.kind OR NEW.rerun_of_id IS DISTINCT FROM OLD.rerun_of_id) THEN RAISE EXCEPTION 'Run inputs are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='step_executions' THEN
  IF OLD.status IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'Finished steps are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.run_id<>OLD.run_id OR NEW.node_id<>OLD.node_id OR NEW.occurrence_number<>OLD.occurrence_number OR NEW.node_visit_number<>OLD.node_visit_number OR NEW.input_step_refs<>OLD.input_step_refs OR NEW.scheduling_key<>OLD.scheduling_key OR NEW.branch_ref IS DISTINCT FROM OLD.branch_ref) THEN RAISE EXCEPTION 'Step identity and input are immutable' USING ERRCODE='23514'; END IF;
 ELSIF OLD.status IN ('answered','cancelled') THEN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'delivered_at')<>(to_jsonb(NEW)-'delivered_at') THEN RAISE EXCEPTION 'Human decisions are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER run_history_guard BEFORE UPDATE OR DELETE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_runtime_history();
CREATE TRIGGER step_history_guard BEFORE UPDATE OR DELETE ON step_executions FOR EACH ROW EXECUTE FUNCTION guard_runtime_history();
CREATE TRIGGER human_history_guard BEFORE UPDATE OR DELETE ON human_requests FOR EACH ROW EXECUTE FUNCTION guard_runtime_history();
ALTER TABLE input_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_requests ENABLE ROW LEVEL SECURITY;
