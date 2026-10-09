-- Evidence allowance belongs to the repair attempt, including infrastructure retries.
ALTER TABLE repair_attempts
  ADD COLUMN document_read_count integer NOT NULL DEFAULT 0 CHECK (document_read_count BETWEEN 0 AND 3),
  ADD COLUMN document_byte_count integer NOT NULL DEFAULT 0 CHECK (document_byte_count BETWEEN 0 AND 20971520);
