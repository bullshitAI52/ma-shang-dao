// Drizzle schema for this space: user favorites (lines & stations) only.
// All transit data itself is fetched live from the upstream APIs and is
// never persisted.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const favorites = sqliteTable("favorites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 收藏所属城市；城市切换后只显示当前城市的收藏，旧数据默认厦门
  city: text("city").notNull().default("厦门"),
  // "line" (value = 线路名, label = 线路名) or
  // "station" (value = 站名, label = 站名) or
  // "lineStation" (value = 线路名, label = 站名)
  kind: text("kind", { enum: ["line", "station", "lineStation"] }).notNull(),
  value: text("value").notNull(),
  label: text("label").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 常用路线：一组起点+终点，label 默认「起点 → 终点」，与 favorites 分开存。
export const favoriteRoutes = sqliteTable("favorite_routes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  label: text("label").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
