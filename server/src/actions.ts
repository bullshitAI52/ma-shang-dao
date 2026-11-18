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
import { and, desc, eq, or } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const DEFAULT_CITY = "厦门";

/** 客户端传来的城市名（缺省/空白时回落到厦门，保持原有行为）。 */
function cityOf(v: string | undefined): string {
  const t = (v ?? "").trim().replace(/\s+/g, "");
  return t || DEFAULT_CITY;
}

// ---------- 设置（settings 表） ----------
// API key 取用顺序：设置页里存的 key 优先，没有再回退主机上的 key
// 文件（~/.apizero_key、~/.amap_key，由 privileged 读）。key 只存
// 服务端，对前端只回来源状态与末 4 位掩码，绝不回完整值。

const SETTING_APIZERO_KEY = "apizero_key";
const SETTING_AMAP_KEY = "amap_key";
const SETTING_DEFAULT_CITY = "default_city";
const SETTING_CACHE_TTL = "cache_ttl_sec";

const CACHE_TTL_CHOICES = [60, 90, 120, 180];
const DEFAULT_CACHE_TTL_SEC = 90;

async function getSetting(ctx: Ctx, key: string): Promise<string> {
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .limit(1);
    return rows[0]?.value ?? "";
  } catch {
    return "";
  }
}

async function setSetting(ctx: Ctx, key: string, value: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: new Date() },
    });
}

async function deleteSetting(ctx: Ctx, key: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
}

/** 设置页里存的 apizero key（没有返回空串，privileged 会回退读文件）。 */
async function uiApizeroKey(ctx: Ctx): Promise<string> {
  return (await getSetting(ctx, SETTING_APIZERO_KEY)).trim();
}
async function uiAmapKey(ctx: Ctx): Promise<string> {
  return (await getSetting(ctx, SETTING_AMAP_KEY)).trim();
}

