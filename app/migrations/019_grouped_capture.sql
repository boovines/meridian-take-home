-- Completed capture items are immutable checkpoints owned by one selected-email job.
CREATE TABLE grouped_capture_items (
 workflow_id uuid NOT NULL,
 job_id uuid NOT NULL,
 source_key text NOT NULL,
 artifact_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,source_key),
 FOREIGN KEY(workflow_id,job_id) REFERENCES grouped_executions(workflow_id,job_id),
 FOREIGN KEY(workflow_id,artifact_id) REFERENCES artifacts(workflow_id,id)
);
ALTER TABLE grouped_capture_items ENABLE ROW LEVEL SECURITY;
