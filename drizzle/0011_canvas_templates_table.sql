CREATE TABLE `canvas_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text DEFAULT '厦门' NOT NULL,
	`kind` text NOT NULL,
	`line` text DEFAULT '' NOT NULL,
	`station` text DEFAULT '' NOT NULL,
	`direction` integer DEFAULT 0 NOT NULL,
	`terminal` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