/** 当前生效的实时查询缓存秒数（设置值不在预设档位时回落 90）。 */
async function cacheTtlSec(ctx: Ctx): Promise<number> {
  const n = Number(await getSetting(ctx, SETTING_CACHE_TTL));
  return CACHE_TTL_CHOICES.includes(n) ? n : DEFAULT_CACHE_TTL_SEC;
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

// 北京时间（Asia/Shanghai）「H:MM」：小时不补零，如「7:20」。服务端
// 运行环境时区不一定是北京，凡是时刻显示一律显式按 Asia/Shanghai 换算，
// 不用运行环境的本地时区。
const bjTimeFmt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function beijingHm(d: Date): string {
  const parts = bjTimeFmt.formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  const min = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${Number(h) % 24}:${min.padStart(2, "0")}`;
}

// 接口的 arrival_time 归一成北京时间「H:MM」：
// - 带时区的 ISO 时刻 → 显式按 Asia/Shanghai 换算
// - 「2026-08-30 07:20」这类无时区字符串是接口给的北京时间墙钟时间，
//   直接取时刻部分并去掉小时的前导零（07:20 → 7:20）
// - 纯「07:20」同上
function beijingArrivalHm(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/T.*(Z|[+-]\d{2}:?\d{2})\s*$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return beijingHm(d);
  }
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${Number(m[1])}:${m[2]}`;
  return s;
}

function toBus(raw: unknown): Bus {
  const b = rec(raw);
  return {
    busId: str(b.bus_id),
    stopsRemaining: numOrNull(b.stops_remaining),
    travelMinutes: numOrNull(b.travel_minutes),
    arrivalTime: beijingArrivalHm(str(b.arrival_time)),
  };
}

// ---------- upstream calls (through privileged host functions) ----------

async function apizero(
  ctx: Ctx,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await ctx.executePrivileged(privileged.apizeroCall, {
    paramsJson: JSON.stringify(params),
    keyOverride: await uiApizeroKey(ctx),
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
    keyOverride: await uiAmapKey(ctx),
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
// apizero 免费额度很小：实时查询结果缓存一段时间（默认 90 秒，设置页
// 可调 60/90/120/180 秒），同一查询在缓存期内重复请求直接返回缓存、
// 不再调用接口；只有客户端显式「强制刷新」才绕过缓存。缓存时长在写入
// 时按当前设置取值，改设置后新写入的条目即按新时长生效。
// 线路站点序几乎不变，缓存 12 小时，仅用于推导「下一站」，不额外烧额度。

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
async function cacheSet(ctx: Ctx, key: string, value: unknown): Promise<void> {
  const ttlMs = (await cacheTtlSec(ctx)) * 1000;
  queryCache.set(key, { expiresAt: Date.now() + ttlMs, value });
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
      // 顺带沉淀进点选缓存：这条线的站序与终点站以后可直接点选
      await rememberLineInfo(ctx, city, line, {
        directionStops: { direction, stops },
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

// ---------- 线路点选缓存（终点站/站序沉淀，尽量不打字） ----------
// 画布到站卡选方向/站名时要「点选不要打字」，选项不能现查 apizero
// （额度金贵）。办法：凡是别处已经查到过的线路信息——查线路详情与
// 站序、实时结果自带的终点站、规划方案带的终点站、高德线路检索的
// 起讫站、用户手填过的终点站/站名——都按「城市+线路」沉淀进
// line_pick_cache 表，下次同线路直接可选。沉淀失败不挡主流程。

type LineInfo = {
  terminals: string[];
  stops1: string[];
  stops2: string[];
  extraStations: string[];
};

function parseStrArr(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x !== "")
      : [];
  } catch {
    return [];
  }
}

function mergeNames(base: string[], add: string[], cap: number): string[] {
  const out = [...base];
  for (const n of add) {
    const t = n.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, cap);
}

async function readLineInfo(
  ctx: Ctx,
  city: string,
  line: string,
): Promise<LineInfo> {
  const empty: LineInfo = {
    terminals: [],
    stops1: [],
    stops2: [],
    extraStations: [],
  };
  if (!line) return empty;
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db
      .select()
      .from(schema.linePickCache)
      .where(
        and(
          eq(schema.linePickCache.city, city),
          eq(schema.linePickCache.line, line),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r) return empty;
    return {
      terminals: parseStrArr(r.terminalsJson),
      stops1: parseStrArr(r.stops1Json),
      stops2: parseStrArr(r.stops2Json),
      extraStations: parseStrArr(r.extraStationsJson),
    };
  } catch {
    return empty;
  }
}

/** 把新查到/用户填入的线路信息合并进点选缓存（有更新才写库）。 */
async function rememberLineInfo(
  ctx: Ctx,
  city: string,
  line: string,
  patch: {
    terminals?: string[];
    directionStops?: { direction: number; stops: string[] };
    extraStations?: string[];
  },
): Promise<void> {
  if (!line) return;
  try {
    const cur = await readLineInfo(ctx, city, line);
    const next: LineInfo = {
      terminals: patch.terminals
        ? mergeNames(cur.terminals, patch.terminals, 6)
        : cur.terminals,
      stops1:
        patch.directionStops?.direction === 1 &&
        patch.directionStops.stops.length > 0
          ? patch.directionStops.stops
          : cur.stops1,
      stops2:
        patch.directionStops?.direction === 2 &&
        patch.directionStops.stops.length > 0
          ? patch.directionStops.stops
          : cur.stops2,
      extraStations: patch.extraStations
        ? mergeNames(cur.extraStations, patch.extraStations, 80)
        : cur.extraStations,
    };
    // 站序的首末站本身就是两个终点站，一并沉淀
    for (const stops of [next.stops1, next.stops2]) {
      if (stops.length > 0) {
        next.terminals = mergeNames(
          next.terminals,
          [stops[0] ?? "", stops[stops.length - 1] ?? ""],
          6,
        );
      }
    }
    if (
      JSON.stringify(next) ===
      JSON.stringify({
        terminals: cur.terminals,
        stops1: cur.stops1,
        stops2: cur.stops2,
        extraStations: cur.extraStations,
      })
    ) {
      return;
    }
    const db = ctx.db<typeof schema>();
    const values = {
      city,
      line,
      terminalsJson: JSON.stringify(next.terminals),
      stops1Json: JSON.stringify(next.stops1),
      stops2Json: JSON.stringify(next.stops2),
      extraStationsJson: JSON.stringify(next.extraStations),
      updatedAt: new Date(),
    };
    await db
      .insert(schema.linePickCache)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.linePickCache.city, schema.linePickCache.line],
        set: {
          terminalsJson: values.terminalsJson,
          stops1Json: values.stops1Json,
          stops2Json: values.stops2Json,
          extraStationsJson: values.extraStationsJson,
          updatedAt: values.updatedAt,
        },
      });
  } catch {
    // 沉淀只是锦上添花，失败不影响查询主流程
  }
}

/**
 * 高德线路检索兜底（不耗 apizero 额度）：按线路名查 /v3/bus/linename，
 * 基础名与目标线路完全一致的条目取起讫站作终点站、busstops 作站序。
 * 高德返回双向两条，顺序不保证与 apizero 方向号一致——点选场景只
 * 需要「有哪些终点站/站点」，方向号仍按终点站名匹配，不受影响。
 */
async function amapLineInfo(
  ctx: Ctx,
  city: string,
  line: string,
): Promise<LineInfo | null> {
  try {
    const d = await amap(ctx, "/v3/bus/linename", {
      keywords: line,
      city,
      extensions: "all",
      offset: "25",
      page: "1",
    });
    if (str(d.status) !== "1") return null;
    const info: LineInfo = {
      terminals: [],
      stops1: [],
      stops2: [],
      extraStations: [],
    };
    let dirIdx = 0;
    for (const raw of arr(d.buslines)) {
      const b = rec(raw);
      const full = str(b.name);
      const base = (full.split(/[(（]/)[0] ?? full).trim();
      if (base !== line) continue;
      info.terminals = mergeNames(
        info.terminals,
        [str(b.start_stop), str(b.end_stop)],
        6,
      );
      const stops = arr(b.busstops)
        .map((s) => str(rec(s).name))
        .filter((n) => n !== "");
      if (stops.length > 0 && dirIdx === 0 && info.stops1.length === 0) {
        info.stops1 = stops;
        dirIdx = 1;
      } else if (stops.length > 0 && info.stops2.length === 0) {
        info.stops2 = stops;
      }
    }
    if (info.terminals.length === 0 && info.stops1.length === 0) return null;
    return info;
  } catch {
    return null;
  }
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

// 画布到站卡「点选」用的选项：某线路已知的终点站（方向二选一）、
// 站序（点选站名）与最近用过的线路（点选线路 chips）。全部来自服务
// 端沉淀缓存/站序缓存/高德线路检索，不调 apizero。
const linePickOptionsResponse = z.object({
  terminals: z.array(z.string()),
  stops: z.array(z.string()),
  recentLines: z.array(z.string()),
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

// 「我的站牌」打开时只读服务端缓存里的快照：有缓存的卡先显示缓存，
// 没缓存的卡返回 null 让前端显示「点查」，全程不调用上游接口。
const boardSnapshotResponse = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      realtime: lineRealtimeResponse.nullable(),
      arrivals: stationArrivalsResponse.nullable(),
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
          // 该段行进方向的终点站：从高德线路名括号里「(起点--终点)」
          // 解析，取行进方向那一头；解析不到为空串。转画布时用它定
          // 方向，不用再额外调实时接口。
          terminal: z.string(),
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

const favoritePlacesResponse = z.object({
  places: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      address: z.string(),
    }),
  ),
});

// 换乘步行时间：用户按「城市 + 换乘站名 + 接驳线路」手动设的分钟数。
const transferWalkTimesResponse = z.object({
  items: z.array(
    z.object({
      station: z.string(),
      nextLine: z.string(),
      minutes: z.number(),
    }),
  ),
});

// ---------- 画布（到站模块 + 文本模块 + 连线，按城市隔离） ----------
// 模块位置（x/y 世界坐标）、字段与连线都存服务端；连线只表达路线
// 关系，不触发任何查询。厦门画布首次打开（为空且从未初始化）时按
// 用户手绘草图一次性预置种子，方向一律用线路站序实查判定，判定不
// 了的模块宁缺勿错、先不预置；种子标记存 settings，删空不补回。

const canvasResponse = z.object({
  modules: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      line: z.string(),
      station: z.string(),
      direction: z.number(),
      terminal: z.string(),
      text: z.string(),
      note: z.string(),
      enabled: z.boolean(),
      x: z.number(),
      y: z.number(),
    }),
  ),
  links: z.array(
    z.object({ id: z.number(), fromId: z.number(), toId: z.number() }),
  ),
});

async function listCanvas(
  ctx: Ctx,
  city: string,
): Promise<z.infer<typeof canvasResponse>> {
  const db = ctx.db<typeof schema>();
  const mods = await db
    .select()
    .from(schema.canvasModules)
    .where(eq(schema.canvasModules.city, city))
    .orderBy(schema.canvasModules.id)
    .limit(200);
  const lnks = await db
    .select()
    .from(schema.canvasLinks)
    .where(eq(schema.canvasLinks.city, city))
    .orderBy(schema.canvasLinks.id)
    .limit(400);
  return {
    modules: mods.map((m) => ({
      id: m.id,
      kind: m.kind,
      line: m.line,
      station: m.station,
      direction: m.direction,
      terminal: m.terminal,
      text: m.text,
      note: m.note,
      enabled: m.enabled !== 0,
      x: m.x,
      y: m.y,
    })),
    links: lnks.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId })),
  };
}

const CANVAS_SEED_KEY_PREFIX = "canvas_seeded:";

/**
 * 按站序判定方向：某方向的站点序里，上车站在前、其后有站名含 marker
 * 的站，这个方向就是要的方向；终点站取该方向站点序的最后一站。
 * 两个方向都判定不了返回 null（调用方宁缺勿错，不预置该模块）。
 */
async function seedDirection(
  ctx: Ctx,
  city: string,
  line: string,
  station: string,
  marker: string,
): Promise<{ direction: number; terminal: string } | null> {
  for (const direction of [1, 2]) {
    const stops = await getLineStops(ctx, city, line, direction, true);
    if (!stops || stops.length === 0) continue;
    const si = stops.indexOf(station);
    if (si < 0) continue;
    if (!stops.slice(si + 1).some((s) => s.includes(marker))) continue;
    return { direction, terminal: stops[stops.length - 1] ?? "" };
  }
  return null;
}

