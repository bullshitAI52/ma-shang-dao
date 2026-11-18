ALTER TABLE `canvas_modules` ADD COLUMN `parent_id` integer;
--> statement-breakpoint
UPDATE `canvas_modules` AS m
SET `parent_id` = (
  SELECT MIN(p.id)
  FROM `canvas_modules` AS p
  WHERE p.city = m.city
    AND p.project_id = m.project_id
    AND p.step_index = (
      SELECT MAX(q.step_index)
      FROM `canvas_modules` AS q
      WHERE q.city = m.city
        AND q.project_id = m.project_id
        AND q.step_index < m.step_index
    )
  HAVING COUNT(*) = 1
);
