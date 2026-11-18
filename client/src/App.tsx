import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

// ---------- types derived from actions ----------

type RealtimeResult = ApiResponse<typeof api, "queryLineRealtime">;
type LineDetailResult = ApiResponse<typeof api, "getLineDetail">;
type StationArrivalsResult = ApiResponse<typeof api, "queryStationArrivals">;
type RoutePlanResult = ApiResponse<typeof api, "planRoute">;
type Favorite = ApiResponse<typeof api, "listFavorites">["favorites"][number];
type FavRoute = ApiResponse<typeof api, "listFavoriteRoutes">["routes"][number];
type FavPlace = ApiResponse<typeof api, "listFavoritePlaces">["places"][number];
type ActiveTrip = NonNullable<ApiResponse<typeof api, "getActiveTrip">["trip"]>;
type TripSegment = ActiveTrip["segments"][number];
type RoutePlan = RoutePlanResult["plans"][number];
type BusInfo = RealtimeResult["directions"][number]["buses"][number];
type BoardEntry = ApiResponse<typeof api, "getBoardSnapshot">["entries"][number];
type CanvasData = ApiResponse<typeof api, "getCanvas">;
type CanvasModule = CanvasData["modules"][number];
type CanvasTemplate = ApiResponse<typeof api, "getCanvasTemplates">["templates"][number];

// ---------- 城市切换 ----------
// 默认厦门（保持原有体验与收藏）；所选城市存 localStorage，刷新不丢。
// 收藏按城市分开存，只显示当前城市的。

const PRESET_CITIES = [
  "厦门", "上海", "北京", "广州", "深圳", "成都", "杭州", "武汉",
  "西安", "南京", "重庆", "福州", "天津", "苏州", "郑州", "长沙",
  "青岛", "大连", "宁波", "昆明",
];
const CITY_STORAGE_KEY = "transit-city";

function loadStoredCity(): string {
  try {
    return window.localStorage.getItem(CITY_STORAGE_KEY)?.trim() || "厦门";
  } catch {
    return "厦门";
  }
}

function hasStoredCity(): boolean {
  try {
    return !!window.localStorage.getItem(CITY_STORAGE_KEY)?.trim();
  } catch {
    return false;
  }
}

type SettingsData = ApiResponse<typeof api, "getSettings">;

// 底部主导航：一屏只干一件事。原「线路」「站点」并入「查车」，
// 收藏（线路/站点/常用路线）集中到「收藏」页。设置页从顶部齿轮进入，
// 不占底部导航。
// "trip"（行程模式）与 "settings" 一样不占底部导航：行程从规划结果
// 进入、或从查车页顶部的行程横条回到。"canvas"（画布）同样不占底部
// 导航：从查车页顶部的醒目入口、或收藏页顶部的入口进入。
type Tab = "home" | "route" | "nearby" | "metro" | "favorites" | "settings" | "trip" | "canvas";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "查车" },
  { id: "route", label: "规划" },
  { id: "nearby", label: "附近" },
  { id: "metro", label: "地铁" },
  { id: "favorites", label: "收藏" },
];

// 查车页内部视图：查询表单 / 线路详情 / 站点到站
type HomeMode = "query" | "line" | "station";

// ---------- small pieces ----------

function LineBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center bg-[var(--accent)] px-2 py-0.5 text-sm font-bold text-[var(--accent-ink)] [border-radius:6px]">
      {name}
    </span>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mt-4 border border-[var(--danger)] px-4 py-3 [border-radius:var(--radius)]">
      <p className="text-sm text-[var(--danger)]">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 px-3 text-sm font-medium text-[var(--accent)] underline"
        >
          重试
        </button>
      )}
    </div>
  );
}

function FavButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`shrink-0 px-3 text-sm [border-radius:8px] ${
        active
          ? "bg-[var(--surface2)] font-bold text-[var(--text)]"
          : "bg-[var(--surface2)] text-[var(--dim)]"
      }`}
    >
      {active ? "★ 已收藏" : "☆ 收藏"}
    </button>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="flex items-center gap-2 text-base font-bold text-[var(--text)]">
      <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-[var(--accent)] [border-radius:2px]" />
      {children}
    </h2>
  );
}

// ---------- 换乘步行时间（可手动调节） ----------
// 默认按步行距离 ÷ 80 米/分钟估算；用户在某个换乘点调过之后，按
// 「城市 + 换乘站名 + 接驳线路」存服务端，下次规划或行程里再遇到同一
// 个换乘点自动套用并标注「按你的设置」，不同换乘点互不影响。规划、
// 行程、宽裕度提示读的是同一份设置，所以行程进行中改完立即生效。

type WalkSegLike = {
  type: string;
  name: string;
  departure: string;
  arrival: string;
  walkDistance: string;
};

function walkKeyOf(station: string, nextLine: string): string {
  return `${station.trim()}|${nextLine.trim()}`;
}

function defaultWalkMinutes(distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  return Math.min(30, Math.round(distanceMeters / 80));
}

/**
 * 步行段 idx 对应的换乘点：接驳线路是它后面第一段乘车线路，换乘站名
 * 取那段的上车站；后面没有乘车段（末尾步行）时站名取上一段的下车站、
 * 接驳线路为空串。
 */
function walkPointOf(
  segments: WalkSegLike[],
  idx: number,
): { station: string; nextLine: string } {
  for (let j = idx + 1; j < segments.length; j++) {
    const s = segments[j];
    if (s && s.type !== "步行") return { station: s.departure, nextLine: s.name };
  }
  for (let j = idx - 1; j >= 0; j--) {
    const s = segments[j];
    if (s && s.type !== "步行") return { station: s.arrival, nextLine: "" };
  }
  return { station: "", nextLine: "" };
}

/** 乘车段 idx 是否紧接上一乘车段（中间没有步行段）：同站/过街换乘。 */
function isDirectTransfer(segments: WalkSegLike[], idx: number): boolean {
  if (idx <= 0) return false;
  const prev = segments[idx - 1];
  return !!prev && prev.type !== "步行";
}

/** 乘车段 idx 之前是否已有乘车段（即它是不是换乘接驳段）。 */
function hasRideBefore(segments: WalkSegLike[], idx: number): boolean {
  return segments.slice(0, idx).some((s) => s.type !== "步行");
}

function useWalkTimes(city: string) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["transferWalkTimes", city],
    queryFn: () => api.getTransferWalkTimes({ city }),
  });
  const map = new Map<string, number>();
  for (const it of q.data?.items ?? []) {
    map.set(walkKeyOf(it.station, it.nextLine), it.minutes);
  }
  const mut = useMutation({
    mutationFn: (args: { station: string; nextLine: string; minutes: number }) =>
      api.setTransferWalkTime({ ...args, city }),
    onSuccess: (data) =>
      queryClient.setQueryData(["transferWalkTimes", city], data),
  });
  const effective = (station: string, nextLine: string, defaultMin: number) => {
    const custom = map.get(walkKeyOf(station, nextLine));
    return { minutes: custom ?? defaultMin, isCustom: custom !== undefined };
  };
  const setMinutes = (station: string, nextLine: string, minutes: number) => {
    const st = station.trim();
    if (!st) return;
    mut.mutate({ station: st, nextLine: nextLine.trim(), minutes });
  };
  return { effective, setMinutes };
}

/** 步行分钟数调节：− / + 一分钟一档，中间可直接输入，范围 0–30 分钟。 */
function WalkTimeControl({
  minutes,
  isCustom,
  onChange,
  label,
}: {
  minutes: number;
  isCustom: boolean;
  onChange: (m: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(30, Math.max(0, Math.round(n)));
  const commitDraft = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(n)) onChange(clamp(n));
    setDraft(null);
  };
  const btnCls =
    "shrink-0 bg-[var(--surface2)] px-3.5 py-1 text-base font-bold text-[var(--text)] [border-radius:8px] disabled:opacity-40";
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-sm text-[var(--dim)]">步行约</span>
      <button
        type="button"
        aria-label={`减少${label}的步行时间`}
        disabled={minutes <= 0}
        onClick={() => onChange(clamp(minutes - 1))}
        className={btnCls}
      >
        −
      </button>
      <input
        value={draft ?? String(minutes)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
        }}
        inputMode="numeric"
        aria-label={`${label}的步行分钟数（0 到 30 分钟）`}
        className="w-14 shrink-0 border border-[var(--border)] bg-[var(--surface)] px-1 py-1.5 text-center text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]"
      />
      <button
        type="button"
        aria-label={`增加${label}的步行时间`}
        disabled={minutes >= 30}
        onClick={() => onChange(clamp(minutes + 1))}
        className={btnCls}
      >
        +
      </button>
      <span className="text-sm text-[var(--dim)]">分钟</span>
      {isCustom && <span className="text-xs text-[var(--dim)]">按你的设置</span>}
    </span>
  );
}

