import { useEffect, useRef, useState, type FormEvent } from "react";
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
// 进入、或从查车页顶部的行程横条回到。
type Tab = "home" | "route" | "nearby" | "metro" | "favorites" | "settings" | "trip";

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
  return <h2 className="text-sm font-bold text-[var(--dim)]">{children}</h2>;
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
            {homeMode === "query" && (
              <section aria-label="实时到站查询">
                {favRouteList.length > 0 && (
                  <div className="mt-4">
                    <SectionTitle>常用路线</SectionTitle>
                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                      {favRouteList.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          className="shrink-0 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] [border-radius:999px]"
                          aria-label={`规划常用路线 ${r.label}`}
                          onClick={() => runRoute(r.origin, r.destination)}
                        >
                          {r.label}
                        </button>
                      ))}
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
                onStartTrip={startTrip}
                starting={startTripMut.isPending}
                hasActiveTrip={!!activeTrip}
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
                <article key={m.name} className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 [border-radius:var(--radius)]">
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

            <BoardSection
              city={city}
              favorites={favList}
              onOpenLineStation={(line, station) => runRealtime(line, station)}
              onOpenStation={(name) => openStation(name)}
            />

            <div className="mt-6">
              <SectionTitle>线路与站点</SectionTitle>
              {favList.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
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
                        className="shrink-0 px-3 text-[var(--dim)]"
                        onClick={() => removeFav.mutate(f.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-6">
              <SectionTitle>常用路线</SectionTitle>
              {favRouteList.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
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
                        aria-label={`删除常用路线 ${r.label}`}
                        className="shrink-0 px-3 text-[var(--dim)]"
                        onClick={() => removeFavRoute.mutate(r.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-6">
              <SectionTitle>常用地点</SectionTitle>
              {placeList.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  还没有常用地点。在「规划」里输入地点后点「☆ 把起点/终点存为常用地点」，下次点一下名字就能填好。
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] [border-radius:var(--radius)]">
                  {placeList.map((p) => (
                    <li key={p.id} className="flex items-center gap-1 px-4 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-bold text-[var(--text)]">{p.name}</span>
                        <span className="block truncate text-sm text-[var(--dim)]">{p.address}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`把${p.name}设为起点并去规划`}
                        className="shrink-0 px-2 text-sm text-[var(--accent)]"
                        onClick={() => { setOrigin(p.address); setTab("route"); }}
                      >
                        设起点
                      </button>
                      <button
                        type="button"
                        aria-label={`把${p.name}设为终点并去规划`}
                        className="shrink-0 px-2 text-sm text-[var(--accent)]"
                        onClick={() => { setDestination(p.address); setTab("route"); }}
                      >
                        设终点
                      </button>
                      <button
                        type="button"
                        aria-label={`删除常用地点 ${p.name}`}
                        className="shrink-0 px-2 text-[var(--dim)]"
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
                  ? "font-bold text-[var(--accent)]"
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
        <p className="mt-2 text-sm text-[var(--dim)]">
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
    <article className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 [border-radius:var(--radius)]">
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
  if (bus.arrivalTime) parts.push(`预计 ${bus.arrivalTime} 到`);
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
  onStartTrip,
  starting,
  hasActiveTrip,
}: {
  data: RoutePlanResult;
  onStartTrip: (plan: RoutePlan) => void;
  starting: boolean;
  hasActiveTrip: boolean;
}) {
  return (
    <div className="mt-6 space-y-3">
      {data.plans.map((p, i) => {
        const rides = p.segments.filter((s) => s.type !== "步行");
        return (
          <article key={i} className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 [border-radius:var(--radius)]">
            <p className="text-lg font-bold text-[var(--text)]">
              约 {p.durationMin} 分钟
              {p.best && <span className="ml-2 text-sm font-bold text-[var(--amber)]">最优</span>}
            </p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              方案 {i + 1} · 步行约 {p.walking} 米{p.cost && p.cost !== "0" && p.cost !== "?" ? ` · 票价约 ${p.cost} 元` : ""}
            </p>
            <ol className="mt-2 space-y-1.5">
              {rides.map((s, j) => (
                <li key={j} className="text-base text-[var(--text)]">
                  <span className="mr-1.5 text-[var(--accent)]">{CIRCLES[j] ?? `${j + 1}.`}</span>
                  {s.departure ? `${s.departure}${s.departure.endsWith("站") ? "" : "站"}` : "起点"} 坐
                  <span className="font-bold"> {s.name} </span>→{" "}
                  {s.arrival ? `${s.arrival}${s.arrival.endsWith("站") ? "" : "站"}` : "终点"} 下车
                </li>
              ))}
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

// 当前段的上车站实时：先只读服务端缓存快照（不调接口），有缓存先
// 显示；真查询只在用户点「查实时 / 刷新」时发生，复用 queryLineRealtime
// 的服务端缓存，不自动轮询。换乘段（isTransfer）用琥珀色醒目呈现。
function TripRealtime({
  city,
  seg,
  isTransfer,
}: {
  city: string;
  seg: TripSegment;
  isTransfer: boolean;
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

  return (
    <div
      className={`mt-3 px-3 py-3 [border-radius:8px] ${
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
}: {
  trip: ActiveTrip;
  onAdvance: () => void;
  advancing: boolean;
  advanceError: string;
  onEnd: () => void;
  ending: boolean;
  onBack: () => void;
}) {
  const [confirmEnd, setConfirmEnd] = useState(false);
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
          return (
            <li
              key={i}
              className={`border px-4 py-3 [border-radius:var(--radius)] ${
                isCurrent
                  ? "border-[var(--accent)] bg-[var(--surface)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              } ${done ? "opacity-60" : ""}`}
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
                  <span className="shrink-0 text-xs font-bold text-[var(--accent)]">
                    {ride && trip.phase === "riding" ? "已上车" : "当前段"}
                  </span>
                )}
              </div>

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
                    isTransfer={trip.currentIndex > 0}
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
                <p className="mt-2 text-sm text-[var(--dim)]">
                  跟着导航走到{seg.arrival ? `「${seg.arrival}」` : "下一段上车点"}，走完点下面的按钮。
                </p>
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

      {confirmEnd ? (
        <div className="mt-4 flex items-center gap-2">
          <p className="flex-1 text-sm text-[var(--text)]">确定结束这次行程？进度会清掉。</p>
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
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-bold text-[var(--text)]">{title}</h3>
        <span className="shrink-0 text-xs text-[var(--dim)]">
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
          className="bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
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
            className="px-3 text-sm font-medium text-[var(--danger)] [border-radius:8px] disabled:opacity-50"
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

      <div className="mt-6">
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
