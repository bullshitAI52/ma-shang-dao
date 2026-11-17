DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
