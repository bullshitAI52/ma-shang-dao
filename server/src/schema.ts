// Drizzle schema for this space: user favorites (lines & stations) only.
// All transit data itself is fetched live from the upstream APIs and is
// never persisted.

import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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

// 换乘步行时间（用户手动调节）：按「城市 + 换乘站名 + 接驳线路」一条，
// minutes 是用户设的步行分钟数（0–30）。规划与行程里再遇到同一个换乘点
// 自动套用；没有记录的换乘点按步行距离 ÷ 80 米/分钟估算。接驳线路为
// 空串表示行程末尾的步行段（下车站 → 终点）。
export const transferWalkTimes = sqliteTable("transfer_walk_times", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  station: text("station").notNull(),
  nextLine: text("next_line").notNull().default(""),
  minutes: integer("minutes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 画布模块：到站卡片（station：线路+站点+方向，direction 是接口方向号
// 1/2、terminal 是该方向终点站）与文本卡片（text：纯文字，如目的地）。
// x/y 是画布世界坐标（浮点），按城市隔离。note 是卡片底部的小字备注。
// enabled 是到站卡的开始/停止开关：1=开始（可查实时），0=停止（变灰
// 待机、不发起任何查询）；新模块默认开始。文本卡不用这个字段。
export const canvasModules = sqliteTable("canvas_modules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  kind: text("kind", { enum: ["station", "text"] }).notNull(),
  line: text("line").notNull().default(""),
  station: text("station").notNull().default(""),
  direction: integer("direction").notNull().default(0),
  terminal: text("terminal").notNull().default(""),
  text: text("text").notNull().default(""),
  note: text("note").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  x: real("x").notNull().default(0),
  y: real("y").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 画布连线：from 模块 → to 模块，只表达路线关系，不触发任何查询。
// 删模块时服务端一并删掉与它相连的线。
export const canvasLinks = sqliteTable("canvas_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  fromId: integer("from_id").notNull(),
  toId: integer("to_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 模块库：用户把配好的画布模块存成的模板（只存配置——类型/站名/
// 线路/方向/终点站/文本/备注，不存实时数据、不存位置），按城市隔
// 离。调用时按配置在画布上放一份独立副本，改/删副本不影响模板，
// 删模板也不影响已放出的副本。同一城市同一配置只存一条（服务端
// 保存时去重）。
export const canvasTemplates = sqliteTable("canvas_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().default("厦门"),
  kind: text("kind", { enum: ["station", "text"] }).notNull(),
  line: text("line").notNull().default(""),
  station: text("station").notNull().default(""),
  direction: integer("direction").notNull().default(0),
  terminal: text("terminal").notNull().default(""),
  text: text("text").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 线路点选缓存：按「城市 + 线路」沉淀这条线已知的终点站与站序，供
// 画布到站卡点选方向/站名用（尽量不打字、且取选项不消耗 apizero 额
// 度）。来源：查线路详情/站序时顺带记、实时查询结果自带的终点站、
// 规划转画布时方案带的终点站、高德线路检索的起讫站、用户手填过的
// 终点站与站名——谁先查到就存下来，之后同线路直接可选。
// terminals_json 是终点站名数组；stops1/stops2_json 是两个方向的站
// 序数组；extra_stations_json 是没有方向站序时零散记下的站名数组。
export const linePickCache = sqliteTable(
  "line_pick_cache",
  {
    city: text("city").notNull(),
    line: text("line").notNull(),
    terminalsJson: text("terminals_json").notNull().default("[]"),
    stops1Json: text("stops1_json").notNull().default("[]"),
    stops2Json: text("stops2_json").notNull().default("[]"),
    extraStationsJson: text("extra_stations_json").notNull().default("[]"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.city, t.line] })],
);

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
