CREATE TABLE `line_pick_cache` (
	`city` text NOT NULL,
	`line` text NOT NULL,
	`terminals_json` text DEFAULT '[]' NOT NULL,
	`stops1_json` text DEFAULT '[]' NOT NULL,
	`stops2_json` text DEFAULT '[]' NOT NULL,
	`extra_stations_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`city`, `line`)
);
