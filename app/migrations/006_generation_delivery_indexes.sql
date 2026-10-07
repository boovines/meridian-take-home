-- Delivery and expiration are separate bounded scans; historical finished jobs
-- should not make each five-second worker poll progressively more expensive.
DROP INDEX jobs_pending_dispatch;
CREATE INDEX jobs_pending_delivery ON workflow_jobs(created_at,id)
 WHERE status IN ('queued','cancel_requested');
CREATE INDEX jobs_active_deadline ON workflow_jobs(deadline_at,id)
 WHERE status IN ('queued','running','cancel_requested');
-- Resuming a generation looks up one sealed source checkpoint by its job ID.
CREATE INDEX generated_project_checkpoint ON artifacts(workflow_id,(metadata->>'generation_job_id'),created_at DESC)
 WHERE kind='generated_project' AND state='ready';