// ---------- app ----------

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("home");
  const [homeMode, setHomeMode] = useState<HomeMode>("query");
  const [city, setCity] = useState<string>(loadStoredCity);
  const [customCityMode, setCustomCityMode] = useState(false);
  const [customCityInput, setCustomCityInput] = useState("");

  // 跨视图共享的输入（从收藏/线路/站点点过来时预填）
  const [rtLine, setRtLine] = useState("");
  const [rtStation, setRtStation] = useState("");
  const [lineInput, setLineInput] = useState("");
  const [stationInput, setStationInput] = useState("");

  const favorites = useQuery({
    queryKey: ["favorites", city],
    queryFn: () => api.listFavorites({ city }),
  });
  const favList = favorites.data?.favorites ?? [];
  const addFav = useMutation({
    mutationFn: (args: { kind: "line" | "station" | "lineStation"; value: string; label: string }) =>
      api.addFavorite({ ...args, city }),
    onSuccess: (data) => queryClient.setQueryData(["favorites", city], data),
  });
  const removeFav = useMutation({
    mutationFn: (id: number) => api.removeFavorite({ id, city }),
    onSuccess: (data) => queryClient.setQueryData(["favorites", city], data),
  });
  const findFav = (kind: string, value: string, label: string) =>
    favList.find((f) => f.kind === kind && f.value === value && f.label === label);
  const toggleFav = (kind: "line" | "station" | "lineStation", value: string, label: string) => {
    const existing = findFav(kind, value, label);
    if (existing) removeFav.mutate(existing.id);
    else addFav.mutate({ kind, value, label });
  };
  const openFavorite = (f: Favorite) => {
    if (f.kind === "line") runLineDetail(f.value);
    else if (f.kind === "station") openStation(f.label);
    else runRealtime(f.value, f.label);
  };

  // 实时到站（缓存期内重复查询走服务端缓存，forceRefresh 才真调接口）
  const rt = useMutation({
    mutationFn: (args: { line: string; station: string; forceRefresh?: boolean }) =>
      api.queryLineRealtime({ ...args, city }),
  });
  const runRealtime = (line: string, station: string) => {
    setRtLine(line);
    setRtStation(station);
    setHomeMode("query");
    setTab("home");
    rt.mutate({ line, station });
  };
  const onRtSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (rtLine.trim() && rtStation.trim()) rt.mutate({ line: rtLine, station: rtStation });
  };

  // 线路详情
  const ld = useMutation({
    mutationFn: (line: string) => api.getLineDetail({ line, city }),
  });
  const [ldDir, setLdDir] = useState(0);
  const runLineDetail = (line: string) => {
    setLineInput(line);
    setHomeMode("line");
    setTab("home");
    setLdDir(0);
    ld.mutate(line);
  };
  const onLineSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (lineInput.trim()) {
      setLdDir(0);
      ld.mutate(lineInput);
    }
  };

  // 站点
  const ss = useMutation({
    mutationFn: (keyword: string) => api.searchStations({ keyword, city }),
  });
  const sa = useMutation({
    mutationFn: (args: { station: string; forceRefresh?: boolean }) =>
      api.queryStationArrivals({ ...args, city }),
  });
  const [saStation, setSaStation] = useState("");
  const openStation = (name: string) => {
    setSaStation(name);
    setHomeMode("station");
    setTab("home");
    sa.mutate({ station: name });
  };
  const onStationSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (stationInput.trim()) ss.mutate(stationInput);
  };

  // 附近站点（只在用户点按钮时请求一次定位，不自动轮询）
  const nb = useMutation({
    mutationFn: (args: { lng: number; lat: number }) => api.findNearbyStations(args),
  });
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const findNearby = () => {
    setLocError("");
    if (!("geolocation" in navigator)) {
      setLocError("这个设备/浏览器不支持定位，无法查找附近站点。");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        nb.mutate({ lng: pos.coords.longitude, lat: pos.coords.latitude });
      },
      (err) => {
        setLocating(false);
        setLocError(
          err.code === err.PERMISSION_DENIED
            ? "定位被拒绝了。允许定位后，再点一次就能看你身边的公交站。"
            : "定位失败，请确认手机定位已开启后重试。",
        );
      },
      { timeout: 15000, maximumAge: 60000 },
    );
  };

  // 路线规划
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  // 把当前起点/终点存为常用地点时的命名表单（目标字段 + 名字输入）
  const [savePlaceTarget, setSavePlaceTarget] = useState<"origin" | "destination" | null>(null);
  const [savePlaceName, setSavePlaceName] = useState("");
  const rp = useMutation({
    mutationFn: (args: { origin: string; destination: string }) =>
      api.planRoute({ ...args, city }),
  });
  const onRouteSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (origin.trim() && destination.trim()) rp.mutate({ origin, destination });
  };
  const runRoute = (o: string, d: string) => {
    setOrigin(o);
    setDestination(d);
    setTab("route");
    rp.mutate({ origin: o, destination: d });
  };

  // 常用路线收藏（与线路/站点收藏分开存，统一在收藏页展示，按城市过滤）
  const favRoutes = useQuery({
    queryKey: ["favoriteRoutes", city],
    queryFn: () => api.listFavoriteRoutes({ city }),
  });
  const favRouteList = favRoutes.data?.routes ?? [];
  const addFavRoute = useMutation({
    mutationFn: (args: { origin: string; destination: string }) =>
      api.addFavoriteRoute({ ...args, city }),
    onSuccess: (data) => queryClient.setQueryData(["favoriteRoutes", city], data),
  });
  const removeFavRoute = useMutation({
    mutationFn: (id: number) => api.removeFavoriteRoute({ id, city }),
    onSuccess: (data) => queryClient.setQueryData(["favoriteRoutes", city], data),
  });
  const currentRouteFav = favRouteList.find(
    (r) => r.origin === origin.trim() && r.destination === destination.trim(),
  );
  const toggleCurrentRouteFav = () => {
    if (currentRouteFav) removeFavRoute.mutate(currentRouteFav.id);
    else if (origin.trim() && destination.trim())
      addFavRoute.mutate({ origin: origin.trim(), destination: destination.trim() });
  };

  // 常用地点（按城市隔离，服务端存）
  const favPlaces = useQuery({
    queryKey: ["favoritePlaces", city],
    queryFn: () => api.listFavoritePlaces({ city }),
  });
  const placeList = favPlaces.data?.places ?? [];
  const addPlace = useMutation({
    mutationFn: (args: { name: string; address: string }) =>
      api.addFavoritePlace({ ...args, city }),
    onSuccess: (data) => queryClient.setQueryData(["favoritePlaces", city], data),
  });
  const removePlace = useMutation({
    mutationFn: (id: number) => api.removeFavoritePlace({ id, city }),
    onSuccess: (data) => queryClient.setQueryData(["favoritePlaces", city], data),
  });

  // 进行中的行程（服务端存，关页重开能续；同时只有一个）
  const tripQ = useQuery({
    queryKey: ["activeTrip"],
    queryFn: () => api.getActiveTrip({}),
  });
  const activeTrip = tripQ.data?.trip ?? null;
  const [tripFinished, setTripFinished] = useState(false);
  const startTripMut = useMutation({
    mutationFn: (args: { origin: string; destination: string; plan: RoutePlan }) =>
      api.startTrip({
        origin: args.origin,
        destination: args.destination,
        city,
        segments: args.plan.segments,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["activeTrip"], data);
      setTripFinished(false);
      setTab("trip");
    },
  });
  const startTrip = (plan: RoutePlan) => {
    if (origin.trim() && destination.trim()) {
      startTripMut.mutate({ origin: origin.trim(), destination: destination.trim(), plan });
    }
  };

  // 把规划方案 / 进行中行程转到画布：服务端把各段变成一条模块链
  // （乘车段→到站模块、步行段→文本模块、终点→文本模块，依次连线），
  // 排在画布现有内容下方。转完跳画布页，并让画布把新链滚到视口顶部。
  const [canvasFocus, setCanvasFocus] = useState<{ y: number; nonce: number } | null>(null);
  const toCanvasMut = useMutation({
    mutationFn: (args: {
      origin: string;
      destination: string;
      segments: {
        type: string;
        name: string;
        departure: string;
        arrival: string;
        walkDistance: string;
        terminal?: string;
      }[];
    }) => api.importPlanToCanvas({ ...args, city }),
    onSuccess: (data) => {
      const prev = queryClient.getQueryData<CanvasData>(["canvas", city]);
      const prevIds = new Set((prev?.modules ?? []).map((m) => m.id));
      const fresh = data.modules.filter((m) => !prevIds.has(m.id));
      queryClient.setQueryData(["canvas", city], data);
      if (fresh.length > 0) {
        setCanvasFocus({
          y: Math.min(...fresh.map((m) => m.y)),
          nonce: Date.now(),
        });
      }
      setTab("canvas");
    },
  });
  const planToCanvas = (plan: RoutePlan) => {
    if (origin.trim() && destination.trim()) {
      toCanvasMut.mutate({
        origin: origin.trim(),
        destination: destination.trim(),
        segments: plan.segments,
      });
    }
  };
  const tripToCanvas = () => {
    if (!activeTrip) return;
    toCanvasMut.mutate({
      origin: activeTrip.origin,
      destination: activeTrip.destination,
      segments: activeTrip.segments.map((s) => ({
        type: s.type,
        name: s.name,
        departure: s.departure,
        arrival: s.arrival,
        walkDistance: s.walkDistance,
        terminal: s.terminal,
      })),
    });
  };

  // 常用路线一键开始行程：用该路线的起点+终点自动规划（走高德，不耗
  // apizero 额度），取最优方案直接 startTrip 并跳行程视图，不再手动选
  // 方案。已有进行中行程时不静默覆盖：先置 pendingQuickRoute 弹确认，
  // 用户点「结束并开始新行程」才真正执行替换。
  const [pendingQuickRoute, setPendingQuickRoute] = useState<FavRoute | null>(null);
  const quickStartMut = useMutation({
    mutationFn: async (r: FavRoute) => {
      const res = await api.planRoute({ origin: r.origin, destination: r.destination, city });
      if (!res.ok) throw new Error(res.error || "规划失败，没有可用方案");
      const plan = res.plans.find((p) => p.best) ?? res.plans[0];
      if (!plan) throw new Error("没有找到可用方案");
      return api.startTrip({
        origin: r.origin,
        destination: r.destination,
        city,
        segments: plan.segments,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["activeTrip"], data);
      setTripFinished(false);
      setPendingQuickRoute(null);
      setTab("trip");
    },
  });
  const quickStartTrip = (r: FavRoute) => {
    quickStartMut.reset();
    if (activeTrip) setPendingQuickRoute(r);
    else quickStartMut.mutate(r);
  };
  const quickPendingId = quickStartMut.isPending
    ? (quickStartMut.variables?.id ?? null)
    : null;
  const advanceTripMut = useMutation({
    mutationFn: () => api.advanceTrip({}),
    onSuccess: (data) => {
      if (data.trip?.finished) {
        // 行程完成：服务端已清除进行中状态，本地展示到达页
        queryClient.setQueryData(["activeTrip"], { trip: null });
        setTripFinished(true);
      } else {
        queryClient.setQueryData(["activeTrip"], data);
      }
    },
  });
  const endTripMut = useMutation({
    mutationFn: () => api.endTrip({}),
    onSuccess: (data) => {
      queryClient.setQueryData(["activeTrip"], data);
      setTripFinished(false);
      setTab("home");
    },
  });

  // 地铁线路（按城市取：厦门内置数据，其他城市服务端由高德整理并缓存）
  const metro = useQuery({
    queryKey: ["metroLines", city],
    queryFn: () => api.getMetroLines({ city }),
  });

  // 设置（默认城市等）：服务端存一份默认城市。本机从没存过城市时，
  // 用服务端默认城市作初始值；存过就以本机为准——与顶部切换共用同一
  // 份 city 状态，不另做一套。
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings({}),
  });
  const hadStoredCityRef = useRef(hasStoredCity());
  const appliedServerDefaultRef = useRef(false);

  // 切换城市：持久化 + 清掉上一个城市的查询结果，避免串城市显示
  const switchCity = (raw: string) => {
    const c = raw.trim().replace(/\s+/g, "");
    if (!c || c === city) {
      setCustomCityMode(false);
      return;
    }
    setCity(c);
    setCustomCityMode(false);
    setCustomCityInput("");
    try {
      window.localStorage.setItem(CITY_STORAGE_KEY, c);
    } catch {
      // 存不下也不影响本次使用
    }
    rt.reset();
    ld.reset();
    ss.reset();
    sa.reset();
    nb.reset();
    rp.reset();
    setHomeMode("query");
    setLocError("");
  };

  // 首次拿到服务端设置且本机没存过城市时，套用服务端默认城市（只做一次）
  const serverDefaultCity = settingsQ.data?.defaultCity ?? "";
  useEffect(() => {
    if (appliedServerDefaultRef.current) return;
    if (hadStoredCityRef.current) {
      appliedServerDefaultRef.current = true;
      return;
    }
    if (serverDefaultCity) {
      appliedServerDefaultRef.current = true;
      switchCity(serverDefaultCity);
    }
    // switchCity 每次渲染都是新引用，只按服务端默认值触发一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDefaultCity]);

  // 统一智能搜索（解析规则照机器人 parse_input）：一个输入自动分发到对应功能并直接出结果
  const [smart, setSmart] = useState("");
  const LINE_TOKEN = /^(\d+|快\d+|m\d+|brt)路?$/i;
  const onSmartSubmit = (e: FormEvent) => {
    e.preventDefault();
    const s = smart.trim();
    if (!s) return;
    // 含「地铁/号线」→ 地铁信息
    if (s.includes("地铁") || s.includes("号线")) {
      setTab("metro");
      return;
    }
    const tokens = s.split(/[\s,，、;；]+/).filter(Boolean);
    const first = tokens[0] ?? "";
    if (tokens.length >= 2) {
      // 首词是线路 → 线路+站名查实时到站；否则两个词 → 路线规划
      if (LINE_TOKEN.test(first)) {
        runRealtime(first, tokens.slice(1).join(" "));
      } else {
        runRoute(first, tokens.slice(1).join(" "));
      }
      return;
    }
    // 单个词：线路格式 → 线路详情；其余 → 站点搜索
    if (LINE_TOKEN.test(first)) {
      runLineDetail(first);
    } else {
      setStationInput(first);
      setHomeMode("station");
      setTab("home");
      ss.mutate(first);
    }
  };

  const inputCls =
    "w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]";
  const submitCls =
    "shrink-0 bg-[var(--accent)] px-5 font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50";
  const ghostBtnCls =
    "shrink-0 bg-[var(--surface2)] px-3 font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50";

  return (
    <div className="min-h-screen bg-[var(--bg)] font-sans">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-28">
        {/* 顶部：只保留城市切换 + 统一搜索 */}
        <header className="sticky top-0 z-10 -mx-4 border-b border-[var(--border)] bg-[var(--bg)] px-4 pt-3 pb-3">
          {customCityMode ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                switchCity(customCityInput);
              }}
            >
              <input
                className={inputCls}
                value={customCityInput}
                onChange={(e) => setCustomCityInput(e.target.value)}
                placeholder="输入城市名，如：合肥"
                aria-label="自定义城市名"
                autoComplete="off"
                autoFocus
              />
              <button type="submit" className={submitCls} disabled={!customCityInput.trim()}>
                切换
              </button>
              <button type="button" className={ghostBtnCls} onClick={() => setCustomCityMode(false)}>
                取消
              </button>
            </form>
          ) : (
            <div className="flex gap-2">
              <select
                id="city-select"
                aria-label="切换城市"
                className="w-24 shrink-0 border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-base font-bold text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]"
                value={PRESET_CITIES.includes(city) ? city : "__current"}
                onChange={(e) => {
                  if (e.target.value === "__custom") setCustomCityMode(true);
                  else switchCity(e.target.value);
                }}
              >
                {!PRESET_CITIES.includes(city) && <option value="__current">{city}</option>}
                {PRESET_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="__custom">自定义城市…</option>
              </select>
              <form onSubmit={onSmartSubmit} className="flex min-w-0 flex-1 gap-2">
                <input
                  className={inputCls}
                  value={smart}
                  onChange={(e) => setSmart(e.target.value)}
                  placeholder="查线路 / 站名 / 起点 终点 / 地铁1号线"
                  aria-label="智能搜索：输入线路、站名、起点终点或地铁线路"
                  autoComplete="off"
                />
                <button type="submit" className={submitCls} disabled={!smart.trim()}>
                  搜
                </button>
              </form>
              <button
                type="button"
                onClick={() => setTab("settings")}
                aria-label="打开设置"
                className={`shrink-0 px-3 text-lg [border-radius:8px] ${
                  tab === "settings"
                    ? "bg-[var(--surface2)] font-bold text-[var(--accent)]"
                    : "bg-[var(--surface2)] text-[var(--dim)]"
                }`}
              >
                ⚙
              </button>
            </div>
          )}
        </header>

        {/* 一键开始行程：已有进行中行程时的替换确认（不静默覆盖） */}
        {pendingQuickRoute && (
          <div
            className="mt-4 border border-[var(--amber)] bg-[var(--amber-bg)] px-4 py-3 [border-radius:var(--radius)]"
            role="alertdialog"
            aria-label="已有进行中的行程，确认开始新行程"
          >
            <p className="text-sm text-[var(--text)]">
              已有进行中的行程
              {activeTrip && (
                <>
                  （{activeTrip.origin} → {activeTrip.destination}）
                </>
              )}
              。开始「{pendingQuickRoute.label}」会结束当前行程。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
                disabled={quickStartMut.isPending}
                onClick={() => quickStartMut.mutate(pendingQuickRoute)}
              >
                {quickStartMut.isPending ? "正在开始…" : "结束并开始新行程"}
              </button>
              <button
                type="button"
                className={ghostBtnCls}
                onClick={() => setPendingQuickRoute(null)}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {quickStartMut.isError && (
          <div className="mt-4">
            <ErrorBox
              message={`开始行程失败：${quickStartMut.error instanceof Error ? quickStartMut.error.message : String(quickStartMut.error)}`}
            />
          </div>
        )}

        {/* ============ 查车 ============ */}
        {tab === "home" && (
          <>
            {activeTrip && (
              <button
                type="button"
                onClick={() => setTab("trip")}
                aria-label="回到进行中的行程"
                className="mt-4 flex w-full items-center gap-2 border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-left [border-radius:var(--radius)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                  <span className="font-bold">行程进行中</span>
                  {" · "}
                  {activeTrip.origin} → {activeTrip.destination}
                  {" · 第 "}
                  {activeTrip.currentIndex + 1}/{activeTrip.segments.length} 段
                </span>
                <span className="shrink-0 text-sm font-bold text-[var(--accent)]">继续行程 ›</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setTab("canvas")}
              aria-label="打开到站画布"
              className="mt-4 flex w-full items-center gap-2 bg-[var(--accent)] px-4 py-3 text-left [border-radius:var(--radius)]"
            >
              <span className="min-w-0 flex-1 text-sm text-[var(--accent-ink)]">
                <span className="text-base font-bold">到站画布</span>
                {" · "}把常坐的车摆成一张图，连线看路线，每块单独刷新
              </span>
              <span className="shrink-0 text-sm font-bold text-[var(--accent-ink)]">打开画布 ›</span>
            </button>
            {homeMode === "query" && (
              <section aria-label="实时到站查询">
                {favRouteList.length > 0 && (
                  <div className="mt-4">
                    <SectionTitle>常用路线</SectionTitle>
                    <div className="mt-2">
                      <FavRouteChips
                        routes={favRouteList}
                        onPlan={(r) => runRoute(r.origin, r.destination)}
                        onQuickStart={quickStartTrip}
                        pendingId={quickPendingId}
                        startDisabled={quickStartMut.isPending}
                      />
                    </div>
                  </div>
                )}

                <form onSubmit={onRtSubmit} className="mt-5 space-y-3">
                  <div>
                    <label htmlFor="rt-line" className="mb-1 block text-sm text-[var(--dim)]">
                      线路（例：33、快1路、BRT、M36）
                    </label>
                    <input
                      id="rt-line"
                      className={inputCls}
                      value={rtLine}
                      onChange={(e) => setRtLine(e.target.value)}
                      placeholder="输入线路号"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label htmlFor="rt-station" className="mb-1 block text-sm text-[var(--dim)]">
                      站名（可模糊输入）
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="rt-station"
                        className={inputCls}
                        value={rtStation}
                        onChange={(e) => setRtStation(e.target.value)}
                        placeholder="输入站名"
                        autoComplete="off"
                      />
                      <button type="submit" className={submitCls} disabled={rt.isPending}>
                        {rt.isPending ? "查询中…" : "查到站"}
                      </button>
                    </div>
                  </div>
                </form>

                {rt.data && !rt.data.ok && (
                  <ErrorBox
                    message={rt.data.error}
                    onRetry={() => rtLine.trim() && rtStation.trim() && rt.mutate({ line: rtLine, station: rtStation })}
                  />
                )}
                {rt.isError && (
                  <ErrorBox message={`查询失败：${String(rt.error)}`} onRetry={() => rtLine.trim() && rtStation.trim() && rt.mutate({ line: rtLine, station: rtStation })} />
                )}
                {rt.data?.ok && (
                  <RealtimePanel
                    data={rt.data}
                    onRefresh={() => rt.mutate({ line: rt.data.line, station: rt.data.station })}
                    onForceRefresh={() => rt.mutate({ line: rt.data.line, station: rt.data.station, forceRefresh: true })}
                    refreshing={rt.isPending}
                    favActive={!!findFav("lineStation", rt.data.line, rt.data.station)}
                    onToggleFav={() => toggleFav("lineStation", rt.data.line, rt.data.station)}
                  />
                )}
              </section>
            )}

            {homeMode === "line" && (
              <section aria-label="线路详情查询">
                <button
                  type="button"
                  onClick={() => setHomeMode("query")}
                  className="mt-4 text-sm font-medium text-[var(--accent)]"
                >
                  ‹ 返回查车
                </button>
                <form onSubmit={onLineSubmit} className="mt-3">
                  <label htmlFor="line-input" className="mb-1 block text-sm text-[var(--dim)]">
                    线路号（例：33、33路、快1路、BRT、M36路）
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="line-input"
                      className={inputCls}
                      value={lineInput}
                      onChange={(e) => setLineInput(e.target.value)}
                      placeholder="输入线路号"
                      autoComplete="off"
                    />
                    <button type="submit" className={submitCls} disabled={ld.isPending}>
                      {ld.isPending ? "查询中…" : "查线路"}
                    </button>
                  </div>
                </form>

                {ld.data && !ld.data.ok && <ErrorBox message={ld.data.error} onRetry={() => lineInput.trim() && ld.mutate(lineInput)} />}
                {ld.isError && <ErrorBox message={`查询失败：${String(ld.error)}`} onRetry={() => lineInput.trim() && ld.mutate(lineInput)} />}
                {ld.data?.ok && (
                  <LineDetailPanel
                    data={ld.data}
                    dir={Math.min(ldDir, ld.data.directions.length - 1)}
                    onDir={setLdDir}
                    favActive={!!findFav("line", ld.data.line, ld.data.line)}
                    onToggleFav={() => toggleFav("line", ld.data.line, ld.data.line)}
                    onStopTap={(stop) => runRealtime(ld.data.line, stop)}
                  />
                )}
              </section>
            )}

            {homeMode === "station" && (
              <section aria-label="站点查询">
                <button
                  type="button"
                  onClick={() => setHomeMode("query")}
                  className="mt-4 text-sm font-medium text-[var(--accent)]"
                >
                  ‹ 返回查车
                </button>
                <form onSubmit={onStationSubmit} className="mt-3">
                  <label htmlFor="station-input" className="mb-1 block text-sm text-[var(--dim)]">
                    站名关键词（例：火车站、中山公园）
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="station-input"
                      className={inputCls}
                      value={stationInput}
                      onChange={(e) => setStationInput(e.target.value)}
                      placeholder="输入站名关键词"
                      autoComplete="off"
                    />
                    <button type="submit" className={submitCls} disabled={ss.isPending}>
                      {ss.isPending ? "搜索中…" : "搜站点"}
                    </button>
                  </div>
                </form>

                {ss.data && !ss.data.ok && <ErrorBox message={ss.data.error} />}
                {ss.data?.ok && ss.data.stations.length === 0 && (
                  <p className="mt-4 text-sm text-[var(--dim)]">没搜到相关站点，换个关键词试试。</p>
                )}
                {ss.data?.ok && ss.data.stations.length > 0 && (
                  <ul className="mt-4 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                    {ss.data.stations.map((s) => (
                      <li key={s.name}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-4 py-3 text-left"
                          aria-label={`查看站点 ${s.name} 的实时到站`}
                          onClick={() => openStation(s.name)}
                        >
                          <span className="text-base text-[var(--text)]">
                            {s.name}
                            {s.kind === "subway" && <span className="ml-2 text-xs text-[var(--dim)]">地铁站</span>}
                          </span>
                          <span className="text-sm text-[var(--accent)]">看全部线路到站 ›</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {sa.isPending && <p className="mt-6 text-sm text-[var(--dim)]">正在查「{saStation}」的实时到站…</p>}
                {sa.data && !sa.data.ok && <ErrorBox message={sa.data.error} onRetry={() => saStation && sa.mutate({ station: saStation })} />}
                {sa.data?.ok && (
                  <StationArrivalsPanel
                    data={sa.data}
                    onRefresh={() => sa.mutate({ station: sa.data.station })}
                    onForceRefresh={() => sa.mutate({ station: sa.data.station, forceRefresh: true })}
                    refreshing={sa.isPending}
                    favActive={!!findFav("station", sa.data.station, sa.data.station)}
                    onToggleFav={() => toggleFav("station", sa.data.station, sa.data.station)}
                    onLineTap={(line) => runRealtime(line, sa.data.station)}
                  />
                )}
              </section>
            )}
          </>
        )}

        {/* ============ 路线规划 ============ */}
        {tab === "route" && (
          <section aria-label="路线规划">
            <form onSubmit={onRouteSubmit} className="mt-5 space-y-3">
              <div>
                <label htmlFor="route-origin" className="mb-1 block text-sm text-[var(--dim)]">起点</label>
                <PlaceChips places={placeList} fieldLabel="起点" onPick={(p) => setOrigin(p.address)} />
                <input id="route-origin" className={inputCls} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={`输入${city}的起点地名`} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="route-dest" className="mb-1 block text-sm text-[var(--dim)]">终点</label>
                <PlaceChips places={placeList} fieldLabel="终点" onPick={(p) => setDestination(p.address)} />
                <div className="flex gap-2">
                  <input id="route-dest" className={inputCls} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="输入终点地名" autoComplete="off" />
                  <button
                    type="button"
                    aria-label="交换起点和终点"
                    className={ghostBtnCls}
                    onClick={() => { setOrigin(destination); setDestination(origin); }}
                  >
                    ⇅ 交换
                  </button>
                  <button type="submit" className={submitCls} disabled={rp.isPending}>
                    {rp.isPending ? "规划中…" : "规划"}
                  </button>
                </div>
              </div>
              <div>
                <button
                  type="button"
                  onClick={toggleCurrentRouteFav}
                  disabled={!origin.trim() || !destination.trim() || addFavRoute.isPending || removeFavRoute.isPending}
                  aria-label={currentRouteFav ? "取消收藏这条路线" : "收藏这条路线为常用路线"}
                  className={`px-3 py-1.5 text-sm [border-radius:8px] disabled:opacity-50 ${
                    currentRouteFav
                      ? "bg-[var(--surface2)] font-bold text-[var(--text)]"
                      : "bg-[var(--surface2)] text-[var(--dim)]"
                  }`}
                >
                  {currentRouteFav ? "★ 已收藏为常用路线" : "☆ 收藏这条路线"}
                </button>
              </div>
            </form>

            {favRouteList.length > 0 && (
              <div className="mt-4">
                <SectionTitle>常用路线</SectionTitle>
                <div className="mt-2">
                  <FavRouteChips
                    routes={favRouteList}
                    onPlan={(r) => runRoute(r.origin, r.destination)}
                    onQuickStart={quickStartTrip}
                    pendingId={quickPendingId}
                    startDisabled={quickStartMut.isPending}
                  />
                </div>
              </div>
            )}

            <div className="mt-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!origin.trim()}
                  onClick={() => { setSavePlaceTarget(savePlaceTarget === "origin" ? null : "origin"); setSavePlaceName(""); }}
                  aria-label="把当前起点存为常用地点"
                  className="bg-[var(--surface2)] px-3 py-1.5 text-sm text-[var(--text)] [border-radius:8px] disabled:opacity-50"
                >
                  ☆ 把起点存为常用地点
                </button>
                <button
                  type="button"
                  disabled={!destination.trim()}
                  onClick={() => { setSavePlaceTarget(savePlaceTarget === "destination" ? null : "destination"); setSavePlaceName(""); }}
                  aria-label="把当前终点存为常用地点"
                  className="bg-[var(--surface2)] px-3 py-1.5 text-sm text-[var(--text)] [border-radius:8px] disabled:opacity-50"
                >
                  ☆ 把终点存为常用地点
                </button>
              </div>
              {savePlaceTarget && (
                <div className="mt-3 border border-[var(--border)] bg-[var(--surface)] px-4 py-3 [border-radius:var(--radius)]">
                  <p className="text-sm text-[var(--dim)]">
                    给「{savePlaceTarget === "origin" ? origin.trim() : destination.trim()}」起个名字：
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {["家", "公司", "学校", "车站"].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setSavePlaceName(n)}
                        aria-label={`用「${n}」作为常用地点名字`}
                        className={`px-3 py-1 text-sm [border-radius:999px] ${savePlaceName === n ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]" : "bg-[var(--surface2)] text-[var(--text)]"}`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      className={inputCls}
                      value={savePlaceName}
                      onChange={(e) => setSavePlaceName(e.target.value)}
                      placeholder="输入名字，如：家、公司、孩子学校"
                      aria-label="常用地点名字"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      disabled={!savePlaceName.trim() || addPlace.isPending}
                      onClick={() => {
                        addPlace.mutate(
                          {
                            name: savePlaceName.trim(),
                            address: savePlaceTarget === "origin" ? origin.trim() : destination.trim(),
                          },
                          { onSuccess: () => setSavePlaceTarget(null) },
                        );
                      }}
                      className={submitCls}
                    >
                      保存
                    </button>
                    <button type="button" className={ghostBtnCls} onClick={() => setSavePlaceTarget(null)}>
                      取消
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--dim)]">同名再保存会更新那个地点的地址。</p>
                </div>
              )}
            </div>

            {rp.data && !rp.data.ok && <ErrorBox message={rp.data.error} onRetry={() => origin.trim() && destination.trim() && rp.mutate({ origin, destination })} />}
            {rp.isError && <ErrorBox message={`规划失败：${String(rp.error)}`} />}
            {rp.data?.ok && (
              <RoutePlansPanel
                data={rp.data}
                city={city}
                onStartTrip={startTrip}
                starting={startTripMut.isPending}
                hasActiveTrip={!!activeTrip}
                onToCanvas={planToCanvas}
                toCanvasPending={toCanvasMut.isPending}
                toCanvasError={toCanvasMut.isError ? `转到画布失败：${String(toCanvasMut.error)}` : ""}
              />
            )}
            {startTripMut.isError && <ErrorBox message={`开始行程失败：${String(startTripMut.error)}`} />}
          </section>
        )}

        {/* ============ 附近站点 ============ */}
        {tab === "nearby" && (
          <section aria-label="附近站点">
            <p className="mt-5 text-sm text-[var(--dim)]">
              用手机定位找你身边最近的公交站（1.5 公里内，按距离排），点一个站直接看它的实时到站。定位只在这一次点击时请求，不会持续跟踪。
            </p>
            <button
              type="button"
              onClick={findNearby}
              disabled={locating || nb.isPending}
              className="mt-3 w-full bg-[var(--accent)] px-5 py-2.5 font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
            >
              {locating ? "定位中…" : nb.isPending ? "搜索附近站点中…" : "定位并查找附近站点"}
            </button>

            {locError && <ErrorBox message={locError} />}
            {nb.data && !nb.data.ok && <ErrorBox message={nb.data.error} onRetry={findNearby} />}
            {nb.isError && <ErrorBox message={`搜索失败：${String(nb.error)}`} onRetry={findNearby} />}
            {nb.data?.ok && nb.data.stations.length === 0 && (
              <p className="mt-4 text-sm text-[var(--dim)]">1.5 公里内没搜到公交站，换个位置再试试。</p>
            )}
            {nb.data?.ok && nb.data.stations.length > 0 && (
              <ul className="mt-4 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                {nb.data.stations.map((s) => (
                  <li key={s.name}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                      aria-label={`查看站点 ${s.name} 的实时到站`}
                      onClick={() => openStation(s.name)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-[var(--text)]">{s.name}</span>
                        {s.lines && (
                          <span className="block truncate text-xs text-[var(--dim)]">{s.lines}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-sm font-bold text-[var(--text)]">
                        {s.distance < 1000 ? `${Math.round(s.distance)} 米` : `${(s.distance / 1000).toFixed(1)} 公里`}
                      </span>
                      <span className="shrink-0 text-sm text-[var(--accent)]">到站 ›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ============ 地铁 ============ */}
        {tab === "metro" && (
          <section aria-label={`${city}地铁信息`} className="mt-5 space-y-3">
            {metro.isPending && (
              <p className="text-sm text-[var(--dim)]">正在整理{city}的地铁线路…</p>
            )}
            {metro.data && !metro.data.ok && (
              <ErrorBox message={metro.data.error} onRetry={() => metro.refetch()} />
            )}
            {metro.isError && (
              <ErrorBox message={`地铁数据加载失败：${String(metro.error)}`} onRetry={() => metro.refetch()} />
            )}
            {metro.data?.ok && metro.data.lines.length === 0 && (
              <p className="text-sm text-[var(--dim)]">
                没有查到{city}的地铁线路数据（这个城市可能还没有开通地铁，或高德暂未收录）。
              </p>
            )}
            {metro.data?.ok &&
              metro.data.lines.map((m) => (
                <article key={m.name} className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 [border-radius:var(--radius)]">
                  <div className="flex items-baseline gap-2">
                    <LineBadge name={m.name} />
                    {m.route && <span className="min-w-0 text-base font-medium text-[var(--text)]">{m.route}</span>}
                  </div>
                  <dl className="mt-2 space-y-1 text-sm text-[var(--dim)]">
                    {m.hours && (
                      <div className="flex gap-2"><dt className="shrink-0">首末班</dt><dd className="text-[var(--text)]">{m.hours}</dd></div>
                    )}
                    {m.interval && (
                      <div className="flex gap-2"><dt className="shrink-0">发车间隔</dt><dd className="text-[var(--text)]">{m.interval}</dd></div>
                    )}
                    {m.note && (
                      <div className="flex gap-2"><dt className="shrink-0">备注</dt><dd>{m.note}</dd></div>
                    )}
                  </dl>
                </article>
              ))}
            {metro.data?.ok && metro.data.lines.length > 0 && metro.data.source === "amap" && (
              <p className="text-xs text-[var(--dim)]">线路数据由高德地图整理，服务端已缓存，不会每次打开都重新查询。</p>
            )}
          </section>
        )}

        {/* ============ 收藏 ============ */}
        {tab === "favorites" && (
          <section aria-label="我的收藏" className="mt-5">
            <p className="text-sm text-[var(--dim)]">{city}的收藏，点一条直接查询。</p>

            <button
              type="button"
              onClick={() => setTab("canvas")}
              aria-label="打开到站画布"
              className="mt-3 flex w-full items-center gap-2 border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-left [border-radius:var(--radius)]"
            >
              <span className="min-w-0 flex-1 text-sm text-[var(--text)]">
                <span className="font-bold">到站画布</span>
                {" · "}把收藏的车摆到画布上连线看
              </span>
              <span className="shrink-0 text-sm font-bold text-[var(--accent)]">打开画布 ›</span>
            </button>

            <BoardSection
              city={city}
              favorites={favList}
              onOpenLineStation={(line, station) => runRealtime(line, station)}
              onOpenStation={(name) => openStation(name)}
            />

            <div className="mt-8">
              <SectionTitle>线路与站点</SectionTitle>
              {favList.length === 0 ? (
                <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                  还没有收藏。在查车结果里点「☆ 收藏」，线路、站点和「线路+站点」都会收进这里。
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                  {favList.map((f) => (
                    <li key={f.id} className="flex items-center">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3 text-left"
                        aria-label={`查询收藏 ${f.kind === "line" ? f.value : f.kind === "station" ? f.label : `${f.value} ${f.label}`}`}
                        onClick={() => openFavorite(f)}
                      >
                        {f.kind === "line" && <LineBadge name={f.value} />}
                        {f.kind === "lineStation" && <LineBadge name={f.value} />}
                        <span className="min-w-0 truncate text-base text-[var(--text)]">
                          {f.kind === "line" && "线路详情"}
                          {f.kind === "station" && f.label}
                          {f.kind === "lineStation" && `在 ${f.label} 的到站`}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`删除收藏 ${f.value} ${f.label}`}
                        className="shrink-0 px-3.5 text-lg text-[var(--dim)]"
                        onClick={() => removeFav.mutate(f.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-8">
              <SectionTitle>常用路线</SectionTitle>
              {favRouteList.length === 0 ? (
                <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                  还没有常用路线。在「规划」里查好一条路线，点「☆ 收藏这条路线」就会出现在这里。
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                  {favRouteList.map((r) => (
                    <li key={r.id} className="flex items-center">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate px-4 py-3 text-left text-base text-[var(--text)]"
                        aria-label={`规划常用路线 ${r.label}`}
                        onClick={() => runRoute(r.origin, r.destination)}
                      >
                        {r.label}
                      </button>
                      <button
                        type="button"
                        aria-label={`按常用路线 ${r.label} 开始行程`}
                        className="shrink-0 bg-[var(--surface2)] px-2.5 py-1 text-sm font-bold whitespace-nowrap text-[var(--accent)] [border-radius:999px] disabled:opacity-50"
                        disabled={quickStartMut.isPending}
                        onClick={() => quickStartTrip(r)}
                      >
                        {quickPendingId === r.id ? "规划中…" : "开始行程"}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除常用路线 ${r.label}`}
                        className="shrink-0 px-3.5 text-lg text-[var(--dim)]"
                        onClick={() => removeFavRoute.mutate(r.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-8">
              <SectionTitle>常用地点</SectionTitle>
              {placeList.length === 0 ? (
                <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                  还没有常用地点。在「规划」里输入地点后点「☆ 把起点/终点存为常用地点」，下次点一下名字就能填好。
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                  {placeList.map((p) => (
                    <li key={p.id} className="flex items-center gap-1.5 px-4 py-3.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-bold text-[var(--text)]">{p.name}</span>
                        <span className="block truncate text-sm text-[var(--dim)]">{p.address}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`把${p.name}设为起点并去规划`}
                        className="shrink-0 bg-[var(--surface2)] px-2.5 py-1 text-sm font-medium text-[var(--accent)] [border-radius:999px]"
                        onClick={() => { setOrigin(p.address); setTab("route"); }}
                      >
                        设起点
                      </button>
                      <button
                        type="button"
                        aria-label={`把${p.name}设为终点并去规划`}
                        className="shrink-0 bg-[var(--surface2)] px-2.5 py-1 text-sm font-medium text-[var(--accent)] [border-radius:999px]"
                        onClick={() => { setDestination(p.address); setTab("route"); }}
                      >
                        设终点
                      </button>
                      <button
                        type="button"
                        aria-label={`删除常用地点 ${p.name}`}
                        className="shrink-0 px-2.5 text-lg text-[var(--dim)]"
                        onClick={() => removePlace.mutate(p.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {/* ============ 行程模式 ============ */}
        {tab === "trip" && (
          tripFinished ? (
            <section aria-label="行程完成" className="mt-10 text-center">
              <p className="text-3xl font-bold text-[var(--text)]">已到达目的地</p>
              <p className="mt-2 text-sm text-[var(--dim)]">这趟行程结束了，辛苦啦。</p>
              <button
                type="button"
                onClick={() => { setTripFinished(false); setTab("home"); }}
                className="mt-6 bg-[var(--accent)] px-6 py-2.5 font-bold text-[var(--accent-ink)] [border-radius:8px]"
              >
                返回查车
              </button>
            </section>
          ) : activeTrip ? (
            <TripPanel
              trip={activeTrip}
              onAdvance={() => advanceTripMut.mutate()}
              advancing={advanceTripMut.isPending}
              advanceError={advanceTripMut.isError ? `推进失败：${String(advanceTripMut.error)}` : ""}
              onEnd={() => endTripMut.mutate()}
              ending={endTripMut.isPending}
              onBack={() => setTab("home")}
              onToCanvas={tripToCanvas}
              toCanvasPending={toCanvasMut.isPending}
              toCanvasError={toCanvasMut.isError ? `转到画布失败：${String(toCanvasMut.error)}` : ""}
            />
          ) : (
            <section aria-label="行程模式" className="mt-10 text-center">
              <p className="text-base text-[var(--text)]">现在没有进行中的行程</p>
              <p className="mt-2 text-sm text-[var(--dim)]">在「规划」里查好路线，点方案上的「开始行程」就会进入行程模式。</p>
              <button
                type="button"
                onClick={() => setTab("route")}
                className="mt-5 bg-[var(--accent)] px-6 py-2.5 font-bold text-[var(--accent-ink)] [border-radius:8px]"
              >
                去规划路线
              </button>
            </section>
          )
        )}

        {/* ============ 画布 ============ */}
        {tab === "canvas" && (
          <CanvasView city={city} onBack={() => setTab("home")} focus={canvasFocus} />
        )}

        {/* ============ 设置 ============ */}
        {tab === "settings" && (
          <SettingsPanel
            city={city}
            onBack={() => setTab("home")}
            onPickCity={(c) => switchCity(c)}
          />
        )}

        <footer className="mt-10 text-center text-xs text-[var(--dim)]">
          实时数据来自公交实时接口 · 路线规划由高德地图提供
        </footer>
      </main>

      {/* 底部主导航 */}
      <nav
        aria-label="主导航"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--surface)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex w-full max-w-2xl">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`flex-1 py-3 text-base ${
                tab === t.id
                  ? "font-bold text-[var(--accent)] shadow-[inset_0_2px_0_0_var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ---------- panels ----------

// 站牌卡上的一班车摘要：还有 N 站 · 约 M 分钟（有什么显示什么）
function boardHeadline(bus: BusInfo): string {
  if (bus.stopsRemaining === 0) return "即将到站";
  const parts: string[] = [];
  if (bus.stopsRemaining != null) parts.push(`还有 ${bus.stopsRemaining} 站`);
  if (bus.travelMinutes != null) parts.push(`约 ${bus.travelMinutes} 分钟`);
  return parts.length > 0 ? parts.join(" · ") : "有车在途";
}

// 「我的站牌」：收藏里的 lineStation 与 station 各成一张卡。打开页面不
// 自动调接口——先向服务端要一份只读缓存快照（getBoardSnapshot），有
// 缓存的卡直接显示并标数据时间，没缓存的卡是「点查」状态；每张卡各自
// 刷新，只查自己那一张（继续吃服务端缓存），不做一键全刷。
function BoardSection({
  city,
  favorites,
  onOpenLineStation,
  onOpenStation,
}: {
  city: string;
  favorites: Favorite[];
  onOpenLineStation: (line: string, station: string) => void;
  onOpenStation: (station: string) => void;
}) {
  const boardFavs = favorites.filter(
    (f) => f.kind === "lineStation" || f.kind === "station",
  );
  const snapshot = useQuery({
    queryKey: ["boardSnapshot", city, boardFavs.map((f) => f.id).join(",")],
    queryFn: () =>
      api.getBoardSnapshot({
        city,
        items: boardFavs.map((f) => ({
          id: f.id,
          kind: f.kind as "lineStation" | "station",
          value: f.value,
          label: f.label,
        })),
      }),
    enabled: boardFavs.length > 0,
  });
  const entryOf = (id: number) => snapshot.data?.entries.find((e) => e.id === id);

  return (
    <div className="mt-5">
      <SectionTitle>我的站牌</SectionTitle>
      {boardFavs.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
          在实时到站页点「☆ 收藏」线路+站点，这里就会变成你的站牌；收藏整个站点也会生成一张站牌卡。
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-[var(--dim)]">
            打开不自动查询：有缓存先看缓存，每张卡点刷新只查它自己。
          </p>
          <div className="mt-3 space-y-3">
            {boardFavs.map((f) => (
              <BoardCard
                key={f.id}
                fav={f}
                city={city}
                entry={entryOf(f.id)}
                onOpen={() =>
                  f.kind === "lineStation"
                    ? onOpenLineStation(f.value, f.label)
                    : onOpenStation(f.label)
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BoardCard({
  fav,
  city,
  entry,
  onOpen,
}: {
  fav: Favorite;
  city: string;
  entry: BoardEntry | undefined;
  onOpen: () => void;
}) {
  const isLineStation = fav.kind === "lineStation";
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: fav.value, station: fav.label, city }),
  });
  const saM = useMutation({
    mutationFn: () => api.queryStationArrivals({ station: fav.label, city }),
  });
  const rtData: RealtimeResult | null =
    rtM.data?.ok ? rtM.data : (entry?.realtime ?? null);
  const saData: StationArrivalsResult | null =
    saM.data?.ok ? saM.data : (entry?.arrivals ?? null);
  const loaded = isLineStation ? rtData : saData;
  const pending = rtM.isPending || saM.isPending;
  const error =
    (rtM.data && !rtM.data.ok ? rtM.data.error : "") ||
    (saM.data && !saM.data.ok ? saM.data.error : "") ||
    (rtM.isError ? `查询失败：${String(rtM.error)}` : "") ||
    (saM.isError ? `查询失败：${String(saM.error)}` : "");
  const refresh = () => (isLineStation ? rtM.mutate() : saM.mutate());

  const stationRows = saData
    ? saData.directions.flatMap((d) => d.lines.map((ln) => ({ dir: d.direction, ln })))
    : [];

  return (
    <article className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 [border-radius:var(--radius)]">
      <div className="flex items-center gap-2">
        {isLineStation && <LineBadge name={fav.value} />}
        <button
          type="button"
          onClick={onOpen}
          aria-label={
            isLineStation
              ? `查看 ${fav.value} 在 ${fav.label} 的实时到站详情`
              : `查看站点 ${fav.label} 的全部线路到站`
          }
          className="min-w-0 flex-1 truncate text-left text-base font-bold text-[var(--text)]"
        >
          {fav.label}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={pending}
          aria-label={
            loaded
              ? `刷新站牌 ${isLineStation ? `${fav.value} ${fav.label}` : fav.label}`
              : `查询站牌 ${isLineStation ? `${fav.value} ${fav.label}` : fav.label} 的实时到站`
          }
          className="shrink-0 bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
        >
          {pending ? "查询中…" : loaded ? "刷新" : "点查"}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      {!loaded && !error && (
        <p className="mt-2 text-sm text-[var(--dim)]">还没查过，点「点查」看现在有没有车。</p>
      )}

      {isLineStation && rtData && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`查看 ${fav.value} 在 ${fav.label} 的全部班次`}
          className="mt-2 block w-full text-left"
        >
          <ul className="space-y-1.5">
            {rtData.directions.map((d) => {
              const next = d.buses[0];
              return (
                <li key={d.direction} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-[var(--dim)]">
                    开往 {d.terminal || "—"}
                  </span>
                  <span className="shrink-0 text-lg font-bold text-[var(--text)]">
                    {d.error ? "查询失败" : next ? boardHeadline(next) : "暂无车"}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            数据时间 {rtData.queriedAt}
            {rtData.cached ? " · 缓存" : ""} · 点卡片看全部班次
          </p>
        </button>
      )}

      {!isLineStation && saData && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`查看站点 ${fav.label} 的全部线路到站`}
          className="mt-2 block w-full text-left"
        >
          {stationRows.length === 0 ? (
            <p className="text-sm text-[var(--dim)]">这个站暂无线路数据</p>
          ) : (
            <ul className="space-y-1.5">
              {stationRows.slice(0, 6).map(({ dir, ln }, i) => {
                const next = ln.buses[0];
                return (
                  <li key={`${dir}-${ln.line}-${i}`} className="flex items-center gap-2">
                    <LineBadge name={ln.line} />
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--dim)]">
                      开往 {ln.terminal || "—"}
                    </span>
                    <span className="shrink-0 text-base font-bold text-[var(--text)]">
                      {next ? boardHeadline(next) : "暂无车"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {stationRows.length > 6 && (
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              还有 {stationRows.length - 6} 条线路，点卡片查看全部
            </p>
          )}
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            数据时间 {saData.queriedAt}
            {saData.cached ? " · 缓存" : ""}
          </p>
        </button>
      )}
    </article>
  );
}

function busHeadline(bus: BusInfo): string {
  if (bus.stopsRemaining === 0) return "即将到站";
  if (bus.travelMinutes != null) return `约 ${bus.travelMinutes} 分钟`;
  if (bus.stopsRemaining != null) return `剩 ${bus.stopsRemaining} 站`;
  return "有车在途";
}

function busDetail(bus: BusInfo): string {
  const parts: string[] = [];
  if (bus.stopsRemaining != null && bus.stopsRemaining > 0) parts.push(`剩 ${bus.stopsRemaining} 站`);
  if (bus.arrivalTime) parts.push(`预计 ${bus.arrivalTime}到`);
  if (bus.busId) parts.push(bus.busId);
  return parts.join(" · ");
}

function ResultHeader({
  title,
  badge,
  meta,
  favActive,
  favLabel,
  onToggleFav,
  onRefresh,
  onForceRefresh,
  refreshing,
}: {
  title: string;
  badge?: string;
  meta: string;
  favActive: boolean;
  favLabel: string;
  onToggleFav: () => void;
  onRefresh: () => void;
  onForceRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {badge && <LineBadge name={badge} />}
        <h2 className="min-w-0 flex-1 truncate text-xl font-bold text-[var(--text)]">{title}</h2>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">{meta}</p>
      <div className="mt-3 flex gap-2">
        <FavButton active={favActive} onClick={onToggleFav} label={favLabel} />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="刷新实时到站"
          className="shrink-0 bg-[var(--accent)] px-3.5 font-medium text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
        <button
          type="button"
          onClick={onForceRefresh}
          disabled={refreshing}
          aria-label="强制刷新实时到站（重新调用接口）"
          className="shrink-0 bg-[var(--surface2)] px-3 font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
        >
          强制刷新
        </button>
      </div>
    </div>
  );
}

function RealtimePanel({
  data,
  onRefresh,
  onForceRefresh,
  refreshing,
  favActive,
  onToggleFav,
}: {
  data: RealtimeResult;
  onRefresh: () => void;
  onForceRefresh: () => void;
  refreshing: boolean;
  favActive: boolean;
  onToggleFav: () => void;
}) {
  return (
    <div className="mt-6">
      <ResultHeader
        badge={data.line}
        title={data.station}
        meta={`数据时间 ${data.queriedAt}${data.cached ? " · 缓存（不重复调接口）" : ""}`}
        favActive={favActive}
        favLabel={`收藏 ${data.line} 在 ${data.station} 的到站查询`}
        onToggleFav={onToggleFav}
        onRefresh={onRefresh}
        onForceRefresh={onForceRefresh}
        refreshing={refreshing}
      />

      <div className="mt-5 space-y-6">
        {data.directions.map((d) => {
          const [nextBus, ...restBuses] = d.buses;
          return (
            <section
              key={d.direction}
              aria-label={`开往 ${d.terminal || "未知方向"}`}
              className="border border-[var(--border)] bg-[var(--surface)] px-4 py-4 [border-radius:var(--radius)]"
            >
              <h3 className="text-base font-bold text-[var(--text)]">开往 {d.terminal || "—"}</h3>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                {[
                  d.nextStop ? `下一站 ${d.nextStop}` : "",
                  d.firstTime || d.lastTime ? `首班 ${d.firstTime} / 末班 ${d.lastTime}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {d.error ? (
                <p className="mt-3 text-sm text-[var(--danger)]">这个方向查询失败：{d.error}</p>
              ) : !nextBus ? (
                <p className="mt-3 text-sm text-[var(--dim)]">暂无车辆信息（可能尚未发车或已收班）</p>
              ) : (
                <>
                  <div className="mt-3">
                    <p className="text-3xl font-bold text-[var(--text)]">{busHeadline(nextBus)}</p>
                    {busDetail(nextBus) && (
                      <p className="mt-1 text-sm text-[var(--dim)]">下一班 · {busDetail(nextBus)}</p>
                    )}
                  </div>
                  {restBuses.length > 0 && (
                    <ul className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
                      {restBuses.map((b, i) => (
                        <li key={`${b.busId}-${i}`} className="flex items-baseline justify-between gap-3 py-2">
                          <span className="text-base text-[var(--text)]">{busHeadline(b)}</span>
                          <span className="shrink-0 text-xs text-[var(--dim)]">{busDetail(b)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function LineDetailPanel({
  data,
  dir,
  onDir,
  favActive,
  onToggleFav,
  onStopTap,
}: {
  data: LineDetailResult;
  dir: number;
  onDir: (d: number) => void;
  favActive: boolean;
  onToggleFav: () => void;
  onStopTap: (stop: string) => void;
}) {
  const current = data.directions[dir] ?? data.directions[0];
  if (!current) return null;
  return (
    <div className="mt-5">
      <div className="flex items-center gap-2">
        <LineBadge name={data.line} />
        <h2 className="min-w-0 flex-1 truncate text-xl font-bold text-[var(--text)]">
          {current.start} ↔ {current.end}
        </h2>
        <FavButton active={favActive} onClick={onToggleFav} label={`收藏线路 ${data.line}`} />
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        首班 {current.firstTime} · 末班 {current.lastTime} · 票价 {current.price || "未知"} · 共 {current.stopCount} 站
      </p>

      {data.directions.length > 1 && (
        <div className="mt-4 flex gap-2" role="group" aria-label="选择方向">
          {data.directions.map((d, i) => (
            <button
              key={d.direction}
              type="button"
              onClick={() => onDir(i)}
              aria-pressed={i === dir}
              className={`flex-1 px-3 py-2 text-sm [border-radius:8px] ${
                i === dir
                  ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                  : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
              }`}
            >
              往 {d.end}
            </button>
          ))}
        </div>
      )}

      <p className="mt-5 text-xs text-[var(--dim)]">点任意站点，直接查这条线在该站的实时到站：</p>
      <ol className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-2 py-1 [border-radius:var(--radius)]">
        {current.stops.map((stop, i) => (
          <li key={`${stop}-${i}`}>
            <button
              type="button"
              onClick={() => onStopTap(stop)}
              aria-label={`查 ${data.line} 在 ${stop} 的实时到站`}
              className="flex w-full items-center gap-3 px-2 py-2 text-left"
            >
              <span className="w-6 shrink-0 text-right text-xs text-[var(--dim)]">{i + 1}</span>
              <span className={`h-2 w-2 shrink-0 rounded-full ${i === 0 || i === current.stops.length - 1 ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`} />
              <span className="flex-1 text-base text-[var(--text)]">{stop}</span>
              <span className="text-sm text-[var(--accent)]">到站 ›</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StationArrivalsPanel({
  data,
  onRefresh,
  onForceRefresh,
  refreshing,
  favActive,
  onToggleFav,
  onLineTap,
}: {
  data: StationArrivalsResult;
  onRefresh: () => void;
  onForceRefresh: () => void;
  refreshing: boolean;
  favActive: boolean;
  onToggleFav: () => void;
  onLineTap: (line: string) => void;
}) {
  return (
    <div className="mt-6">
      <ResultHeader
        title={data.station}
        meta={`数据时间 ${data.queriedAt} · 点线路看该线双向详情${data.cached ? " · 缓存（不重复调接口）" : ""}`}
        favActive={favActive}
        favLabel={`收藏站点 ${data.station}`}
        onToggleFav={onToggleFav}
        onRefresh={onRefresh}
        onForceRefresh={onForceRefresh}
        refreshing={refreshing}
      />

      <div className="mt-5 space-y-6">
        {data.directions.map((d) => (
          <section key={d.direction} aria-label={`方向 ${d.direction === 1 ? "一" : "二"}`}>
            <SectionTitle>{`方向 ${d.direction === 1 ? "一" : "二"}`}</SectionTitle>
            {d.error ? (
              <p className="mt-2 text-sm text-[var(--danger)]">查询失败：{d.error}</p>
            ) : d.lines.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--dim)]">这个方向暂无线路数据</p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                {d.lines.map((ln) => {
                  const next = ln.buses[0];
                  return (
                    <li key={ln.line}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 px-3 py-3 text-left"
                        aria-label={`查 ${ln.line} 在 ${data.station} 的双向实时到站`}
                        onClick={() => onLineTap(ln.line)}
                      >
                        <LineBadge name={ln.line} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[var(--text)]">
                            开往 {ln.terminal || "—"}
                            {ln.nextStop && <span className="text-[var(--dim)]"> · 下一站 {ln.nextStop}</span>}
                          </span>
                          <span className="block text-xs text-[var(--dim)]">首班 {ln.firstTime} / 末班 {ln.lastTime}</span>
                        </span>
                        <span className={`shrink-0 text-base font-bold ${next?.stopsRemaining === 0 ? "text-[var(--amber)]" : "text-[var(--text)]"}`}>
                          {next
                            ? next.stopsRemaining === 0
                              ? "即将到站"
                              : next.stopsRemaining != null
                                ? `剩 ${next.stopsRemaining} 站${next.travelMinutes != null ? ` · 约${next.travelMinutes}分` : ""}`
                                : next.travelMinutes != null
                                  ? `约 ${next.travelMinutes} 分钟`
                                  : "有车"
                            : "暂无车"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

const CIRCLES = "①②③④⑤⑥⑦⑧⑨⑩";

// 常用路线快捷横排（首页与规划页共用）：点路线名去规划，点「开始行程」
// 一键按最优方案开始行程。pendingId 是正在自动规划的那条路线 id。
function FavRouteChips({
  routes,
  onPlan,
  onQuickStart,
  pendingId,
  startDisabled,
}: {
  routes: FavRoute[];
  onPlan: (r: FavRoute) => void;
  onQuickStart: (r: FavRoute) => void;
  pendingId: number | null;
  startDisabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-2">
      {routes.map((r) => (
        <span key={r.id} className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] [border-radius:999px]"
            aria-label={`规划常用路线 ${r.label}`}
            onClick={() => onPlan(r)}
          >
            {r.label}
          </button>
          <button
            type="button"
            className="px-1.5 py-2 text-sm font-bold whitespace-nowrap text-[var(--accent)] disabled:opacity-50"
            aria-label={`按常用路线 ${r.label} 开始行程`}
            disabled={startDisabled}
            onClick={() => onQuickStart(r)}
          >
            {pendingId === r.id ? "规划中…" : "开始行程"}
          </button>
        </span>
      ))}
    </div>
  );
}

function PlaceChips({
  places,
  fieldLabel,
  onPick,
}: {
  places: FavPlace[];
  fieldLabel: string;
  onPick: (p: FavPlace) => void;
}) {
  if (places.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {places.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          aria-label={`把常用地点${p.name}（${p.address}）填为${fieldLabel}`}
          className="border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm text-[var(--text)] [border-radius:999px]"
        >
          {p.name}
          <span className="ml-1 text-xs text-[var(--dim)]">{p.address}</span>
        </button>
      ))}
    </div>
  );
}

function RoutePlansPanel({
  data,
  city,
  onStartTrip,
  starting,
  hasActiveTrip,
  onToCanvas,
  toCanvasPending,
  toCanvasError,
}: {
  data: RoutePlanResult;
  city: string;
  onStartTrip: (plan: RoutePlan) => void;
  starting: boolean;
  hasActiveTrip: boolean;
  onToCanvas: (plan: RoutePlan) => void;
  toCanvasPending: boolean;
  toCanvasError: string;
}) {
  const walk = useWalkTimes(city);
  return (
    <div className="mt-6 space-y-3">
      {data.plans.map((p, i) => {
        let rideNo = 0;
        return (
          <article key={i} className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 [border-radius:var(--radius)]">
            <p className="text-lg font-bold text-[var(--text)]">
              约 {p.durationMin} 分钟
              {p.best && <span className="ml-2 text-sm font-bold text-[var(--amber)]">最优</span>}
            </p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              方案 {i + 1} · 步行约 {p.walking} 米{p.cost && p.cost !== "0" && p.cost !== "?" ? ` · 票价约 ${p.cost} 元` : ""}
            </p>
            <ol className="mt-2 space-y-1.5">
              {p.segments.map((s, j) => {
                if (s.type === "步行") {
                  const dist = Number(s.walkDistance) || 0;
                  const between =
                    hasRideBefore(p.segments, j) &&
                    p.segments.slice(j + 1).some((x) => x.type !== "步行");
                  // 没有距离又不是换乘步行（高德的占位步行段）不占行
                  if (dist <= 0 && !between) return null;
                  const pt = walkPointOf(p.segments, j);
                  const eff = walk.effective(
                    pt.station,
                    pt.nextLine,
                    defaultWalkMinutes(dist),
                  );
                  return (
                    <li
                      key={j}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6"
                    >
                      <span className="text-sm text-[var(--dim)]">
                        {between ? "换乘步行" : "步行"}
                        {dist > 0 ? `约 ${dist} 米 ·` : " ·"}
                      </span>
                      <WalkTimeControl
                        minutes={eff.minutes}
                        isCustom={eff.isCustom}
                        onChange={(m) => walk.setMinutes(pt.station, pt.nextLine, m)}
                        label={
                          pt.station
                            ? `${pt.station}${pt.nextLine ? `换乘${pt.nextLine}` : "步行"}`
                            : "步行段"
                        }
                      />
                    </li>
                  );
                }
                rideNo += 1;
                const direct = isDirectTransfer(p.segments, j);
                const effDirect = direct
                  ? walk.effective(s.departure, s.name, 0)
                  : null;
                return (
                  <li key={j} className="text-base text-[var(--text)]">
                    <span className="mr-1.5 text-[var(--accent)]">{CIRCLES[rideNo - 1] ?? `${rideNo}.`}</span>
                    {s.departure ? `${s.departure}${s.departure.endsWith("站") ? "" : "站"}` : "起点"} 坐
                    <span className="font-bold"> {s.name} </span>→{" "}
                    {s.arrival ? `${s.arrival}${s.arrival.endsWith("站") ? "" : "站"}` : "终点"} 下车
                    {direct && effDirect && (
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
                        <span className="text-sm text-[var(--dim)]">
                          同站换乘（可能要过街）·
                        </span>
                        <WalkTimeControl
                          minutes={effDirect.minutes}
                          isCustom={effDirect.isCustom}
                          onChange={(m) => walk.setMinutes(s.departure, s.name, m)}
                          label={`${s.departure}换乘${s.name}`}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              onClick={() => onStartTrip(p)}
              disabled={starting}
              aria-label={`按方案 ${i + 1} 开始行程`}
              className="mt-3 w-full bg-[var(--accent)] px-4 py-2 font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
            >
              {starting ? "正在开始…" : "开始行程"}
            </button>
            <button
              type="button"
              onClick={() => onToCanvas(p)}
              disabled={toCanvasPending}
              aria-label={`把方案 ${i + 1} 转到画布`}
              className="mt-2 w-full border border-[var(--accent)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--accent)] [border-radius:8px] disabled:opacity-50"
            >
              {toCanvasPending ? "正在转到画布…" : "转到画布"}
            </button>
            {toCanvasError && <p className="mt-1.5 text-sm text-[var(--danger)]">{toCanvasError}</p>}
            {hasActiveTrip && (
              <p className="mt-1.5 text-xs text-[var(--dim)]">开始新行程会替换当前进行中的行程。</p>
            )}
          </article>
        );
      })}
    </div>
  );
}

// ---------- 行程模式 ----------

/** 宽裕度结论：余量 = 下一班车分钟数 − 步行分钟数。 */
function slackVerdict(margin: number): { text: string; className: string } {
  if (margin >= 3) return { text: "赶得上", className: "text-[var(--accent)]" };
  if (margin >= 0) return { text: "有点紧", className: "text-[var(--amber)]" };
  return { text: "赶不上这班", className: "text-[var(--danger)]" };
}

// 当前段的上车站实时：先只读服务端缓存快照（不调接口），有缓存先
// 显示；真查询只在用户点「查实时 / 刷新」时发生，复用 queryLineRealtime
// 的服务端缓存，不自动轮询。换乘段（isTransfer）用琥珀色醒目呈现。
// walk 传进来时（换乘接驳段，或正在走的步行段的下一段车）同时显示
// 步行时间调节与宽裕度：余量 = 下一班车还有 M 分钟 − 步行 X 分钟；
// 实时缺失/报错/班次没有分钟数时只显示步行设置，不给结论、不编造。
function TripRealtime({
  city,
  seg,
  isTransfer,
  walk,
}: {
  city: string;
  seg: TripSegment;
  isTransfer: boolean;
  walk?: {
    minutes: number;
    isCustom: boolean;
    onChange: (m: number) => void;
    label: string;
  };
}) {
  const snapshot = useQuery({
    queryKey: ["tripRtSnapshot", city, seg.name, seg.departure],
    queryFn: () =>
      api.getBoardSnapshot({
        city,
        items: [{ id: 1, kind: "lineStation", value: seg.name, label: seg.departure }],
      }),
  });
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: seg.name, station: seg.departure, city }),
  });
  const data: RealtimeResult | null = rtM.data?.ok
    ? rtM.data
    : (snapshot.data?.entries[0]?.realtime ?? null);
  const error =
    (rtM.data && !rtM.data.ok ? rtM.data.error : "") ||
    (rtM.isError ? `查询失败：${String(rtM.error)}` : "");
  const dirs = data
    ? seg.terminal
      ? data.directions.filter((d) => d.terminal === seg.terminal).length > 0
        ? data.directions.filter((d) => d.terminal === seg.terminal)
        : data.directions
      : data.directions
    : [];

  // 宽裕度：只用第一个有车且没报错的方向算；班次没有分钟数就不算
  const slackDir = dirs.find((d) => !d.error && d.buses.length > 0);
  const slackNext = slackDir?.buses[0];
  const slackSecond = slackDir?.buses[1];
  const slackMargin =
    walk && slackNext?.travelMinutes != null
      ? slackNext.travelMinutes - walk.minutes
      : null;
  const slackMargin2 =
    walk && slackMargin != null && slackMargin < 0 && slackSecond?.travelMinutes != null
      ? slackSecond.travelMinutes - walk.minutes
      : null;

  return (
    <div
      className={`mt-3 px-3.5 py-3.5 [border-radius:10px] ${
        isTransfer
          ? "border border-[var(--amber)] bg-[var(--amber-bg)]"
          : "bg-[var(--surface2)]"
      }`}
    >
      <div className="flex items-center gap-2">
        <p className={`flex-1 text-sm font-bold ${isTransfer ? "text-[var(--amber)]" : "text-[var(--text)]"}`}>
          {isTransfer ? "换乘车实时 · 别错过" : "这班车实时"} · 在{seg.departure}上车
        </p>
        <button
          type="button"
          onClick={() => rtM.mutate()}
          disabled={rtM.isPending}
          aria-label={`刷新 ${seg.name} 在 ${seg.departure} 的实时到站`}
          className="shrink-0 bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
        >
          {rtM.isPending ? "查询中…" : data ? "刷新" : "查实时"}
        </button>
      </div>
      {walk && (
        <div className="mt-2">
          <WalkTimeControl
            minutes={walk.minutes}
            isCustom={walk.isCustom}
            onChange={walk.onChange}
            label={walk.label}
          />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      {!data && !error && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          {snapshot.isPending ? "正在看有没有缓存…" : "暂时没有缓存数据，点「查实时」看这班车到哪了。"}
        </p>
      )}
      {data && (
        <>
          <ul className="mt-2 space-y-1.5">
            {dirs.map((d) => {
              const next = d.buses[0];
              return (
                <li key={d.direction} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-[var(--dim)]">
                    开往 {d.terminal || "—"}
                  </span>
                  <span className="shrink-0 text-xl font-bold text-[var(--text)]">
                    {d.error ? "查询失败" : next ? boardHeadline(next) : "暂无车"}
                  </span>
                </li>
              );
            })}
          </ul>
          {walk && slackMargin != null && slackNext?.travelMinutes != null && (
            <div className="mt-2 border-t border-[var(--border)] pt-2 text-sm">
              <p className="text-[var(--text)]">
                下一班约 {slackNext.travelMinutes} 分钟到 − 步行 {walk.minutes}{" "}
                分钟 = 余量 {slackMargin} 分钟 ·{" "}
                <span className={`font-bold ${slackVerdict(slackMargin).className}`}>
                  {slackVerdict(slackMargin).text}
                </span>
              </p>
              {slackMargin < 0 &&
                (slackMargin2 != null && slackSecond?.travelMinutes != null ? (
                  <p className="mt-1 text-[var(--text)]">
                    再下一班约 {slackSecond.travelMinutes} 分钟到 · 余量{" "}
                    {slackMargin2} 分钟 ·{" "}
                    <span
                      className={`font-bold ${slackVerdict(slackMargin2).className}`}
                    >
                      {slackVerdict(slackMargin2).text}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-[var(--dim)]">
                    暂时没有再下一班的数据
                  </p>
                ))}
            </div>
          )}
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            数据时间 {data.queriedAt}
            {data.cached ? " · 缓存" : ""} · 不自动刷新，点刷新才查
          </p>
        </>
      )}
    </div>
  );
}

function TripPanel({
  trip,
  onAdvance,
  advancing,
  advanceError,
  onEnd,
  ending,
  onBack,
  onToCanvas,
  toCanvasPending,
  toCanvasError,
}: {
  trip: ActiveTrip;
  onAdvance: () => void;
  advancing: boolean;
  advanceError: string;
  onEnd: () => void;
  ending: boolean;
  onBack: () => void;
  onToCanvas: () => void;
  toCanvasPending: boolean;
  toCanvasError: string;
}) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const walk = useWalkTimes(trip.city);
  const current = trip.segments[trip.currentIndex];
  if (!current) return null;
  const isLast = trip.currentIndex === trip.segments.length - 1;
  const isRide = current.type !== "步行";
  const advanceLabel = !isRide
    ? isLast
      ? "已走完 · 完成行程"
      : "已走完这段步行"
    : trip.phase === "waiting"
      ? "已上车"
      : isLast
        ? `已下车 · 完成行程`
        : `已下车（到达 ${current.arrival}）`;

  return (
    <section aria-label="行程模式" className="mt-5">
      <button type="button" onClick={onBack} className="text-sm font-medium text-[var(--accent)]">
        ‹ 返回查车（行程不会丢）
      </button>
      <h2 className="mt-3 text-xl font-bold text-[var(--text)]">
        {trip.origin} → {trip.destination}
      </h2>
      <p className="mt-1 text-xs text-[var(--dim)]">
        第 {trip.currentIndex + 1} / 共 {trip.segments.length} 段 · 进度保存在服务端，关掉页面再打开能接着走
      </p>

      <ol className="mt-5 space-y-3">
        {trip.segments.map((seg, i) => {
          const done = i < trip.currentIndex;
          const isCurrent = i === trip.currentIndex;
          const ride = seg.type !== "步行";
          // 本段涉及的换乘步行时间：步行段按 walkPointOf 取换乘点；
          // 紧接上一段车的同站换乘，换乘点就是本段的上车站+本段线路；
          // 当前接驳段若前面是步行段，默认值取那段步行距离的估算。
          const walkPt = !ride ? walkPointOf(trip.segments, i) : null;
          const walkEff =
            walkPt && !ride
              ? walk.effective(
                  walkPt.station,
                  walkPt.nextLine,
                  defaultWalkMinutes(Number(seg.walkDistance) || 0),
                )
              : null;
          const direct = ride && isDirectTransfer(trip.segments, i);
          const directEff = direct
            ? walk.effective(seg.departure, seg.name, 0)
            : null;
          const transferRide = ride && hasRideBefore(trip.segments, i);
          const prevSeg = i > 0 ? trip.segments[i - 1] : undefined;
          const curRideEff = transferRide
            ? walk.effective(
                seg.departure,
                seg.name,
                prevSeg && prevSeg.type === "步行"
                  ? defaultWalkMinutes(Number(prevSeg.walkDistance) || 0)
                  : 0,
              )
            : null;
          const nextRideSeg = !ride
            ? trip.segments.slice(i + 1).find((s) => s.type !== "步行")
            : undefined;
          return (
            <li
              key={i}
              className={`border px-4 py-3.5 [border-radius:var(--radius)] ${
                isCurrent
                  ? "border-2 border-[var(--accent)] bg-[var(--surface)] shadow-sm"
                  : "border-[var(--border)] bg-[var(--surface)]"
              } ${done ? "opacity-75" : ""}`}
            >
              <div className="flex items-baseline gap-2">
                <span className={`shrink-0 text-sm font-bold ${isCurrent ? "text-[var(--accent)]" : "text-[var(--dim)]"}`}>
                  {done ? "✓" : `${i + 1}`}
                </span>
                {ride ? (
                  <LineBadge name={seg.name} />
                ) : (
                  <span className="inline-flex shrink-0 items-center bg-[var(--surface2)] px-2 py-0.5 text-sm font-bold text-[var(--text)] [border-radius:6px]">
                    步行
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-base text-[var(--text)]">
                  {ride
                    ? `${seg.departure} → ${seg.arrival}`
                    : seg.walkDistance
                      ? `步行约 ${seg.walkDistance} 米${seg.arrival ? `到 ${seg.arrival}` : ""}`
                      : "步行一段"}
                </span>
                {ride && seg.stopCount != null && (
                  <span className="shrink-0 text-xs text-[var(--dim)]">共 {seg.stopCount} 站</span>
                )}
                {isCurrent && (
                  <span className="shrink-0 bg-[var(--accent)] px-2 py-0.5 text-xs font-bold text-[var(--accent-ink)] [border-radius:999px]">
                    {ride && trip.phase === "riding" ? "已上车" : "当前段"}
                  </span>
                )}
              </div>

              {!ride && walkPt && walkEff && !(isCurrent && nextRideSeg) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {Number(seg.walkDistance) > 0 && (
                    <span className="text-sm text-[var(--dim)]">
                      约 {seg.walkDistance} 米 ·
                    </span>
                  )}
                  <WalkTimeControl
                    minutes={walkEff.minutes}
                    isCustom={walkEff.isCustom}
                    onChange={(m) => walk.setMinutes(walkPt.station, walkPt.nextLine, m)}
                    label={
                      walkPt.station
                        ? `${walkPt.station}${walkPt.nextLine ? `换乘${walkPt.nextLine}` : "步行"}`
                        : "步行段"
                    }
                  />
                </div>
              )}
              {ride && direct && !isCurrent && directEff && (
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm text-[var(--dim)]">
                    换乘（同站，可能要过街）·
                  </span>
                  <WalkTimeControl
                    minutes={directEff.minutes}
                    isCustom={directEff.isCustom}
                    onChange={(m) => walk.setMinutes(seg.departure, seg.name, m)}
                    label={`${seg.departure}换乘${seg.name}`}
                  />
                </div>
              )}

              {isCurrent && ride && (
                <>
                  {trip.phase === "riding" && seg.stopCount != null && (
                    <p className="mt-3 border border-[var(--amber)] bg-[var(--amber-bg)] px-3 py-2 text-base font-bold text-[var(--text)] [border-radius:8px]">
                      已上车 · 还剩 {seg.stopCount} 站到「{seg.arrival}」下车，别坐过站
                      <span className="block text-xs font-normal text-[var(--dim)]">按站点序计算的站数，不是车辆实时位置</span>
                    </p>
                  )}
                  <TripRealtime
                    city={trip.city}
                    seg={seg}
                    isTransfer={transferRide}
                    walk={
                      curRideEff
                        ? {
                            minutes: curRideEff.minutes,
                            isCustom: curRideEff.isCustom,
                            onChange: (m: number) =>
                              walk.setMinutes(seg.departure, seg.name, m),
                            label: `${seg.departure}换乘${seg.name}`,
                          }
                        : undefined
                    }
                  />
                  {seg.stops.length > 0 ? (
                    <ol className="mt-3 border-t border-[var(--border)] pt-2">
                      {seg.stops.map((stop, j) => {
                        const isFirst = j === 0;
                        const isStopLast = j === seg.stops.length - 1;
                        return (
                          <li key={`${stop}-${j}`} className="flex items-center gap-3 px-1 py-1.5">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                isFirst
                                  ? "bg-[var(--accent)]"
                                  : isStopLast
                                    ? "bg-[var(--amber)]"
                                    : "bg-[var(--border)]"
                              }`}
                            />
                            <span className={`flex-1 text-base ${isFirst || isStopLast ? "font-bold text-[var(--text)]" : "text-[var(--dim)]"}`}>
                              {stop}
                            </span>
                            {isFirst && <span className="shrink-0 text-xs font-bold text-[var(--accent)]">上车站</span>}
                            {isStopLast && <span className="shrink-0 text-xs font-bold text-[var(--amber)]">下车站</span>}
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="mt-2 text-xs text-[var(--dim)]">
                      这条线没取到站点序，站数未知；认准在「{seg.arrival}」下车。
                    </p>
                  )}
                </>
              )}
              {isCurrent && !ride && (
                <>
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    跟着导航走到{seg.arrival ? `「${seg.arrival}」` : "下一段上车点"}，走完点下面的按钮。
                  </p>
                  {nextRideSeg && walkPt && walkEff && (
                    <TripRealtime
                      city={trip.city}
                      seg={nextRideSeg}
                      isTransfer={hasRideBefore(trip.segments, i)}
                      walk={{
                        minutes: walkEff.minutes,
                        isCustom: walkEff.isCustom,
                        onChange: (m: number) =>
                          walk.setMinutes(walkPt.station, walkPt.nextLine, m),
                        label: walkPt.nextLine
                          ? `${walkPt.station}换乘${walkPt.nextLine}`
                          : `${walkPt.station}步行`,
                      }}
                    />
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>

      {advanceError && <ErrorBox message={advanceError} />}
      <button
        type="button"
        onClick={onAdvance}
        disabled={advancing}
        aria-label={advanceLabel}
        className="mt-5 w-full bg-[var(--accent)] px-5 py-3 text-lg font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
      >
        {advancing ? "记录中…" : advanceLabel}
      </button>

      <button
        type="button"
        onClick={onToCanvas}
        disabled={toCanvasPending}
        aria-label="把这趟行程转到画布"
        className="mt-3 w-full border border-[var(--accent)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--accent)] [border-radius:8px] disabled:opacity-50"
      >
        {toCanvasPending ? "正在转到画布…" : "转到画布"}
      </button>
      {toCanvasError && <p className="mt-1.5 text-sm text-[var(--danger)]">{toCanvasError}</p>}

      {confirmEnd ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <p className="min-w-40 flex-1 text-sm text-[var(--text)]">确定结束这次行程？进度会清掉。</p>
          <button
            type="button"
            onClick={onEnd}
            disabled={ending}
            className="shrink-0 px-3 font-bold text-[var(--danger)] [border-radius:8px] disabled:opacity-50"
          >
            {ending ? "结束中…" : "确认结束"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmEnd(false)}
            className="shrink-0 bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px]"
          >
            继续行程
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmEnd(true)}
          aria-label="结束行程"
          className="mt-4 w-full px-3 py-2 text-sm text-[var(--dim)]"
        >
          结束行程（放弃这次出行）
        </button>
      )}
    </section>
  );
}

// ---------- 设置页 ----------
// 从顶部齿轮进入，不占底部导航。分两组：API 密钥、偏好设置。
// key 只存服务端：这里只看得到来源状态与末 4 位掩码，输入框留空 =
// 不修改；填新值点保存才替换；「清除」删掉界面存的 key、回退到文件。
// 默认城市与顶部城市切换共用同一份 city 状态：改这里就是改当前城市，
// 同时存一份到服务端作默认。

const CACHE_TTL_OPTIONS = [60, 90, 120, 180];

function keyStatusText(st: SettingsData["apizero"]): string {
  if (st.source === "ui") return `已设置（界面） · ••••${st.suffix}`;
  if (st.source === "file") return `已设置（文件） · ••••${st.suffix}`;
  return "未设置";
}

function SettingsPanel({
  city,
  onBack,
  onPickCity,
}: {
  city: string;
  onBack: () => void;
  onPickCity: (c: string) => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings({}),
  });
  const data = settings.data;

  const [apizeroInput, setApizeroInput] = useState("");
  const [amapInput, setAmapInput] = useState("");
  const [ttlSel, setTtlSel] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [testResults, setTestResults] = useState<
    Partial<Record<"apizero" | "amap", { ok: boolean; message: string }>>
  >({});

  const applyData = (d: SettingsData) =>
    queryClient.setQueryData(["settings"], d);

  const saveMut = useMutation({
    mutationFn: (args: {
      apizeroKey?: string;
      amapKey?: string;
      defaultCity?: string;
      cacheTtlSec?: number;
    }) => api.saveSettings(args),
    onSuccess: (d) => {
      applyData(d);
      setApizeroInput("");
      setAmapInput("");
      setFeedback("已保存，立即生效。");
    },
    onError: (e) => setFeedback(`保存失败：${String(e)}`),
  });

  const clearMut = useMutation({
    mutationFn: (service: "apizero" | "amap") => api.clearApiKey({ service }),
    onSuccess: (d, service) => {
      applyData(d);
      if (service === "apizero") setApizeroInput("");
      else setAmapInput("");
      setFeedback(
        service === "apizero"
          ? "已清除界面里存的实时公交 key，之后用服务器文件里的 key。"
          : "已清除界面里存的高德 key，之后用服务器文件里的 key。",
      );
    },
    onError: (e) => setFeedback(`清除失败：${String(e)}`),
  });

  const testMut = useMutation({
    mutationFn: (args: { service: "apizero" | "amap"; key?: string }) =>
      api.testApiKey(args),
  });
  const runTest = (service: "apizero" | "amap") => {
    const typed = service === "apizero" ? apizeroInput.trim() : amapInput.trim();
    testMut.mutate(
      { service, ...(typed ? { key: typed } : {}) },
      {
        onSuccess: (r) =>
          setTestResults((prev) => ({ ...prev, [service]: r })),
        onError: (e) =>
          setTestResults((prev) => ({
            ...prev,
            [service]: { ok: false, message: `测试失败：${String(e)}` },
          })),
      },
    );
  };

  const effectiveTtl = ttlSel ?? data?.cacheTtlSec ?? 90;

  const onSave = () => {
    setFeedback("");
    saveMut.mutate({
      ...(apizeroInput.trim() ? { apizeroKey: apizeroInput.trim() } : {}),
      ...(amapInput.trim() ? { amapKey: amapInput.trim() } : {}),
      defaultCity: city,
      cacheTtlSec: effectiveTtl,
    });
  };

  const keyField = (
    service: "apizero" | "amap",
    title: string,
    desc: string,
    value: string,
    setValue: (v: string) => void,
    st: SettingsData["apizero"] | undefined,
  ) => (
    <div className="border-t border-[var(--border)] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div>
        <h3 className="text-base font-bold text-[var(--text)]">{title}</h3>
        <span className="mt-1.5 inline-block bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--dim)] [border-radius:999px]">
          {st ? keyStatusText(st) : "读取中…"}
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">{desc}</p>
      <label
        htmlFor={`key-${service}`}
        className="mt-3 mb-1 block text-sm text-[var(--dim)]"
      >
        新 key（留空 = 不修改）
      </label>
      <input
        id={`key-${service}`}
        type="password"
        className="w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={st?.source === "none" ? "粘贴 key 到这里" : "留空表示不修改"}
        autoComplete="off"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => runTest(service)}
          disabled={testMut.isPending}
          aria-label={`测试${title}`}
          className="bg-[var(--surface2)] px-3 py-1.5 text-sm font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
        >
          {testMut.isPending && testMut.variables?.service === service
            ? "测试中…"
            : "测试"}
        </button>
        {service === "apizero" && (
          <span className="text-xs text-[var(--dim)]">测试将消耗 1 次调用</span>
        )}
        {st?.source === "ui" && (
          <button
            type="button"
            onClick={() => clearMut.mutate(service)}
            disabled={clearMut.isPending}
            aria-label={`清除界面里存的${title}`}
            className="px-3 py-1.5 text-sm font-medium text-[var(--danger)] [border-radius:8px] disabled:opacity-50"
          >
            清除
          </button>
        )}
      </div>
      {testResults[service] && (
        <p
          className={`mt-2 text-sm ${testResults[service].ok ? "text-[var(--text)]" : "text-[var(--danger)]"}`}
          role="status"
        >
          {testResults[service].ok ? "✓ " : "✗ "}
          {testResults[service].message}
        </p>
      )}
    </div>
  );

  return (
    <section aria-label="设置" className="mt-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm font-medium text-[var(--accent)]"
      >
        ‹ 返回
      </button>
      <h2 className="mt-3 text-xl font-bold text-[var(--text)]">设置</h2>

      {settings.isError && (
        <ErrorBox
          message={`设置读取失败：${String(settings.error)}`}
          onRetry={() => settings.refetch()}
        />
      )}

      <div className="mt-5">
        <SectionTitle>API 密钥</SectionTitle>
        <div className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-4 py-4 [border-radius:var(--radius)]">
          {keyField(
            "apizero",
            "实时公交 key（apizero）",
            "线路详情、站点搜索、实时到站都用它，按次计费。界面里存的优先，没有才用服务器上的 ~/.apizero_key 文件。",
            apizeroInput,
            setApizeroInput,
            data?.apizero,
          )}
          {keyField(
            "amap",
            "高德 key",
            "路线规划、附近站点、其他城市地铁都用它。界面里存的优先，没有才用服务器上的 ~/.amap_key 文件。",
            amapInput,
            setAmapInput,
            data?.amap,
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--dim)]">
          key 只保存在服务端，这里只显示末 4 位；输入框留空保存不会改动已有的 key。
        </p>
      </div>

      <div className="mt-8">
        <SectionTitle>偏好设置</SectionTitle>
        <div className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-4 py-4 [border-radius:var(--radius)]">
          <div>
            <label
              htmlFor="default-city"
              className="mb-1 block text-sm text-[var(--dim)]"
            >
              默认城市（与顶部城市切换是同一个，改这里立即切换当前城市）
            </label>
            <select
              id="default-city"
              aria-label="默认城市"
              className="w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]"
              value={PRESET_CITIES.includes(city) ? city : "__current"}
              onChange={(e) => {
                const c = e.target.value;
                if (c === "__current") return;
                setFeedback("");
                onPickCity(c);
                saveMut.mutate({ defaultCity: c });
              }}
            >
              {!PRESET_CITIES.includes(city) && (
                <option value="__current">{city}</option>
              )}
              {PRESET_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-[var(--dim)]">
              不在列表里的城市，用顶部城市切换里的「自定义城市…」选好后，这里会自动跟上。
            </p>
          </div>

          <div className="mt-5">
            <label
              htmlFor="cache-ttl"
              className="mb-1 block text-sm text-[var(--dim)]"
            >
              查询缓存时长（实时查询结果缓存多久，越长越省接口额度）
            </label>
            <select
              id="cache-ttl"
              aria-label="查询缓存时长"
              className="w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]"
              value={effectiveTtl}
              onChange={(e) => setTtlSel(Number(e.target.value))}
            >
              {CACHE_TTL_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s} 秒{s === 90 ? "（默认）" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={saveMut.isPending || !data}
        className="mt-6 w-full bg-[var(--accent)] px-5 py-2.5 font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
      >
        {saveMut.isPending ? "保存中…" : "保存设置"}
      </button>
      {feedback && (
        <p className="mt-3 text-center text-sm text-[var(--text)]" role="status">
          {feedback}
        </p>
      )}
    </section>
  );
}

// ---------- 到站画布 ----------
// 把到站卡片当工作流模块摆在可平移/缩放的自由画布上，一个个加、
// 拖动摆放、连线表达路线关系。模块与连线存服务端、按城市隔离。
// 实时口径与站牌一致：打开先读服务端缓存快照（零接口调用），每张
// 到站卡各自刷新（走 queryLineRealtime、吃缓存），不自动轮询。
// 手势分工：拖模块本体移动模块，拖空白处平移画布，双指/滚轮缩放。

const CANVAS_WORLD_W = 2400;
const CANVAS_WORLD_H = 1800;
const CANVAS_MODULE_W = 232;

function clampScale(k: number): number {
  return Math.min(2.5, Math.max(0.3, k));
}

function CanvasView({
  city,
  onBack,
  focus,
}: {
  city: string;
  onBack: () => void;
  focus: { y: number; nonce: number } | null;
}) {
  const inputCls =
    "w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] [border-radius:8px] outline-none focus:border-[var(--accent)]";
  const submitCls =
    "shrink-0 bg-[var(--accent)] px-5 font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50";
  const queryClient = useQueryClient();
  const canvasQ = useQuery({
    queryKey: ["canvas", city],
    queryFn: () => api.getCanvas({ city }),
  });
  const modules = canvasQ.data?.modules ?? [];
  const links = canvasQ.data?.links ?? [];
  // 停止状态的到站模块不进快照、不发起任何查询；空白卡（线路/站名
  // 还没填）也没有可查的键，一样不进快照
  const stationMods = modules.filter(
    (m) => m.kind === "station" && m.enabled && m.line.trim() && m.station.trim(),
  );

  // 打开画布先读缓存快照：有缓存的到站卡直接显示，没缓存的点刷新才查
  const snapshot = useQuery({
    queryKey: ["canvasSnapshot", city, stationMods.map((m) => m.id).join(",")],
    queryFn: () =>
      api.getBoardSnapshot({
        city,
        items: stationMods.map((m) => ({
          id: m.id,
          kind: "lineStation" as const,
          value: m.line,
          label: m.station,
        })),
      }),
    enabled: stationMods.length > 0,
  });
  const entryOf = (id: number) => snapshot.data?.entries.find((e) => e.id === id);

  const applyCanvas = (data: CanvasData) =>
    queryClient.setQueryData(["canvas", city], data);
  const addModuleMut = useMutation({
    mutationFn: (args: {
      kind: "station" | "text";
      line?: string;
      station?: string;
      direction?: number;
      terminal?: string;
      text?: string;
      note?: string;
      x: number;
      y: number;
    }) => api.addCanvasModule({ ...args, city }),
    onSuccess: applyCanvas,
  });
  const updateModuleMut = useMutation({
    mutationFn: (args: {
      id: number;
      x?: number;
      y?: number;
      note?: string;
      text?: string;
      enabled?: boolean;
      direction?: number;
      terminal?: string;
      line?: string;
      station?: string;
    }) => api.updateCanvasModule({ ...args, city }),
    onSuccess: applyCanvas,
  });
  const removeModuleMut = useMutation({
    mutationFn: (id: number) => api.removeCanvasModule({ id, city }),
    onSuccess: applyCanvas,
  });
  const addLinkMut = useMutation({
    mutationFn: (args: { fromId: number; toId: number }) =>
      api.addCanvasLink({ ...args, city }),
    onSuccess: applyCanvas,
  });
  const removeLinkMut = useMutation({
    mutationFn: (id: number) => api.removeCanvasLink({ id, city }),
    onSuccess: applyCanvas,
  });

  // 模块库：配好的模块存成模板（只存配置、按城市隔离），之后在
  // 「＋ 加模块」面板里点一下就在画布空位放一份独立副本。副本与
  // 模板互不影响：改/删副本不动模板，删模板不动已放出的副本。
  const templatesQ = useQuery({
    queryKey: ["canvasTemplates", city],
    queryFn: () => api.getCanvasTemplates({ city }),
  });
  const templates = templatesQ.data?.templates ?? [];
  const applyTemplates = (data: { templates: CanvasTemplate[] }) =>
    queryClient.setQueryData(["canvasTemplates", city], data);
  const [templateFlash, setTemplateFlash] = useState("");
  useEffect(() => {
    if (!templateFlash) return;
    const t = setTimeout(() => setTemplateFlash(""), 2600);
    return () => clearTimeout(t);
  }, [templateFlash]);
  const saveTemplateMut = useMutation({
    mutationFn: (m: CanvasModule) =>
      api.saveCanvasTemplate({
        city,
        kind: m.kind === "text" ? "text" : "station",
        line: m.line,
        station: m.station,
        direction: m.direction,
        terminal: m.terminal,
        text: m.text,
        note: m.note,
      }),
    onSuccess: (data) => {
      applyTemplates(data);
      setTemplateFlash(
        data.alreadyInLibrary
          ? "这个模块已经在模块库里了，没有重复存"
          : "已存入模块库，下次在「＋ 加模块」里点一下就能放出来",
      );
    },
    onError: () => setTemplateFlash("存入模块库失败，再试一次"),
  });
  const removeTemplateMut = useMutation({
    mutationFn: (id: number) => api.removeCanvasTemplate({ id, city }),
    onSuccess: applyTemplates,
  });
  const [confirmTemplateId, setConfirmTemplateId] = useState<number | null>(null);
  const templateSummary = (t: CanvasTemplate) =>
    t.kind === "text"
      ? `文本卡：${t.text || "（空）"}`
      : `${t.station || "未填站名"} · ${t.line || "未填线路"}${
          t.terminal
            ? ` · 往${t.terminal}`
            : t.direction
              ? ` · 方向${t.direction}`
              : ""
        }`;

  // 视口（平移 + 缩放）
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 16, y: 16, k: 1 });
  const zoomAt = (cx: number, cy: number, factor: number) => {
    setView((v) => {
      const k2 = clampScale(v.k * factor);
      if (k2 === v.k) return v;
      const wx = (cx - v.x) / v.k;
      const wy = (cy - v.y) / v.k;
      return { k: k2, x: cx - wx * k2, y: cy - wy * k2 };
    });
  };
  const zoomCenter = (factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    zoomAt(rect ? rect.width / 2 : 200, rect ? rect.height / 2 : 200, factor);
  };

  // 从规划/行程转入新链后，把新链滚到视口顶部（每个 nonce 只滚一次）
  const focusSeenRef = useRef(0);
  useEffect(() => {
    if (!focus || !canvasQ.data) return;
    if (focusSeenRef.current === focus.nonce) return;
    focusSeenRef.current = focus.nonce;
    setView({ x: 16, y: 24 - focus.y, k: 1 });
  }, [focus, canvasQ.data]);

  // 滚轮缩放（原生监听，才能 preventDefault 阻止页面滚动）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 0.89);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomAt 每次渲染都是新引用，监听里用的是视口函数式更新，不依赖旧值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 空白处平移 / 双指缩放：在容器上统一跟踪指针（模块自己 stopPropagation）
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    d0: number;
    cx: number;
    cy: number;
    view: { x: number; y: number; k: number };
  } | null>(null);
  const relPos = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  };
  const onBgPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-canvas-module]")) return;
    const p = relPos(e);
    pointersRef.current.set(e.pointerId, p);
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a && b) {
        pinchRef.current = {
          d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2,
          view: { ...view },
        };
      }
    }
  };
  const onBgPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(e.pointerId);
    if (!prev) return;
    const p = relPos(e);
    pointersRef.current.set(e.pointerId, p);
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (!a || !b) return;
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const k2 = clampScale(pinch.view.k * (d / pinch.d0));
      const wx = (pinch.cx - pinch.view.x) / pinch.view.k;
      const wy = (pinch.cy - pinch.view.y) / pinch.view.k;
      setView({ k: k2, x: cx - wx * k2, y: cy - wy * k2 });
      return;
    }
    if (pointersRef.current.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      if (dx !== 0 || dy !== 0) {
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
    }
  };
  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  // 模块拖动：拖动中只改本地覆盖位置，松手才存服务端
  const dragRef = useRef<{
    id: number;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number } | null>(null);
  const posOf = (m: CanvasModule) =>
    dragPos && dragPos.id === m.id ? { x: dragPos.x, y: dragPos.y } : { x: m.x, y: m.y };

  // 连线模式（备选）：点起点模块再点终点模块成线；点已有连线删线
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const onModuleTap = (m: CanvasModule) => {
    if (linkFrom === null) {
      setLinkFrom(m.id);
    } else if (linkFrom === m.id) {
      setLinkFrom(null);
    } else {
      addLinkMut.mutate({ fromId: linkFrom, toId: m.id });
      setLinkFrom(null);
    }
  };

  // 拖拉连线（主方式，工作流式）：按住模块右侧的连接点拖出一条虚线，
  // 松手落到另一个模块上即成线。连接点自己处理指针并捕获，所以不会
  // 和拖模块本体、平移画布的手势打架。
  const linkDragRef = useRef<{ fromId: number; pointerId: number } | null>(null);
  const [linkDrag, setLinkDrag] = useState<{ fromId: number; x: number; y: number } | null>(null);
  const [linkHover, setLinkHover] = useState<number | null>(null);
  const worldFromEvent = (e: { clientX: number; clientY: number }) => {
    const p = relPos(e);
    return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
  };
  const moduleIdAtPoint = (clientX: number, clientY: number): number | null => {
    const el = document
      .elementFromPoint(clientX, clientY)
      ?.closest?.("[data-canvas-module]");
    if (!el) return null;
    const id = Number(el.getAttribute("data-canvas-module"));
    return Number.isFinite(id) && id > 0 ? id : null;
  };
  const onPortPointerDown = (e: ReactPointerEvent<HTMLElement>, m: CanvasModule) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    linkDragRef.current = { fromId: m.id, pointerId: e.pointerId };
    const w = worldFromEvent(e);
    setLinkDrag({ fromId: m.id, x: w.x, y: w.y });
    setLinkHover(null);
  };
  const onPortPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = linkDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const w = worldFromEvent(e);
    setLinkDrag({ fromId: d.fromId, x: w.x, y: w.y });
    const target = moduleIdAtPoint(e.clientX, e.clientY);
    setLinkHover(target !== null && target !== d.fromId ? target : null);
  };
  const onPortPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = linkDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    linkDragRef.current = null;
    setLinkDrag(null);
    setLinkHover(null);
    const target = moduleIdAtPoint(e.clientX, e.clientY);
    if (target !== null && target !== d.fromId) {
      addLinkMut.mutate({ fromId: d.fromId, toId: target });
    }
  };
  const onPortPointerCancel = () => {
    linkDragRef.current = null;
    setLinkDrag(null);
    setLinkHover(null);
  };

  // 整删确认：点模块右上角 ✕ 后先在模块顶部亮出确认条，确认才删
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // 加模块面板
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<"station" | "text">("station");
  const [lineKw, setLineKw] = useState("");
  const [dirIdx, setDirIdx] = useState(0);
  const [textVal, setTextVal] = useState("");
  const ldMut = useMutation({
    mutationFn: (line: string) => api.getLineDetail({ line, city }),
  });
  const centerWorldPos = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 360;
    const h = rect?.height ?? 480;
    const cascade = (modules.length % 6) * 28;
    return {
      x: Math.round((w / 2 - view.x) / view.k - CANVAS_MODULE_W / 2 + cascade),
      y: Math.round((h / 2 - view.y) / view.k - 70 + cascade),
    };
  };
  const closeAdd = () => {
    setAddOpen(false);
    setLineKw("");
    setTextVal("");
    setDirIdx(0);
    ldMut.reset();
  };
  const addStationModule = (station: string) => {
    const data = ldMut.data;
    const dir = data?.directions[dirIdx];
    if (!data || !dir) return;
    const pos = centerWorldPos();
    addModuleMut.mutate({
      kind: "station",
      line: data.line,
      station,
      direction: dir.direction,
      terminal: dir.end,
      ...pos,
    });
    closeAdd();
  };
  const addTextModule = () => {
    const t = textVal.trim();
    if (!t) return;
    const pos = centerWorldPos();
    addModuleMut.mutate({ kind: "text", text: t, ...pos });
    closeAdd();
  };
  // 空白五行卡：不查线路、不调任何接口，点一下就落一张标准五行
  // 到站卡到画布上，站名/线路/方向在卡上点着填，填好点刷新查车。
  const addBlankStationModule = () => {
    const pos = centerWorldPos();
    addModuleMut.mutate({
      kind: "station",
      line: "",
      station: "",
      direction: 0,
      terminal: "",
      ...pos,
    });
    closeAdd();
  };

  // 从模块库调用：按模板配置在当前视口空位放一份独立副本，
  // 副本之后与普通模块完全一样（拖动/连线/开始停止/整删），
  // 改它、删它都不影响库里的模板。
  const placeTemplate = (t: CanvasTemplate) => {
    const pos = centerWorldPos();
    addModuleMut.mutate({
      kind: t.kind === "text" ? "text" : "station",
      line: t.line,
      station: t.station,
      direction: t.direction,
      terminal: t.terminal,
      text: t.text,
      note: t.note,
      ...pos,
    });
    closeAdd();
  };

  const modById = (id: number) => modules.find((m) => m.id === id);

  return (
    <section aria-label="到站画布" className="mt-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回查车"
          className="shrink-0 bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px]"
        >
          ‹ 返回
        </button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-[var(--text)]">
          到站画布 <span className="text-sm font-normal text-[var(--dim)]">· {city}</span>
        </h2>
        <button
          type="button"
          onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}
          aria-label="添加模块"
          className="shrink-0 bg-[var(--accent)] px-3.5 font-bold text-[var(--accent-ink)] [border-radius:8px]"
        >
          {addOpen ? "收起" : "＋ 加模块"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setLinkMode((on) => !on);
            setLinkFrom(null);
          }}
          aria-pressed={linkMode}
          className={`px-3 text-sm [border-radius:8px] ${
            linkMode
              ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
              : "bg-[var(--surface2)] font-medium text-[var(--text)]"
          }`}
        >
          {linkMode ? "连线中（点我退出）" : "连线"}
        </button>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => zoomCenter(0.8)}
            aria-label="缩小画布"
            className="bg-[var(--surface2)] px-3 text-base font-bold text-[var(--text)] [border-radius:8px]"
          >
            −
          </button>
          <span className="min-w-12 text-center text-sm text-[var(--dim)]">
            {Math.round(view.k * 100)}%
          </span>
          <button
            type="button"
            onClick={() => zoomCenter(1.25)}
            aria-label="放大画布"
            className="bg-[var(--surface2)] px-3 text-base font-bold text-[var(--text)] [border-radius:8px]"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => setView({ x: 16, y: 16, k: 1 })}
            className="bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px]"
          >
            复位
          </button>
        </span>
      </div>

      {linkMode && (
        <p className="mt-2 text-sm text-[var(--accent)]" role="status">
          {linkFrom === null
            ? "点一个模块作起点，再点另一个模块，连线就画好了。（平时直接按住模块右侧的蓝点拖到另一个模块上也能连线）"
            : "已选起点，再点另一个模块完成连线；点起点本身取消。点画布上的线可以删掉它。"}
        </p>
      )}

      {templateFlash && (
        <p className="mt-2 text-sm font-medium text-[var(--accent)]" role="status">
          {templateFlash}
        </p>
      )}

      {addOpen && (
        <div className="mt-3 border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 [border-radius:var(--radius)]">
          <div className="flex gap-2" role="group" aria-label="选择模块类型">
            <button
              type="button"
              onClick={() => setAddKind("station")}
              aria-pressed={addKind === "station"}
              className={`px-3.5 text-sm [border-radius:8px] ${
                addKind === "station"
                  ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                  : "bg-[var(--surface2)] font-medium text-[var(--text)]"
              }`}
            >
              到站卡
            </button>
            <button
              type="button"
              onClick={() => setAddKind("text")}
              aria-pressed={addKind === "text"}
              className={`px-3.5 text-sm [border-radius:8px] ${
                addKind === "text"
                  ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                  : "bg-[var(--surface2)] font-medium text-[var(--text)]"
              }`}
            >
              文本卡
            </button>
          </div>

          <button
            type="button"
            onClick={addBlankStationModule}
            disabled={addModuleMut.isPending}
            aria-label="直接放一张空白到站卡到画布上"
            className="mt-3 w-full border-2 border-dashed border-[var(--accent)] bg-[var(--surface2)] px-3 py-2.5 text-left [border-radius:8px] disabled:opacity-50"
          >
            <span className="text-base font-bold text-[var(--accent)]">
              ＋ 直接放一张空白到站卡
            </span>
            <span className="mt-0.5 block text-xs text-[var(--dim)]">
              现成的五行卡，不用查线路、不花额度；放到画布上点前三行选站名、线路、方向（能点选就不打字），选好点刷新查车。
            </span>
          </button>

          {addKind === "text" ? (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addTextModule();
              }}
            >
              <input
                className={inputCls}
                value={textVal}
                onChange={(e) => setTextVal(e.target.value)}
                placeholder="写个目的地或备注，如：马厝"
                aria-label="文本卡内容"
                autoComplete="off"
              />
              <button type="submit" className={submitCls} disabled={!textVal.trim() || addModuleMut.isPending}>
                加到画布
              </button>
            </form>
          ) : (
            <div className="mt-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (lineKw.trim()) {
                    setDirIdx(0);
                    ldMut.mutate(lineKw);
                  }
                }}
              >
                <input
                  className={inputCls}
                  value={lineKw}
                  onChange={(e) => setLineKw(e.target.value)}
                  placeholder="输入线路号，如：33 或 33路"
                  aria-label="要添加的线路号"
                  autoComplete="off"
                />
                <button type="submit" className={submitCls} disabled={!lineKw.trim() || ldMut.isPending}>
                  {ldMut.isPending ? "查线路…" : "查线路"}
                </button>
              </form>
              {ldMut.data && !ldMut.data.ok && (
                <div className="mt-2">
                  <p className="text-sm text-[var(--danger)]">{ldMut.data.error}</p>
                  <button
                    type="button"
                    onClick={addBlankStationModule}
                    disabled={addModuleMut.isPending}
                    aria-label="改用空白卡自己填"
                    className="mt-1.5 border border-[var(--accent)] px-3 py-1 text-sm font-bold text-[var(--accent)] [border-radius:8px] disabled:opacity-50"
                  >
                    改用空白卡自己填 →
                  </button>
                </div>
              )}
              {ldMut.isError && (
                <div className="mt-2">
                  <p className="text-sm text-[var(--danger)]">查线路失败：{String(ldMut.error)}</p>
                  <button
                    type="button"
                    onClick={addBlankStationModule}
                    disabled={addModuleMut.isPending}
                    aria-label="改用空白卡自己填"
                    className="mt-1.5 border border-[var(--accent)] px-3 py-1 text-sm font-bold text-[var(--accent)] [border-radius:8px] disabled:opacity-50"
                  >
                    改用空白卡自己填 →
                  </button>
                </div>
              )}
              {ldMut.data?.ok && (
                <div className="mt-3">
                  <p className="text-sm text-[var(--dim)]">选方向（开往哪个终点站）：</p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {ldMut.data.directions.map((d, i) => (
                      <button
                        key={d.direction}
                        type="button"
                        onClick={() => setDirIdx(i)}
                        aria-pressed={dirIdx === i}
                        className={`px-3 py-1.5 text-sm [border-radius:8px] ${
                          dirIdx === i
                            ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                            : "bg-[var(--surface2)] font-medium text-[var(--text)]"
                        }`}
                      >
                        开往 {d.end}
                      </button>
                    ))}
                  </div>
                  <p className="mt-3 text-sm text-[var(--dim)]">再点你要看的上车站，它就落到画布上：</p>
                  <div className="mt-1.5 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                    {(ldMut.data.directions[dirIdx]?.stops ?? []).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => addStationModule(s)}
                        disabled={addModuleMut.isPending}
                        aria-label={`添加 ${ldMut.data.line} 在 ${s} 的到站卡`}
                        className="bg-[var(--surface2)] px-2.5 py-1.5 text-sm text-[var(--text)] [border-radius:8px] disabled:opacity-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <p className="text-sm font-bold text-[var(--text)]">我的模块库</p>
            {templatesQ.isLoading ? (
              <p className="mt-1.5 text-sm text-[var(--dim)]">正在打开模块库…</p>
            ) : templatesQ.isError ? (
              <p className="mt-1.5 text-sm text-[var(--danger)]">
                模块库打开失败，点「＋ 加模块」收起再打开试试。
              </p>
            ) : templates.length === 0 ? (
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                还没有存过的模块。在画布上把一张卡配好，点卡上的「存库」，它就存到这里；下次点这里任意一条，直接在画布上放一份，不用再填一遍。
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {templates.map((t) => (
                  <li key={t.id} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => placeTemplate(t)}
                      disabled={addModuleMut.isPending}
                      aria-label={`把模块「${templateSummary(t)}」放到画布上`}
                      className="min-w-0 flex-1 truncate bg-[var(--surface2)] px-3 py-2 text-left text-sm font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
                    >
                      {templateSummary(t)}
                      {t.note && (
                        <span className="text-[var(--dim)]"> · 备注：{t.note}</span>
                      )}
                    </button>
                    {confirmTemplateId === t.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmTemplateId(null);
                            removeTemplateMut.mutate(t.id);
                          }}
                          aria-label={`确认从模块库删除「${templateSummary(t)}」`}
                          className="shrink-0 border border-[var(--danger)] px-2.5 text-sm font-bold text-[var(--danger)] [border-radius:8px]"
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmTemplateId(null)}
                          className="shrink-0 bg-[var(--surface2)] px-2.5 text-sm font-medium text-[var(--text)] [border-radius:8px]"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmTemplateId(t.id)}
                        aria-label={`从模块库删除「${templateSummary(t)}」`}
                        className="flex shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--surface)] px-2 text-base leading-none font-bold text-[var(--danger)] [border-radius:8px]"
                        style={{ width: 36 }}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {canvasQ.isLoading && (
        <p className="mt-6 text-center text-sm text-[var(--dim)]">
          正在打开画布…（第一次打开会按线路站序核对预置模块的方向，稍等一下）
        </p>
      )}
      {canvasQ.isError && (
        <div className="mt-4">
          <ErrorBox
            message={`画布打开失败：${String(canvasQ.error)}`}
            onRetry={() => canvasQ.refetch()}
          />
        </div>
      )}

      {canvasQ.data && (
        <div
          ref={containerRef}
          role="application"
          aria-label={`${city}到站画布：拖空白处平移，拖模块移动模块，双指或滚轮缩放`}
          className="relative mt-3 h-[62dvh] min-h-[420px] touch-none overflow-hidden border border-[var(--border)] bg-[var(--surface2)] [border-radius:var(--radius)]"
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <div
            className="absolute top-0 left-0"
            style={{
              width: CANVAS_WORLD_W,
              height: CANVAS_WORLD_H,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              transformOrigin: "0 0",
              backgroundColor: "var(--bg)",
              backgroundImage:
                "radial-gradient(circle, var(--border) 1.2px, transparent 1.4px)",
              backgroundSize: "24px 24px",
            }}
          >
            <svg
              className="absolute top-0 left-0"
              width={CANVAS_WORLD_W}
              height={CANVAS_WORLD_H}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="canvas-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dim)" />
                </marker>
                <marker
                  id="canvas-arrow-accent"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
                </marker>
              </defs>
              {links.map((l) => {
                const a = modById(l.fromId);
                const b = modById(l.toId);
                if (!a || !b) return null;
                const pa = posOf(a);
                const pb = posOf(b);
                const x1 = pa.x + CANVAS_MODULE_W / 2;
                const y1 = pa.y + 52;
                const x2 = pb.x + CANVAS_MODULE_W / 2;
                const y2 = pb.y + 52;
                return (
                  <g key={l.id}>
                    {linkMode && (
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke="transparent"
                        strokeWidth={18}
                        style={{ pointerEvents: "stroke", cursor: "pointer" }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => removeLinkMut.mutate(l.id)}
                      />
                    )}
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="var(--dim)"
                      strokeWidth={2}
                      strokeDasharray="7 6"
                      markerEnd="url(#canvas-arrow)"
                      style={{ pointerEvents: "none" }}
                    />
                  </g>
                );
              })}
              {linkDrag &&
                (() => {
                  const a = modById(linkDrag.fromId);
                  if (!a) return null;
                  const pa = posOf(a);
                  return (
                    <line
                      x1={pa.x + CANVAS_MODULE_W}
                      y1={pa.y + 52}
                      x2={linkDrag.x}
                      y2={linkDrag.y}
                      stroke="var(--accent)"
                      strokeWidth={2.5}
                      strokeDasharray="7 6"
                      markerEnd="url(#canvas-arrow-accent)"
                      style={{ pointerEvents: "none" }}
                    />
                  );
                })()}
            </svg>

            {modules.map((m) => {
              const p = posOf(m);
              const isFrom = linkFrom === m.id;
              const isLinkTarget = linkHover === m.id;
              const stopped = m.kind === "station" && !m.enabled;
              const modLabel =
                m.kind === "station" ? `${m.line} ${m.station}` : `文本卡 ${m.text}`;
              return (
                <div
                  key={m.id}
                  data-canvas-module={m.id}
                  className={`absolute touch-none border bg-[var(--surface)] px-3 py-2.5 shadow-sm [border-radius:var(--radius)] ${
                    isFrom || isLinkTarget
                      ? "border-2 border-[var(--accent)]"
                      : "border-[var(--border)]"
                  } ${linkMode ? "cursor-pointer" : "cursor-grab"} ${
                    stopped ? "opacity-75 saturate-50" : ""
                  }`}
                  style={{ left: p.x, top: p.y, width: CANVAS_MODULE_W }}
                  onPointerDown={(e) => {
                    // 模块上的按钮/输入框优先于连线点选与拖动
                    if ((e.target as HTMLElement).closest("button,input,textarea")) return;
                    if (linkMode) {
                      e.stopPropagation();
                      onModuleTap(m);
                      return;
                    }
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragRef.current = {
                      id: m.id,
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: m.x,
                      origY: m.y,
                      moved: false,
                    };
                    setDragPos({ id: m.id, x: m.x, y: m.y });
                  }}
                  onPointerMove={(e) => {
                    const d = dragRef.current;
                    if (!d || d.id !== m.id || d.pointerId !== e.pointerId) return;
                    const nx = d.origX + (e.clientX - d.startX) / view.k;
                    const ny = d.origY + (e.clientY - d.startY) / view.k;
                    if (Math.abs(nx - d.origX) + Math.abs(ny - d.origY) > 2) d.moved = true;
                    setDragPos({ id: m.id, x: nx, y: ny });
                  }}
                  onPointerUp={(e) => {
                    const d = dragRef.current;
                    if (!d || d.id !== m.id || d.pointerId !== e.pointerId) return;
                    dragRef.current = null;
                    setDragPos(null);
                    if (d.moved) {
                      updateModuleMut.mutate({
                        id: m.id,
                        x: Math.round(d.origX + (e.clientX - d.startX) / view.k),
                        y: Math.round(d.origY + (e.clientY - d.startY) / view.k),
                      });
                    }
                  }}
                  onPointerCancel={() => {
                    if (dragRef.current?.id === m.id) {
                      dragRef.current = null;
                      setDragPos(null);
                    }
                  }}
                >
                  {/* 整删：右上角明确的 ✕，点后先确认一次 */}
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(m.id)}
                    aria-label={`删除模块 ${modLabel}`}
                    className="absolute -top-3 -right-3 z-20 flex min-h-0 items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-base leading-none font-bold text-[var(--danger)] shadow [border-radius:999px]"
                    style={{ width: 36, height: 36 }}
                  >
                    ✕
                  </button>
                  {/* 连线连接点：按住拖出虚线、落到另一个模块上成线 */}
                  <button
                    type="button"
                    aria-label={`从 ${modLabel} 拖出连线`}
                    className="absolute top-1/2 -right-3.5 z-20 min-h-0 -translate-y-1/2 border-2 border-[var(--surface)] bg-[var(--accent)] shadow [border-radius:999px]"
                    style={{ width: 26, height: 26, touchAction: "none" }}
                    onPointerDown={(e) => onPortPointerDown(e, m)}
                    onPointerMove={onPortPointerMove}
                    onPointerUp={onPortPointerUp}
                    onPointerCancel={onPortPointerCancel}
                  />
                  {confirmDeleteId === m.id && (
                    <div className="absolute inset-x-0 -top-1 z-30 border border-[var(--danger)] bg-[var(--surface)] px-2.5 py-2 shadow [border-radius:8px]">
                      <p className="text-xs text-[var(--text)]">
                        删除这个模块？连着它的线也会一起删。
                      </p>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            removeModuleMut.mutate(m.id);
                          }}
                          aria-label={`确认删除模块 ${modLabel}`}
                          className="flex-1 border border-[var(--danger)] bg-[var(--surface)] px-2 text-xs font-bold text-[var(--danger)] [border-radius:6px]"
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="flex-1 bg-[var(--surface2)] px-2 text-xs font-medium text-[var(--text)] [border-radius:6px]"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                  {m.kind === "station" ? (
                    <CanvasStationCard
                      mod={m}
                      city={city}
                      entry={entryOf(m.id)}
                      onStartLink={() => {
                        setLinkMode(true);
                        setLinkFrom(m.id);
                      }}
                      onSaveTemplate={() => saveTemplateMut.mutate(m)}
                      saveTemplatePending={saveTemplateMut.isPending}
                      onSaveNote={(note) => updateModuleMut.mutate({ id: m.id, note })}
                      onSaveStation={(station) =>
                        updateModuleMut.mutate({ id: m.id, station })
                      }
                      onSaveLine={(line) =>
                        // 换了线路，旧方向/终点站多半对不上，一并清掉重定
                        updateModuleMut.mutate({
                          id: m.id,
                          line,
                          direction: 0,
                          terminal: "",
                        })
                      }
                      onToggleEnabled={(enabled) =>
                        updateModuleMut.mutate({ id: m.id, enabled })
                      }
                      onSetDirection={(direction, terminal) =>
                        updateModuleMut.mutate({ id: m.id, direction, terminal })
                      }
                    />
                  ) : (
                    <CanvasTextCard
                      mod={m}
                      onStartLink={() => {
                        setLinkMode(true);
                        setLinkFrom(m.id);
                      }}
                      onSaveTemplate={() => saveTemplateMut.mutate(m)}
                      saveTemplatePending={saveTemplateMut.isPending}
                      onSaveText={(text) => updateModuleMut.mutate({ id: m.id, text })}
                    />
                  )}
                </div>
              );
            })}

            {modules.length === 0 && (
              <p className="absolute top-24 left-1/2 w-64 -translate-x-1/2 text-center text-sm leading-relaxed text-[var(--dim)]">
                画布还是空的。点上面「＋ 加模块」，可以直接放一张空白到站卡自己填，也可以查线路选站加卡，再加文本卡、连线，一个个摆出你的路线图。
              </p>
            )}
          </div>
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
        拖模块本体移动它，拖空白处平移画布，双指或滚轮缩放。连线：按住模块右侧的蓝点拖到另一个模块上松手（虚线带箭头，按顺序连就是行程顺序）；模块右上角 ✕ 整删。到站卡可开始/停止：停止后变灰待机、不查车。打开画布不自动查车：有缓存先看缓存，每张到站卡点刷新只查它自己。到站卡前三行（站名/线路/方向）点一下先出可选项点选——方向是终点站二选一、站名从站序里挑、线路从你用过的里面挑，实在没有选项才打字，选完自动保存；「＋ 加模块」里可以直接放一张空白卡，不用先查线路。配好的模块点卡上的「存库」存入模块库，之后在「＋ 加模块 → 我的模块库」点一下就放一份副本到画布上，副本和模板互不影响。
      </p>
    </section>
  );
}

function CanvasCardActions({
  label,
  onStartLink,
  onSaveTemplate,
  saveTemplatePending,
}: {
  label: string;
  onStartLink: () => void;
  onSaveTemplate?: () => void;
  saveTemplatePending?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {onSaveTemplate && (
        <button
          type="button"
          onClick={onSaveTemplate}
          disabled={saveTemplatePending}
          aria-label={`把${label}存入模块库`}
          className="shrink-0 bg-[var(--surface2)] px-2 py-0.5 text-xs font-medium text-[var(--accent)] [border-radius:999px] disabled:opacity-50"
        >
          {saveTemplatePending ? "存入中…" : "存库"}
        </button>
      )}
      <button
        type="button"
        onClick={onStartLink}
        aria-label={`从${label}开始连线`}
        className="shrink-0 bg-[var(--surface2)] px-2 py-0.5 text-xs font-medium text-[var(--accent)] [border-radius:999px]"
      >
        连线
      </button>
    </span>
  );
}

function CanvasStationCard({
  mod,
  city,
  entry,
  onStartLink,
  onSaveTemplate,
  saveTemplatePending,
  onSaveNote,
  onSaveStation,
  onSaveLine,
  onToggleEnabled,
  onSetDirection,
}: {
  mod: CanvasModule;
  city: string;
  entry: BoardEntry | undefined;
  onStartLink: () => void;
  onSaveTemplate: () => void;
  saveTemplatePending: boolean;
  onSaveNote: (note: string) => void;
  onSaveStation: (station: string) => void;
  onSaveLine: (line: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSetDirection: (direction: number, terminal: string) => void;
}) {
  const stopped = !mod.enabled;
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: mod.line, station: mod.station, city }),
  });
  const data: RealtimeResult | null = stopped
    ? null
    : rtM.data?.ok
      ? rtM.data
      : (entry?.realtime ?? null);
  // 方向未定：方向号 0 且没填终点站（空白卡留空、或从规划转入时定不下来）
  const dirUnset = mod.direction === 0 && !mod.terminal;
  const dir =
    data?.directions.find((d) => d.direction === mod.direction) ??
    data?.directions.find((d) => d.terminal === mod.terminal) ??
    // 方向未定时先按返回数据展示：优先有车的方向，其次第一个方向
    (dirUnset
      ? (data?.directions.find((d) => d.buses.length > 0) ??
        data?.directions[0] ??
        null)
      : null);
  // 数据里的另一个方向：方向行点「换方向」切换过去，并记住选择
  const otherDir =
    data && dir
      ? (data.directions.find((d) => d.direction !== dir.direction) ?? null)
      : null;
  const error = stopped
    ? ""
    : (rtM.data && !rtM.data.ok ? rtM.data.error : "") ||
      (rtM.isError ? `查询失败：${String(rtM.error)}` : "");
  // 前三行就地编辑：点一行进入编辑，失焦/回车保存、Esc 取消，改完即存
  const [editField, setEditField] = useState<"station" | "line" | "terminal" | null>(null);
  const [draft, setDraft] = useState("");
  const startEdit = (field: "station" | "line" | "terminal", value: string) => {
    setEditField(field);
    setDraft(value);
  };
  const commitEdit = () => {
    if (!editField) return;
    const v = draft.trim();
    if (editField === "station" && v !== mod.station) onSaveStation(v);
    // 「33」与已存的「33路」算同一条线，不触发保存（免得误清方向）
    if (editField === "line" && v !== mod.line && `${v}路` !== mod.line) onSaveLine(v);
    // 方向按终点站名存：同时把方向号清 0，查询结果按终点站匹配方向
    if (editField === "terminal" && v !== mod.terminal) onSetDirection(0, v);
    setEditField(null);
  };
  const editInput = (label: string) => (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditField(null);
      }}
      aria-label={label}
      className="w-full border border-[var(--accent)] bg-[var(--surface)] px-1.5 py-0.5 text-base text-[var(--text)] [border-radius:6px] outline-none"
    />
  );
  // 点选优先、尽量不打字：点前三行先出可选项（方向=终点站二选一、
  // 站名=站序列表、线路=用过的线路 chips），选项来自服务端沉淀缓存
  // （不耗 apizero 额度）；实在没有选项才退回上面的打字输入。
  const [picker, setPicker] = useState<"station" | "line" | "terminal" | null>(
    null,
  );
  const pickQ = useQuery({
    queryKey: ["linePickOptions", city, mod.line, mod.direction],
    queryFn: () =>
      api.getLinePickOptions({
        city,
        line: mod.line,
        direction: mod.direction,
      }),
    enabled: picker === "station" || picker === "terminal",
  });
  const recentQ = useQuery({
    queryKey: ["linePickRecent", city],
    queryFn: () => api.getLinePickOptions({ city }),
    enabled: picker === "line",
  });
  // 终点站选项：服务端给的 + 这张卡已查到的实时结果自带的双向终点
  const pickTerminals = Array.from(
    new Set([
      ...(pickQ.data?.terminals ?? []),
      ...(data?.directions
        .map((d) => d.terminal)
        .filter((t) => t !== "") ?? []),
    ]),
  );
  const pickStops = pickQ.data?.stops ?? [];
  const recentLines = (recentQ.data?.recentLines ?? []).filter(
    (l) => l !== mod.line,
  );
  // 选项查完确认一个都没有（或查询失败）时，才退回打字输入
  useEffect(() => {
    if (picker !== "terminal" && picker !== "station") return;
    if (!pickQ.isSuccess && !pickQ.isError) return;
    if (picker === "terminal" && pickTerminals.length === 0) {
      setPicker(null);
      startEdit("terminal", mod.terminal);
    }
    if (picker === "station" && pickStops.length === 0) {
      setPicker(null);
      startEdit("station", mod.station);
    }
    // 只在选项查询落定时判断一次，依赖取查询状态本身
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, pickQ.isSuccess, pickQ.isError, pickQ.data]);
  const pickerFooter = (field: "station" | "line" | "terminal") => (
    <div className="mt-1.5 flex gap-1.5">
      <button
        type="button"
        onClick={() => {
          setPicker(null);
          startEdit(field, field === "station" ? mod.station : field === "line" ? mod.line : mod.terminal);
        }}
        className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--dim)] [border-radius:6px]"
      >
        手动输入
      </button>
      <button
        type="button"
        onClick={() => setPicker(null)}
        className="flex-1 bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--dim)] [border-radius:6px]"
      >
        取消
      </button>
    </div>
  );

  return (
    <div>
      {/* 第 1 行：站名（点一下先从站序里点选，没有站序才打字） */}
      <div>
        <div className="flex items-center gap-1.5">
          {editField === "station" ? (
            <span className="min-w-0 flex-1">{editInput("站名，如：长虹路")}</span>
          ) : (
            <span
              role="button"
              tabIndex={0}
              aria-label={mod.station ? `站名 ${mod.station}，点我选择站名` : "点我选择站名"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setPicker(picker === "station" ? null : "station")}
              onKeyDown={(e) => {
                if (e.key === "Enter") setPicker("station");
              }}
              className={`min-w-0 flex-1 truncate text-base font-bold ${
                mod.station
                  ? "text-[var(--text)] underline decoration-[var(--border)] decoration-dotted underline-offset-4"
                  : "text-[var(--dim)]"
              }`}
            >
              {mod.station || "点这里选站名"}
            </span>
          )}
          <CanvasCardActions
            label={`${mod.line} ${mod.station}`}
            onStartLink={onStartLink}
            onSaveTemplate={onSaveTemplate}
            saveTemplatePending={saveTemplatePending}
          />
        </div>
        {picker === "station" && editField !== "station" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-1.5 border border-[var(--border)] bg-[var(--surface2)] p-1.5 [border-radius:8px]"
          >
            {pickQ.isLoading ? (
              <p className="px-1 py-1 text-sm text-[var(--dim)]">
                正在找这条线的站点…
              </p>
            ) : (
              <>
                <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                  {pickStops.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        onSaveStation(s);
                        setPicker(null);
                      }}
                      aria-label={`选择站名 ${s}`}
                      className={`px-2.5 py-1 text-sm font-medium [border-radius:999px] ${
                        s === mod.station
                          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                          : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {pickerFooter("station")}
              </>
            )}
          </div>
        )}
      </div>
      {/* 第 2 行：线路（点一下先出用过的线路 chips，新线路才打字） */}
      <div className="mt-1">
        {editField === "line" ? (
          editInput("线路名，如：33路")
        ) : mod.line ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`线路 ${mod.line}，点我选择线路`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPicker(picker === "line" ? null : "line")}
            className="inline-block"
          >
            <LineBadge name={mod.line} />
          </span>
        ) : (
          <span
            role="button"
            tabIndex={0}
            aria-label="点我选择线路"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPicker(picker === "line" ? null : "line")}
            className="inline-block border border-dashed border-[var(--border)] px-2 py-0.5 text-sm text-[var(--dim)] [border-radius:6px]"
          >
            点这里选线路
          </span>
        )}
        {picker === "line" && editField !== "line" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-1.5 border border-[var(--border)] bg-[var(--surface2)] p-1.5 [border-radius:8px]"
          >
            {recentQ.isLoading ? (
              <p className="px-1 py-1 text-sm text-[var(--dim)]">
                正在找你用过的线路…
              </p>
            ) : (
              <>
                {recentLines.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {recentLines.map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => {
                          onSaveLine(l);
                          setPicker(null);
                        }}
                        aria-label={`选择线路 ${l}`}
                        className="border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-sm font-bold text-[var(--text)] [border-radius:999px]"
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-1 py-0.5 text-sm text-[var(--dim)]">
                    还没有用过的线路，手动输入一条吧。
                  </p>
                )}
                {pickerFooter("line")}
              </>
            )}
          </div>
        )}
      </div>
      {/* 第 3 行：方向（点一下出终点站大按钮二选一，可留空；有双向数据时可一键换方向） */}
      <div className="mt-1">
        <div className="flex items-center gap-1.5">
          {editField === "terminal" ? (
            <span className="min-w-0 flex-1">{editInput("方向终点站名，如：高崎公交场站，可留空")}</span>
          ) : (
            <>
              <span
                role="button"
                tabIndex={0}
                aria-label={
                  mod.terminal || dir
                    ? `方向开往 ${mod.terminal || dir?.terminal || ""}，点我选择方向`
                    : "点我选择方向（终点站），也可以留空"
                }
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPicker(picker === "terminal" ? null : "terminal")}
                className="min-w-0 flex-1 truncate text-sm text-[var(--dim)] underline decoration-[var(--border)] decoration-dotted underline-offset-4"
              >
                {mod.terminal
                  ? `开往 ${mod.terminal}`
                  : dir
                    ? `开往 ${dir.terminal}`
                    : "方向未填（点我选，可留空）"}
              </span>
              {otherDir && (
                <button
                  type="button"
                  onClick={() => onSetDirection(otherDir.direction, otherDir.terminal)}
                  aria-label={`换方向：改看开往 ${otherDir.terminal} 的车`}
                  className="shrink-0 bg-[var(--surface2)] px-2 py-0.5 text-xs font-medium text-[var(--accent)] [border-radius:999px]"
                >
                  ⇄ 换方向
                </button>
              )}
            </>
          )}
        </div>
        {picker === "terminal" && editField !== "terminal" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-1.5 border border-[var(--border)] bg-[var(--surface2)] p-1.5 [border-radius:8px]"
          >
            {pickQ.isLoading ? (
              <p className="px-1 py-1 text-sm text-[var(--dim)]">
                正在找这条线的终点站…
              </p>
            ) : pickQ.isError ? (
              <>
                <p className="px-1 py-0.5 text-sm text-[var(--dim)]">
                  终点站选项没取到，可以手动输入。
                </p>
                {pickerFooter("terminal")}
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  {pickTerminals.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        onSetDirection(0, t);
                        setPicker(null);
                      }}
                      aria-label={`选择方向：开往 ${t}`}
                      className={`min-h-[2.5rem] px-2.5 py-1.5 text-left text-base font-bold [border-radius:8px] ${
                        t === mod.terminal
                          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                          : "border border-[var(--accent)] bg-[var(--surface)] text-[var(--text)]"
                      }`}
                    >
                      开往 {t}
                    </button>
                  ))}
                </div>
                {pickerFooter("terminal")}
              </>
            )}
          </div>
        )}
      </div>

      {stopped ? (
        <p className="mt-1.5 text-sm text-[var(--dim)]">
          已停止 · 待机中，不查车。点下面「开始」恢复。
        </p>
      ) : (
        <>
          {error && <p className="mt-1.5 text-sm text-[var(--danger)]">{error}</p>}
          {!data && !error && (
            <p className="mt-1.5 text-sm text-[var(--dim)]">
              {mod.line && mod.station
                ? "还没查过，点刷新看现在有没有车。"
                : "先点上面第 1、2 行把站名和线路填好，再点刷新查车。"}
            </p>
          )}
          {data && !dir && !error && (
            <p className="mt-1.5 text-sm text-[var(--dim)]">这个方向暂时没有查到数据。</p>
          )}
          {data && dir && (
            <>
              {dir.error ? (
                <p className="mt-1.5 text-sm text-[var(--danger)]">这个方向查询失败</p>
              ) : (
                <div className="mt-1.5 space-y-1">
                  {/* 第 4 行：第 1 班；第 5 行：第 2 班。格式一致，
                      没有的班次如实写暂无，不编造 */}
                  {[0, 1].map((idx) => {
                    const b = dir.buses[idx];
                    return (
                      <div
                        key={idx}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="shrink-0 text-xs font-medium text-[var(--dim)]">
                            第 {idx + 1} 班
                          </span>
                          <span
                            className={`min-w-0 truncate text-base text-[var(--text)] ${
                              idx === 0 ? "font-bold" : "font-medium"
                            }`}
                          >
                            {b ? boardHeadline(b) : idx === 0 ? "暂无车" : "暂无"}
                          </span>
                        </span>
                        {b?.arrivalTime && (
                          <span className="shrink-0 text-sm text-[var(--dim)]">
                            {b.arrivalTime}到
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-xs text-[var(--dim)]">
                数据时间 {data.queriedAt}
                {data.cached ? " · 缓存" : ""}
              </p>
            </>
          )}
        </>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onToggleEnabled(stopped)}
          aria-label={
            stopped
              ? `开始 ${mod.line} 在 ${mod.station} 的模块`
              : `停止 ${mod.line} 在 ${mod.station} 的模块`
          }
          aria-pressed={!stopped}
          className={`shrink-0 px-3 py-1 text-sm font-bold [border-radius:8px] ${
            stopped
              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
              : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
          }`}
        >
          {stopped ? "▶ 开始" : "■ 停止"}
        </button>
        <button
          type="button"
          onClick={() => rtM.mutate()}
          disabled={stopped || rtM.isPending || !mod.line || !mod.station}
          aria-label={`刷新 ${mod.line} 在 ${mod.station} 的实时到站`}
          className="shrink-0 bg-[var(--accent)] px-3 py-1 text-sm font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-40"
        >
          {rtM.isPending ? "查询中…" : data ? "↻ 刷新" : "↻ 点查"}
        </button>
      </div>
      <input
        defaultValue={mod.note}
        key={`${mod.id}:${mod.note}`}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== mod.note) onSaveNote(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="备注，如：下车过马路"
        aria-label={`${mod.line} ${mod.station} 的备注`}
        className="mt-1.5 w-full border-b border-dashed border-[var(--border)] bg-transparent px-1 py-0.5 text-xs text-[var(--dim)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
      />
    </div>
  );
}

function CanvasTextCard({
  mod,
  onStartLink,
  onSaveTemplate,
  saveTemplatePending,
  onSaveText,
}: {
  mod: CanvasModule;
  onStartLink: () => void;
  onSaveTemplate: () => void;
  saveTemplatePending: boolean;
  onSaveText: (text: string) => void;
}) {
  return (
    <div>
      <div className="flex items-start gap-1.5">
        <textarea
          defaultValue={mod.text}
          key={`${mod.id}:${mod.text}`}
          rows={2}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== mod.text) onSaveText(v);
          }}
          aria-label="文本卡内容（改完点别处保存）"
          className="min-w-0 flex-1 resize-none bg-transparent text-lg font-bold text-[var(--text)] outline-none"
        />
        <CanvasCardActions
          label={`文本卡 ${mod.text}`}
          onStartLink={onStartLink}
          onSaveTemplate={onSaveTemplate}
          saveTemplatePending={saveTemplatePending}
        />
      </div>
      <p className="text-xs text-[var(--dim)]">文本卡 · 改完点别处自动保存</p>
    </div>
  );
}
