-- The canvas remains one working copy. Its process version is distinct from
-- optimistic row revisions/content revisions and advances only at Start revision.
ALTER TABLE workflows ADD COLUMN process_version integer NOT NULL DEFAULT 1 CHECK(process_version>0);
ALTER TABLE workflows ADD COLUMN base_frozen_spec_id uuid;
ALTER TABLE workflows ADD COLUMN current_frozen_spec_id uuid;
ALTER TABLE workflows ADD FOREIGN KEY(id,base_frozen_spec_id) REFERENCES frozen_specs(workflow_id,id);
ALTER TABLE workflows ADD FOREIGN KEY(id,current_frozen_spec_id) REFERENCES frozen_specs(workflow_id,id);

-- Backfill pointers without changing any historical specification bytes.
ALTER TABLE workflows DISABLE TRIGGER frozen_workflow_guard;
UPDATE workflows w SET current_frozen_spec_id=f.id FROM frozen_specs f WHERE f.workflow_id=w.id;
ALTER TABLE workflows ENABLE TRIGGER frozen_workflow_guard;
ALTER TABLE frozen_specs DROP CONSTRAINT frozen_specs_workflow_id_key;
ALTER TABLE frozen_specs ADD COLUMN version_number integer NOT NULL DEFAULT 1 CHECK(version_number>0);
ALTER TABLE frozen_specs ADD COLUMN parent_frozen_spec_id uuid;
ALTER TABLE frozen_specs ADD UNIQUE(workflow_id,version_number);
ALTER TABLE frozen_specs ADD FOREIGN KEY(workflow_id,parent_frozen_spec_id) REFERENCES frozen_specs(workflow_id,id);

ALTER TABLE review_runs ADD COLUMN process_version integer NOT NULL DEFAULT 1 CHECK(process_version>0);
ALTER TABLE discussion_threads ADD COLUMN process_version integer NOT NULL DEFAULT 1 CHECK(process_version>0);
CREATE INDEX review_by_process_version ON review_runs(workflow_id,process_version,finished_at DESC) WHERE status='completed';
CREATE INDEX findings_by_process_version ON discussion_threads(workflow_id,process_version) WHERE kind='finding' AND status='open';
CREATE FUNCTION assign_process_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT process_version INTO NEW.process_version FROM workflows WHERE id=NEW.workflow_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_process_version BEFORE INSERT ON review_runs FOR EACH ROW EXECUTE FUNCTION assign_process_version();
CREATE TRIGGER thread_process_version BEFORE INSERT ON discussion_threads FOR EACH ROW EXECUTE FUNCTION assign_process_version();

DROP INDEX one_draft_plan_per_workflow;
CREATE UNIQUE INDEX one_draft_plan_per_spec ON implementation_plan_versions(workflow_id,frozen_spec_id) WHERE state='draft';

-- Explicit revision transition may unlock a working copy, never a frozen spec.
CREATE OR REPLACE FUNCTION guard_frozen_canvas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; current_state text;
BEGIN
  IF TG_TABLE_NAME='workflows' THEN
    IF OLD.state='frozen' THEN
      IF TG_OP='DELETE' OR NEW.state<>'draft'
        OR NEW.process_version<>OLD.process_version+1
        OR NEW.base_frozen_spec_id IS DISTINCT FROM OLD.current_frozen_spec_id
        OR NEW.current_frozen_spec_id IS DISTINCT FROM OLD.current_frozen_spec_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.desired_outcome IS DISTINCT FROM OLD.desired_outcome
        OR NEW.content_revision<>OLD.content_revision
        OR NEW.active_review_run_id IS NOT NULL THEN
        RAISE EXCEPTION 'Start a new process revision before editing a frozen workflow' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='UPDATE' AND NEW.process_version<>OLD.process_version THEN
      RAISE EXCEPTION 'Only a frozen workflow can start a new process revision' USING ERRCODE='23514';
    END IF;
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

-- A recovered v1 candidate can finish after v2 handoff without becoming v2's default.
ALTER TABLE workflow_run_defaults ADD COLUMN frozen_spec_id uuid;
UPDATE workflow_run_defaults d SET frozen_spec_id=p.frozen_spec_id FROM implementation_versions v JOIN implementation_plan_versions p ON p.id=v.plan_version_id WHERE v.id=d.implementation_version_id;
ALTER TABLE workflow_run_defaults ALTER COLUMN frozen_spec_id SET NOT NULL;
ALTER TABLE workflow_run_defaults DROP CONSTRAINT workflow_run_defaults_pkey;
ALTER TABLE workflow_run_defaults ADD PRIMARY KEY(workflow_id,frozen_spec_id);
ALTER TABLE workflow_run_defaults ADD FOREIGN KEY(workflow_id,frozen_spec_id) REFERENCES frozen_specs(workflow_id,id);
CREATE OR REPLACE FUNCTION guard_recovery_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM repair_sessions s JOIN implementation_plan_versions p ON p.id=s.plan_version_id WHERE s.id=NEW.recovery_session_id AND s.workflow_id=NEW.workflow_id AND s.origin='run' AND s.status='recovered' AND s.baseline_version_id=NEW.implementation_version_id AND p.frozen_spec_id=NEW.frozen_spec_id) THEN
  RAISE EXCEPTION 'Default run version requires accepted recovery evidence for this frozen specification' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP INDEX one_draft_suite;
CREATE UNIQUE INDEX one_draft_suite_per_spec ON evaluation_suite_versions(workflow_id,frozen_spec_id) WHERE state='draft';

