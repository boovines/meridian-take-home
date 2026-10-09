-- Five sequential model request/response pairs, initial/final output and failure.
ALTER TABLE execution_audit_events DROP CONSTRAINT execution_audit_events_sequence_check;
ALTER TABLE execution_audit_events ADD CHECK(sequence BETWEEN 1 AND 13);
