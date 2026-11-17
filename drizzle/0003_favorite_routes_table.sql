CREATE TABLE favorite_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
