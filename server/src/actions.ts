// Actions for 厦门公交. All transit data is fetched live from the same
// upstream APIs the user's Telegram bot (@Xmbus_bot) uses:
//   - apizero 实时公交 API (线路详情 / 站点搜索 / 实时到站), via privileged call
//   - 高德地图 API (inputtips / geocode / transit 换乘规划), via privileged call
// Keys are read from key files on the host inside privileged.ts — never here.
// apizero is billed per call: every action below runs only on an explicit
// user query/refresh from the client. Nothing polls.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, desc, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const DEFAULT_CITY = "厦门";

/** 客户端传来的城市名（缺省/空白时回落到厦门，保持原有行为）。 */
function cityOf(v: string | undefined): string {
  const t = (v ?? "").trim().replace(/\s+/g, "");
  return t || DEFAULT_CITY;
}

// ---------- shared shapes ----------

const busSchema = z.object({
  busId: z.string(),
  stopsRemaining: z.number().nullable(),
  travelMinutes: z.number().nullable(),
  arrivalTime: z.string(),
});
type Bus = z.infer<typeof busSchema>;

const dirRealtimeSchema = z.object({
  direction: z.number(),
  terminal: z.string(),
  nextStop: z.string(),
  firstTime: z.string(),
  lastTime: z.string(),
  price: z.string(),
  error: z.string(),
  buses: z.array(busSchema),
});

// ---------- loose JSON helpers (upstream payloads are untyped) ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toBus(raw: unknown): Bus {
  const b = rec(raw);
  const arrival = str(b.arrival_time);
  return {
    busId: str(b.bus_id),
    stopsRemaining: numOrNull(b.stops_remaining),
    travelMinutes: numOrNull(b.travel_minutes),
    // "2026-08-30 22:23" → "22:23"
    arrivalTime: arrival.includes(" ")
      ? (arrival.split(" ")[1] ?? "").slice(0, 5)
      : arrival,
  };
}

// ---------- upstream calls (through privileged host functions) ----------

async function apizero(
  ctx: Ctx,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await ctx.executePrivileged(privileged.apizeroCall, {
    paramsJson: JSON.stringify(params),
  });
  if (!r.ok) throw new Error(r.error || "公交数据接口请求失败");
  const parsed: unknown = JSON.parse(r.body || "{}");
  return rec(parsed);
}

async function amap(
  ctx: Ctx,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const r = await ctx.executePrivileged(privileged.amapGet, {
    path,
    paramsJson: JSON.stringify(params),
  });
  if (!r.ok) throw new Error(r.error || "高德地图接口请求失败");
  const parsed: unknown = JSON.parse(r.body || "{}");
  return rec(parsed);
}

function normalizeLine(raw: string): string {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t) return "";
  if (t.toUpperCase() === "BRT") return "BRT";
  return t.endsWith("路") ? t : `${t}路`;
}

/** 线路在某站某方向的实时信息（从 query 结果的 lines 里筛目标线路）。 */
async function queryDirection(
  ctx: Ctx,
  city: string,
  station: string,
  direction: number,
  line: string,
): Promise<z.infer<typeof dirRealtimeSchema> | null> {
  const data = await apizero(ctx, {
    type: "query",
    city,
    station,
    direction,
  });
  for (const raw of arr(data.lines)) {
    const ln = rec(raw);
    if (str(ln.line) === line) {
      return {
        direction,
        terminal: str(ln.terminal),
        nextStop: "",
        firstTime: str(ln.first_time),
        lastTime: str(ln.last_time),
        price: str(ln.price),
        error: "",
        buses: arr(ln.buses).map(toBus),
      };
    }
  }
  return null;
}

/** 智能匹配：找到「line」停靠的、匹配关键词的站（同 bot 的 find_station_for_line）。 */
async function findStationForLine(
  ctx: Ctx,
  city: string,
  line: string,
  keyword: string,
): Promise<string | null> {
  const data = await apizero(ctx, {
    type: "stations",
    city,
    station: keyword,
  });
  const candidates = arr(data.stations)
    .map((s) => str(rec(s).name))
    .filter((n) => n !== "");
  if (candidates.length === 0) {
    try {
      const hit = await queryDirection(ctx, city, keyword, 1, line);
      return hit ? keyword : null;
    } catch {
      return null;
    }
  }
  for (const name of candidates) {
    try {
      const hit = await queryDirection(ctx, city, name, 1, line);
      if (hit) return name;
    } catch {
      continue;
    }
  }
  return null;
}