/** 厦门画布种子：草图里的 4 个到站模块 + 马厝/同安中心文本模块 + 连线。 */
async function maybeSeedCanvas(ctx: Ctx, city: string): Promise<void> {
  if (city !== DEFAULT_CITY) return;
  try {
    const db = ctx.db<typeof schema>();
    const existing = await db
      .select({ id: schema.canvasModules.id })
      .from(schema.canvasModules)
      .where(eq(schema.canvasModules.city, city))
      .limit(1);
    if (existing.length > 0) return;
    if (await getSetting(ctx, `${CANVAS_SEED_KEY_PREFIX}${city}`)) return;

    const specs = [
      { line: "33路", station: "长虹路", marker: "西浦路口", x: 330, y: 30 },
      { line: "24路", station: "西浦路口", marker: "马厝", x: 570, y: 250 },
      { line: "103路", station: "西浦路口", marker: "同安", x: 300, y: 250 },
      { line: "752路", station: "西浦路口", marker: "同安", x: 30, y: 250 },
    ];
    const insertModule = async (
      values: typeof schema.canvasModules.$inferInsert,
    ): Promise<number | null> => {
      const rows = await db
        .insert(schema.canvasModules)
        .values(values)
        .returning({ id: schema.canvasModules.id });
      return rows[0]?.id ?? null;
    };
    const ids: (number | null)[] = [];
    for (const s of specs) {
      const dir = await seedDirection(ctx, city, s.line, s.station, s.marker);
      if (!dir) {
        ids.push(null);
        continue;
      }
      ids.push(
        await insertModule({
          city,
          kind: "station",
          line: s.line,
          station: s.station,
          direction: dir.direction,
          terminal: dir.terminal,
          x: s.x,
          y: s.y,
        }),
      );
    }
    if (!ids.some((v) => v != null)) {
      // 一个方向都没判定出来（多半是接口暂不可用）：不落种子标记，
      // 下次打开画布再试，不把空画布当成已初始化。
      return;
    }
    let maCuoId: number | null = null;
    if (ids[1]) {
      maCuoId = await insertModule({
        city,
        kind: "text",
        text: "马厝",
        x: 570,
        y: 490,
      });
    }
    let tongAnId: number | null = null;
    if (ids[2] || ids[3]) {
      tongAnId = await insertModule({
        city,
        kind: "text",
        text: "同安中心",
        x: 165,
        y: 490,
      });
    }
    const idAt = (i: number): number | null => ids[i] ?? null;
    const linkPairs: [number | null, number | null][] = [
      [idAt(0), idAt(1)],
      [idAt(0), idAt(2)],
      [idAt(0), idAt(3)],
      [idAt(1), maCuoId],
      [idAt(2), tongAnId],
      [idAt(3), tongAnId],
    ];
    for (const [a, b] of linkPairs) {
      if (a && b) {
        await db
          .insert(schema.canvasLinks)
          .values({ city, fromId: a, toId: b });
      }
    }
    await setSetting(ctx, `${CANVAS_SEED_KEY_PREFIX}${city}`, "1");
  } catch {
    // 种子失败不挡画布打开：用户仍可自己一个个加模块
  }
}

async function listTransferWalkTimes(
  ctx: Ctx,
  city: string,
): Promise<z.infer<typeof transferWalkTimesResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.transferWalkTimes)
    .where(eq(schema.transferWalkTimes.city, city))
    .limit(200);
  return {
    items: rows.map((r) => ({
      station: r.station,
      nextLine: r.nextLine,
      minutes: r.minutes,
    })),
  };
}

// 行程段：规划方案的段富化后的样子。stops 是按行进方向切出的
// 上车站→下车站站点序（含两端），拿不到站点序时为空数组、stopCount
// 为 null，页面如实显示「站数未知」，不编造。
const tripSegmentSchema = z.object({
  type: z.string(),
  name: z.string(),
  departure: z.string(),
  arrival: z.string(),
  walkDistance: z.string(),
  stops: z.array(z.string()),
  stopCount: z.number().nullable(),
  terminal: z.string(),
});
type TripSegment = z.infer<typeof tripSegmentSchema>;

const activeTripResponse = z.object({
  trip: z
    .object({
      city: z.string(),
      origin: z.string(),
      destination: z.string(),
      segments: z.array(tripSegmentSchema),
      currentIndex: z.number(),
      phase: z.enum(["waiting", "riding"]),
      finished: z.boolean(),
    })
    .nullable(),
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

// ---------- 设置页 ----------

const keyStatusSchema = z.object({
  // ui = 设置页里存的；file = 服务器密钥文件；none = 都没有
  source: z.enum(["ui", "file", "none"]),
  // 生效中的 key 末 4 位（前端拼成 ••••xxxx 显示），未设置为空串
  suffix: z.string(),
});

const settingsResponse = z.object({
  apizero: keyStatusSchema,
  amap: keyStatusSchema,
  defaultCity: z.string(),
  cacheTtlSec: z.number(),
});

const testKeyResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
});

/** 汇总设置页要展示的全部状态：key 只回来源与末 4 位，绝不回完整值。 */
async function buildSettings(
  ctx: Ctx,
): Promise<z.infer<typeof settingsResponse>> {
  const [uiA, uiM, fileStatus, ttl] = await Promise.all([
    uiApizeroKey(ctx),
    uiAmapKey(ctx),
    ctx
      .executePrivileged(privileged.keyFileStatus, {})
      .catch(() => ({
        apizeroSet: false,
        apizeroSuffix: "",
        amapSet: false,
        amapSuffix: "",
      })),
    cacheTtlSec(ctx),
  ]);
  const status = (
    uiKey: string,
    fileSet: boolean,
    fileSuffix: string,
  ): z.infer<typeof keyStatusSchema> => {
    if (uiKey) return { source: "ui", suffix: uiKey.slice(-4) };
    if (fileSet) return { source: "file", suffix: fileSuffix };
    return { source: "none", suffix: "" };
  };
  return {
    apizero: status(uiA, fileStatus.apizeroSet, fileStatus.apizeroSuffix),
    amap: status(uiM, fileStatus.amapSet, fileStatus.amapSuffix),
    defaultCity: (await getSetting(ctx, SETTING_DEFAULT_CITY)).trim(),
    cacheTtlSec: ttl,
  };
}

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

async function listFavoritePlaces(
  ctx: Ctx,
  city: string,
): Promise<z.infer<typeof favoritePlacesResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.favoritePlaces)
    .where(eq(schema.favoritePlaces.city, city))
    .orderBy(desc(schema.favoritePlaces.id))
    .limit(50);
  return {
    places: rows.map((r) => ({ id: r.id, name: r.name, address: r.address })),
  };
}

