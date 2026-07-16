-- Seed the 20-row share_part catalog (A1..J2). These rows are static fixture
-- data: each share (A..J) has two parts (1, 2). Tests and the app both
-- assume their presence. ON CONFLICT keeps this idempotent in case a future
-- ephemeral branch already contains them.
INSERT INTO "share_part" ("id", "share_code", "part_number") VALUES
  ('A1', 'A', 1), ('A2', 'A', 2),
  ('B1', 'B', 1), ('B2', 'B', 2),
  ('C1', 'C', 1), ('C2', 'C', 2),
  ('D1', 'D', 1), ('D2', 'D', 2),
  ('E1', 'E', 1), ('E2', 'E', 2),
  ('F1', 'F', 1), ('F2', 'F', 2),
  ('G1', 'G', 1), ('G2', 'G', 2),
  ('H1', 'H', 1), ('H2', 'H', 2),
  ('I1', 'I', 1), ('I2', 'I', 2),
  ('J1', 'J', 1), ('J2', 'J', 2)
ON CONFLICT ("id") DO NOTHING;