async function geocode(
  ctx: Ctx,
  city: string,
  address: string,
): Promise<{ lng: number; lat: number } | null> {
  // 1. inputtips 优先公交站/地铁站（同 route_engine）
  try {
    const d = await amap(ctx, "/v3/assistant/inputtips", {
      keywords: address,
      city,
    });
    const tips = arr(d.tips).map(rec);
    const chosen =
      tips.find((t) => {
        const n = str(t.name);
        return n.includes("公交站") || n.includes("地铁站");
      }) ?? tips[0];
    const loc = chosen ? str(chosen.location) : "";
    if (loc.includes(",")) {
      const [lngS, latS] = loc.split(",");
      const lng = Number(lngS);
      const lat = Number(latS);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return { lng, lat };
    }
  } catch {
    // 落到地理编码兜底
  }
  // 2. geocode 兜底
  const d = await amap(ctx, "/v3/geocode/geo", { address, city });
  if (str(d.status) === "1") {
    const first = rec(arr(d.geocodes)[0]);
    const loc = str(first.location);
    if (loc.includes(",")) {
      const [lngS, latS] = loc.split(",");
      const lng = Number(lngS);
      const lat = Number(latS);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return { lng, lat };
    }
  }
  return null;
}

// ---------- 服务端缓存（额度保护） ----------
// apizero 免费额度很小：实时查询结果缓存 90 秒，同一查询 90 秒内重复请求
// 直接返回缓存、不再调用接口；只有客户端显式「强制刷新」才绕过缓存。
// 线路站点序几乎不变，缓存 12 小时，仅用于推导「下一站」，不额外烧额度。

const QUERY_CACHE_TTL_MS = 90_000;
const STOPS_CACHE_TTL_MS = 12 * 60 * 60_000;

type CacheEntry<T> = { expiresAt: number; value: T };
const queryCache = new Map<string, CacheEntry<unknown>>();
const stopsCache = new Map<string, CacheEntry<string[]>>();

function cacheGet<T>(key: string): T | null {
  const e = queryCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    queryCache.delete(key);
    return null;
  }
  return e.value as T;
}
function cacheSet(key: string, value: unknown): void {
  queryCache.set(key, { expiresAt: Date.now() + QUERY_CACHE_TTL_MS, value });
}

/** 线路某方向的站点序（长缓存）；forceLineFetch=false 时只读缓存不调接口。 */
async function getLineStops(
  ctx: Ctx,
  city: string,
  line: string,
  direction: number,
  fetchIfMissing: boolean,
): Promise<string[] | null> {
  const key = `${city}|${line}|${direction}`;
  const hit = stopsCache.get(key);
  if (hit && Date.now() <= hit.expiresAt) return hit.value;
  if (hit) stopsCache.delete(key);
  if (!fetchIfMissing) return null;
  try {
    const d = await apizero(ctx, { type: "line", city, line, direction });
    const stops = arr(d.stops)
      .map((s) => (typeof s === "string" ? s : str(rec(s).name)))
      .filter((n) => n !== "");
    if (stops.length > 0) {
      stopsCache.set(key, {
        expiresAt: Date.now() + STOPS_CACHE_TTL_MS,
        value: stops,
      });
    }
    return stops;
  } catch {
    return null;
  }
}

/** 由站点序推「当前站的下一站」；当前站是末站或不在序中时返回空串。 */
function nextStopOf(stops: string[] | null, station: string): string {
  if (!stops) return "";
  const i = stops.indexOf(station);
  if (i < 0 || i >= stops.length - 1) return "";
  return stops[i + 1] ?? "";
}

// ---------- 地铁线路 ----------
// 厦门用机器人内置的静态数据（bot 的 METRO 字典）；其他城市用高德公交
// 线路检索（/v3/bus/linename）拼齐全城线路：按「地铁N号线」逐号检索
// （无果再试「轨道交通N号线」）、命名线逐个补、最后用宽口径「号线」
// 扫一遍兜底，每个关键词都翻完所有分页（单页上限 25 条，大城市不
// 翻页会被截断），合并后按基础名去重。逐号检索不因连续几号无果就
// 停——广州 15/16/17 号线不存在、18/21/22 却有，旧版「连续 3 号无果
// 即停」正是漏掉它们的元凶。结果服务端缓存 7 天（无地铁的城市缓存
// 1 天），不重复调接口；但检索中途被接口拒绝（如当日调用量超限）
// 拿到的残缺列表不进缓存，下次打开重新拉齐。

type MetroLine = {
  name: string;
  route: string;
  hours: string;
  interval: string;
  note: string;
};

const XIAMEN_METRO: MetroLine[] = [
  { name: "地铁1号线", route: "岩内 ↔ 镇海路", hours: "06:30 - 23:00", interval: "高峰约4分钟 / 平峰约7分钟", note: "厦门首条地铁（2017年开通）" },
  { name: "地铁2号线", route: "五缘湾 ↔ 天竺山", hours: "06:30 - 22:30", interval: "高峰约3分钟 / 平峰约6分钟", note: "2019年开通" },
  { name: "地铁3号线", route: "蔡厝 ↔ 厦门火车站", hours: "06:30 - 22:30", interval: "高峰约5分钟 / 平峰约8分钟", note: "2021年开通" },
  { name: "地铁4号线", route: "嵩屿码头 ↔ 翔安机场站", hours: "建设中 / 部分运营", interval: "—", note: "连接机场快线" },
  { name: "地铁5号线", route: "规划中", hours: "尚未开通", interval: "—", note: "规划线路" },
  { name: "地铁6号线", route: "林埭西 ↔ 同翔高新城", hours: "建设中 / 部分运营", interval: "—", note: "集美段先行" },
];