async function loadActiveTrip(
  ctx: Ctx,
): Promise<z.infer<typeof activeTripResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.activeTrip)
    .where(eq(schema.activeTrip.id, 1))
    .limit(1);
  const row = rows[0];
  if (!row) return { trip: null };
  let segments: TripSegment[] = [];
  try {
    const parsed: unknown = JSON.parse(row.segmentsJson || "[]");
    const checked = z.array(tripSegmentSchema).safeParse(parsed);
    if (checked.success) segments = checked.data;
  } catch {
    segments = [];
  }
  if (segments.length === 0) return { trip: null };
  return {
    trip: {
      city: row.city,
      origin: row.origin,
      destination: row.destination,
      segments,
      currentIndex: Math.min(Math.max(row.currentIndex, 0), segments.length - 1),
      phase: row.phase === "riding" ? "riding" : "waiting",
      finished: false,
    },
  };
}

/**
 * 给乘车段富化站点序：先只读 12 小时站点序缓存，两个方向都没命中才
 * 真调线路详情接口（先试方向 1，不含上下车站再试方向 2）。找到包含
 * 上车站与下车站（顺序不限，反向即倒序）的方向后，切出两站之间的
 * 站序（按行进方向排列）。找不到就留空，页面如实显示站数未知。
 */
