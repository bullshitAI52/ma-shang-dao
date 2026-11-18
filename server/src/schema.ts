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

// 设置：键值对。存界面里填的 API key（apizero_key / amap_key，只存
// 服务端、前端只见掩码）、默认城市（default_city）、查询缓存秒数
// （cache_ttl_sec）。没有 UI 值的 key 服务端回退读主机上的 key 文件。
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
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
