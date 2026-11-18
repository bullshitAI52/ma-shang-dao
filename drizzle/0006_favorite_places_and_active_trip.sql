CREATE TABLE favorite_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL DEFAULT '厦门',
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE active_trip (
  id INTEGER PRIMARY KEY,
  city TEXT NOT NULL DEFAULT '厦门',
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'waiting',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
