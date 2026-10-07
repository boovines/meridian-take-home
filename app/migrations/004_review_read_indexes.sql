-- Board reads fetch conversations together, without scanning other workflows.
CREATE INDEX messages_by_workflow_thread ON discussion_messages(workflow_id,thread_id,message_number);
CREATE INDEX anchors_by_workflow_thread ON thread_anchors(workflow_id,thread_id);
CREATE INDEX reviews_recent ON review_runs(workflow_id,created_at DESC,id DESC);