const METRO_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const METRO_EMPTY_TTL_MS = 24 * 60 * 60_000;
// 缓存键带版本号：v2 起用补全后的检索逻辑，旧版残缺列表（广州缺
// 1/3/18/21/22 号线、深圳缺 3/8 号线）即便还在缓存里也不会被读到。
const METRO_CACHE_VERSION = "v2";
const metroCache = new Map<string, CacheEntry<MetroLine[]>>();

/** "05:30:00" / "05:30" / "0530" → 当日分钟数；解析不了返回 null。 */
function hmToMin(v: string): number | null {
  const t = v.trim();
  const colon = /^(\d{1,2}):(\d{2})/.exec(t);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  if (/^\d{4}$/.test(t)) return Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
  return null;
}
function minToHm(m: number): string {
  const mm = m >= 1440 ? m - 1440 : m;
  return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
}

/** 高德 timedesc 是 URL 编码的 JSON：从各时段规则里取最早首班/最晚末班与间隔范围。 */
function parseTimedesc(raw: string): { hours: string; interval: string } {
  if (!raw) return { hours: "", interval: "" };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    let first: number | null = null;
    let last: number | null = null;
    const ivals: number[] = [];
    for (const g of arr(rec(parsed).rule_group)) {
      for (const tgRaw of arr(rec(g).time_group)) {
        const tg = rec(tgRaw);
        const s = hmToMin(str(tg.start_time));
        const e0 = hmToMin(str(tg.end_time));
        const e = e0 === 0 ? 1440 : e0;
        if (s != null && (first == null || s < first)) first = s;
        if (e != null && (last == null || e > last)) last = e;
        const iv = hmToMin(str(tg.interval_time));
        if (iv != null && iv > 0) ivals.push(iv);
      }
    }
    const hours =
      first != null && last != null
        ? `${minToHm(first)} - ${minToHm(last)}`
        : "";
    let interval = "";
    if (ivals.length > 0) {
      const lo = Math.min(...ivals);
      const hi = Math.max(...ivals);
      interval = lo === hi ? `约 ${lo} 分钟` : `约 ${lo}–${hi} 分钟`;
    }
    return { hours, interval };
  } catch {
    return { hours: "", interval: "" };
  }
}

/** start_time/end_time 字段兜底（字符串 "0702" 或字符串数组）。 */
function fieldTime(v: unknown): string {
  const one = Array.isArray(v) ? v[0] : v;
  const m = typeof one === "string" ? hmToMin(one) : null;
  return m != null ? minToHm(m) : "";
}

type MetroFetchResult = {
  lines: MetroLine[];
  /** true = 检索中途被接口拒绝（如当日调用量超限），列表可能残缺 */
  degraded: boolean;
  /** 最近一次接口拒绝的原因（高德 info 原文），供报错展示 */
  apiError: string;
};

