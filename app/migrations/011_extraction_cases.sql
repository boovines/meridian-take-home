-- Isolated Agent cases can read an optional immutable bundle, with the existing
-- same-workflow FK and locked-suite guard. Older step fixtures remain valid.
ALTER TABLE evaluation_cases DROP CONSTRAINT evaluation_cases_check;
ALTER TABLE evaluation_cases ADD CONSTRAINT evaluation_case_input_shape CHECK (
 (kind='workflow' AND input_bundle_id IS NOT NULL AND node_id IS NULL AND input_data IS NULL)
 OR (kind='step' AND node_id IS NOT NULL AND input_data IS NOT NULL AND jsonb_typeof(input_data)='object')
);
