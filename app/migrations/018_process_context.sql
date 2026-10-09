CREATE TABLE workflow_process_context (
  workflow_id uuid PRIMARY KEY REFERENCES workflows(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  context jsonb CHECK (context IS NULL OR (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 60000)),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow_process_context ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER frozen_process_context_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_process_context FOR EACH ROW EXECUTE FUNCTION guard_frozen_canvas();