async function fetchMetroLines(
  ctx: Ctx,
  city: string,
): Promise<MetroFetchResult> {
  const byName = new Map<string, MetroLine & { num: number }>();
  const consider = (raw: unknown) => {
    const b = rec(raw);
    const type = str(b.type);
    if (type !== "地铁" && type !== "磁悬浮列车" && type !== "轻轨") return;
    const full = str(b.name);
    const base = (full.split(/[(（]/)[0] ?? full).trim();
    if (!base) return;
    const start = str(b.start_stop);
    const end = str(b.end_stop);
    const td = parseTimedesc(str(b.timedesc));
    let hours = td.hours;
    if (!hours) {
      const fs = fieldTime(b.start_time);
      const fe = fieldTime(b.end_time);
      if (fs && fe) hours = `${fs} - ${fe}`;
    }
    const notes: string[] = [];
    if (type !== "地铁") notes.push(type);
    const stopCount = arr(b.busstops).length;
    if (stopCount > 0) notes.push(`共 ${stopCount} 站`);
    const dist = numOrNull(b.distance);
    if (dist != null && dist > 0) notes.push(`全长约 ${dist.toFixed(1)} 公里`);
    // 高德对在建/延伸段线路通常没有时刻表数据，如实标注而非装作已开通
    if (!hours) notes.push("高德未提供首末班（可能尚未开通）");
    const numMatch = /(\d+)\s*号线/.exec(base);
    const entry: MetroLine & { num: number } = {
      name: base,
      route: start && end ? `${start} ↔ ${end}` : "",
      hours,
      interval: td.interval,
      note: notes.join(" · "),
      num: numMatch ? Number(numMatch[1]) : 999,
    };
    const existing = byName.get(base);
    // 同名先到先得；但先到的没有首末班、后到的有，用后到的补全
    if (!existing || (!existing.hours && entry.hours)) {
      byName.set(base, entry);
    }
    // 贯通运营被高德合并收录的线（如深圳「地铁2号线(8号线)」溪涌↔赤湾）：
    // 括号里的线号也单独成条，否则 8 号线会被 2 号线吞掉、永远看不到
    const alias = /[(（](\d+)\s*号线[)）]/.exec(full);
    if (alias) {
      const aliasName = `地铁${alias[1]}号线`;
      if (aliasName !== base && !byName.has(aliasName)) {
        byName.set(aliasName, {
          ...entry,
          name: aliasName,
          num: Number(alias[1]),
          note: [...notes, `与${base.replace(/^地铁/, "")}贯通运营`].join(
            " · ",
          ),
        });
      }
    }
  };

  let degraded = false;
  let apiError = "";
  let consecutiveFailures = 0;
  let aborted = false;

  /**
   * 单个关键词翻完所有分页（offset=25 逐页拉，直到拉满 count 或空页）。
   * 返回接口给出的原始条数（判断该关键词是否真无果用）；本次检索被
   * 接口拒绝（status≠1，如当日调用量超限）时返回 -1 并记 degraded，
   * 连续 3 个关键词都被拒绝就停掉整个检索，残缺列表交由调用方不缓存。
   */
  const search = async (keywords: string): Promise<number> => {
    if (aborted) return -1;
    let seen = 0;
    let failed = false;
    for (let page = 1; page <= 10; page++) {
      let lines: unknown[] = [];
      let total = 0;
      try {
        const d = await amap(ctx, "/v3/bus/linename", {
          keywords,
          city,
          extensions: "all",
          offset: "25",
          page: String(page),
        });
        if (str(d.status) !== "1") {
          failed = true;
          apiError = str(d.info) || "接口未返回数据";
          break;
        }
        lines = arr(d.buslines);
        total = numOrNull(d.count) ?? 0;
      } catch (e) {
        failed = true;
        apiError = errMsg(e);
        break;
      }
      if (lines.length === 0) break;
      seen += lines.length;
      for (const raw of lines) consider(raw);
      if (lines.length < 25 || (total > 0 && seen >= total)) break;
    }
    if (failed) {
      degraded = true;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) aborted = true;
      return -1;
    }
    consecutiveFailures = 0;
    return seen;
  };

  // 1) 按线号逐条检索补齐（不设「连续无果即停」：广州 15/16/17 无线、
  //    18/21/22 却有；接口正常应答但无果时才试「轨道交通N号线」叫法）
  for (let n = 1; n <= 30; n++) {
    const seen = await search(`地铁${n}号线`);
    if (seen === 0) await search(`轨道交通${n}号线`);
  }
  // 2) 命名线逐个补：浦江线/磁浮线/APM线/广佛线/机场线/亦庄线等
  for (const kw of [
    "地铁浦江线",
    "磁浮线",
    "APM线",
    "广佛线",
    "机场线",
    "亦庄线",
    "房山线",
    "昌平线",
    "八通线",
    "燕房线",
    "西郊线",
    "S1线",
  ]) {
    await search(kw);
  }
  // 3) 宽口径兜底扫一遍（「号线」在广州 count=100，靠分页翻完；
  //    能捞到逐号/命名都没覆盖的线，如佛山地铁各线）
  await search("号线");

  const lines = [...byName.values()]
    .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name, "zh-CN"))
    .map(({ name, route, hours, interval, note }) => ({
      name,
      route,
      hours,
      interval,
      note,
    }));
  return { lines, degraded, apiError };
}

// ---------- response schemas ----------

const lineDetailResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  line: z.string(),
  directions: z.array(
    z.object({
      direction: z.number(),
      start: z.string(),
      end: z.string(),
      firstTime: z.string(),
      lastTime: z.string(),
      price: z.string(),
      stopCount: z.number(),
      stops: z.array(z.string()),
    }),
  ),
});

const lineRealtimeResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  line: z.string(),
  station: z.string(),
  queriedAt: z.string(),
  cached: z.boolean(),
  directions: z.array(dirRealtimeSchema),
});

const stationsResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  stations: z.array(z.object({ name: z.string(), kind: z.string() })),
});

const stationArrivalsResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  station: z.string(),
  queriedAt: z.string(),
  cached: z.boolean(),
  directions: z.array(
    z.object({
      direction: z.number(),
      error: z.string(),
      lines: z.array(
        z.object({
          line: z.string(),
          terminal: z.string(),
          nextStop: z.string(),
          price: z.string(),
          firstTime: z.string(),
          lastTime: z.string(),
          buses: z.array(busSchema),
        }),
      ),
    }),
  ),
});

const nearbyStationsResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  stations: z.array(
    z.object({
      name: z.string(),
      distance: z.number(),
      lines: z.string(),
      lng: z.number(),
      lat: z.number(),
    }),
  ),
});

const routePlanResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  plans: z.array(
    z.object({
      durationMin: z.number(),
      walking: z.number(),
      distance: z.number(),
      cost: z.string(),
      best: z.boolean(),
      segments: z.array(
        z.object({
          type: z.string(),
          name: z.string(),
          departure: z.string(),
          arrival: z.string(),
          walkDistance: z.string(),
        }),
      ),
    }),
  ),
});

const favoritesResponse = z.object({
  favorites: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      value: z.string(),
      label: z.string(),
    }),
  ),
});

