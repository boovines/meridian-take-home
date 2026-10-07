-- API requests use the server's database connection. Anonymous Supabase REST
-- clients must not read or mutate the tables; no browser database key is used.
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE frozen_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
