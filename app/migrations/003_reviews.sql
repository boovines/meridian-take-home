CREATE TABLE review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  request_key uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','awaiting_customer','completed','cancelled','failed')),
  phase text NOT NULL CHECK (phase IN ('clarification','analysis')),
  started_content_revision bigint NOT NULL,
  initial_snapshot jsonb NOT NULL CHECK (jsonb_typeof(initial_snapshot)='object'),
  analyzed_content_revision bigint,
  analyzed_snapshot jsonb CHECK (jsonb_typeof(analyzed_snapshot)='object'),
  model text NOT NULL,
  model_settings jsonb NOT NULL DEFAULT '{}',
  reviewer_version text NOT NULL,
  error_code text,
  error_message text,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(workflow_id,id),
  UNIQUE(workflow_id,request_key),
  CHECK ((analyzed_content_revision IS NULL)=(analyzed_snapshot IS NULL)),
  CHECK (status NOT IN ('completed','cancelled','failed') OR finished_at IS NOT NULL),
  CHECK (status <> 'completed' OR analyzed_snapshot IS NOT NULL)
);
CREATE UNIQUE INDEX review_one_active ON review_runs(workflow_id)
  WHERE status IN ('queued','running','awaiting_customer');
CREATE INDEX review_latest_completed ON review_runs(workflow_id,finished_at DESC,id DESC)
  WHERE status='completed';

ALTER TABLE workflows ADD COLUMN active_review_run_id uuid;
ALTER TABLE workflows ADD FOREIGN KEY(id,active_review_run_id) REFERENCES review_runs(workflow_id,id);
ALTER TABLE workflows ADD CHECK ((state='reviewing')=(active_review_run_id IS NOT NULL));

CREATE TABLE discussion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  kind text NOT NULL CHECK (kind IN ('finding','note','clarification')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  scope text NOT NULL CHECK (scope IN ('workflow','elements')),
  origin_review_run_id uuid,
  finding_category text CHECK (finding_category IN ('ambiguity','missing_behavior','inconsistency','simplification')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  resolution_kind text CHECK (resolution_kind IN ('workflow_updated','clarified','rejected','target_deleted')),
  resolution_note text,
  closed_at timestamptz,
  previous_finding_id uuid,
  creation_key uuid,
  proposed_node_id uuid,
  proposed_node_revision bigint,
  proposed_patch jsonb CHECK (jsonb_typeof(proposed_patch)='object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,id),
  UNIQUE(workflow_id,creation_key),
  FOREIGN KEY(workflow_id,origin_review_run_id) REFERENCES review_runs(workflow_id,id),
  FOREIGN KEY(workflow_id,previous_finding_id) REFERENCES discussion_threads(workflow_id,id),
  FOREIGN KEY(workflow_id,proposed_node_id) REFERENCES nodes(workflow_id,id),
  CHECK ((kind='note')=(origin_review_run_id IS NULL)),
  CHECK ((kind='finding')=(finding_category IS NOT NULL)),
  CHECK ((status='closed')=(closed_at IS NOT NULL)),
  CHECK (status <> 'open' OR (resolution_kind IS NULL AND resolution_note IS NULL)),
  CHECK (kind <> 'finding' OR status <> 'closed' OR resolution_kind IS NOT NULL),
  CHECK (resolution_kind NOT IN ('clarified','rejected','target_deleted') OR coalesce(length(btrim(resolution_note)),0)>0),
  CHECK (num_nonnulls(proposed_node_id,proposed_node_revision,proposed_patch) IN (0,3)),
  CHECK (proposed_node_id IS NULL OR kind='finding')
);
CREATE INDEX findings_open ON discussion_threads(workflow_id) WHERE kind='finding' AND status='open';
CREATE INDEX threads_recent ON discussion_threads(workflow_id,updated_at DESC,id DESC);
CREATE UNIQUE INDEX review_one_clarification ON discussion_threads(origin_review_run_id) WHERE kind='clarification';

CREATE TABLE discussion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  message_number bigint NOT NULL CHECK (message_number>0),
  parent_message_id uuid,
  author_kind text NOT NULL CHECK (author_kind IN ('customer','ai','system')),
  kind text NOT NULL CHECK (kind IN ('comment','event')),
  body text NOT NULL CHECK (length(btrim(body))>0),
  event_data jsonb CHECK (jsonb_typeof(event_data)='object'),
  source_review_run_id uuid,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(thread_id,id),
  UNIQUE(thread_id,message_number),
  UNIQUE(thread_id,request_key),
  FOREIGN KEY(workflow_id,thread_id) REFERENCES discussion_threads(workflow_id,id),
  FOREIGN KEY(thread_id,parent_message_id) REFERENCES discussion_messages(thread_id,id),
  FOREIGN KEY(workflow_id,source_review_run_id) REFERENCES review_runs(workflow_id,id),
  CHECK ((kind='event')=(event_data IS NOT NULL))
);
CREATE TABLE thread_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  node_id uuid,
  connection_id uuid,
  context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(context_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workflow_id,thread_id) REFERENCES discussion_threads(workflow_id,id),
  FOREIGN KEY(workflow_id,node_id) REFERENCES nodes(workflow_id,id),
  FOREIGN KEY(workflow_id,connection_id) REFERENCES connections(workflow_id,id),
  CHECK (num_nonnulls(node_id,connection_id)=1)
);
CREATE UNIQUE INDEX anchors_unique_node ON thread_anchors(thread_id,node_id) WHERE node_id IS NOT NULL;
CREATE UNIQUE INDEX anchors_unique_connection ON thread_anchors(thread_id,connection_id) WHERE connection_id IS NOT NULL;
CREATE INDEX anchors_by_node ON thread_anchors(workflow_id,node_id) WHERE node_id IS NOT NULL;
CREATE INDEX anchors_by_connection ON thread_anchors(workflow_id,connection_id) WHERE connection_id IS NOT NULL;
ALTER TABLE review_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_anchors ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION guard_frozen_spec() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Frozen specifications cannot be changed' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER frozen_spec_immutable BEFORE UPDATE OR DELETE ON frozen_specs FOR EACH ROW EXECUTE FUNCTION guard_frozen_spec();

CREATE FUNCTION guard_frozen_canvas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; current_state text;
BEGIN
  IF TG_TABLE_NAME='workflows' THEN
    IF OLD.state='frozen' THEN RAISE EXCEPTION 'Frozen workflows cannot be changed' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP='UPDATE' AND OLD.workflow_id<>NEW.workflow_id THEN
      RAISE EXCEPTION 'A block or connection cannot move between workflows' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN wid=OLD.workflow_id; ELSE wid=NEW.workflow_id; END IF;
    SELECT state INTO current_state FROM workflows WHERE id=wid FOR SHARE;
    IF current_state='frozen' THEN RAISE EXCEPTION 'Frozen blocks and connections cannot be changed' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER frozen_workflow_guard BEFORE UPDATE OR DELETE ON workflows FOR EACH ROW EXECUTE FUNCTION guard_frozen_canvas();
CREATE TRIGGER frozen_node_guard BEFORE INSERT OR UPDATE OR DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION guard_frozen_canvas();
CREATE TRIGGER frozen_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON connections FOR EACH ROW EXECUTE FUNCTION guard_frozen_canvas();
