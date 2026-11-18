CREATE TABLE `canvas_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text DEFAULT '厦门' NOT NULL,
	`name` text DEFAULT '默认项目' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `canvas_modules` ADD `project_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `canvas_links` ADD `project_id` integer DEFAULT 0 NOT NULL;