const favoriteRoutesResponse = z.object({
  routes: z.array(
    z.object({
      id: z.number(),
      origin: z.string(),
      destination: z.string(),
      label: z.string(),
    }),
  ),
});

const metroLinesResponse = z.object({
  ok: z.boolean(),
  error: z.string(),
  city: z.string(),
  source: z.string(),
  lines: z.array(
    z.object({
      name: z.string(),
      route: z.string(),
      hours: z.string(),
      interval: z.string(),
      note: z.string(),
    }),
  ),
});

async function listFavoriteRoutes(
  ctx: Ctx,
  city: string,
): Promise<z.infer<typeof favoriteRoutesResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.favoriteRoutes)
    .where(eq(schema.favoriteRoutes.city, city))
    .orderBy(desc(schema.favoriteRoutes.id))
    .limit(50);
  return {
    routes: rows.map((r) => ({
      id: r.id,
      origin: r.origin,
      destination: r.destination,
      label: r.label,
    })),
  };
}

async function listFavorites(
  ctx: Ctx,
  city: string,
): Promise<z.infer<typeof favoritesResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.favorites)
    .where(eq(schema.favorites.city, city))
    .orderBy(desc(schema.favorites.id))
    .limit(100);
  return {
    favorites: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      label: r.label,
    })),
  };
}

const nowHm = () =>
  new Date().toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

// ---------- actions ----------