-- Human gates are defined by the historical snapshot, not the mutable canvas.
CREATE OR REPLACE FUNCTION guard_approved_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; plan_state text;
BEGIN
 IF TG_TABLE_NAME='implementation_plan_versions' THEN
  IF OLD.state='approved' THEN RAISE EXCEPTION 'Approved plans cannot change' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (OLD.workflow_id<>NEW.workflow_id OR OLD.frozen_spec_id<>NEW.frozen_spec_id) THEN
   RAISE EXCEPTION 'A plan cannot move between process specifications' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='UPDATE' AND (OLD.plan_version_id<>NEW.plan_version_id OR OLD.node_id<>NEW.node_id OR OLD.workflow_id<>NEW.workflow_id) THEN
   RAISE EXCEPTION 'Plan step identity cannot change' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN pid=OLD.plan_version_id; ELSE pid=NEW.plan_version_id; END IF;
  SELECT state INTO plan_state FROM implementation_plan_versions WHERE id=pid FOR SHARE;
  IF plan_state='approved' THEN RAISE EXCEPTION 'Approved plan choices cannot change' USING ERRCODE='23514'; END IF;
  IF TG_OP<>'DELETE' AND NEW.selected_method<>'human' AND EXISTS(
    SELECT 1 FROM implementation_plan_versions p JOIN frozen_specs f ON f.id=p.frozen_spec_id,
      jsonb_array_elements(f.graph->'nodes') n
    WHERE p.id=pid AND n->>'id'=NEW.node_id::text AND n->>'type' IN ('human_handoff','human_approval')
  ) THEN RAISE EXCEPTION 'Customer-required human steps must stay human' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- Typed extension of the existing conversation: no second message/anchor store.
ALTER TABLE discussion_messages DROP CONSTRAINT discussion_messages_author_kind_check;
ALTER TABLE discussion_messages ADD CHECK(author_kind IN ('customer','engineer','ai','system'));
CREATE TABLE engineer_change_requests (
  thread_id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  source_frozen_spec_id uuid NOT NULL,
  target_process_version integer CHECK(target_process_version>1),
  resulting_frozen_spec_id uuid,
  request_key uuid NOT NULL,
  original_body text NOT NULL CHECK(length(btrim(original_body)) BETWEEN 1 AND 20000),
  author_role text NOT NULL DEFAULT 'engineer' CHECK(author_role='engineer'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,request_key),
  FOREIGN KEY(workflow_id,thread_id) REFERENCES discussion_threads(workflow_id,id),
  FOREIGN KEY(workflow_id,source_frozen_spec_id) REFERENCES frozen_specs(workflow_id,id),
  FOREIGN KEY(workflow_id,resulting_frozen_spec_id) REFERENCES frozen_specs(workflow_id,id)
);
CREATE INDEX requests_by_revision ON engineer_change_requests(workflow_id,target_process_version);
CREATE INDEX requests_by_source ON engineer_change_requests(workflow_id,source_frozen_spec_id);
ALTER TABLE engineer_change_requests ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION guard_engineer_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.workflow_id<>OLD.workflow_id OR NEW.thread_id<>OLD.thread_id
   OR NEW.source_frozen_spec_id<>OLD.source_frozen_spec_id OR NEW.original_body<>OLD.original_body
   OR NEW.request_key<>OLD.request_key OR NEW.author_role<>OLD.author_role
   OR (OLD.target_process_version IS NOT NULL AND NEW.target_process_version IS DISTINCT FROM OLD.target_process_version)
   OR (OLD.resulting_frozen_spec_id IS NOT NULL AND NEW.resulting_frozen_spec_id IS DISTINCT FROM OLD.resulting_frozen_spec_id) THEN
   RAISE EXCEPTION 'Engineer request provenance cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineer_request_guard BEFORE UPDATE OR DELETE ON engineer_change_requests FOR EACH ROW EXECUTE FUNCTION guard_engineer_request();

-- Prevent a suite for v1 from lending a pass label to a v2 implementation.
CREATE FUNCTION guard_evaluation_spec() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM implementation_versions v JOIN implementation_plan_versions p ON p.id=v.plan_version_id JOIN evaluation_suite_versions s ON s.frozen_spec_id=p.frozen_spec_id AND s.workflow_id=p.workflow_id WHERE v.id=NEW.implementation_version_id AND s.id=NEW.suite_version_id AND v.workflow_id=NEW.workflow_id) THEN
 RAISE EXCEPTION 'Evaluation code and suite must use the same frozen specification' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_spec_guard BEFORE INSERT ON evaluation_runs FOR EACH ROW EXECUTE FUNCTION guard_evaluation_spec();

CREATE FUNCTION guard_spec_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workflows w WHERE w.id=NEW.workflow_id AND w.state='draft' AND w.process_version=NEW.version_number AND w.content_revision=NEW.source_content_revision AND w.base_frozen_spec_id IS NOT DISTINCT FROM NEW.parent_frozen_spec_id) THEN
   RAISE EXCEPTION 'Freeze must use the current draft version, lineage and content' USING ERRCODE='23514'; END IF;
 IF (NEW.version_number=1)<>(NEW.parent_frozen_spec_id IS NULL) OR (NEW.version_number>1 AND NOT EXISTS(SELECT 1 FROM frozen_specs p WHERE p.id=NEW.parent_frozen_spec_id AND p.workflow_id=NEW.workflow_id AND p.version_number=NEW.version_number-1)) THEN
   RAISE EXCEPTION 'Frozen specification lineage must be consecutive' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spec_lineage_guard BEFORE INSERT ON frozen_specs FOR EACH ROW EXECUTE FUNCTION guard_spec_lineage();
