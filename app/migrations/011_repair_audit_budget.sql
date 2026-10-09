-- Audit inspection allowance survives generation retries on any worker.
ALTER TABLE repair_attempts
  ADD COLUMN audit_read_count integer NOT NULL DEFAULT 0 CHECK (audit_read_count BETWEEN 0 AND 3);
