CREATE TABLE scoping_sessions (
  workflow_id uuid PRIMARY KEY REFERENCES workflows(id),
  note text NOT NULL DEFAULT '' CHECK (length(note)<=50000),
  note_revision bigint NOT NULL DEFAULT 1 CHECK (note_revision>0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  incorporated_note_revision bigint,
  current_scope_id uuid,
  current_preview_id uuid,
  applied_preview_id uuid,
  applied_content_revision bigint,
  apply_request_key uuid,
  applied_element_ids jsonb CHECK (jsonb_typeof(applied_element_ids)='object'),
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(applied_preview_id,applied_content_revision,apply_request_key,applied_at,applied_element_ids) IN (0,5))
);
CREATE TABLE scoping_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES scoping_sessions(workflow_id),
  request_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('interview','preview')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
  session_revision bigint NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  model text NOT NULL,
  error_message text,
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(workflow_id,id), UNIQUE(workflow_id,request_key),
  CHECK ((status IN ('completed','cancelled','failed'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX scoping_one_active ON scoping_operations(workflow_id) WHERE status IN ('queued','running');
CREATE TABLE scoping_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES scoping_sessions(workflow_id),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scope','preview')),
  note_revision bigint NOT NULL,
  scope_id uuid,
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,id), UNIQUE(operation_id),
  FOREIGN KEY(workflow_id,operation_id) REFERENCES scoping_operations(workflow_id,id),
  FOREIGN KEY(workflow_id,scope_id) REFERENCES scoping_versions(workflow_id,id),
  CHECK ((kind='preview')=(scope_id IS NOT NULL))
);
ALTER TABLE scoping_sessions ADD FOREIGN KEY(workflow_id,current_scope_id) REFERENCES scoping_versions(workflow_id,id);
ALTER TABLE scoping_sessions ADD FOREIGN KEY(workflow_id,current_preview_id) REFERENCES scoping_versions(workflow_id,id);
ALTER TABLE scoping_sessions ADD FOREIGN KEY(workflow_id,applied_preview_id) REFERENCES scoping_versions(workflow_id,id);
CREATE TABLE scoping_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES scoping_sessions(workflow_id),
  operation_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  author text NOT NULL CHECK (author IN ('expert','agent')),
  body text NOT NULL CHECK (length(btrim(body))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workflow_id,operation_id) REFERENCES scoping_operations(workflow_id,id),
  UNIQUE(operation_id,author)
);
CREATE TABLE scoping_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES scoping_sessions(workflow_id),
  preview_id uuid NOT NULL,
  source_key text NOT NULL,
  question text NOT NULL,
  anchors jsonb NOT NULL,
  thread_id uuid,
  FOREIGN KEY(workflow_id,preview_id) REFERENCES scoping_versions(workflow_id,id),
  FOREIGN KEY(workflow_id,thread_id) REFERENCES discussion_threads(workflow_id,id),
  UNIQUE(workflow_id,source_key)
);
CREATE INDEX scoping_outbox ON scoping_operations(status,created_at) WHERE status IN ('queued','running');
CREATE INDEX scoping_history ON scoping_messages(workflow_id,sequence);
CREATE FUNCTION guard_scoping_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Scoping history cannot be changed' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER scoping_version_immutable BEFORE UPDATE OR DELETE ON scoping_versions FOR EACH ROW EXECUTE FUNCTION guard_scoping_history();
CREATE TRIGGER scoping_message_immutable BEFORE UPDATE OR DELETE ON scoping_messages FOR EACH ROW EXECUTE FUNCTION guard_scoping_history();
ALTER TABLE scoping_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoping_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoping_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoping_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoping_obligations ENABLE ROW LEVEL SECURITY;
