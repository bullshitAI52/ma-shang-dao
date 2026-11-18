CREATE TABLE `canvas_modules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text DEFAULT '厦门' NOT NULL,
	`kind` text NOT NULL,
	`line` text DEFAULT '' NOT NULL,
	`station` text DEFAULT '' NOT NULL,
	`direction` integer DEFAULT 0 NOT NULL,
	`terminal` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `canvas_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text DEFAULT '厦门' NOT NULL,
	`from_id` integer NOT NULL,
	`to_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
