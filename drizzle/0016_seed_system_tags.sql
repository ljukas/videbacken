-- Seed the fixed, curated tag vocabulary (ADR-0012). Slugs are stable identifiers;
-- the UI localizes each via m.tag_<slug>() (added in Slice 2). No user-created tags.
INSERT INTO "tag" ("slug", "sort_order") VALUES
  ('restaurant', 0),
  ('anchorage', 1),
  ('pier', 2),
  ('cove', 3),
  ('beach', 4),
  ('marina', 5),
  ('bar', 6),
  ('snorkeling', 7),
  ('provisioning', 8),
  ('viewpoint', 9)
ON CONFLICT ("slug") DO NOTHING;