export const Actions = {
  getLineDetail: defineAction({
    description: "查某城市公交某条线路的详情：双向起讫站、首末班、票价和全部站点。city 缺省为厦门。",
    request: z.object({
      line: z.string().min(1).max(20),
      city: z.string().max(20).optional(),
    }),
    response: lineDetailResponse,
    privileged: [privileged.apizeroCall],
    async handler(ctx, args): Promise<z.infer<typeof lineDetailResponse>> {
      const city = cityOf(args.city);
      const line = normalizeLine(args.line);
      if (!line) {
        return { ok: false, error: "请输入线路号", line: "", directions: [] };
      }
      const fetchDir = async (direction: number) => {
        const d = await apizero(ctx, {
          type: "line",
          city,
          line,
          direction,
        });
        const stops = arr(d.stops).map((s) =>
          typeof s === "string" ? s : str(rec(s).name),
        );
        // 顺带填充站点序长缓存，供实时查询推导「下一站」
        if (stops.length > 0) {
          stopsCache.set(`${city}|${line}|${direction}`, {
            expiresAt: Date.now() + STOPS_CACHE_TTL_MS,
            value: stops.filter((n) => n !== ""),
          });
        }
        return {
          direction,
          start: str(d.start),
          end: str(d.end),
          firstTime: str(d.first_time),
          lastTime: str(d.last_time),
          price: str(d.price),
          stopCount: numOrNull(d.stop_count) ?? stops.length,
          stops,
        };
      };
      try {
        const d1 = await fetchDir(1);
        let d2: Awaited<ReturnType<typeof fetchDir>> | null = null;
        try {
          d2 = await fetchDir(2);
        } catch {
          d2 = null;
        }
        // 反向若与正向起讫完全相同（环线等），只保留一个方向
        const directions =
          d2 && !(d2.start === d1.start && d2.end === d1.end)
            ? [d1, d2]
            : [d1];
        return { ok: true, error: "", line, directions };
      } catch (e) {
        return { ok: false, error: errMsg(e), line, directions: [] };
      }
    },
  }),

  queryLineRealtime: defineAction({
    description:
      "查某条线路在某个站的双向实时到站：每辆车剩几站、约几分钟到、预计到站时刻，并标出每个方向的下一站。站名可模糊，会先智能匹配该线路实际停靠的站。同一查询 90 秒内走服务端缓存不调接口，forceRefresh=true 才强制重新调用。",
    request: z.object({
      line: z.string().min(1).max(20),
      station: z.string().min(1).max(40),
      city: z.string().max(20).optional(),
      forceRefresh: z.boolean().optional(),
    }),
    response: lineRealtimeResponse,
    privileged: [privileged.apizeroCall],
    async handler(ctx, args): Promise<z.infer<typeof lineRealtimeResponse>> {
      const city = cityOf(args.city);
      const line = normalizeLine(args.line);
      const keyword = args.station.trim();
      const cacheKey = `rt|${city}|${line}|${keyword}`;
      if (!args.forceRefresh) {
        const hit =
          cacheGet<z.infer<typeof lineRealtimeResponse>>(cacheKey);
        if (hit) return { ...hit, cached: true };
      }
      const empty = {
        ok: false,
        line,
        station: "",
        queriedAt: nowHm(),
        cached: false,
        directions: [] as z.infer<typeof dirRealtimeSchema>[],
      };
      try {
        const station = await findStationForLine(ctx, city, line, keyword);
        if (!station) {
          return {
            ...empty,
            error: `找不到「${line}」停靠的「${keyword}」站`,
          };
        }
        const directions: z.infer<typeof dirRealtimeSchema>[] = [];
        for (const direction of [1, 2]) {
          try {
            const hit = await queryDirection(ctx, city, station, direction, line);
            if (hit) {
              // 下一站由该方向站点序推得（站点序长缓存，不额外烧额度）
              const stops = await getLineStops(ctx, city, line, direction, true);
              directions.push({ ...hit, nextStop: nextStopOf(stops, station) });
            }
          } catch (e) {
            directions.push({
              direction,
              terminal: "",
              nextStop: "",
              firstTime: "",
              lastTime: "",
              price: "",
              error: errMsg(e),
              buses: [],
            });
          }
        }
        if (directions.length === 0) {
          return {
            ...empty,
            station,
            error: `「${line}」目前在「${station}」没有查到数据`,
          };
        }
        const result: z.infer<typeof lineRealtimeResponse> = {
          ok: true,
          error: "",
          line,
          station,
          queriedAt: nowHm(),
          cached: false,
          directions,
        };
        // 全部方向都失败的结果不进缓存，避免把短暂故障缓存 90 秒
        if (directions.some((d) => !d.error)) cacheSet(cacheKey, result);
        return result;
      } catch (e) {
        return { ...empty, error: errMsg(e) };
      }
    },
  }),

  searchStations: defineAction({
    description: "按关键词搜索某城市公交官方站名，返回相关站点列表。city 缺省为厦门。",
    request: z.object({
      keyword: z.string().min(1).max(40),
      city: z.string().max(20).optional(),
    }),
    response: stationsResponse,
    privileged: [privileged.apizeroCall],
    async handler(ctx, args): Promise<z.infer<typeof stationsResponse>> {
      try {
        const data = await apizero(ctx, {
          type: "stations",
          city: cityOf(args.city),
          station: args.keyword.trim(),
        });
        const stations = arr(data.stations)
          .map((s) => {
            const r = rec(s);
            return { name: str(r.name), kind: str(r.kind) };
          })
          .filter((s) => s.name !== "");
        return { ok: true, error: "", stations };
      } catch (e) {
        return { ok: false, error: errMsg(e), stations: [] };
      }
    },
  }),

  queryStationArrivals: defineAction({
    description:
      "查某个站双向所有经过线路的实时到站（每条线路的车辆剩几站、约几分钟到）；线路站点序已在缓存中时同时标出下一站。同一站 90 秒内走服务端缓存不调接口，forceRefresh=true 才强制重新调用。",
    request: z.object({
      station: z.string().min(1).max(40),
      city: z.string().max(20).optional(),
      forceRefresh: z.boolean().optional(),
    }),
    response: stationArrivalsResponse,
    privileged: [privileged.apizeroCall],
    async handler(
      ctx,
      args,
    ): Promise<z.infer<typeof stationArrivalsResponse>> {
      const city = cityOf(args.city);
      const station = args.station.trim();
      const cacheKey = `sa|${city}|${station}`;
      if (!args.forceRefresh) {
        const hit =
          cacheGet<z.infer<typeof stationArrivalsResponse>>(cacheKey);
        if (hit) return { ...hit, cached: true };
      }
      const base = {
        station,
        queriedAt: nowHm(),
        cached: false,
        directions: [] as z.infer<typeof stationArrivalsResponse>["directions"],
      };
      try {
        const directions: z.infer<typeof stationArrivalsResponse>["directions"] =
          [];
        for (const direction of [1, 2]) {
          try {
            const data = await apizero(ctx, {
              type: "query",
              city,
              station,
              direction,
            });
            const lines: z.infer<
              typeof stationArrivalsResponse
            >["directions"][number]["lines"] = [];
            for (const raw of arr(data.lines)) {
              const ln = rec(raw);
              const lineName = str(ln.line);
              // 下一站只读站点序长缓存（不为标注额外调接口），有缓存才标
              const stops = lineName
                ? await getLineStops(ctx, city, lineName, direction, false)
                : null;
              lines.push({
                line: lineName,
                terminal: str(ln.terminal),
                nextStop: nextStopOf(stops, station),
                price: str(ln.price),
                firstTime: str(ln.first_time),
                lastTime: str(ln.last_time),
                buses: arr(ln.buses).map(toBus),
              });
            }
            directions.push({ direction, error: "", lines });
          } catch (e) {
            directions.push({ direction, error: errMsg(e), lines: [] });
          }
        }
        const result: z.infer<typeof stationArrivalsResponse> = {
          ok: true,
          error: "",
          ...base,
          directions,
        };
        // 全部方向都失败的结果不进缓存，避免把短暂故障缓存 90 秒
        if (directions.some((d) => !d.error)) cacheSet(cacheKey, result);
        return result;
      } catch (e) {
        return { ok: false, error: errMsg(e), ...base };
      }
    },
  }),

  findNearbyStations: defineAction({
    description:
      "按经纬度用高德周边搜索找最近的公交站点（types=150700），按距离升序返回最多 10 个，含距离米数与经过线路。",
    request: z.object({
      lng: z.number().min(110).max(125),
      lat: z.number().min(20).max(30),
    }),
    response: nearbyStationsResponse,
    privileged: [privileged.amapGet],
    async handler(ctx, args): Promise<z.infer<typeof nearbyStationsResponse>> {
      try {
        const data = await amap(ctx, "/v3/place/around", {
          location: `${args.lng},${args.lat}`,
          types: "150700",
          radius: "1500",
          sortrule: "distance",
          offset: "15",
          page: "1",
        });
        if (str(data.status) !== "1") {
          return {
            ok: false,
            error: `附近站点搜索失败：${str(data.info) || "未知错误"}`,
            stations: [],
          };
        }
        const stations: z.infer<typeof nearbyStationsResponse>["stations"] =
          [];
        const seen = new Set<string>();
        for (const raw of arr(data.pois)) {
          const p = rec(raw);
          // POI 名形如「福泽园(公交站)」，去掉后缀即公交官方站名
          const name = str(p.name)
            .replace(/[（(]公交站[）)]\s*$/, "")
            .trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const loc = str(p.location);
          const [lngS, latS] = loc.includes(",")
            ? loc.split(",")
            : ["", ""];
          stations.push({
            name,
            distance: numOrNull(p.distance) ?? 0,
            lines: str(p.address),
            lng: Number(lngS) || 0,
            lat: Number(latS) || 0,
          });
          if (stations.length >= 10) break;
        }
        return { ok: true, error: "", stations };
      } catch (e) {
        return { ok: false, error: errMsg(e), stations: [] };
      }
    },
  }),

  planRoute: defineAction({
    description:
      "规划某城市市内公交/地铁换乘路线：输入起点和终点地名，返回多套方案（时长、步行距离、票价、逐段乘车说明），并按时间+步行+换乘综合标出最优方案。city 缺省为厦门。",
    request: z.object({
      origin: z.string().min(1).max(60),
      destination: z.string().min(1).max(60),
      city: z.string().max(20).optional(),
    }),
    response: routePlanResponse,
    privileged: [privileged.amapGet],
    async handler(ctx, args): Promise<z.infer<typeof routePlanResponse>> {
      const city = cityOf(args.city);
      try {
        const o = await geocode(ctx, city, args.origin.trim());
        const d = await geocode(ctx, city, args.destination.trim());
        if (!o || !d) {
          return { ok: false, error: "无法定位起点或终点", plans: [] };
        }
        const data = await amap(ctx, "/v3/direction/transit/integrated", {
          origin: `${o.lng},${o.lat}`,
          destination: `${d.lng},${d.lat}`,
          city,
          cityd: city,
          strategy: "0",
          nightflag: "0",
        });
        if (str(data.status) !== "1") {
          return {
            ok: false,
            error: `规划失败：${str(data.info) || "未知错误"}`,
            plans: [],
          };
        }
        const transits = arr(rec(data.route).transits);
        if (transits.length === 0) {
          return { ok: false, error: "没有找到公交/地铁方案", plans: [] };
        }
        const plans = transits.map((raw) => {
          const t = rec(raw);
          const durationSec = numOrNull(t.duration) ?? 0;
          const walking = numOrNull(t.walking_distance) ?? 0;
          const segments: z.infer<typeof routePlanResponse>["plans"][number]["segments"] =
            [];
          for (const segRaw of arr(t.segments)) {
            const seg = rec(segRaw);
            if ("bus" in seg) {
              const buslines = arr(rec(seg.bus).buslines);
              const bl = rec(buslines[0]);
              if (buslines.length > 0) {
                const name = str(bl.name);
                segments.push({
                  type: str(bl.type) || "公交",
                  name: name.includes("(")
                    ? (name.split("(")[0] ?? name).trim()
                    : name,
                  departure: str(rec(bl.departure_stop).name),
                  arrival: str(rec(bl.arrival_stop).name),
                  walkDistance: "",
                });
              }
            } else if ("walking" in seg) {
              segments.push({
                type: "步行",
                name: "",
                departure: "",
                arrival: "",
                walkDistance: str(rec(seg.walking).distance),
              });
            }
          }
          const rides = segments.filter((s) => s.type !== "步行").length;
          const score =
            Math.floor(durationSec / 60) +
            walking / 100 +
            Math.max(0, rides - 1) * 3;
          return {
            durationMin: Math.round(durationSec / 60),
            walking,
            distance: numOrNull(t.distance) ?? 0,
            cost: str(t.cost),
            best: false,
            segments,
            score,
          };
        });
        let bestIdx = 0;
        plans.forEach((p, i) => {
          if (p.score < (plans[bestIdx]?.score ?? Infinity)) bestIdx = i;
        });
        return {
          ok: true,
          error: "",
          plans: plans.map((p, i) => ({
            durationMin: p.durationMin,
            walking: p.walking,
            distance: p.distance,
            cost: p.cost,
            best: i === bestIdx,
            segments: p.segments,
          })),
        };
      } catch (e) {
        return { ok: false, error: errMsg(e), plans: [] };
      }
    },
  }),

  getMetroLines: defineAction({
    description:
      "列出某城市的地铁线路（名称、起讫、首末班、发车间隔）。厦门用内置数据；其他城市由高德公交线路检索实时整理并在服务端缓存 7 天。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: metroLinesResponse,
    privileged: [privileged.amapGet],
    async handler(ctx, args): Promise<z.infer<typeof metroLinesResponse>> {
      const city = cityOf(args.city);
      if (city === DEFAULT_CITY) {
        return { ok: true, error: "", city, source: "builtin", lines: XIAMEN_METRO };
      }
      const cacheKey = `${METRO_CACHE_VERSION}|${city}`;
      const hit = metroCache.get(cacheKey);
      if (hit && Date.now() <= hit.expiresAt) {
        return { ok: true, error: "", city, source: "amap", lines: hit.value };
      }
      if (hit) metroCache.delete(cacheKey);
      try {
        const { lines, degraded, apiError } = await fetchMetroLines(ctx, city);
        // 检索被接口拒绝且一条都没拿到：如实报错让用户稍后重试，
        // 不把「接口超限」伪装成「这个城市没有地铁」
        if (lines.length === 0 && degraded) {
          return {
            ok: false,
            error: `地铁数据暂时拉不到：高德接口拒绝了请求（${apiError || "未知原因"}），可能是今日调用次数已达上限，请稍后再试`,
            city,
            source: "amap",
            lines: [],
          };
        }
        // 残缺列表不进缓存：下次打开重新拉齐；完整的才缓存 7 天
        if (!degraded) {
          metroCache.set(cacheKey, {
            expiresAt:
              Date.now() +
              (lines.length > 0 ? METRO_CACHE_TTL_MS : METRO_EMPTY_TTL_MS),
            value: lines,
          });
        }
        return { ok: true, error: "", city, source: "amap", lines };
      } catch (e) {
        return { ok: false, error: errMsg(e), city, source: "amap", lines: [] };
      }
    },
  }),

  listFavorites: defineAction({
    description: "列出用户在某城市收藏的常用线路、站点和线路+站点组合。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: favoritesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritesResponse>> {
      return listFavorites(ctx, cityOf(args.city));
    },
  }),

  addFavorite: defineAction({
    description: "给某城市添加一条收藏：kind 为 line（线路）、station（站点）或 lineStation（某线路在某站）。city 缺省为厦门。",
    request: z.object({
      kind: z.enum(["line", "station", "lineStation"]),
      value: z.string().min(1).max(40),
      label: z.string().min(1).max(40),
      city: z.string().max(20).optional(),
    }),
    response: favoritesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritesResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      const value =
        args.kind === "station" ? args.value.trim() : normalizeLine(args.value);
      const label =
        args.kind === "line" ? value : args.label.trim();
      const existing = await db
        .select()
        .from(schema.favorites)
        .where(
          and(
            eq(schema.favorites.city, city),
            eq(schema.favorites.kind, args.kind),
            eq(schema.favorites.value, value),
            eq(schema.favorites.label, label),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        await db
          .insert(schema.favorites)
          .values({ city, kind: args.kind, value, label });
      }
      return listFavorites(ctx, city);
    },
  }),

  removeFavorite: defineAction({
    description: "删除一条收藏，返回该城市剩余的收藏列表。",
    request: z.object({
      id: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: favoritesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritesResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.favorites)
        .where(eq(schema.favorites.id, args.id));
      return listFavorites(ctx, cityOf(args.city));
    },
  }),

  listFavoriteRoutes: defineAction({
    description: "列出用户在某城市收藏的常用路线（起点+终点组合）。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: favoriteRoutesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoriteRoutesResponse>> {
      return listFavoriteRoutes(ctx, cityOf(args.city));
    },
  }),

  addFavoriteRoute: defineAction({
    description:
      "把某城市的一组起点+终点存为常用路线，名称自动用「起点 → 终点」，重复添加自动去重。city 缺省为厦门。",
    request: z.object({
      origin: z.string().min(1).max(60),
      destination: z.string().min(1).max(60),
      city: z.string().max(20).optional(),
    }),
    response: favoriteRoutesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoriteRoutesResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      const origin = args.origin.trim();
      const destination = args.destination.trim();
      const existing = await db
        .select()
        .from(schema.favoriteRoutes)
        .where(
          and(
            eq(schema.favoriteRoutes.city, city),
            eq(schema.favoriteRoutes.origin, origin),
            eq(schema.favoriteRoutes.destination, destination),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        await db.insert(schema.favoriteRoutes).values({
          city,
          origin,
          destination,
          label: `${origin} → ${destination}`,
        });
      }
      return listFavoriteRoutes(ctx, city);
    },
  }),

  removeFavoriteRoute: defineAction({
    description: "删除一条常用路线收藏，返回该城市剩余的常用路线列表。",
    request: z.object({
      id: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: favoriteRoutesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoriteRoutesResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.favoriteRoutes)
        .where(eq(schema.favoriteRoutes.id, args.id));
      return listFavoriteRoutes(ctx, cityOf(args.city));
    },
  }),
} satisfies ActionsModule;
