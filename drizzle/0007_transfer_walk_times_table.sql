CREATE TABLE `transfer_walk_times` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text DEFAULT '厦门' NOT NULL,
	`station` text NOT NULL,
	`next_line` text DEFAULT '' NOT NULL,
	`minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
