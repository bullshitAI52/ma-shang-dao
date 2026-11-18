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

// 常用地点：名称（家/公司/自定义）+ 地点关键词，按城市隔离。
export const favoritePlaces = sqliteTable("favorite_places", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  name: text("name").notNull(),
  address: text("address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 进行中的行程：全表只存一行（id 固定 1），同时只能有一个进行中行程。
// segments_json 存所选方案各段的富化信息（线路/上车/下车/站点序切片），
// current_index 是当前段下标，phase 为 waiting（未上车/步行未走）或
// riding（已上车、未下车）。行程完成或放弃即删行。
export const activeTrip = sqliteTable("active_trip", {
  id: integer("id").primaryKey(),
  city: text("city").notNull().default("厦门"),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  segmentsJson: text("segments_json").notNull(),
  currentIndex: integer("current_index").notNull().default(0),
  phase: text("phase", { enum: ["waiting", "riding"] })
    .notNull()
    .default("waiting"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