async function enrichRideSegment(
  ctx: Ctx,
  city: string,
  seg: TripSegment,
): Promise<TripSegment> {
  const dep = seg.departure.trim();
  const arr = seg.arrival.trim();
  if (!dep || !arr || !seg.name) return seg;
  const sliceFrom = (stops: string[] | null): TripSegment | null => {
    if (!stops) return null;
    const i = stops.indexOf(dep);
    const j = stops.indexOf(arr);
    if (i < 0 || j < 0 || i === j) return null;
    const slice = i < j ? stops.slice(i, j + 1) : stops.slice(j, i + 1).reverse();
    return {
      ...seg,
      stops: slice,
      stopCount: slice.length - 1,
      terminal: i < j ? (stops[stops.length - 1] ?? "") : (stops[0] ?? ""),
    };
  };
  for (const dir of [1, 2]) {
    const hit = sliceFrom(await getLineStops(ctx, city, seg.name, dir, false));
    if (hit) return hit;
  }
  for (const dir of [1, 2]) {
    const hit = sliceFrom(await getLineStops(ctx, city, seg.name, dir, true));
    if (hit) return hit;
  }
  return seg;
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

// 数据时间与到站时刻同一口径：北京时间、小时不补零（「7:20」）
const nowHm = () => beijingHm(new Date());

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
          // 起讫站与站序沉淀进点选缓存，画布选方向/站名时可直接点
          await rememberLineInfo(ctx, city, line, {
            terminals: [str(d.start), str(d.end)],
            directionStops: {
              direction,
              stops: stops.filter((n) => n !== ""),
            },
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
      "查某条线路在某个站的双向实时到站：每辆车剩几站、约几分钟到、预计到站时刻，并标出每个方向的下一站。站名可模糊，会先智能匹配该线路实际停靠的站。同一查询在缓存时长内（设置页可调，默认 90 秒）走服务端缓存不调接口，forceRefresh=true 才强制重新调用。",
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
        // 全部方向都失败的结果不进缓存，避免把短暂故障存进缓存
        if (directions.some((d) => !d.error)) await cacheSet(ctx, cacheKey, result);
        // 实时结果自带的双向终点站与匹配到的官方站名沉淀进点选缓存
        await rememberLineInfo(ctx, city, line, {
          terminals: directions.map((d) => d.terminal),
          extraStations: [station],
        });
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
      "查某个站双向所有经过线路的实时到站（每条线路的车辆剩几站、约几分钟到）；线路站点序已在缓存中时同时标出下一站。同一站在缓存时长内（设置页可调，默认 90 秒）走服务端缓存不调接口，forceRefresh=true 才强制重新调用。",
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
        // 全部方向都失败的结果不进缓存，避免把短暂故障存进缓存
        if (directions.some((d) => !d.error)) await cacheSet(ctx, cacheKey, result);
        // 每条经过线路的终点站与本站名沉淀进点选缓存
        const seenLines = new Set<string>();
        for (const d of directions) {
          for (const ln of d.lines) {
            if (!ln.line || seenLines.has(ln.line)) continue;
            seenLines.add(ln.line);
            await rememberLineInfo(ctx, city, ln.line, {
              terminals: [ln.terminal],
              extraStations: [station],
            });
          }
        }
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
                // 高德线路名形如「33路(公园东门--高崎公交场站)」，
                // 括号里是该方向的起讫站，后一头就是行进方向终点站
                const paren = name.match(/[（(]([^（）()]*)[）)]/);
                const ends = (paren?.[1] ?? "")
                  .split("--")
                  .map((s) => s.trim())
                  .filter((s) => s !== "");
                segments.push({
                  type: str(bl.type) || "公交",
                  name: name.includes("(")
                    ? (name.split("(")[0] ?? name).trim()
                    : name,
                  departure: str(rec(bl.departure_stop).name),
                  arrival: str(rec(bl.arrival_stop).name),
                  walkDistance: "",
                  terminal:
                    ends.length >= 2 ? (ends[ends.length - 1] ?? "") : "",
                });
              }
            } else if ("walking" in seg) {
              segments.push({
                type: "步行",
                name: "",
                departure: "",
                arrival: "",
                walkDistance: str(rec(seg.walking).distance),
                terminal: "",
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

  getBoardSnapshot: defineAction({
    description:
      "「我的站牌」打开时读取收藏条目在服务端缓存里的已有结果：只读缓存、绝不调用上游接口；某条没有缓存时该条返回 null，前端显示「点查」由用户逐卡刷新。",
    request: z.object({
      city: z.string().max(20).optional(),
      items: z
        .array(
          z.object({
            id: z.number().int().positive(),
            kind: z.enum(["lineStation", "station"]),
            value: z.string().min(1).max(40),
            label: z.string().min(1).max(40),
          }),
        )
        .max(50),
    }),
    response: boardSnapshotResponse,
    async handler(ctx, args): Promise<z.infer<typeof boardSnapshotResponse>> {
      void ctx;
      const city = cityOf(args.city);
      const entries = args.items.map((it) => {
        if (it.kind === "lineStation") {
          const key = `rt|${city}|${normalizeLine(it.value)}|${it.label.trim()}`;
          const hit = cacheGet<z.infer<typeof lineRealtimeResponse>>(key);
          return {
            id: it.id,
            realtime: hit && hit.ok ? { ...hit, cached: true } : null,
            arrivals: null,
          };
        }
        const key = `sa|${city}|${it.label.trim()}`;
        const hit = cacheGet<z.infer<typeof stationArrivalsResponse>>(key);
        return {
          id: it.id,
          realtime: null,
          arrivals: hit && hit.ok ? { ...hit, cached: true } : null,
        };
      });
      return { entries };
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

  listFavoritePlaces: defineAction({
    description: "列出用户在某城市存的常用地点（名称+地点关键词）。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: favoritePlacesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritePlacesResponse>> {
      return listFavoritePlaces(ctx, cityOf(args.city));
    },
  }),

  addFavoritePlace: defineAction({
    description:
      "把一个地点存为某城市的常用地点：name 是用户起的名字（如家、公司），address 是规划时用的地点关键词。同城市同名自动更新地址，同名同址不重复存。city 缺省为厦门。",
    request: z.object({
      name: z.string().min(1).max(20),
      address: z.string().min(1).max(60),
      city: z.string().max(20).optional(),
    }),
    response: favoritePlacesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritePlacesResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      const name = args.name.trim();
      const address = args.address.trim();
      const sameName = await db
        .select()
        .from(schema.favoritePlaces)
        .where(
          and(
            eq(schema.favoritePlaces.city, city),
            eq(schema.favoritePlaces.name, name),
          ),
        )
        .limit(1);
      if (sameName[0]) {
        await db
          .update(schema.favoritePlaces)
          .set({ address })
          .where(eq(schema.favoritePlaces.id, sameName[0].id));
      } else {
        await db.insert(schema.favoritePlaces).values({ city, name, address });
      }
      return listFavoritePlaces(ctx, city);
    },
  }),

  removeFavoritePlace: defineAction({
    description: "删除一个常用地点，返回该城市剩余的常用地点列表。",
    request: z.object({
      id: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: favoritePlacesResponse,
    async handler(ctx, args): Promise<z.infer<typeof favoritePlacesResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.favoritePlaces)
        .where(eq(schema.favoritePlaces.id, args.id));
      return listFavoritePlaces(ctx, cityOf(args.city));
    },
  }),

  getTransferWalkTimes: defineAction({
    description:
      "列出用户在某城市手动设过的换乘步行时间：每条是「换乘站名 + 接驳线路 → 分钟数」。规划与行程里遇到同一换乘点时套用用户的值，没有记录的按步行距离估算。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: transferWalkTimesResponse,
    async handler(ctx, args): Promise<z.infer<typeof transferWalkTimesResponse>> {
      return listTransferWalkTimes(ctx, cityOf(args.city));
    },
  }),

  setTransferWalkTime: defineAction({
    description:
      "保存某个换乘点的步行时间（分钟，0–30）：按城市 + 换乘站名 + 接驳线路存，已有同换乘点的记录会被更新，不同换乘点互不影响。返回该城市全部换乘步行设置。接驳线路可为空串（行程末尾步行段）。city 缺省为厦门。",
    request: z.object({
      station: z.string().min(1).max(60),
      nextLine: z.string().max(60),
      minutes: z.number().int().min(0).max(30),
      city: z.string().max(20).optional(),
    }),
    response: transferWalkTimesResponse,
    async handler(ctx, args): Promise<z.infer<typeof transferWalkTimesResponse>> {
      const city = cityOf(args.city);
      const station = args.station.trim();
      const nextLine = args.nextLine.trim();
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.transferWalkTimes)
        .where(
          and(
            eq(schema.transferWalkTimes.city, city),
            eq(schema.transferWalkTimes.station, station),
            eq(schema.transferWalkTimes.nextLine, nextLine),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(schema.transferWalkTimes)
          .set({ minutes: args.minutes, updatedAt: new Date() })
          .where(eq(schema.transferWalkTimes.id, existing[0].id));
      } else {
        await db.insert(schema.transferWalkTimes).values({
          city,
          station,
          nextLine,
          minutes: args.minutes,
        });
      }
      return listTransferWalkTimes(ctx, city);
    },
  }),

  getLinePickOptions: defineAction({
    description:
      "给画布到站卡「点选不打字」用的选项：某线路已知的终点站（选方向用）与站序（选站名用），外加当前城市最近用过的线路（选线路 chips 用）。数据优先读服务端点选沉淀缓存与站序长缓存，都没有终点站时用高德线路检索兜底（结果会沉淀下来）；全程不调 apizero、不耗实时额度。line 可空（只取 recentLines）。direction 是卡片当前方向号，用来决定站序先给哪个方向。",
    request: z.object({
      line: z.string().max(20).optional(),
      direction: z.number().int().min(0).max(2).optional(),
      city: z.string().max(20).optional(),
    }),
    response: linePickOptionsResponse,
    privileged: [privileged.amapGet],
    async handler(ctx, args): Promise<z.infer<typeof linePickOptionsResponse>> {
      const city = cityOf(args.city);
      const line = normalizeLine(args.line ?? "");
      const db = ctx.db<typeof schema>();
      // 最近用过的线路：画布模块里用过的 + 收藏过的（线路/线路站点）
      const recentLines: string[] = [];
      const pushRecent = (v: string) => {
        const t = v.trim();
        if (t && !recentLines.includes(t) && recentLines.length < 12) {
          recentLines.push(t);
        }
      };
      const mods = await db
        .select({ line: schema.canvasModules.line })
        .from(schema.canvasModules)
        .where(
          and(
            eq(schema.canvasModules.city, city),
            eq(schema.canvasModules.kind, "station"),
          ),
        )
        .orderBy(desc(schema.canvasModules.id))
        .limit(100);
      for (const m of mods) pushRecent(m.line);
      const favs = await db
        .select({
          kind: schema.favorites.kind,
          value: schema.favorites.value,
        })
        .from(schema.favorites)
        .where(eq(schema.favorites.city, city))
        .orderBy(desc(schema.favorites.id))
        .limit(100);
      for (const f of favs) {
        if (f.kind === "line" || f.kind === "lineStation") {
          pushRecent(normalizeLine(f.value));
        }
      }
      if (!line) return { terminals: [], stops: [], recentLines };

      const info = await readLineInfo(ctx, city, line);
      // 站序内存长缓存里有的也算数（与沉淀表互补）
      for (const dir of [1, 2] as const) {
        const e = stopsCache.get(`${city}|${line}|${dir}`);
        if (e && Date.now() <= e.expiresAt && e.value.length > 0) {
          if (dir === 1 && info.stops1.length === 0) info.stops1 = e.value;
          if (dir === 2 && info.stops2.length === 0) info.stops2 = e.value;
          info.terminals = mergeNames(
            info.terminals,
            [e.value[0] ?? "", e.value[e.value.length - 1] ?? ""],
            6,
          );
        }
      }
      // 沉淀与缓存都没有终点站时，高德线路检索兜底一次并沉淀
      if (info.terminals.length === 0) {
        const am = await amapLineInfo(ctx, city, line);
        if (am) {
          info.terminals = mergeNames(info.terminals, am.terminals, 6);
          if (info.stops1.length === 0) info.stops1 = am.stops1;
          if (info.stops2.length === 0) info.stops2 = am.stops2;
          await rememberLineInfo(ctx, city, line, {
            terminals: am.terminals,
            directionStops:
              am.stops1.length > 0
                ? { direction: 1, stops: am.stops1 }
                : undefined,
          });
          if (am.stops2.length > 0) {
            await rememberLineInfo(ctx, city, line, {
              directionStops: { direction: 2, stops: am.stops2 },
            });
          }
        }
      }
      // 站序：优先卡片当前方向的，其次另一个方向；再补零散记下的站名
      const want = args.direction === 2 ? info.stops2 : info.stops1;
      const other = args.direction === 2 ? info.stops1 : info.stops2;
      const stops = mergeNames(
        [...(want.length > 0 ? want : other)],
        [...other, ...info.extraStations],
        120,
      );
      return { terminals: info.terminals, stops, recentLines };
    },
  }),

  getCanvas: defineAction({
    description:
      "读取某城市画布的全部模块（到站卡/文本卡，含位置与备注）与连线。厦门画布为空且从未初始化时，先按用户通勤草图一次性预置种子（方向按线路站序实查判定，判定不了的模块不预置；用户删空后不再自动补）。city 缺省为厦门。",
    request: z.object({ city: z.string().max(20).optional() }),
    response: canvasResponse,
    privileged: [privileged.apizeroCall],
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      await maybeSeedCanvas(ctx, city);
      return listCanvas(ctx, city);
    },
  }),

  addCanvasModule: defineAction({
    description:
      "往某城市画布加一个模块：kind=station 时给 line/station/direction（接口方向号 1/2）/terminal（该方向终点站），kind=text 时给 text（纯文字内容）；x/y 是画布世界坐标。line/station/terminal 都可留空——那就是一张空白五行到站卡，创建不调任何接口，之后在卡上就地填字（updateCanvasModule 改 line/station/terminal）。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      kind: z.enum(["station", "text"]),
      line: z.string().max(20).optional(),
      station: z.string().max(40).optional(),
      direction: z.number().int().min(0).max(2).optional(),
      terminal: z.string().max(40).optional(),
      text: z.string().max(200).optional(),
      note: z.string().max(100).optional(),
      x: z.number().min(-10000).max(10000),
      y: z.number().min(-10000).max(10000),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      await db.insert(schema.canvasModules).values({
        city,
        kind: args.kind,
        line: args.kind === "station" ? normalizeLine(args.line ?? "") : "",
        station: args.kind === "station" ? (args.station ?? "").trim() : "",
        direction: args.kind === "station" ? (args.direction ?? 0) : 0,
        terminal: args.kind === "station" ? (args.terminal ?? "").trim() : "",
        text: args.kind === "text" ? (args.text ?? "").trim() : "",
        note: (args.note ?? "").trim(),
        x: args.x,
        y: args.y,
      });
      // 向导选定的终点站/站名也沉淀进点选缓存
      if (args.kind === "station") {
        const line = normalizeLine(args.line ?? "");
        if (line) {
          await rememberLineInfo(ctx, city, line, {
            terminals: args.terminal?.trim() ? [args.terminal.trim()] : [],
            extraStations: args.station?.trim() ? [args.station.trim()] : [],
          });
        }
      }
      return listCanvas(ctx, city);
    },
  }),

  updateCanvasModule: defineAction({
    description:
      "更新画布模块：传 x/y 改位置（拖动结束时保存），传 note 改备注，传 text 改文本模块的文字，传 enabled 开/停到站模块（停止后不查实时），传 direction/terminal 补选方向（从规划转入时方向定不了的模块用），传 line/station 改到站模块的线路与站名（空白卡就地填写用，line 会按规范补「路」后缀）；没传的字段不动。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      id: z.number().int().positive(),
      x: z.number().min(-10000).max(10000).optional(),
      y: z.number().min(-10000).max(10000).optional(),
      note: z.string().max(100).optional(),
      text: z.string().max(200).optional(),
      enabled: z.boolean().optional(),
      direction: z.number().int().min(0).max(2).optional(),
      terminal: z.string().max(40).optional(),
      line: z.string().max(20).optional(),
      station: z.string().max(40).optional(),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      const set: Partial<typeof schema.canvasModules.$inferInsert> = {};
      if (args.x !== undefined) set.x = args.x;
      if (args.y !== undefined) set.y = args.y;
      if (args.note !== undefined) set.note = args.note.trim();
      if (args.text !== undefined) set.text = args.text.trim();
      if (args.enabled !== undefined) set.enabled = args.enabled ? 1 : 0;
      if (args.direction !== undefined) set.direction = args.direction;
      if (args.terminal !== undefined) set.terminal = args.terminal.trim();
      if (args.line !== undefined) set.line = normalizeLine(args.line);
      if (args.station !== undefined) set.station = args.station.trim();
      if (Object.keys(set).length > 0) {
        await db
          .update(schema.canvasModules)
          .set(set)
          .where(eq(schema.canvasModules.id, args.id));
      }
      // 用户在卡上填/选的终点站与站名沉淀进点选缓存：下次同线路的卡
      // 直接点选，不用再打字。线路以更新后的值为准。
      if (args.terminal?.trim() || args.station?.trim()) {
        const rows = await db
          .select({ line: schema.canvasModules.line })
          .from(schema.canvasModules)
          .where(eq(schema.canvasModules.id, args.id))
          .limit(1);
        const lineNow = rows[0]?.line ?? "";
        if (lineNow) {
          await rememberLineInfo(ctx, city, lineNow, {
            terminals: args.terminal?.trim() ? [args.terminal.trim()] : [],
            extraStations: args.station?.trim()
              ? [args.station.trim()]
              : [],
          });
        }
      }
      return listCanvas(ctx, city);
    },
  }),

  removeCanvasModule: defineAction({
    description:
      "删除一个画布模块，并一并删掉与它相连的全部连线。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      id: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.canvasLinks)
        .where(
          or(
            eq(schema.canvasLinks.fromId, args.id),
            eq(schema.canvasLinks.toId, args.id),
          ),
        );
      await db
        .delete(schema.canvasModules)
        .where(eq(schema.canvasModules.id, args.id));
      return listCanvas(ctx, city);
    },
  }),

  addCanvasLink: defineAction({
    description:
      "在画布两个模块之间加一条连线（fromId → toId，只表达路线关系，不触发任何查询）；自己连自己、重复连线（正反向都算）会被忽略。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      fromId: z.number().int().positive(),
      toId: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      if (args.fromId !== args.toId) {
        const mods = await db
          .select({ id: schema.canvasModules.id })
          .from(schema.canvasModules)
          .where(
            and(
              eq(schema.canvasModules.city, city),
              or(
                eq(schema.canvasModules.id, args.fromId),
                eq(schema.canvasModules.id, args.toId),
              ),
            ),
          );
        if (mods.length === 2) {
          const dup = await db
            .select({ id: schema.canvasLinks.id })
            .from(schema.canvasLinks)
            .where(
              and(
                eq(schema.canvasLinks.city, city),
                or(
                  and(
                    eq(schema.canvasLinks.fromId, args.fromId),
                    eq(schema.canvasLinks.toId, args.toId),
                  ),
                  and(
                    eq(schema.canvasLinks.fromId, args.toId),
                    eq(schema.canvasLinks.toId, args.fromId),
                  ),
                ),
              ),
            )
            .limit(1);
          if (dup.length === 0) {
            await db.insert(schema.canvasLinks).values({
              city,
              fromId: args.fromId,
              toId: args.toId,
            });
          }
        }
      }
      return listCanvas(ctx, city);
    },
  }),

  removeCanvasLink: defineAction({
    description: "删除画布上的一条连线。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      id: z.number().int().positive(),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.canvasLinks)
        .where(eq(schema.canvasLinks.id, args.id));
      return listCanvas(ctx, city);
    },
  }),

  importPlanToCanvas: defineAction({
    description:
      "把一套规划方案（或进行中行程的各段）一键转成画布上的一条模块链：每个乘车段生成一个到站模块（上车站+线路+方向），步行段生成文本模块（步行约 X 分钟），最后加一个目的地文本模块，模块从左到右排开、依次连线。方向优先用方案自带的终点站与服务端站点序缓存（只读、不调实时接口）推导；推导不出方向号时用终点站匹配，终点站也没有就建 direction=0 的模块、由用户在画布上点选方向。画布已有内容时新链排在现有内容下方，不覆盖不清屏。返回该城市画布全量。city 缺省为厦门。",
    request: z.object({
      origin: z.string().min(1).max(60),
      destination: z.string().min(1).max(60),
      segments: z
        .array(
          z.object({
            type: z.string().max(20),
            name: z.string().max(60),
            departure: z.string().max(60),
            arrival: z.string().max(60),
            walkDistance: z.string().max(20),
            terminal: z.string().max(60).optional(),
          }),
        )
        .min(1)
        .max(20),
      city: z.string().max(20).optional(),
    }),
    response: canvasResponse,
    async handler(ctx, args): Promise<z.infer<typeof canvasResponse>> {
      const city = cityOf(args.city);
      const db = ctx.db<typeof schema>();

      // 新链排在现有内容下方：取现有模块的最大 y 再下移一行多
      const existing = await db
        .select({ y: schema.canvasModules.y })
        .from(schema.canvasModules)
        .where(eq(schema.canvasModules.city, city))
        .limit(400);
      const baseY =
        existing.length > 0
          ? Math.max(...existing.map((r) => r.y)) + 300
          : 40;
      const baseX = 40;
      const stepX = 292;
      const perRow = 7;
      const rowH = 300;

      type ModSpec = {
        kind: "station" | "text";
        line?: string;
        station?: string;
        direction?: number;
        terminal?: string;
        text?: string;
      };
      const specs: ModSpec[] = [];
      const segs = args.segments;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (!s) continue;
        if (s.type === "步行") {
          const dist = Number(s.walkDistance) || 0;
          const between =
            segs.slice(0, i).some((x) => x.type !== "步行") &&
            segs.slice(i + 1).some((x) => x.type !== "步行");
          // 与规划页同一口径：没距离又不是换乘步行的占位段不生成模块
          if (dist <= 0 && !between) continue;
          const mins =
            dist > 0 ? Math.min(30, Math.max(1, Math.round(dist / 80))) : 0;
          specs.push({
            kind: "text",
            text:
              dist > 0
                ? `步行约 ${mins} 分钟`
                : "步行换乘",
          });
          continue;
        }
        // 乘车段：方向先用方案自带终点站，再用站点序缓存（只读）核对
        // 出方向号；缓存没有就只存终点站（卡片查询时按终点站匹配方
        // 向）；终点站也没有就 direction=0，等用户在画布上点选。
        const line = s.name.trim();
        const station = s.departure.trim();
        let terminal = (s.terminal ?? "").trim();
        let direction = 0;
        if (line && station) {
          for (const dir of [1, 2]) {
            const stops = await getLineStops(ctx, city, line, dir, false);
            if (!stops || stops.length === 0) continue;
            const si = stops.indexOf(station);
            if (si < 0) continue;
            const last = stops[stops.length - 1] ?? "";
            if (terminal && last === terminal) {
              direction = dir;
              break;
            }
            if (!terminal && si < stops.length - 1) {
              // 没有终点站信息时：上车站不在该方向末站、且下车站在它
              // 后面，才认定是这个方向
              const ai = stops.indexOf(s.arrival.trim());
              if (ai > si) {
                direction = dir;
                terminal = last;
                break;
              }
            }
          }
          if (direction === 0 && terminal) {
            // 方向号没核对出来不要紧：卡片按终点站也能匹配方向；
            // 但终点站若与缓存里某方向的末站对不上（缓存旧/异名），
            // 保持原样让用户点选修正，不硬改。
          }
        }
        // 方案自带的终点站与上车站沉淀进点选缓存，下次同线路可点选
        if (line) {
          await rememberLineInfo(ctx, city, normalizeLine(line), {
            terminals: terminal ? [terminal] : [],
            extraStations: station ? [station] : [],
          });
        }
        specs.push({
          kind: "station",
          line,
          station,
          direction,
          terminal,
        });
      }
      specs.push({ kind: "text", text: args.destination.trim() });

      const ids: number[] = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (!spec) continue;
        const x = baseX + (i % perRow) * stepX;
        const y = baseY + Math.floor(i / perRow) * rowH;
        const rows = await db
          .insert(schema.canvasModules)
          .values({
            city,
            kind: spec.kind,
            line: spec.kind === "station" ? (spec.line ?? "") : "",
            station: spec.kind === "station" ? (spec.station ?? "") : "",
            direction: spec.kind === "station" ? (spec.direction ?? 0) : 0,
            terminal: spec.kind === "station" ? (spec.terminal ?? "") : "",
            text: spec.kind === "text" ? (spec.text ?? "") : "",
            x,
            y,
          })
          .returning({ id: schema.canvasModules.id });
        const id = rows[0]?.id;
        if (id) ids.push(id);
      }
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = ids[i];
        const b = ids[i + 1];
        if (a && b) {
          await db
            .insert(schema.canvasLinks)
            .values({ city, fromId: a, toId: b });
        }
      }
      return listCanvas(ctx, city);
    },
  }),

  getActiveTrip: defineAction({
    description:
      "读取当前进行中的行程（所选方案各段、当前进行到第几段、是否已上车）；没有进行中行程时 trip 为 null。关掉页面再打开靠它续上行程。",
    request: z.object({}),
    response: activeTripResponse,
    async handler(ctx): Promise<z.infer<typeof activeTripResponse>> {
      return loadActiveTrip(ctx);
    },
  }),

  startTrip: defineAction({
    description:
      "开始一段行程：把所选规划方案的各段存为唯一进行中行程（已有进行中行程会被替换），并为每个乘车段按站点序算出上车站→下车站之间的站序与站数（防坐过站用）。当前段从第一段开始。",
    request: z.object({
      origin: z.string().min(1).max(60),
      destination: z.string().min(1).max(60),
      city: z.string().max(20).optional(),
      segments: z
        .array(
          z.object({
            type: z.string().max(20),
            name: z.string().max(60),
            departure: z.string().max(60),
            arrival: z.string().max(60),
            walkDistance: z.string().max(20),
          }),
        )
        .min(1)
        .max(20),
    }),
    response: activeTripResponse,
    privileged: [privileged.apizeroCall],
    async handler(ctx, args): Promise<z.infer<typeof activeTripResponse>> {
      const city = cityOf(args.city);
      const segments: TripSegment[] = [];
      for (const s of args.segments) {
        const base: TripSegment = {
          type: s.type,
          name: s.name,
          departure: s.departure,
          arrival: s.arrival,
          walkDistance: s.walkDistance,
          stops: [],
          stopCount: null,
          terminal: "",
        };
        segments.push(
          s.type === "步行" ? base : await enrichRideSegment(ctx, city, base),
        );
      }
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db
        .insert(schema.activeTrip)
        .values({
          id: 1,
          city,
          origin: args.origin.trim(),
          destination: args.destination.trim(),
          segmentsJson: JSON.stringify(segments),
          currentIndex: 0,
          phase: "waiting",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.activeTrip.id,
          set: {
            city,
            origin: args.origin.trim(),
            destination: args.destination.trim(),
            segmentsJson: JSON.stringify(segments),
            currentIndex: 0,
            phase: "waiting",
            updatedAt: now,
          },
        });
      return loadActiveTrip(ctx);
    },
  }),

  advanceTrip: defineAction({
    description:
      "推进行程一步：乘车段先从未上车变已上车、再变已下车并进入下一段；步行段直接进入下一段。最后一段完成后行程结束并清除进行中状态，返回值里 trip.finished=true 表示刚完成（行程数据仍附带返回供前端展示到达页）。",
    request: z.object({}),
    response: activeTripResponse,
    async handler(ctx): Promise<z.infer<typeof activeTripResponse>> {
      const db = ctx.db<typeof schema>();
      const cur = await loadActiveTrip(ctx);
      if (!cur.trip) return { trip: null };
      const { segments, currentIndex, phase } = cur.trip;
      const seg = segments[currentIndex];
      if (!seg) {
        await db.delete(schema.activeTrip).where(eq(schema.activeTrip.id, 1));
        return { trip: null };
      }
      const isRide = seg.type !== "步行";
      if (isRide && phase === "waiting") {
        await db
          .update(schema.activeTrip)
          .set({ phase: "riding", updatedAt: new Date() })
          .where(eq(schema.activeTrip.id, 1));
        return loadActiveTrip(ctx);
      }
      const next = currentIndex + 1;
      if (next >= segments.length) {
        await db.delete(schema.activeTrip).where(eq(schema.activeTrip.id, 1));
        return {
          trip: { ...cur.trip, currentIndex, phase, finished: true },
        };
      }
      await db
        .update(schema.activeTrip)
        .set({ currentIndex: next, phase: "waiting", updatedAt: new Date() })
        .where(eq(schema.activeTrip.id, 1));
      return loadActiveTrip(ctx);
    },
  }),

  endTrip: defineAction({
    description: "放弃并清除当前进行中的行程。",
    request: z.object({}),
    response: activeTripResponse,
    async handler(ctx): Promise<z.infer<typeof activeTripResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.activeTrip).where(eq(schema.activeTrip.id, 1));
      return { trip: null };
    },
  }),

  getSettings: defineAction({
    description:
      "读取设置页状态：两个 API key 各自的来源（界面存的/服务器文件/未设置）与末 4 位掩码（绝不返回完整 key）、默认城市、实时查询缓存秒数。",
    request: z.object({}),
    response: settingsResponse,
    privileged: [privileged.keyFileStatus],
    async handler(ctx): Promise<z.infer<typeof settingsResponse>> {
      return buildSettings(ctx);
    },
  }),

  saveSettings: defineAction({
    description:
      "保存设置：apizeroKey/amapKey 传了非空新值才替换界面里存的 key（不传或空串 = 不修改）；defaultCity 保存默认城市；cacheTtlSec 保存实时查询缓存秒数（60/90/120/180）。保存后即时生效，返回更新后的设置状态。",
    request: z.object({
      apizeroKey: z.string().max(200).optional(),
      amapKey: z.string().max(200).optional(),
      defaultCity: z.string().max(20).optional(),
      cacheTtlSec: z.number().int().optional(),
    }),
    response: settingsResponse,
    privileged: [privileged.keyFileStatus],
    async handler(ctx, args): Promise<z.infer<typeof settingsResponse>> {
      const aKey = (args.apizeroKey ?? "").trim();
      if (aKey) await setSetting(ctx, SETTING_APIZERO_KEY, aKey);
      const mKey = (args.amapKey ?? "").trim();
      if (mKey) await setSetting(ctx, SETTING_AMAP_KEY, mKey);
      if (args.defaultCity !== undefined) {
        await setSetting(ctx, SETTING_DEFAULT_CITY, cityOf(args.defaultCity));
      }
      if (
        args.cacheTtlSec !== undefined &&
        CACHE_TTL_CHOICES.includes(args.cacheTtlSec)
      ) {
        await setSetting(ctx, SETTING_CACHE_TTL, String(args.cacheTtlSec));
      }
      return buildSettings(ctx);
    },
  }),

  clearApiKey: defineAction({
    description:
      "清除设置页里存的某个 API key（service 为 apizero 或 amap），清除后回退到服务器密钥文件；返回更新后的设置状态。",
    request: z.object({ service: z.enum(["apizero", "amap"]) }),
    response: settingsResponse,
    privileged: [privileged.keyFileStatus],
    async handler(ctx, args): Promise<z.infer<typeof settingsResponse>> {
      await deleteSetting(
        ctx,
        args.service === "apizero" ? SETTING_APIZERO_KEY : SETTING_AMAP_KEY,
      );
      return buildSettings(ctx);
    },
  }),

  testApiKey: defineAction({
    description:
      "测试某个 API key 是否可用：key 传了就测这个新值，没传就测当前生效的 key（界面存的优先、否则文件）。高德用一次轻量地理编码调用；apizero 用一次站点搜索调用、会消耗 1 次接口调用。结果如实返回，接口报错原文放在 message 里。",
    request: z.object({
      service: z.enum(["apizero", "amap"]),
      key: z.string().max(200).optional(),
    }),
    response: testKeyResponse,
    privileged: [privileged.apizeroCall, privileged.amapGet],
    async handler(ctx, args): Promise<z.infer<typeof testKeyResponse>> {
      const typed = (args.key ?? "").trim();
      if (args.service === "apizero") {
        const keyOverride = typed || (await uiApizeroKey(ctx));
        const r = await ctx.executePrivileged(privileged.apizeroCall, {
          paramsJson: JSON.stringify({
            type: "stations",
            city: DEFAULT_CITY,
            station: "火车站",
          }),
          keyOverride,
        });
        if (!r.ok) return { ok: false, message: r.error || "接口请求失败" };
        let count = 0;
        try {
          count = arr(rec(JSON.parse(r.body || "{}")).stations).length;
        } catch {
          count = 0;
        }
        return {
          ok: true,
          message: `连接成功，接口正常返回（测试站搜到 ${count} 个相关站点）`,
        };
      }
      const keyOverride = typed || (await uiAmapKey(ctx));
      const r = await ctx.executePrivileged(privileged.amapGet, {
        path: "/v3/geocode/geo",
        // 地址要带城市名：只写「火车站」高德引擎会报 ENGINE_RESPONSE_DATA_ERROR
        paramsJson: JSON.stringify({
          address: `${DEFAULT_CITY}火车站`,
          city: DEFAULT_CITY,
        }),
        keyOverride,
      });
      if (!r.ok) return { ok: false, message: r.error || "接口请求失败" };
      let body: Record<string, unknown> = {};
      try {
        body = rec(JSON.parse(r.body || "{}"));
      } catch {
        return { ok: false, message: "高德接口返回了无法解析的内容" };
      }
      if (str(body.status) === "1") {
        return { ok: true, message: "连接成功，高德接口正常返回" };
      }
      return {
        ok: false,
        message: `高德接口拒绝了请求：${str(body.info) || "未知错误"}${str(body.infocode) ? `（infocode ${str(body.infocode)}）` : ""}`,
      };
    },
  }),
} satisfies ActionsModule;
