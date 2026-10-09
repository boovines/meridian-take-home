-- Completion alone is not a syntax check (fixture execution can skip it).
ALTER TABLE evaluation_runs
 ADD COLUMN build_check_status text CHECK(build_check_status IN ('passed','failed')),
 ADD COLUMN build_checked_at timestamptz,
 ADD CONSTRAINT evaluation_build_evidence_pair CHECK((build_check_status IS NULL) = (build_checked_at IS NULL));
CREATE FUNCTION guard_evaluation_build_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.build_check_status IS NOT NULL AND
    (NEW.build_check_status IS DISTINCT FROM OLD.build_check_status OR NEW.build_checked_at IS DISTINCT FROM OLD.build_checked_at) THEN
  RAISE EXCEPTION 'Recorded build evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_build_evidence_guard BEFORE UPDATE ON evaluation_runs FOR EACH ROW EXECUTE FUNCTION guard_evaluation_build_evidence();
