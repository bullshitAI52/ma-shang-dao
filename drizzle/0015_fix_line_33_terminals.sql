UPDATE line_pick_cache SET terminals_json = '["公园东门","高崎公交场站"]' WHERE city = '厦门' AND line = '33路';
--> statement-breakpoint
UPDATE canvas_modules SET terminal = '高崎公交场站' WHERE line = '33路' AND terminal LIKE 'gong%';
--> statement-breakpoint
UPDATE canvas_modules SET terminal = '公园东门' WHERE line = '33路' AND terminal = '公园东';
--> statement-breakpoint
UPDATE canvas_templates SET terminal = '高崎公交场站' WHERE line = '33路' AND terminal LIKE 'gong%';
--> statement-breakpoint
UPDATE canvas_templates SET terminal = '公园东门' WHERE line = '33路' AND terminal = '公园东';
