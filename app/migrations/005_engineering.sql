CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  kind text NOT NULL CHECK(kind IN ('source_document','generated_project','evaluator','trace','report','step_payload')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed')),
  storage_backend text NOT NULL CHECK(storage_backend IN ('local','supabase')),
  storage_key text NOT NULL UNIQUE,
  content_hash text CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  byte_size bigint CHECK(byte_size>=0),
  media_type text NOT NULL,
  display_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  UNIQUE(workflow_id,id),
  CHECK(state<>'ready' OR (content_hash IS NOT NULL AND byte_size IS NOT NULL AND ready_at IS NOT NULL))
);
CREATE TABLE implementation_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  frozen_spec_id uuid NOT NULL,
  version_number integer NOT NULL CHECK(version_number>0),
  parent_plan_version_id uuid,
  creation_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,id),
  UNIQUE(workflow_id,version_number),
  UNIQUE(workflow_id,creation_key),
  FOREIGN KEY(workflow_id,frozen_spec_id) REFERENCES frozen_specs(workflow_id,id),
  FOREIGN KEY(workflow_id,parent_plan_version_id) REFERENCES implementation_plan_versions(workflow_id,id),
  CHECK((state='approved')=(approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_draft_plan_per_workflow ON implementation_plan_versions(workflow_id) WHERE state='draft';
CREATE TABLE implementation_plan_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  node_id uuid NOT NULL,
  recommended_method text CHECK(recommended_method IN ('code','agent','human')),
  recommendation_reason text,
  selected_method text NOT NULL CHECK(selected_method IN ('code','agent','human')),
  approved_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_version_id,node_id),
  FOREIGN KEY(workflow_id,plan_version_id) REFERENCES implementation_plan_versions(workflow_id,id),
  FOREIGN KEY(workflow_id,node_id) REFERENCES nodes(workflow_id,id),
  CHECK((recommended_method IS NULL)=(recommendation_reason IS NULL))
);
CREATE TABLE workflow_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  kind text NOT NULL CHECK(kind IN ('generation','evaluation','repair','execution')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting_for_human','cancel_requested','succeeded','failed','cancelled')),
  request_key uuid NOT NULL,
  source_request jsonb NOT NULL CHECK(jsonb_typeof(source_request)='object'),
  phase text NOT NULL DEFAULT 'queued',
  progress jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(progress)='object'),
  plan_version_id uuid NOT NULL,
  input_version_id uuid,
  executor_ref text NOT NULL UNIQUE,
  deadline_at timestamptz NOT NULL,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,id),
  UNIQUE(workflow_id,request_key),
  FOREIGN KEY(workflow_id,plan_version_id) REFERENCES implementation_plan_versions(workflow_id,id),
  CHECK((status IN ('succeeded','failed','cancelled'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_workflow_job ON workflow_jobs(workflow_id)
 WHERE status IN ('queued','running','waiting_for_human','cancel_requested');
CREATE INDEX workflow_jobs_recent ON workflow_jobs(workflow_id,created_at DESC,id DESC);
CREATE TABLE implementation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  plan_version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK(version_number>0),
  parent_version_id uuid,
  created_by_job_id uuid NOT NULL,
  generation_key text NOT NULL,
  artifact_id uuid NOT NULL,
  entrypoint text NOT NULL,
  node_file_map jsonb NOT NULL CHECK(jsonb_typeof(node_file_map)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,id),
  UNIQUE(workflow_id,version_number),
  UNIQUE(created_by_job_id,generation_key),
  FOREIGN KEY(workflow_id,plan_version_id) REFERENCES implementation_plan_versions(workflow_id,id),
  FOREIGN KEY(workflow_id,parent_version_id) REFERENCES implementation_versions(workflow_id,id),
  FOREIGN KEY(workflow_id,created_by_job_id) REFERENCES workflow_jobs(workflow_id,id),
  FOREIGN KEY(workflow_id,artifact_id) REFERENCES artifacts(workflow_id,id)
);
ALTER TABLE workflow_jobs ADD FOREIGN KEY(workflow_id,input_version_id) REFERENCES implementation_versions(workflow_id,id);
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_plan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_versions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION guard_ready_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='ready' THEN RAISE EXCEPTION 'Ready artifacts cannot change' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION guard_ready_artifact();
CREATE TRIGGER implementation_immutable BEFORE UPDATE OR DELETE ON implementation_versions FOR EACH ROW EXECUTE FUNCTION guard_frozen_spec();
CREATE FUNCTION guard_approved_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; plan_state text;
BEGIN
 IF TG_TABLE_NAME='implementation_plan_versions' THEN
  IF OLD.state='approved' THEN RAISE EXCEPTION 'Approved plans cannot change' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='UPDATE' AND (OLD.plan_version_id<>NEW.plan_version_id OR OLD.node_id<>NEW.node_id OR OLD.workflow_id<>NEW.workflow_id) THEN
   RAISE EXCEPTION 'Plan step identity cannot change' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN pid=OLD.plan_version_id; ELSE pid=NEW.plan_version_id; END IF;
  SELECT state INTO plan_state FROM implementation_plan_versions WHERE id=pid FOR SHARE;
  IF plan_state='approved' THEN RAISE EXCEPTION 'Approved plan choices cannot change' USING ERRCODE='23514'; END IF;
  IF TG_OP<>'DELETE' AND NEW.selected_method<>'human' AND EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND type IN ('human_handoff','human_approval')) THEN
   RAISE EXCEPTION 'Customer-required human steps must stay human' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER approved_plan_guard BEFORE UPDATE OR DELETE ON implementation_plan_versions FOR EACH ROW EXECUTE FUNCTION guard_approved_plan();
CREATE TRIGGER approved_step_guard BEFORE INSERT OR UPDATE OR DELETE ON implementation_plan_steps FOR EACH ROW EXECUTE FUNCTION guard_approved_plan();
CREATE INDEX jobs_pending_dispatch ON workflow_jobs(created_at,id) WHERE status='queued';
CREATE INDEX reviews_pending_dispatch ON review_runs(created_at,id) WHERE status='queued';
