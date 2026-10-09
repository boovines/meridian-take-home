-- Questions belong to implementation recovery, never to process human approvals.
-- One question per candidate leaves the second generation invocation for continuation.
CREATE TABLE engineer_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 session_id uuid NOT NULL,
 attempt_id uuid NOT NULL UNIQUE,
 question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
 why_needed text NOT NULL CHECK(length(why_needed) BETWEEN 1 AND 2000),
 node_ids uuid[] NOT NULL,
 source_artifact_ids uuid[] NOT NULL DEFAULT '{}',
 audit_event_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','cancelled')),
 answer text CHECK(length(answer) BETWEEN 1 AND 4000),
 reuse boolean NOT NULL DEFAULT false,
 answer_key uuid,
 answered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,id),
 UNIQUE(workflow_id,answer_key),
 FOREIGN KEY(workflow_id,session_id) REFERENCES repair_sessions(workflow_id,id),
 FOREIGN KEY(workflow_id,attempt_id) REFERENCES repair_attempts(workflow_id,id),
 CHECK((status='answered')=(answer IS NOT NULL AND answer_key IS NOT NULL AND answered_at IS NOT NULL)),
 CHECK(status='answered' OR (answer IS NULL AND answer_key IS NULL AND answered_at IS NULL AND NOT reuse))
);
CREATE INDEX questions_by_session ON engineer_questions(session_id,created_at,id);
CREATE FUNCTION guard_engineer_question() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Question history is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status<>'open' OR (NEW.workflow_id,NEW.session_id,NEW.attempt_id,NEW.question,NEW.why_needed,NEW.node_ids,NEW.source_artifact_ids,NEW.audit_event_ids,NEW.created_at)
   IS DISTINCT FROM (OLD.workflow_id,OLD.session_id,OLD.attempt_id,OLD.question,OLD.why_needed,OLD.node_ids,OLD.source_artifact_ids,OLD.audit_event_ids,OLD.created_at) THEN
   RAISE EXCEPTION 'Question and recorded answer are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id
  WHERE a.id=NEW.attempt_id AND s.id=NEW.session_id AND s.workflow_id=NEW.workflow_id AND s.origin='run') THEN
  RAISE EXCEPTION 'Question must belong to its run recovery attempt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineer_question_guard BEFORE INSERT OR UPDATE OR DELETE ON engineer_questions FOR EACH ROW EXECUTE FUNCTION guard_engineer_question();
CREATE TABLE workflow_clarifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 frozen_spec_id uuid NOT NULL,
 question_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workflow_id,frozen_spec_id) REFERENCES frozen_specs(workflow_id,id),
 FOREIGN KEY(workflow_id,question_id) REFERENCES engineer_questions(workflow_id,id)
);
CREATE INDEX clarification_scope ON workflow_clarifications(workflow_id,frozen_spec_id);
CREATE FUNCTION guard_workflow_clarification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Clarification provenance is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM engineer_questions q JOIN repair_sessions s ON s.id=q.session_id JOIN implementation_plan_versions p ON p.id=s.plan_version_id
 WHERE q.id=NEW.question_id AND q.workflow_id=NEW.workflow_id AND q.status='answered' AND q.reuse AND p.frozen_spec_id=NEW.frozen_spec_id) THEN
 RAISE EXCEPTION 'Reuse requires an explicit answered question in the same frozen workflow' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_clarification_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_clarifications FOR EACH ROW EXECUTE FUNCTION guard_workflow_clarification();
-- Immutable context per invocation: the continuation records an answer without
-- retroactively changing what the initial diagnosis or earlier candidates saw.
CREATE TABLE repair_clarification_contexts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 attempt_id uuid NOT NULL REFERENCES repair_attempts(id),
 invocation_number integer NOT NULL CHECK(invocation_number BETWEEN 1 AND 2),
 attempt_token uuid NOT NULL UNIQUE,
 clarifications jsonb NOT NULL CHECK(jsonb_typeof(clarifications)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,invocation_number)
);
CREATE FUNCTION retain_clarification_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recorded clarification context is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id WHERE a.id=NEW.attempt_id AND s.origin='run' AND a.status='running' AND a.attempt_token=NEW.attempt_token AND a.invocation_count=NEW.invocation_number) THEN
 RAISE EXCEPTION 'Context must describe the claimed generation invocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER clarification_context_guard BEFORE INSERT OR UPDATE OR DELETE ON repair_clarification_contexts FOR EACH ROW EXECUTE FUNCTION retain_clarification_context();
ALTER TABLE engineer_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_clarifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_clarification_contexts ENABLE ROW LEVEL SECURITY;
