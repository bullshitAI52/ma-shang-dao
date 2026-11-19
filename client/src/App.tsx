import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SafeAreaTopScrim,
  SpaceActionError,
  setFailureNoticeText,
} from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

// 表单输入的长度/范围限制直接取自服务端动作的请求模式，页面与服务端
// 不会各说一套；每个喂给受限字段的输入都展开对应的 FIELDS 条目。
const FIELDS = actionFields<typeof Actions>();

// 保存失败的底部提示用中文措辞：服务端自己给的报错原文已是中文、直接
// 用；请求字段校验失败（英文默认消息）换成一句中文提示。
setFailureNoticeText((error, message) => {
  if (error instanceof SpaceActionError && error.issues.length > 0) {
    return "填写的内容不符合要求，请检查后再试一次。";
  }
  return message;
});

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
    <span className="inline-flex shrink-0 items-center bg-[var(--accent)] px-2.5 py-1 text-base font-bold text-[var(--accent-ink)] [border-radius:6px]">
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
        {...FIELDS.setTransferWalkTime.minutes}
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
  const [rtFail, setRtFail] = useState("");
  const [rtFormError, setRtFormError] = useState("");
  const rt = useMutation({
    mutationFn: (args: { line: string; station: string; forceRefresh?: boolean }) =>
      api.queryLineRealtime({ ...args, city }),
    onError: (e) => setRtFail(`查询失败：${e.message}`),
  });
  const runRealtime = (line: string, station: string) => {
    setRtLine(line);
    setRtStation(station);
    setHomeMode("query");
    setTab("home");
    setRtFail("");
    setRtFormError("");
    rt.mutate({ line, station });
  };
  const onRtSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!rtLine.trim() || !rtStation.trim()) {
      setRtFormError("线路和站名都要填，缺一个查不了。");
      return;
    }
    setRtFormError("");
    setRtFail("");
    rt.mutate({ line: rtLine, station: rtStation });
  };
  // 错误框的「重试」：输入被清掉时不静默跳过，提示缺什么
  const retryRt = () => {
    if (!rtLine.trim() || !rtStation.trim()) {
      setRtFormError("线路和站名都要填，缺一个查不了。");
      return;
    }
    setRtFormError("");
    setRtFail("");
    rt.mutate({ line: rtLine, station: rtStation });
  };

  // 线路详情
  const [ldFail, setLdFail] = useState("");
  const [ldFormError, setLdFormError] = useState("");
  const ld = useMutation({
    mutationFn: (line: string) => api.getLineDetail({ line, city }),
    onError: (e) => setLdFail(`查询失败：${e.message}`),
  });
  const [ldDir, setLdDir] = useState(0);
  const runLineDetail = (line: string) => {
    setLineInput(line);
    setHomeMode("line");
    setTab("home");
    setLdDir(0);
    setLdFail("");
    setLdFormError("");
    ld.mutate(line);
  };
  const onLineSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!lineInput.trim()) {
      setLdFormError("先填线路号再查。");
      return;
    }
    setLdFormError("");
    setLdFail("");
    setLdDir(0);
    ld.mutate(lineInput);
  };
  // 错误框的「重试」：线路号被清掉时不静默跳过，提示先填
  const retryLd = () => {
    if (!lineInput.trim()) {
      setLdFormError("先填线路号再查。");
      return;
    }
    setLdFormError("");
    setLdFail("");
    setLdDir(0);
    ld.mutate(lineInput);
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
  const [ssFormError, setSsFormError] = useState("");
  const onStationSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!stationInput.trim()) {
      setSsFormError("先填站名关键词再搜。");
      return;
    }
    setSsFormError("");
    ss.mutate(stationInput);
  };

  // 附近站点（只在用户点按钮时请求一次定位，不自动轮询）
  const [nbFail, setNbFail] = useState("");
  const nb = useMutation({
    mutationFn: (args: { lng: number; lat: number }) => api.findNearbyStations(args),
    onError: (e) => setNbFail(`搜索失败：${e.message}`),
  });
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const findNearby = () => {
    setLocError("");
    setNbFail("");
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
  const [rpFail, setRpFail] = useState("");
  const [routeFormError, setRouteFormError] = useState("");
  const rp = useMutation({
    mutationFn: (args: { origin: string; destination: string }) =>
      api.planRoute({ ...args, city }),
    onError: (e) => setRpFail(`规划失败：${e.message}`),
  });
  const onRouteSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!origin.trim() || !destination.trim()) {
      setRouteFormError("起点和终点都要填，缺一个规划不了。");
      return;
    }
    setRouteFormError("");
    setRpFail("");
    rp.mutate({ origin, destination });
  };
  const runRoute = (o: string, d: string) => {
    setOrigin(o);
    setDestination(d);
    setTab("route");
    setRouteFormError("");
    setRpFail("");
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
    if (currentRouteFav) {
      removeFavRoute.mutate(currentRouteFav.id);
      return;
    }
    if (!origin.trim() || !destination.trim()) {
      setRouteFormError("起点和终点都填好，才能收藏为常用路线。");
      return;
    }
    setRouteFormError("");
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
  const [startTripFail, setStartTripFail] = useState("");
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
      setStartTripFail("");
      setTab("trip");
    },
    onError: (e) => setStartTripFail(`开始行程失败：${e.message}`),
  });
  const startTrip = (plan: RoutePlan) => {
    if (origin.trim() && destination.trim()) {
      setStartTripFail("");
      startTripMut.mutate({ origin: origin.trim(), destination: destination.trim(), plan });
    }
  };

  // 把规划方案 / 进行中行程转到画布：服务端把各段变成一条模块链
  // （乘车段→到站模块、步行段→文本模块、终点→文本模块，依次连线），
  // 排在画布现有内容下方。转完跳画布页，并让画布把新链滚到视口顶部。
  const [canvasFocus, setCanvasFocus] = useState<{ y: number; nonce: number } | null>(null);
  const [toCanvasFail, setToCanvasFail] = useState("");
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
    }) => {
      // 转入用户当前所在的画布项目（画布页把当前项目 id 记在本地）
      let pid: number | undefined;
      try {
        const v = Number(window.localStorage.getItem(`canvas-project:${city}`));
        if (Number.isFinite(v) && v > 0) pid = v;
      } catch {
        // 读不到本地记录就让服务端用最早的项目
      }
      return api.importPlanToCanvas({ ...args, city, projectId: pid });
    },
    onError: (e) => setToCanvasFail(`转到画布失败：${e.message}`),
    onSuccess: (data) => {
      setToCanvasFail("");
      const prev = queryClient.getQueryData<CanvasData>(["canvasLatest", city]);
      const prevIds = new Set(
        prev && prev.projectId === data.projectId
          ? prev.modules.map((m) => m.id)
          : [],
      );
      const fresh = data.modules.filter((m) => !prevIds.has(m.id));
      queryClient.setQueryData(["canvasLatest", city], data);
      queryClient.setQueryData(["canvas", city, data.projectId], data);
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
      setToCanvasFail("");
      toCanvasMut.mutate({
        origin: origin.trim(),
        destination: destination.trim(),
        segments: plan.segments,
      });
    }
  };
  const tripToCanvas = () => {
    if (!activeTrip) return;
    setToCanvasFail("");
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
  const [quickFail, setQuickFail] = useState("");
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
      setQuickFail("");
      setTab("trip");
    },
    onError: (e) => setQuickFail(`开始行程失败：${e.message}`),
  });
  const quickStartTrip = (r: FavRoute) => {
    quickStartMut.reset();
    setQuickFail("");
    if (activeTrip) setPendingQuickRoute(r);
    else quickStartMut.mutate(r);
  };
  const quickPendingId = quickStartMut.isPending
    ? (quickStartMut.variables?.id ?? null)
    : null;
  const [advanceFail, setAdvanceFail] = useState("");
  const advanceTripMut = useMutation({
    mutationFn: () => api.advanceTrip({}),
    onSuccess: (data) => {
      setAdvanceFail("");
      if (data.trip?.finished) {
        // 行程完成：服务端已清除进行中状态，本地展示到达页
        queryClient.setQueryData(["activeTrip"], { trip: null });
        setTripFinished(true);
      } else {
        queryClient.setQueryData(["activeTrip"], data);
      }
    },
    onError: (e) => setAdvanceFail(`推进失败：${e.message}`),
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
  const [smartError, setSmartError] = useState("");
  const [cityFormError, setCityFormError] = useState("");
  const LINE_TOKEN = /^(\d+|快\d+|m\d+|brt)路?$/i;
  const onSmartSubmit = (e: FormEvent) => {
    e.preventDefault();
    const s = smart.trim();
    if (!s) {
      setSmartError("先输入线路、站名，或「起点 终点」，再点搜。");
      return;
    }
    setSmartError("");
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
            <div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!customCityInput.trim()) {
                    setCityFormError("先输入城市名再切换。");
                    return;
                  }
                  setCityFormError("");
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
                <button
                  type="button"
                  className={ghostBtnCls}
                  onClick={() => {
                    setCityFormError("");
                    setCustomCityMode(false);
                  }}
                >
                  取消
                </button>
              </form>
              {cityFormError && (
                <p className="mt-2 text-sm text-[var(--danger)]">{cityFormError}</p>
              )}
            </div>
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
          {smartError && (
            <p className="mt-2 text-sm text-[var(--danger)]">{smartError}</p>
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
        {quickFail && (
          <div className="mt-4">
            <ErrorBox message={quickFail} />
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
                      {...FIELDS.queryLineRealtime.line}
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
                        {...FIELDS.queryLineRealtime.station}
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

                {rtFormError && (
                  <p className="mt-3 text-sm text-[var(--danger)]">{rtFormError}</p>
                )}
                {rt.data && !rt.data.ok && (
                  <ErrorBox message={rt.data.error} onRetry={retryRt} />
                )}
                {rtFail && <ErrorBox message={rtFail} onRetry={retryRt} />}
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
                      {...FIELDS.getLineDetail.line}
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

                {ldFormError && (
                  <p className="mt-3 text-sm text-[var(--danger)]">{ldFormError}</p>
                )}
                {ld.data && !ld.data.ok && <ErrorBox message={ld.data.error} onRetry={retryLd} />}
                {ldFail && <ErrorBox message={ldFail} onRetry={retryLd} />}
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
                      {...FIELDS.searchStations.keyword}
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

                {ssFormError && (
                  <p className="mt-3 text-sm text-[var(--danger)]">{ssFormError}</p>
                )}
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
                <input {...FIELDS.planRoute.origin} id="route-origin" className={inputCls} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={`输入${city}的起点地名`} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="route-dest" className="mb-1 block text-sm text-[var(--dim)]">终点</label>
                <PlaceChips places={placeList} fieldLabel="终点" onPick={(p) => setDestination(p.address)} />
                <div className="flex gap-2">
                  <input {...FIELDS.planRoute.destination} id="route-dest" className={inputCls} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="输入终点地名" autoComplete="off" />
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
                      {...FIELDS.addFavoritePlace.name}
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

            {routeFormError && (
              <p className="mt-3 text-sm text-[var(--danger)]">{routeFormError}</p>
            )}
            {rp.data && !rp.data.ok && <ErrorBox message={rp.data.error} onRetry={() => origin.trim() && destination.trim() && rp.mutate({ origin, destination })} />}
            {rpFail && (
              <ErrorBox
                message={rpFail}
                onRetry={() => {
                  if (!origin.trim() || !destination.trim()) return;
                  setRpFail("");
                  rp.mutate({ origin, destination });
                }}
              />
            )}
            {rp.data?.ok && (
              <RoutePlansPanel
                data={rp.data}
                city={city}
                onStartTrip={startTrip}
                starting={startTripMut.isPending}
                hasActiveTrip={!!activeTrip}
                onToCanvas={planToCanvas}
                toCanvasPending={toCanvasMut.isPending}
                toCanvasError={toCanvasFail}
              />
            )}
            {startTripFail && <ErrorBox message={startTripFail} />}
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
            {nbFail && <ErrorBox message={nbFail} onRetry={findNearby} />}
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
              onAdvance={() => {
                setAdvanceFail("");
                advanceTripMut.mutate();
              }}
              advancing={advanceTripMut.isPending}
              advanceError={advanceFail}
              onEnd={() => endTripMut.mutate()}
              ending={endTripMut.isPending}
              onBack={() => setTab("home")}
              onToCanvas={tripToCanvas}
              toCanvasPending={toCanvasMut.isPending}
              toCanvasError={toCanvasFail}
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
          <CanvasView key={city} city={city} onBack={() => setTab("home")} focus={canvasFocus} />
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
  const [rtFail, setRtFail] = useState("");
  const [saFail, setSaFail] = useState("");
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: fav.value, station: fav.label, city }),
    onError: (e) => setRtFail(`查询失败：${e.message}`),
  });
  const saM = useMutation({
    mutationFn: () => api.queryStationArrivals({ station: fav.label, city }),
    onError: (e) => setSaFail(`查询失败：${e.message}`),
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
    rtFail ||
    saFail;
  const refresh = () => {
    if (isLineStation) {
      setRtFail("");
      rtM.mutate();
    } else {
      setSaFail("");
      saM.mutate();
    }
  };

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
  const [rtFail, setRtFail] = useState("");
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: seg.name, station: seg.departure, city }),
    onError: (e) => setRtFail(`查询失败：${e.message}`),
  });
  const data: RealtimeResult | null = rtM.data?.ok
    ? rtM.data
    : (snapshot.data?.entries[0]?.realtime ?? null);
  const error =
    (rtM.data && !rtM.data.ok ? rtM.data.error : "") || rtFail;
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
          onClick={() => {
            setRtFail("");
            rtM.mutate();
          }}
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
    onError: (e) => setFeedback(`保存失败：${e.message}`),
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
    onError: (e) => setFeedback(`清除失败：${e.message}`),
  });

  const testMut = useMutation({
    mutationFn: (args: { service: "apizero" | "amap"; key?: string }) =>
      api.testApiKey(args),
    onSuccess: (r, args) =>
      setTestResults((prev) => ({ ...prev, [args.service]: r })),
    onError: (e, args) =>
      setTestResults((prev) => ({
        ...prev,
        [args.service]: { ok: false, message: `测试失败：${e.message}` },
      })),
  });
  const runTest = (service: "apizero" | "amap") => {
    const typed = service === "apizero" ? apizeroInput.trim() : amapInput.trim();
    testMut.mutate({ service, ...(typed ? { key: typed } : {}) });
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
        {...(service === "apizero"
          ? FIELDS.saveSettings.apizeroKey
          : FIELDS.saveSettings.amapKey)}
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
// 实时口径与站牌一致：打开先读服务端缓存快照（零接口调用），不做
// 自动定时轮询——到站卡点「开始」只立即查一次，之后每张卡各自点
// 「点查/刷新」才再查（走 queryLineRealtime、吃 90 秒服务端缓存），
// 「停止」待机不查询。
// 手势分工：拖模块本体移动模块，拖空白处平移画布，双指/滚轮缩放。

const CANVAS_WORLD_W = 2400;
const CANVAS_WORLD_H = 1800;
// 卡片基础宽度：手机上至少正文字号可读、按钮热区 ≥40px，232 太挤，
// 放大到 272；宁可平移画布也不要把卡缩到看不清。
const CANVAS_MODULE_W = 272;
// 模块高度估算（到站卡五行 + 按钮行约 210），只用于打开时 fit、
// 新模块避让重叠的粗算，不参与真实渲染。
const CANVAS_MODULE_H_EST = 215;

function clampScale(k: number): number {
  return Math.min(2.5, Math.max(0.3, k));
}

// 连线链推导：按连线关系把模块排成一条条链。链头 = 有连线但
// 没有入边的模块；从链头沿出边（按连线 id 顺序取第一条未走过的）
// 一路走到底。分支的另一条边、环等剩余的已连线模块再各自成组；
// 完全没有连线的模块最后单独成组（loose，chain=false）。
// 路线树升级后，纵向流改由 parentId 成树（见 buildCanvasTree）；
// 这套连线顺序只剩自由画布的步号徽章在用。
type FlowGroup = {
  modules: CanvasModule[];
  pathLinkIds: number[];
  chain: boolean;
};

function buildFlowGroups(
  mods: CanvasModule[],
  lnks: CanvasData["links"],
): FlowGroup[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const outgoing = new Map<number, { toId: number; linkId: number }[]>();
  const hasIncoming = new Set<number>();
  const inAnyLink = new Set<number>();
  for (const l of lnks) {
    if (!byId.has(l.fromId) || !byId.has(l.toId)) continue;
    const arr = outgoing.get(l.fromId) ?? [];
    arr.push({ toId: l.toId, linkId: l.id });
    outgoing.set(l.fromId, arr);
    hasIncoming.add(l.toId);
    inAnyLink.add(l.fromId);
    inAnyLink.add(l.toId);
  }
  for (const arr of outgoing.values()) arr.sort((a, b) => a.linkId - b.linkId);
  const sortYX = (a: CanvasModule, b: CanvasModule) =>
    a.y - b.y || a.x - b.x || a.id - b.id;
  const visited = new Set<number>();
  const walk = (start: CanvasModule) => {
    const arr: CanvasModule[] = [];
    const pathIds: number[] = [];
    let cur: CanvasModule | undefined = start;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      arr.push(cur);
      const nxt = (outgoing.get(cur.id) ?? []).find((o) => !visited.has(o.toId));
      if (!nxt) break;
      pathIds.push(nxt.linkId);
      cur = byId.get(nxt.toId);
    }
    return { arr, pathIds };
  };
  const groups: FlowGroup[] = [];
  const heads = mods
    .filter((m) => inAnyLink.has(m.id) && !hasIncoming.has(m.id))
    .sort(sortYX);
  for (const h of heads) {
    if (visited.has(h.id)) continue;
    const { arr, pathIds } = walk(h);
    if (arr.length > 0) groups.push({ modules: arr, pathLinkIds: pathIds, chain: true });
  }
  for (const m of [...mods].sort(sortYX)) {
    if (!inAnyLink.has(m.id) || visited.has(m.id)) continue;
    const { arr, pathIds } = walk(m);
    if (arr.length > 0) groups.push({ modules: arr, pathLinkIds: pathIds, chain: true });
  }
  for (const m of mods.filter((x) => !inAnyLink.has(x.id)).sort(sortYX)) {
    groups.push({ modules: [m], pathLinkIds: [], chain: false });
  }
  return groups;
}

// 纵向流的路线树：模块按 parentId 挂接成树（类二叉树）——parentId=0
// （或指向不存在的卡，防御性兜底）为顶层，顶层之间是主线顺序
// （然后）；子卡是父卡分出的不同路线，同一父卡的子卡之间是备选
// （或），子卡还能再挂子卡。同层顺序按 stepIndex 再按 id（创建先
// 后）：迁移前的步序原样保留，新卡（stepIndex 更大）排在同层最后。
type CanvasTreeNode = { mod: CanvasModule; children: CanvasTreeNode[] };

function buildCanvasTree(mods: CanvasModule[]): CanvasTreeNode[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const kidsOf = new Map<number, CanvasModule[]>();
  const roots: CanvasModule[] = [];
  for (const m of mods) {
    if (m.parentId > 0 && m.parentId !== m.id && byId.has(m.parentId)) {
      const arr = kidsOf.get(m.parentId) ?? [];
      arr.push(m);
      kidsOf.set(m.parentId, arr);
    } else {
      roots.push(m);
    }
  }
  const byStepThenId = (a: CanvasModule, b: CanvasModule) =>
    a.stepIndex - b.stepIndex || a.id - b.id;
  const seen = new Set<number>();
  const build = (m: CanvasModule): CanvasTreeNode => {
    seen.add(m.id);
    const kids = (kidsOf.get(m.id) ?? [])
      .filter((k) => !seen.has(k.id))
      .sort(byStepThenId);
    return { mod: m, children: kids.map(build) };
  };
  const tree = roots.sort(byStepThenId).map(build);
  // 互相挂接成环的卡（服务端已防环，这里兜底）：没被任何树根触达
  // 的按顶层补在最后，保证每张卡都渲染得出来
  for (const m of mods.filter((x) => !seen.has(x.id)).sort(byStepThenId)) {
    tree.push(build(m));
  }
  return tree;
}

// 子树里卡的总数（折叠摘要的「后面还有 N 张卡」用）
function treeDescendantCount(node: CanvasTreeNode): number {
  return node.children.reduce(
    (n, c) => n + 1 + treeDescendantCount(c),
    0,
  );
}

// 子树的全部后代 id（挂接选父卡时排除自己与子孙，防环）
function treeDescendantIds(node: CanvasTreeNode): Set<number> {
  const out = new Set<number>();
  const walk = (n: CanvasTreeNode) => {
    for (const c of n.children) {
      out.add(c.mod.id);
      walk(c);
    }
  };
  walk(node);
  return out;
}

// 卡的一行摘要名：到站卡「站名 · 线路」，文本卡用文字本身
function canvasModLabel(m: CanvasModule): string {
  if (m.kind === "station") {
    const line = m.line.trim();
    const st = m.station.trim();
    if (line && st) return `${st} · ${line}`;
    return line || st || "未填的到站卡";
  }
  return m.text.trim() || "未填的文本卡";
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
  // 画布项目：当前项目 id 记在本地（按城市），服务端返回的 projectId
  // 为准（本地存的可能已删或不属于本城时以服务端落定的为准）。
  const projectStorageKey = `canvas-project:${city}`;
  const [projectId, setProjectId] = useState<number>(() => {
    try {
      const v = Number(window.localStorage.getItem(projectStorageKey));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  });
  const canvasQ = useQuery({
    queryKey: ["canvas", city, projectId],
    queryFn: () =>
      api.getCanvas({ city, projectId: projectId > 0 ? projectId : undefined }),
  });
  const projects = canvasQ.data?.projects ?? [];
  const curProjectId = canvasQ.data?.projectId ?? 0;
  const currentProject = projects.find((p) => p.id === curProjectId);
  useEffect(() => {
    const pid = canvasQ.data?.projectId;
    if (!pid) return;
    if (pid !== projectId) setProjectId(pid);
    try {
      window.localStorage.setItem(projectStorageKey, String(pid));
    } catch {
      // 存不下不影响使用，只是下次打开回到最早的项目
    }
    // 给规划/行程转画布留一份最新画布镜像（算新链位置用）
    queryClient.setQueryData(["canvasLatest", city], canvasQ.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasQ.data]);
  const modules = canvasQ.data?.modules ?? [];
  const links = canvasQ.data?.links ?? [];

  // 显示模式：自由画布（free）/ 纵向流（flow）/ 文字版（text）。
  // 选择按「城市+项目」记在 localStorage；没记过的项目，窄屏
  // （<640px）默认纵向流、宽屏默认自由画布。
  const [canvasMode, setCanvasMode] = useState<"free" | "flow" | "text">("flow");
  const modeProjectRef = useRef(0);
  useEffect(() => {
    if (!curProjectId || modeProjectRef.current === curProjectId) return;
    modeProjectRef.current = curProjectId;
    let v: string | null = null;
    try {
      v = window.localStorage.getItem(`canvas-mode:${city}:${curProjectId}`);
    } catch {
      v = null;
    }
    if (v === "free" || v === "flow" || v === "text") setCanvasMode(v);
    else setCanvasMode(window.innerWidth < 640 ? "flow" : "free");
  }, [curProjectId, city]);
  const switchMode = (m: "free" | "flow" | "text") => {
    setCanvasMode(m);
    try {
      window.localStorage.setItem(`canvas-mode:${city}:${curProjectId}`, m);
    } catch {
      // 存不下不影响本次切换
    }
  };
  // 连线推导的顺序与步骤分组：路线树升级后只供自由画布的步号徽章
  // 用（第X步/方案A/B），纵向流的结构改由 parentId 路线树决定。
  const flowGroups = buildFlowGroups(modules, links);
  // 步骤分组：把流顺序压平，连续同 stepIndex 的卡归为一步。显示的
  // 「第 X 步」用步组在序列中的序号（stepIndex 只是分组键、允许
  // 空缺，序号永远连续）。
  type FlowEntry = { mod: CanvasModule; group: FlowGroup; idx: number };
  const flowSeq: FlowEntry[] = flowGroups.flatMap((g) =>
    g.modules.map((m, idx) => ({ mod: m, group: g, idx })),
  );
  type StepGroup = { step: number; entries: FlowEntry[] };
  const stepGroups: StepGroup[] = [];
  for (const e of flowSeq) {
    const last = stepGroups[stepGroups.length - 1];
    if (last && last.step === e.mod.stepIndex) last.entries.push(e);
    else stepGroups.push({ step: e.mod.stepIndex, entries: [e] });
  }
  // 每张卡的步骤信息：所属步组的序号（显示用）、组内第几个方案
  const stepInfoById = new Map<
    number,
    { ordinal: number; inGroup: number; groupSize: number }
  >();
  stepGroups.forEach((sg, gi) => {
    sg.entries.forEach((e, i) => {
      stepInfoById.set(e.mod.id, {
        ordinal: gi + 1,
        inGroup: i,
        groupSize: sg.entries.length,
      });
    });
  });
  // 纵向流路线树：按 parentId 递归成树，渲染与挂接选卡共用
  const canvasTree = buildCanvasTree(modules);
  const treeNodeById = new Map<number, CanvasTreeNode>();
  const collectTreeNodes = (nodes: CanvasTreeNode[]) => {
    for (const n of nodes) {
      treeNodeById.set(n.mod.id, n);
      collectTreeNodes(n.children);
    }
  };
  collectTreeNodes(canvasTree);
  // 支线折叠状态：按「城市+项目」存 localStorage，重开保持
  const collapsedStorageKey = curProjectId
    ? `canvas-collapsed:${city}:${curProjectId}`
    : "";
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<number>>(
    new Set(),
  );
  useEffect(() => {
    if (!collapsedStorageKey) return;
    try {
      const raw = window.localStorage.getItem(collapsedStorageKey);
      const arr: unknown = raw ? JSON.parse(raw) : [];
      setCollapsedIds(
        new Set(
          Array.isArray(arr)
            ? arr.filter((x): x is number => typeof x === "number")
            : [],
        ),
      );
    } catch {
      setCollapsedIds(new Set());
    }
  }, [collapsedStorageKey]);
  const toggleCollapsed = (id: number) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(
          collapsedStorageKey,
          JSON.stringify([...next]),
        );
      } catch {
        // 存不下不影响本次折叠
      }
      return next;
    });
  };
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

  // 到站卡当前显示的实时状态（卡片自己点查到的数据与报错，就是卡面
  // 此刻呈现的那一份）按模块 id 同步到这里：文字版模式直接读这份
  // 状态渲染，两边永远是同一份数据、文字版没有自己的副本。卡片还
  // 没挂载过（直接以文字版打开画布）时，文字版退回上面的缓存快照
  // entry——那正是卡片首屏用的同一份。文字版的「全部刷新」也把
  // 逐张查询的结果写进这同一份 rtReports，不另存副本。
  const [rtReports, setRtReports] = useState<
    ReadonlyMap<number, { data: RealtimeResult | null; error: string }>
  >(new Map());
  const reportRt = useCallback(
    (id: number, data: RealtimeResult | null, error: string) => {
      setRtReports((prev) => {
        const cur = prev.get(id);
        if (cur && cur.data === data && cur.error === error) return prev;
        const next = new Map(prev);
        next.set(id, { data, error });
        return next;
      });
    },
    [],
  );

  // 文字版「全部刷新」：一次性手动刷新当前项目里所有已填好站名+线路
  // 的到站卡——逐张走与卡片点查完全相同的 queryLineRealtime（同一
  // 接口、同一 90 秒服务端缓存），结果写回同一份 rtReports，文字版
  // 与卡片两边同步。不管卡片是开始还是停止都查这一次，但不改任何
  // 卡的启停状态、不开启自动轮询。某张失败（报错原文）只记到那张
  // 卡名下，不中断其余卡。refreshProgress 非空即刷新进行中。
  const refreshTargets = modules.filter(
    (m) => m.kind === "station" && m.line.trim() && m.station.trim(),
  );
  const [refreshProgress, setRefreshProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState("");
  const refreshAll = async () => {
    if (refreshProgress) return;
    const targets = refreshTargets;
    if (targets.length === 0) return;
    setRefreshProgress({ done: 0, total: targets.length });
    let done = 0;
    for (const m of targets) {
      try {
        const res = await api.queryLineRealtime({
          line: m.line,
          station: m.station,
          city,
        });
        if (res.ok) reportRt(m.id, res, "");
        else reportRt(m.id, null, res.error);
      } catch (e) {
        reportRt(
          m.id,
          null,
          `查询失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      done += 1;
      setRefreshProgress({ done, total: targets.length });
    }
    setRefreshProgress(null);
    const now = new Date();
    setLastRefreshedAt(
      `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`,
    );
    // 服务端缓存已被逐张查询刷新过：让快照重读，卡片切回来时首屏
    // 用的 entry 也同步到这次结果
    void queryClient.invalidateQueries({
      queryKey: ["canvasSnapshot", city],
    });
  };

  const applyCanvas = (data: CanvasData) => {
    queryClient.setQueryData(["canvas", city, data.projectId], data);
    queryClient.setQueryData(["canvasLatest", city], data);
    if (data.projectId !== projectId) setProjectId(data.projectId);
  };
  const addModuleMut = useMutation({
    mutationFn: (args: {
      kind: "station" | "text";
      line?: string;
      station?: string;
      direction?: number;
      terminal?: string;
      text?: string;
      note?: string;
      parentId?: number;
      x: number;
      y: number;
    }) =>
      api.addCanvasModule({
        ...args,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: (data) => {
      // 不带 parentId 的新卡默认顶层（parentId 为空）：纵向流里排在
      // 主线最后；卡片「更多」里的「＋ 在后面加一张 / ＋ 加并列方案」
      // 会直接带上 parentId，新卡一落下就在树里就位，不用再挂接。
      applyCanvas(data);
    },
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
      stepIndex?: number;
    }) =>
      api.updateCanvasModule({
        ...args,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: applyCanvas,
  });
  const removeModuleMut = useMutation({
    mutationFn: (id: number) =>
      api.removeCanvasModule({
        id,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: applyCanvas,
  });
  const addLinkMut = useMutation({
    mutationFn: (args: { fromId: number; toId: number }) =>
      api.addCanvasLink({
        ...args,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: applyCanvas,
  });
  const removeLinkMut = useMutation({
    mutationFn: (id: number) =>
      api.removeCanvasLink({
        id,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: applyCanvas,
  });

  // 路线树挂接：把卡挂到某张卡后面（成为它的子卡/分支路线）或移
  // 到顶层。服务端校验同项目与防环，失败原因经 attachError 显示在
  // 选卡列表里，不静默失败。attachForId 是正在选父卡的那张卡。
  const [attachForId, setAttachForId] = useState<number | null>(null);
  const [attachError, setAttachError] = useState("");
  const setParentMut = useMutation({
    mutationFn: (args: { id: number; parentId: number }) =>
      api.setCanvasModuleParent({
        ...args,
        city,
        projectId: curProjectId > 0 ? curProjectId : undefined,
      }),
    onSuccess: (res) => {
      if (res.ok && res.canvas) {
        applyCanvas(res.canvas);
        setAttachForId(null);
        setAttachError("");
      } else {
        if (res.canvas) applyCanvas(res.canvas);
        setAttachError(res.error || "挂接失败，再试一次");
      }
    },
    onError: () => setAttachError("挂接失败，再试一次"),
  });

  // 项目操作：新建（空白画布起步、建好自动切过去）、改名、删除
  // （确认一次，连带删该项目的模块与连线；模块库不受影响）。
  const [projectPanel, setProjectPanel] = useState<
    "none" | "switch" | "menu" | "create" | "rename" | "delete"
  >("none");
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectError, setProjectError] = useState("");
  const createProjectMut = useMutation({
    mutationFn: (name: string) => api.createCanvasProject({ city, name }),
    onSuccess: (res) => {
      if (res.ok && res.canvas) {
        applyCanvas(res.canvas);
        setProjectPanel("none");
        setProjectNameInput("");
        setProjectError("");
      } else {
        setProjectError(res.error || "新建项目失败，再试一次");
      }
    },
    onError: () => setProjectError("新建项目失败，再试一次"),
  });
  const renameProjectMut = useMutation({
    mutationFn: (args: { id: number; name: string }) =>
      api.renameCanvasProject({ ...args, city }),
    onSuccess: (res) => {
      if (res.ok && res.canvas) {
        applyCanvas(res.canvas);
        setProjectPanel("none");
        setProjectNameInput("");
        setProjectError("");
      } else {
        // 同名被服务端拦截：面板留着、把原因显示出来，不静默失败
        setProjectError(res.error || "改名失败，再试一次");
      }
    },
    onError: () => setProjectError("改名失败，再试一次"),
  });
  const deleteProjectMut = useMutation({
    mutationFn: (id: number) => api.deleteCanvasProject({ id, city }),
    onSuccess: (data) => {
      applyCanvas(data);
      setProjectPanel("none");
      setProjectError("");
    },
    onError: () => setProjectError("删除项目失败，再试一次"),
  });
  const switchProject = (id: number) => {
    // 点了就先关面板清错误：哪怕点的是当前项目，也不能看起来没反应
    setProjectPanel("none");
    setProjectError("");
    if (id === curProjectId) return;
    setLinkMode(false);
    setLinkFrom(null);
    setAttachForId(null);
    setAttachError("");
    setProjectId(id);
    try {
      window.localStorage.setItem(projectStorageKey, String(id));
    } catch {
      // 存不下不影响本次切换
    }
  };

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

  // 模块层叠顺序：后点的模块在最前。stack 存模块 id 数组，越靠后
  // z 越高；点中/拖动/打开点选面板都会把模块提到最前，被压住的卡
  // 点一下就能翻上来。
  const [stack, setStack] = useState<number[]>([]);
  useEffect(() => {
    setStack((prev) => {
      const ids = modules.map((m) => m.id);
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      return added.length === 0 && kept.length === prev.length
        ? prev
        : [...kept, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules.map((m) => m.id).join(",")]);
  const bringToFront = (id: number) => {
    setStack((prev) =>
      prev[prev.length - 1] === id ? prev : [...prev.filter((x) => x !== id), id],
    );
  };
  const zOf = (id: number) => {
    const i = stack.indexOf(id);
    return 10 + (i >= 0 ? i : 0);
  };

  // 打开项目时按内容 fit 一次：能整张放下就整张放下，但缩放不低于
  // 0.95（卡片不小于可读尺寸、44px 热区缩放后仍 ≥40px），放不下就以
  // 0.95 定位到第一张卡靠平移看。每个项目只 fit 一次，用户之后自己
  // 缩放/平移的不再被覆盖。
  const fittedProjectsRef = useRef(new Set<number>());
  useEffect(() => {
    if (!canvasQ.data || modules.length === 0) return;
    if (canvasMode !== "free") return; // 纵向流不缩放；切回自由画布时再 fit
    const pid = canvasQ.data.projectId;
    if (fittedProjectsRef.current.has(pid)) return;
    if (focus && focusSeenRef.current !== focus.nonce) return; // 转入新链的定位优先
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 50) return;
    fittedProjectsRef.current.add(pid);
    const minX = Math.min(...modules.map((m) => m.x));
    const minY = Math.min(...modules.map((m) => m.y));
    const maxX = Math.max(...modules.map((m) => m.x)) + CANVAS_MODULE_W;
    const maxY = Math.max(...modules.map((m) => m.y)) + CANVAS_MODULE_H_EST;
    const bw = maxX - minX;
    const bh = maxY - minY;
    let k = Math.min(
      1.1,
      (rect.width - 24) / Math.max(bw, 1),
      (rect.height - 24) / Math.max(bh, 1),
    );
    if (k < 0.95) k = 0.95;
    k = clampScale(k);
    setView({
      k,
      x: Math.round(12 - minX * k),
      y: Math.round(12 - minY * k),
    });
    // canvasMode 入依赖：从纵向流切回自由画布时也要补 fit 一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasQ.data, canvasMode]);
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

  // 整删确认：点卡片「更多」里的「删除」后先在模块顶部亮出确认条，确认才删
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  // 卡片「更多」展开区：同一时间只开一张卡（两种模式共用一个状态），
  // 存库/删除/备注/挂接都收在这里，卡面只留核心信息与一行操作
  const [moreCardId, setMoreCardId] = useState<number | null>(null);

  // 加模块面板
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<"station" | "text">("station");
  const [lineKw, setLineKw] = useState("");
  const [lineKwError, setLineKwError] = useState("");
  const [dirIdx, setDirIdx] = useState(0);
  const [textVal, setTextVal] = useState("");
  const [textFormError, setTextFormError] = useState("");
  const [ldFail, setLdFail] = useState("");
  const ldMut = useMutation({
    mutationFn: (line: string) => api.getLineDetail({ line, city }),
    onError: (e) => setLdFail(`查线路失败：${e.message}`),
  });
  const centerWorldPos = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 360;
    const h = rect?.height ?? 480;
    const base = {
      x: Math.round((w / 2 - view.x) / view.k - CANVAS_MODULE_W / 2),
      y: Math.round((h / 2 - view.y) / view.k - 90),
    };
    // 新模块尽量落在空白处：从视口中心起按网格候选逐个试，
    // 与已有模块矩形（宽 + 估算高，各留 16 间隔）不重叠的第一个胜出；
    // 全试完都重叠就回到中心点（用户可拖动，点一下也会置顶）。
    const overlaps = (x: number, y: number) =>
      modules.some(
        (m) =>
          x < m.x + CANVAS_MODULE_W + 16 &&
          x + CANVAS_MODULE_W + 16 > m.x &&
          y < m.y + CANVAS_MODULE_H_EST + 16 &&
          y + CANVAS_MODULE_H_EST + 16 > m.y,
      );
    if (!overlaps(base.x, base.y)) return base;
    for (let ring = 1; ring <= 4; ring++) {
      const dx = ring * (CANVAS_MODULE_W + 24);
      const dy = ring * (CANVAS_MODULE_H_EST + 24);
      const candidates = [
        { x: base.x + dx, y: base.y },
        { x: base.x - dx, y: base.y },
        { x: base.x, y: base.y + dy },
        { x: base.x, y: base.y - dy },
        { x: base.x + dx, y: base.y + dy },
        { x: base.x - dx, y: base.y + dy },
      ];
      for (const c of candidates) {
        const cc = { x: Math.round(c.x), y: Math.round(c.y) };
        if (!overlaps(cc.x, cc.y)) return cc;
      }
    }
    return base;
  };
  const closeAdd = () => {
    setAddOpen(false);
    setLineKw("");
    setLineKwError("");
    setTextVal("");
    setTextFormError("");
    setDirIdx(0);
    setLdFail("");
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
    if (!t) {
      setTextFormError("先写点文字再加到画布。");
      return;
    }
    setTextFormError("");
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

  // ---- 纵向流（路线树）渲染：卡片本体与自由画布共用同一组件，
  // 这里只负责树的结构（缩进/分支线/或/折叠）与挂接工具 ----
  const renderFlowCard = (m: CanvasModule, tools: ReactNode): ReactNode => {
    const stopped = m.kind === "station" && !m.enabled;
    const modLabel =
      m.kind === "station" ? `${m.line} ${m.station}` : `文本卡 ${m.text}`;
    const toggleMore = () => {
      if (attachForId !== null && attachForId !== m.id) {
        setAttachForId(null);
        setAttachError("");
      }
      setMoreCardId(moreCardId === m.id ? null : m.id);
    };
    return (
      <div
        className={`relative border bg-[var(--surface)] px-3.5 py-3 shadow-sm [border-radius:var(--radius)] ${
          stopped ? "opacity-75 saturate-50" : ""
        } border-[var(--border)]`}
      >
        {/* 整删入口已收进卡片「更多」展开区（点删除后仍先出确认条） */}
        {confirmDeleteId === m.id && (
          <div className="absolute inset-x-2 top-2 z-30 border border-[var(--danger)] bg-[var(--surface)] px-3 py-2.5 shadow [border-radius:8px]">
            <p className="text-sm text-[var(--text)]">
              删除这个模块？连着它的线也会一起删，挂在它下面的卡会改挂到它的上一级。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteId(null);
                  removeModuleMut.mutate(m.id);
                }}
                aria-label={`确认删除模块 ${modLabel}`}
                className="min-h-11 flex-1 border border-[var(--danger)] bg-[var(--surface)] px-2 text-sm font-bold text-[var(--danger)] [border-radius:8px]"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="min-h-11 flex-1 bg-[var(--surface2)] px-2 text-sm font-medium text-[var(--text)] [border-radius:8px]"
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
            onSaveTemplate={() => saveTemplateMut.mutate(m)}
            saveTemplatePending={saveTemplateMut.isPending}
            onSaveNote={(note) => updateModuleMut.mutate({ id: m.id, note })}
            onSaveStation={(station) =>
              updateModuleMut.mutate({ id: m.id, station })
            }
            onSaveLine={(line) =>
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
            moreOpen={moreCardId === m.id}
            onToggleMore={toggleMore}
            onDeleteRequest={() => setConfirmDeleteId(m.id)}
            flowTools={tools}
            onRtReport={reportRt}
          />
        ) : (
          <CanvasTextCard
            mod={m}
            onSaveTemplate={() => saveTemplateMut.mutate(m)}
            saveTemplatePending={saveTemplateMut.isPending}
            onSaveText={(text) => updateModuleMut.mutate({ id: m.id, text })}
            moreOpen={moreCardId === m.id}
            onToggleMore={toggleMore}
            onDeleteRequest={() => setConfirmDeleteId(m.id)}
            flowTools={tools}
          />
        )}
      </div>
    );
  };

  // 一键加卡（路线树）：不用先在顶层加卡再回来挂接，点一下新卡
  // 就直接生在本卡的树位置上。都是空白到站卡、零接口调用、自动
  // 保存，落下后在卡上点选站名/线路即可。
  // - 在后面加一张：parent = 本卡，出现在本卡下方缩进处，接着本
  //   条路线往下走；本卡若是收起状态先展开，不然新卡会被折住。
  // - 加并列方案：parent = 本卡的 parent，与本卡同层并列（中间
  //   是「或」）；本卡是顶层卡时新卡也是顶层。
  const addCardBehind = (m: CanvasModule) => {
    if (collapsedIds.has(m.id)) toggleCollapsed(m.id);
    addModuleMut.mutate({
      kind: "station",
      line: "",
      station: "",
      direction: 0,
      terminal: "",
      parentId: m.id,
      x: Math.round(m.x),
      y: Math.round(m.y + CANVAS_MODULE_H_EST + 32),
    });
  };
  const addCardBeside = (m: CanvasModule) => {
    if (m.parentId > 0 && collapsedIds.has(m.parentId)) {
      toggleCollapsed(m.parentId);
    }
    addModuleMut.mutate({
      kind: "station",
      line: "",
      station: "",
      direction: 0,
      terminal: "",
      parentId: m.parentId,
      x: Math.round(m.x + 24),
      y: Math.round(m.y + CANVAS_MODULE_H_EST + 32),
    });
  };

  // 每卡「更多」里的路线树工具：顶部是两个一键加卡入口（在后面
  // 加一张 / 加并列方案），下面是挪动已存在卡的挂接（挂到某张卡
  // 后面选父卡 / 移到顶层）。选父卡时列出项目内其他卡，自己与自
  // 己的子孙不列（防环，服务端还会再校验一次）。
  const renderTreeTools = (node: CanvasTreeNode): ReactNode => {
    const m = node.mod;
    const label = canvasModLabel(m);
    const parentMod =
      m.parentId > 0 ? modules.find((x) => x.id === m.parentId) : undefined;
    if (attachForId === m.id) {
      const descIds = treeDescendantIds(node);
      const candidates = modules.filter(
        (x) => x.id !== m.id && !descIds.has(x.id),
      );
      return (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <p className="text-sm font-bold text-[var(--text)]">
            把「{label}」挂到哪张卡后面？
          </p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={setParentMut.isPending}
                onClick={() =>
                  setParentMut.mutate({ id: m.id, parentId: c.id })
                }
                aria-label={`把 ${label} 挂到 ${canvasModLabel(c)} 后面`}
                className="min-h-11 bg-[var(--surface2)] px-3 text-left text-base font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
              >
                {canvasModLabel(c)}
                {c.id === m.parentId && (
                  <span className="text-[var(--accent)]">
                    （现在就挂在这张后面）
                  </span>
                )}
              </button>
            ))}
            {candidates.length === 0 && (
              <p className="text-sm text-[var(--dim)]">
                没有别的卡可以挂了。
              </p>
            )}
          </div>
          {attachError && (
            <p className="mt-1.5 text-sm text-[var(--danger)]" role="alert">
              {attachError}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setAttachForId(null);
              setAttachError("");
            }}
            className="mt-1.5 min-h-10 px-3 text-sm font-bold text-[var(--dim)] [border-radius:8px]"
          >
            取消
          </button>
        </div>
      );
    }
    return (
      <div className="mt-2 border-t border-[var(--border)] pt-2">
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            disabled={addModuleMut.isPending}
            onClick={() => addCardBehind(m)}
            aria-label={`在 ${label} 后面加一张空白到站卡，接着这条路线往下`}
            className="min-h-11 bg-[var(--accent)] px-3 text-left text-base font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
          >
            ＋ 在后面加一张
            <span className="text-sm font-medium opacity-80">
              {" "}
              · 接着这条路线往下
            </span>
          </button>
          <button
            type="button"
            disabled={addModuleMut.isPending}
            onClick={() => addCardBeside(m)}
            aria-label={`给 ${label} 加一张并列的空白到站卡，同层备选，任选其一`}
            className="min-h-11 bg-[var(--surface2)] px-3 text-left text-base font-bold text-[var(--text)] [border-radius:8px] disabled:opacity-50"
          >
            ＋ 加并列方案
            <span className="text-sm font-medium text-[var(--dim)]">
              {" "}
              · 和这张同层，任选其一
            </span>
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          加的都是空白到站卡，落下后点卡上的站名、线路就能选，不用打字。
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              setAttachForId(m.id);
              setAttachError("");
            }}
            aria-label={`把 ${label} 挂到某张卡后面`}
            className="min-h-10 flex-1 bg-[var(--surface2)] px-3 text-sm font-bold whitespace-nowrap text-[var(--text)] [border-radius:8px]"
          >
            挂到某张卡后面
          </button>
          {m.parentId > 0 && (
            <button
              type="button"
              disabled={setParentMut.isPending}
              onClick={() => setParentMut.mutate({ id: m.id, parentId: 0 })}
              aria-label={`把 ${label} 移到顶层`}
              className="min-h-10 flex-1 bg-[var(--surface2)] px-3 text-sm font-bold whitespace-nowrap text-[var(--text)] [border-radius:8px] disabled:opacity-50"
            >
              移到顶层
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          {parentMod
            ? `现在挂在「${canvasModLabel(parentMod)}」后面`
            : "现在在顶层（主线）"}
          {node.children.length > 0
            ? ` · 下面挂着 ${node.children.length} 张子卡`
            : ""}
        </p>
      </div>
    );
  };

  // 递归渲染一个树节点：卡片 + 它的子卡块。子卡块相对父卡缩进、
  // 左侧一条虚线分支线相连；同父子卡之间以「或」分隔（备选路线）；
  // 折叠时整棵子树收成一行摘要按钮。
  const renderTreeNode = (node: CanvasTreeNode): ReactNode => {
    const m = node.mod;
    const kids = node.children;
    const label = canvasModLabel(m);
    const collapsed = collapsedIds.has(m.id);
    const descCount = treeDescendantCount(node);
    const first = kids[0]?.mod;
    const firstShort = first
      ? first.kind === "station"
        ? first.line.trim() || first.station.trim() || "到站卡"
        : first.text.trim() || "文本卡"
      : "";
    return (
      <div key={m.id}>
        {renderFlowCard(m, renderTreeTools(node))}
        {kids.length > 0 &&
          (collapsed ? (
            <button
              type="button"
              onClick={() => toggleCollapsed(m.id)}
              aria-label={`展开 ${label} 后面折叠的 ${descCount} 张卡`}
              className="mt-1.5 ml-5 flex min-h-11 w-[calc(100%-1.25rem)] items-center gap-2 border border-dashed border-[var(--border)] bg-[var(--surface2)] px-3 text-left text-sm font-bold text-[var(--accent)] [border-radius:8px]"
            >
              <span aria-hidden="true">▸</span>
              <span className="min-w-0 truncate">
                {firstShort} · 后面还有 {descCount} 张卡
              </span>
            </button>
          ) : (
            <>
              <div className="mt-1 ml-5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--dim)]">
                  ↳{" "}
                  {kids.length > 1
                    ? `从这里分出 ${kids.length} 条路线，任选其一`
                    : "接着往下"}
                </span>
                <button
                  type="button"
                  onClick={() => toggleCollapsed(m.id)}
                  aria-label={`收起 ${label} 后面的 ${descCount} 张卡`}
                  className="min-h-10 shrink-0 bg-[var(--surface2)] px-3 text-sm font-bold text-[var(--text)] [border-radius:8px]"
                >
                  收起 ▴
                </button>
              </div>
              <div className="ml-5 border-l-[3px] border-dashed border-[var(--accent)] pl-3">
                {kids.map((child, ci) => (
                  <div key={child.mod.id} className="pt-2">
                    {ci > 0 && (
                      <div
                        className="flex items-center justify-center pb-2"
                        aria-hidden="true"
                      >
                        <span className="border border-[var(--amber)] bg-[var(--amber-bg)] px-3 py-0.5 text-sm font-black text-[var(--amber)] [border-radius:999px]">
                          或
                        </span>
                      </div>
                    )}
                    {renderTreeNode(child)}
                  </div>
                ))}
              </div>
            </>
          ))}
      </div>
    );
  };

  // ---- 文字版渲染：与纵向流同一棵路线树（canvasTree）、同一次序，
  // 平铺成纯文字。子卡相对父卡用树形符号缩进（├─ / └─，续行用 │
  // 对齐），同父并列子卡之间一行「或」；顶层之间是主线先后，用 ↓
  // 分隔（与纵向流的向下箭头同义）。每张到站卡呈现站名、线路、
  // 开往方向与第 1 / 第 2 班；实时状态读 rtReports 里卡片同步来的
  // 当前显示状态（点查结果、暂无车、报错都如实带过来），卡片还没
  // 挂载过时退回缓存快照 entry，与卡片首屏同源。文字版不看折叠
  // 状态（整棵树全展开，方便一眼看全）；刷新只经顶部的「全部
  // 刷新」一次性逐张查询，结果仍写回同一份 rtReports ----
  const renderTextNode = (
    node: CanvasTreeNode,
    prefix: string,
    isChild: boolean,
    isLast: boolean,
  ): ReactNode => {
    const m = node.mod;
    const kids = node.children;
    const branch = isChild ? (isLast ? "└─ " : "├─ ") : "";
    const cont = prefix + (isChild ? (isLast ? "   " : "│  ") : "");
    let title: ReactNode;
    const details: ReactNode[] = [];
    if (m.kind === "text") {
      title = (
        <span className="font-bold text-[var(--text)]">
          {m.text.trim() || "（未填的文本卡）"}
        </span>
      );
      if (m.note.trim()) {
        details.push(
          <span key="note" className="text-[var(--dim)]">
            {m.note.trim()}
          </span>,
        );
      }
    } else {
      // 与卡片完全同口径地选方向：先按方向号、再按终点站名，方向
      // 未定时优先有车的方向
      const rep = rtReports.get(m.id);
      // 「全部刷新」给停止的卡也查过一次时，rep 里带着数据或报错：
      // 这一次的结果照样显示（启停状态本身不变）；没有这种结果的
      // 停止卡仍按待机显示
      const hasFresh = !!rep && (rep.data !== null || rep.error !== "");
      const data: RealtimeResult | null =
        !m.enabled && !hasFresh
          ? null
          : rep
            ? rep.data
            : (entryOf(m.id)?.realtime ?? null);
      const rtError = !m.enabled && !hasFresh ? "" : rep ? rep.error : "";
      const dirUnset = m.direction === 0 && !m.terminal;
      const dir =
        data?.directions.find((d) => d.direction === m.direction) ??
        data?.directions.find((d) => d.terminal === m.terminal) ??
        (dirUnset
          ? (data?.directions.find((d) => d.buses.length > 0) ??
            data?.directions[0] ??
            null)
          : null);
      const terminalText = m.terminal || dir?.terminal || "";
      title = (
        <>
          <span className="font-bold text-[var(--text)]">
            {m.station.trim() || "未填站名"}
          </span>
          {m.line.trim() && (
            <span className="font-bold text-[var(--accent)]">
              {" · "}
              {m.line.trim()}
            </span>
          )}
        </>
      );
      details.push(
        <span key="dir" className="text-[var(--dim)]">
          {terminalText ? `开往 ${terminalText}` : "方向未填"}
        </span>,
      );
      if (!m.enabled && !hasFresh) {
        details.push(
          <span key="stopped" className="text-[var(--dim)]">
            已停止 · 待机中，不查车
          </span>,
        );
      } else {
        if (rtError) {
          details.push(
            <span key="err" className="text-[var(--danger)]">
              {rtError}
            </span>,
          );
        }
        if (!data && !rtError) {
          details.push(
            <span key="none" className="text-[var(--dim)]">
              {m.line.trim() && m.station.trim()
                ? "未查询"
                : "站名和线路还没填好"}
            </span>,
          );
        }
        if (data && !dir && !rtError) {
          details.push(
            <span key="nodir" className="text-[var(--dim)]">
              这个方向暂时没有查到数据
            </span>,
          );
        }
        if (data && dir) {
          if (dir.error) {
            details.push(
              <span key="derr" className="text-[var(--danger)]">
                这个方向查询失败
              </span>,
            );
          } else {
            for (const idx of [0, 1]) {
              const b = dir.buses[idx];
              details.push(
                <span key={`bus${idx}`} className="text-[var(--text)]">
                  <span className="text-[var(--dim)]">第 {idx + 1} 班 </span>
                  {b
                    ? `${boardHeadline(b)}${b.arrivalTime ? ` · ${b.arrivalTime}到` : ""}`
                    : idx === 0
                      ? "暂无车"
                      : "暂无"}
                </span>,
              );
            }
            details.push(
              <span key="time" className="text-xs text-[var(--dim)]">
                数据时间 {data.queriedAt}
                {data.cached ? " · 缓存" : ""}
              </span>,
            );
          }
        }
      }
      if (m.note.trim()) {
        details.push(
          <span key="note" className="text-[var(--dim)]">
            备注：{m.note.trim()}
          </span>,
        );
      }
    }
    return (
      <div key={m.id}>
        <p className="text-base whitespace-pre-wrap">
          <span className="text-[var(--dim)]" aria-hidden="true">
            {prefix}
            {branch}
          </span>
          {title}
        </p>
        {details.map((d, i) => (
          <p key={i} className="whitespace-pre-wrap">
            <span className="text-[var(--dim)]" aria-hidden="true">
              {cont}
            </span>
            {d}
          </p>
        ))}
        {kids.map((child, ci) => (
          <div key={child.mod.id}>
            {ci > 0 && (
              <p
                className="font-bold whitespace-pre-wrap text-[var(--amber)]"
                aria-hidden="true"
              >
                {cont}或
              </p>
            )}
            {renderTextNode(child, cont, true, ci === kids.length - 1)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <section
      aria-label="到站画布"
      className="mt-2 flex flex-col"
      style={{ height: "calc(100dvh - 11.5rem)", minHeight: 480 }}
    >
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回查车"
          className="min-h-10 shrink-0 bg-[var(--surface2)] px-3 text-base font-medium text-[var(--text)] [border-radius:8px]"
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
          className="min-h-10 shrink-0 bg-[var(--accent)] px-3.5 text-base font-bold text-[var(--accent-ink)] [border-radius:8px]"
        >
          {addOpen ? "收起" : "＋ 加模块"}
        </button>
      </div>

      {/* 页头第二行：当前项目名（点开切换列表）+ 模式切换 + ⋯ 菜单，
          一行放下，不再有平铺按钮的胖项目栏 */}
      <div className="mt-1.5 flex shrink-0 items-center gap-1.5">
        {canvasQ.data && (
          <button
            type="button"
            onClick={() => {
              setProjectPanel(projectPanel === "switch" ? "none" : "switch");
              setProjectError("");
            }}
            aria-expanded={projectPanel === "switch"}
            aria-label={`当前项目「${currentProject?.name ?? ""}」，点我切换项目`}
            className="flex min-h-10 max-w-36 min-w-0 shrink items-center gap-1 bg-[var(--surface)] px-2.5 text-base font-black text-[var(--text)] [border-radius:8px] border border-[var(--border)]"
          >
            <span className="min-w-0 truncate">{currentProject?.name ?? "…"}</span>
            <span className="shrink-0 text-xs text-[var(--dim)]" aria-hidden="true">
              ▾
            </span>
          </button>
        )}
        {/* 显示模式切换：自由画布 / 纵向流 / 文字版，按城市+项目记住
            选择；模式说明已移入下方「操作说明」折叠区，这里不再占位 */}
        <div
          className="flex shrink-0 overflow-hidden border border-[var(--border)] [border-radius:8px]"
          role="group"
          aria-label="画布显示模式"
        >
          <button
            type="button"
            onClick={() => switchMode("free")}
            aria-pressed={canvasMode === "free"}
            className={`min-h-10 px-3 text-sm ${
              canvasMode === "free"
                ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                : "bg-[var(--surface)] font-medium text-[var(--dim)]"
            }`}
          >
            自由画布
          </button>
          <button
            type="button"
            onClick={() => switchMode("flow")}
            aria-pressed={canvasMode === "flow"}
            className={`min-h-10 px-3 text-sm ${
              canvasMode === "flow"
                ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                : "bg-[var(--surface)] font-medium text-[var(--dim)]"
            }`}
          >
            纵向流
          </button>
          <button
            type="button"
            onClick={() => switchMode("text")}
            aria-pressed={canvasMode === "text"}
            className={`min-h-10 px-3 text-sm ${
              canvasMode === "text"
                ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                : "bg-[var(--surface)] font-medium text-[var(--dim)]"
            }`}
          >
            文字版
          </button>
        </div>
        <span className="min-w-0 flex-1" />
        {canvasQ.data && (
          <button
            type="button"
            onClick={() => {
              setProjectPanel(projectPanel === "menu" ? "none" : "menu");
              setProjectError("");
            }}
            aria-expanded={projectPanel === "menu"}
            aria-label="项目管理菜单（新建、改名、删除）"
            className="flex min-h-10 min-w-10 shrink-0 items-center justify-center bg-[var(--surface)] px-2 text-lg font-black text-[var(--text)] [border-radius:8px] border border-[var(--border)]"
          >
            ⋯
          </button>
        )}
      </div>

      {canvasQ.data && projectPanel === "switch" && (
        <div
          className="mt-1.5 flex shrink-0 flex-wrap items-center gap-1.5 border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 [border-radius:var(--radius)]"
          role="group"
          aria-label="切换画布项目"
        >
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => switchProject(p.id)}
              aria-pressed={p.id === curProjectId}
              aria-label={`切换到项目「${p.name}」（${
                p.moduleCount > 0 ? `${p.moduleCount} 张卡` : "空项目"
              }）${p.id === curProjectId ? "，当前项目" : ""}`}
              className={`min-h-10 shrink-0 px-3 text-sm whitespace-nowrap [border-radius:8px] ${
                p.id === curProjectId
                  ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                  : "bg-[var(--surface2)] font-medium text-[var(--text)]"
              }`}
            >
              {p.id === curProjectId ? "✓ " : ""}
              {p.name}
              <span className="opacity-75">
                {p.moduleCount > 0 ? ` · ${p.moduleCount} 张卡` : " · 空"}
              </span>
            </button>
          ))}
        </div>
      )}

      {canvasQ.data && projectPanel === "menu" && (
        <div
          className="mt-1.5 flex shrink-0 items-center gap-1.5 border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 [border-radius:var(--radius)]"
          role="group"
          aria-label="项目管理"
        >
          <button
            type="button"
            onClick={() => {
              setProjectPanel("create");
              setProjectNameInput("");
              setProjectError("");
            }}
            className="min-h-10 shrink-0 border border-dashed border-[var(--accent)] px-3 text-sm font-bold whitespace-nowrap text-[var(--accent)] [border-radius:8px]"
          >
            ＋ 新建项目
          </button>
          <button
            type="button"
            onClick={() => {
              setProjectPanel("rename");
              setProjectNameInput(currentProject?.name ?? "");
              setProjectError("");
            }}
            className="min-h-10 shrink-0 bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--text)] [border-radius:8px]"
          >
            改名
          </button>
          <button
            type="button"
            onClick={() => {
              setProjectPanel("delete");
              setProjectError("");
            }}
            className="min-h-10 shrink-0 bg-[var(--surface2)] px-3 text-sm font-medium text-[var(--danger)] [border-radius:8px]"
          >
            删除项目
          </button>
        </div>
      )}

      {canvasQ.data &&
        (projectPanel === "create" ||
          projectPanel === "rename" ||
          projectPanel === "delete" ||
          projectError) && (
        <div className="mt-1.5 shrink-0 border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 [border-radius:var(--radius)]">
          {projectPanel === "create" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = projectNameInput.trim();
                if (!n) {
                  setProjectError("项目名不能为空，先起个名再建。");
                  return;
                }
                setProjectError("");
                createProjectMut.mutate(n);
              }}
            >
              <input
                {...FIELDS.createCanvasProject.name}
                className={inputCls}
                value={projectNameInput}
                onChange={(e) => setProjectNameInput(e.target.value)}
                placeholder="给新项目起个名，如：上班、下班、去同安"
                aria-label="新项目名称"
                autoComplete="off"
              />
              <button
                type="submit"
                className={submitCls}
                disabled={!projectNameInput.trim() || createProjectMut.isPending}
              >
                {createProjectMut.isPending ? "建中…" : "建好并切换"}
              </button>
            </form>
          )}
          {projectPanel === "rename" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = projectNameInput.trim();
                if (!n) {
                  setProjectError("新名不能为空。");
                  return;
                }
                setProjectError("");
                if (curProjectId > 0) {
                  renameProjectMut.mutate({ id: curProjectId, name: n });
                }
              }}
            >
              <input
                {...FIELDS.renameCanvasProject.name}
                className={inputCls}
                value={projectNameInput}
                onChange={(e) => setProjectNameInput(e.target.value)}
                placeholder="新的项目名，如：上班"
                aria-label="当前项目的新名称"
                autoComplete="off"
              />
              <button
                type="submit"
                className={submitCls}
                disabled={!projectNameInput.trim() || renameProjectMut.isPending}
              >
                {renameProjectMut.isPending ? "改中…" : "保存新名"}
              </button>
            </form>
          )}
          {projectPanel === "delete" && (
            <div className="border border-[var(--danger)] px-3 py-2.5 [border-radius:8px]">
              <p className="text-sm leading-relaxed text-[var(--text)]">
                删除项目「{currentProject?.name}」会连带删掉里面的{" "}
                {modules.length} 个模块和 {links.length}{" "}
                条连线，删了不能恢复。模块库里的模板不受影响。
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (curProjectId > 0) deleteProjectMut.mutate(curProjectId);
                  }}
                  disabled={deleteProjectMut.isPending}
                  aria-label={`确认删除项目「${currentProject?.name ?? ""}」`}
                  className="bg-[var(--danger)] px-3.5 font-bold text-white [border-radius:8px] disabled:opacity-50"
                >
                  {deleteProjectMut.isPending ? "删除中…" : "确认删除"}
                </button>
                <button
                  type="button"
                  onClick={() => setProjectPanel("none")}
                  className="bg-[var(--surface2)] px-3.5 font-medium text-[var(--text)] [border-radius:8px]"
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {projectError && (
            <p className="mt-2 text-sm text-[var(--danger)]" role="alert">
              {projectError}
            </p>
          )}
        </div>
      )}

      {/* 工具栏（连线/缩放/复位）已改为浮在画布左上角，不再单独占一行 */}

      {addOpen && (
        <div className="mt-2 max-h-[48dvh] shrink-0 overflow-y-auto border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 [border-radius:var(--radius)]">
          <div className="flex gap-2" role="group" aria-label="选择模块类型">
            <button
              type="button"
              onClick={() => setAddKind("station")}
              aria-pressed={addKind === "station"}
              className={`min-h-11 px-4 text-base [border-radius:8px] ${
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
              className={`min-h-11 px-4 text-base [border-radius:8px] ${
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
            <div className="mt-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addTextModule();
                }}
              >
                <input
                  {...FIELDS.addCanvasModule.text}
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
              {textFormError && (
                <p className="mt-2 text-sm text-[var(--danger)]">{textFormError}</p>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!lineKw.trim()) {
                    setLineKwError("先输入线路号再查线路。");
                    return;
                  }
                  setLineKwError("");
                  setLdFail("");
                  setDirIdx(0);
                  ldMut.mutate(lineKw);
                }}
              >
                <input
                  {...FIELDS.getLineDetail.line}
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
              {lineKwError && (
                <p className="mt-2 text-sm text-[var(--danger)]">{lineKwError}</p>
              )}
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
              {ldFail && (
                <div className="mt-2">
                  <p className="text-sm text-[var(--danger)]">{ldFail}</p>
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
                        className={`min-h-11 px-3.5 text-base [border-radius:8px] ${
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
                        className="min-h-11 bg-[var(--surface2)] px-3.5 py-2 text-base text-[var(--text)] [border-radius:8px] disabled:opacity-50"
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
                还没有存过的模块。在画布上把一张卡配好，点卡片「更多」里的「存库」，它就存到这里；下次点这里任意一条，直接在画布上放一份，不用再填一遍。
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
                      className="min-h-11 min-w-0 flex-1 truncate bg-[var(--surface2)] px-3 py-2.5 text-left text-base font-medium text-[var(--text)] [border-radius:8px] disabled:opacity-50"
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
                        className="flex min-h-11 shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--surface)] px-2 text-base leading-none font-bold text-[var(--danger)] [border-radius:8px]"
                        style={{ width: 44 }}
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

      {canvasQ.data && canvasMode === "free" && (
        <div
          ref={containerRef}
          role="application"
          aria-label={`${city}到站画布：拖空白处平移，拖模块移动模块，双指或滚轮缩放`}
          className="relative mt-2 min-h-0 flex-1 touch-none overflow-hidden border border-[var(--border)] bg-[var(--surface2)] [border-radius:var(--radius)]"
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {/* 浮动工具栏：连线/缩放/复位压成一行小栏浮在画布左上角，
              不再单独占高度；按钮热区 ≥40px */}
          <div className="absolute top-2 left-2 z-40 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setLinkMode((on) => !on);
                setLinkFrom(null);
              }}
              aria-pressed={linkMode}
              className={`min-h-10 px-3.5 text-sm shadow [border-radius:8px] ${
                linkMode
                  ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                  : "bg-[var(--surface)] font-medium text-[var(--text)]"
              }`}
            >
              {linkMode ? "连线中" : "连线"}
            </button>
            <button
              type="button"
              onClick={() => zoomCenter(0.8)}
              aria-label="缩小画布"
              className="min-h-10 min-w-10 bg-[var(--surface)] px-2 text-lg font-bold text-[var(--text)] shadow [border-radius:8px]"
            >
              −
            </button>
            <span className="min-w-11 bg-[var(--surface)] px-1 py-2 text-center text-sm text-[var(--dim)] shadow [border-radius:8px]">
              {Math.round(view.k * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomCenter(1.25)}
              aria-label="放大画布"
              className="min-h-10 min-w-10 bg-[var(--surface)] px-2 text-lg font-bold text-[var(--text)] shadow [border-radius:8px]"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={() => setView({ x: 16, y: 16, k: 1 })}
              className="min-h-10 bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] shadow [border-radius:8px]"
            >
              复位
            </button>
          </div>
          {(linkMode || templateFlash) && (
            <div className="pointer-events-none absolute right-2 bottom-2 left-2 z-40">
              {linkMode && (
                <p
                  className="bg-[var(--surface)] px-3 py-2 text-sm text-[var(--accent)] shadow [border-radius:8px]"
                  role="status"
                >
                  {linkFrom === null
                    ? "点一个模块作起点，再点另一个模块完成连线；点画布上的线可删线。（平时按住模块右侧蓝点拖到另一个模块上也能连线）"
                    : "已选起点，再点另一个模块完成连线；点起点本身取消。"}
                </p>
              )}
              {templateFlash && (
                <p
                  className="mt-1.5 bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--accent)] shadow [border-radius:8px]"
                  role="status"
                >
                  {templateFlash}
                </p>
              )}
            </div>
          )}
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
                  className={`absolute touch-none border bg-[var(--surface)] px-3.5 py-3 shadow-sm [border-radius:var(--radius)] ${
                    isFrom || isLinkTarget
                      ? "border-2 border-[var(--accent)]"
                      : "border-[var(--border)]"
                  } ${linkMode ? "cursor-pointer" : "cursor-grab"} ${
                    stopped ? "opacity-75 saturate-50" : ""
                  }`}
                  style={{ left: p.x, top: p.y, width: CANVAS_MODULE_W, zIndex: zOf(m.id) }}
                  onPointerDownCapture={() => bringToFront(m.id)}
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
                  {/* 整删入口已收进卡片「更多」展开区（点删除后仍先出确认条） */}
                  {/* 步骤徽章：同一步的卡是备选方案，徽章标步号与方案字母 */}
                  {(() => {
                    const info = stepInfoById.get(m.id);
                    if (!info) return null;
                    return (
                      <span className="absolute -top-3 left-3 z-20 border border-[var(--border)] bg-[var(--surface2)] px-2 py-0.5 text-xs font-black whitespace-nowrap text-[var(--text)] shadow [border-radius:999px]">
                        第{info.ordinal}步
                        {info.groupSize > 1 &&
                          ` · 方案${String.fromCharCode(65 + info.inGroup)}`}
                      </span>
                    );
                  })()}
                  {/* 连线连接点：按住拖出虚线、落到另一个模块上成线 */}
                  <button
                    type="button"
                    aria-label={`从 ${modLabel} 拖出连线`}
                    className="absolute top-1/2 -right-5 z-20 min-h-0 -translate-y-1/2 border-2 border-[var(--surface)] bg-[var(--accent)] shadow [border-radius:999px]"
                    style={{ width: 44, height: 44, touchAction: "none" }}
                    onPointerDown={(e) => onPortPointerDown(e, m)}
                    onPointerMove={onPortPointerMove}
                    onPointerUp={onPortPointerUp}
                    onPointerCancel={onPortPointerCancel}
                  />
                  {confirmDeleteId === m.id && (
                    <div className="absolute inset-x-0 -top-1 z-30 border border-[var(--danger)] bg-[var(--surface)] px-2.5 py-2 shadow [border-radius:8px]">
                      <p className="text-sm text-[var(--text)]">
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
                          className="min-h-10 flex-1 border border-[var(--danger)] bg-[var(--surface)] px-2 text-sm font-bold text-[var(--danger)] [border-radius:6px]"
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="min-h-10 flex-1 bg-[var(--surface2)] px-2 text-sm font-medium text-[var(--text)] [border-radius:6px]"
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
                      moreOpen={moreCardId === m.id}
                      onToggleMore={() =>
                        setMoreCardId(moreCardId === m.id ? null : m.id)
                      }
                      onDeleteRequest={() => setConfirmDeleteId(m.id)}
                      onRtReport={reportRt}
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
                      moreOpen={moreCardId === m.id}
                      onToggleMore={() =>
                        setMoreCardId(moreCardId === m.id ? null : m.id)
                      }
                      onDeleteRequest={() => setConfirmDeleteId(m.id)}
                    />
                  )}
                </div>
              );
            })}

            {modules.length === 0 && (
              <p className="absolute top-24 left-1/2 w-72 -translate-x-1/2 text-center text-base leading-relaxed text-[var(--dim)]">
                画布还是空的。点上面「＋ 加模块」，可以直接放一张空白到站卡自己填，也可以查线路选站加卡，再加文本卡、连线，一个个摆出你的路线图。
              </p>
            )}
          </div>
        </div>
      )}

      {canvasQ.data && canvasMode === "flow" && (
        <div
          className="mt-2 min-h-0 flex-1 overflow-y-auto"
          aria-label={`${city}到站纵向流：按路线树从上往下排列的大卡，子卡是父卡分出的不同路线`}
        >
          {templateFlash && (
            <p className="mb-2 px-1 text-sm font-medium text-[var(--accent)]" role="status">
              {templateFlash}
            </p>
          )}
          {modules.length === 0 && (
            <p className="px-2 py-10 text-center text-base leading-relaxed text-[var(--dim)]">
              还没有模块。点上面「＋ 加模块」放一张空白到站卡，或从模块库调用、从规划转进来，第一张卡就会出现在这里。
            </p>
          )}
          {canvasTree.map((node, i) => (
            <div key={node.mod.id}>
              {i > 0 && (
                <div
                  className="flex flex-col items-center py-1.5"
                  aria-hidden="true"
                >
                  <span className="h-5 border-l-[3px] border-dashed border-[var(--accent)]" />
                  <span className="-mt-1.5 text-2xl leading-none font-black text-[var(--accent)]">
                    ↓
                  </span>
                </div>
              )}
              {renderTreeNode(node)}
            </div>
          ))}
        </div>
      )}

      {canvasQ.data && canvasMode === "text" && (
        <div
          className="mt-2 min-h-0 flex-1 overflow-y-auto"
          aria-label={`${city}到站画布文字版：与纵向流同一棵路线树的纯文字版，内容与卡片当前状态同步`}
        >
          {templateFlash && (
            <p className="mb-2 px-1 text-sm font-medium text-[var(--accent)]" role="status">
              {templateFlash}
            </p>
          )}
          {modules.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
              <button
                type="button"
                onClick={() => void refreshAll()}
                disabled={refreshProgress !== null || refreshTargets.length === 0}
                aria-label="全部刷新：逐张查询当前项目里所有已填好站名和线路的到站卡（开始和停止的都查一次，不改变启停状态）"
                className="min-h-10 bg-[var(--accent)] px-4 text-base font-bold text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-50"
              >
                {refreshProgress
                  ? `刷新中 ${refreshProgress.done}/${refreshProgress.total}…`
                  : "↻ 全部刷新"}
              </button>
              {refreshProgress === null && lastRefreshedAt && (
                <span className="text-sm text-[var(--dim)]" role="status">
                  已更新 {lastRefreshedAt}
                </span>
              )}
              {refreshTargets.length === 0 && (
                <span className="text-sm text-[var(--dim)]">
                  还没有填好站名和线路的到站卡可刷新
                </span>
              )}
            </div>
          )}
          {modules.length === 0 ? (
            <p className="px-2 py-10 text-center text-base leading-relaxed text-[var(--dim)]">
              还没有模块。点上面「＋ 加模块」放一张空白到站卡，或从模块库调用、从规划转进来，第一张卡就会出现在这里。
            </p>
          ) : (
            <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm leading-7 [border-radius:var(--radius)]">
              {canvasTree.map((node, i) => (
                <div key={node.mod.id}>
                  {i > 0 && (
                    <p
                      className="font-black text-[var(--accent)]"
                      aria-hidden="true"
                    >
                      ↓
                    </p>
                  )}
                  {renderTextNode(node, "", false, true)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <details className="mt-1.5 shrink-0">
        <summary className="min-h-8 cursor-pointer text-sm text-[var(--dim)]">
          操作说明（点开看）
        </summary>
        <p className="pb-1 text-xs leading-relaxed text-[var(--dim)]">
          三种看法：自由画布自由拖动摆布，拖模块本体移动它（点中或拖动的模块会自动翻到最前），拖空白处平移画布，双指或滚轮缩放；纵向流是路线树，像二叉树一样分叉：顶层卡自上而下是主线（卡间向下的大箭头是「然后」），一张卡下面缩进挂着的子卡是它分出的不同路线，同父的子卡之间标「或」任选其一，子卡下面还能再挂子卡、继续往下分。文字版把同一棵路线树写成纯文字：每张卡一行站名、线路、开往方向和第 1 班 / 第 2 班，子卡缩进并用树形符号相连、同父子卡之间标「或」，整棵树全展开；它和卡片共用同一份数据——在卡片上开始 / 点查后切过来，看到的就是卡片此刻的最新结果（暂无车、报错也一样）；文字版顶部有「全部刷新」，点一次把当前项目里所有填好站名和线路的到站卡逐张查一遍（开始、停止的都查，只查这一次、不改启停状态、之后不自动刷新），结果同步回文字版和卡片，某张查失败只在那一行显示报错、不影响其他卡。带子卡的卡能点「收起」把整条支线折成一行摘要，点摘要重新展开，收起状态会记住。卡面只留核心信息（站名/线路/方向/第 1 班/第 2 班/数据时间）和一行操作（开始/停止、点查、更多）；存库、删除、备注、挂接都收在卡片的「更多」里，点开才显示，一次只开一张。挂接：在「更多」里点「挂到某张卡后面」再点选一张卡，这张卡就成为它的子卡（分支路线）；「移到顶层」解除挂接回到主线；不能挂到自己或自己的子卡下面（会绕成圈）。续接新卡不用挂接：在某张卡的「更多」顶部点「＋ 在后面加一张」，新卡直接生在它下面接着往下；点「＋ 加并列方案」，新卡和它同层并列、中间是「或」。加的都是空白到站卡，落下后点选站名线路即可。「＋ 加模块」新放的卡默认在顶层主线。自由画布里每张卡左上角有步号徽章（旧的步骤编号，同一步多卡标方案A/B/C）。连线（自由画布）：按住模块右侧的蓝点拖到另一个模块上松手（虚线带箭头）；整删在卡片「更多」里点「删除」（会先确认一次；删掉一张卡，它的子卡会自动改挂到它的上一级）。到站卡可开始/停止：停止后变灰待机、不查车；点「开始」只当场查一次，之后不自动刷新，想看最新就点卡上的「点查/刷新」再查（走 90 秒缓存）。打开画布不自动查车：有缓存先看缓存。到站卡前三行（站名/线路/方向）点一下先出可选项点选——方向行点 ◀ ▶ 直接在两个终点站之间切换、点方向文字出终点站二选一，站名从站序里挑、线路从你用过的里面挑，实在没有选项才打字，选完自动保存；「＋ 加模块」里可以直接放一张空白卡，不用先查线路。配好的模块点卡片「更多」里的「存库」存入模块库，之后在「＋ 加模块 → 我的模块库」点一下就放一份副本到画布上，副本和模板互不影响。页头点项目名可以切换项目，「⋯」菜单里新建、改名、删除项目。项目里的模块、连线、位置改完即存，切走再回来原样恢复。
        </p>
      </details>
    </section>
  );
}

// 卡片「更多」展开区里的次要操作：存库 / 连线（仅自由画布）/ 删除。
// 卡面瘦身后这些不再常驻，由卡片的「更多」按钮点开才显示；删除仍走
// 外层已有的确认条（onDeleteRequest 只是提出请求）。
function CanvasCardMoreTools({
  label,
  onStartLink,
  onSaveTemplate,
  saveTemplatePending,
  onDeleteRequest,
}: {
  label: string;
  // 纵向流模式不传 onStartLink：流模式里顺序由链与 ↑↓ 决定，不显示「连线」
  onStartLink?: () => void;
  onSaveTemplate?: () => void;
  saveTemplatePending?: boolean;
  onDeleteRequest: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {onSaveTemplate && (
        <button
          type="button"
          onClick={onSaveTemplate}
          disabled={saveTemplatePending}
          aria-label={`把${label}存入模块库`}
          className="min-h-10 flex-1 bg-[var(--surface2)] px-3 text-sm font-bold whitespace-nowrap text-[var(--accent)] [border-radius:8px] disabled:opacity-50"
        >
          {saveTemplatePending ? "存入中…" : "存库"}
        </button>
      )}
      {onStartLink && (
        <button
          type="button"
          onClick={onStartLink}
          aria-label={`从${label}开始连线`}
          className="min-h-10 flex-1 bg-[var(--surface2)] px-3 text-sm font-bold whitespace-nowrap text-[var(--accent)] [border-radius:8px]"
        >
          连线
        </button>
      )}
      <button
        type="button"
        onClick={onDeleteRequest}
        aria-label={`删除${label}`}
        className="min-h-10 flex-1 bg-[var(--surface2)] px-3 text-sm font-bold whitespace-nowrap text-[var(--danger)] [border-radius:8px]"
      >
        删除
      </button>
    </div>
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
  moreOpen,
  onToggleMore,
  onDeleteRequest,
  flowTools,
  onRtReport,
}: {
  mod: CanvasModule;
  city: string;
  entry: BoardEntry | undefined;
  // 把本卡当前显示的实时状态（数据/报错）同步给画布层：文字版模式
  // 按这份状态渲染，保证文字版与卡片永远同一份数据
  onRtReport?: (
    id: number,
    data: RealtimeResult | null,
    error: string,
  ) => void;
  onStartLink?: () => void;
  onSaveTemplate: () => void;
  saveTemplatePending: boolean;
  onSaveNote: (note: string) => void;
  onSaveStation: (station: string) => void;
  onSaveLine: (line: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSetDirection: (direction: number, terminal: string) => void;
  // 「更多」展开区：同一时间只开一张卡（状态在 CanvasView 里）
  moreOpen: boolean;
  onToggleMore: () => void;
  onDeleteRequest: () => void;
  // 纵向流的路线树工具（挂接/移到顶层），由流渲染处传入、只在展开区里显示
  flowTools?: ReactNode;
}) {
  const stopped = !mod.enabled;
  const [rtFail, setRtFail] = useState("");
  const rtM = useMutation({
    mutationFn: () =>
      api.queryLineRealtime({ line: mod.line, station: mod.station, city }),
    onError: (e) => setRtFail(`查询失败：${e.message}`),
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
  const error = stopped
    ? ""
    : (rtM.data && !rtM.data.ok ? rtM.data.error : "") || rtFail;
  // 当前显示状态（点查结果/缓存快照/报错）同步给画布层：切到文字版
  // 时按这份状态重新渲染，暂无车、报错都如实带过去，不另存副本
  useEffect(() => {
    onRtReport?.(mod.id, data, error);
  }, [onRtReport, mod.id, data, error]);
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
      {...(editField === "line"
        ? FIELDS.updateCanvasModule.line
        : editField === "station"
          ? FIELDS.updateCanvasModule.station
          : FIELDS.updateCanvasModule.terminal)}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditField(null);
      }}
      aria-label={label}
      className="min-h-11 w-full border border-[var(--accent)] bg-[var(--surface)] px-2 py-1.5 text-base text-[var(--text)] [border-radius:6px] outline-none"
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
    // 线路一填好就预取终点站选项（点选缓存/高德兜底，不耗 apizero），
    // 这样方向行的左右三角随时能切，不必先打开点选面板
    enabled: picker === "station" || picker === "terminal" || mod.line !== "",
  });
  const recentQ = useQuery({
    queryKey: ["linePickRecent", city],
    queryFn: () => api.getLinePickOptions({ city }),
    enabled: picker === "line",
  });
  // 终点站选项：服务端给的 + 这张卡已查到的实时结果自带的双向终点。
  // 只留含中文字符的站名：曾有拼音碎片（如 "gong yu lo"）混进终点
  // 选项，三角翻转会翻到它、永远到不了真正的另一端终点
  const pickTerminals = Array.from(
    new Set([
      ...(pickQ.data?.terminals ?? []),
      ...(data?.directions
        .map((d) => d.terminal)
        .filter((t) => t !== "") ?? []),
    ]),
  ).filter((t) => /[\u3400-\u9fff]/.test(t));
  const pickStops = pickQ.data?.stops ?? [];
  const recentLines = (recentQ.data?.recentLines ?? []).filter(
    (l) => l !== mod.line,
  );
  // 方向行左右三角：线路填好后点 ◀/▶ 直接在两个终点站之间切换，
  // 不打开面板、不用打字。另一个终点站与点选面板同源（点选缓存 +
  // 这张卡已查到的双向实时数据 + 高德兜底），切换立即存服务端；
  // 已有双向实时数据时第 4/5 行直接按新方向从现有数据换显，不重查。
  const currentTerminal = mod.terminal || dir?.terminal || "";
  const otherTerminal =
    pickTerminals.find((t) => t !== "" && t !== currentTerminal) ?? "";
  const [triHint, setTriHint] = useState("");
  useEffect(() => {
    if (!triHint) return;
    const id = setTimeout(() => setTriHint(""), 4000);
    return () => clearTimeout(id);
  }, [triHint]);
  const flipDirection = () => {
    if (otherTerminal) {
      // 实时数据里有这个方向就带上方向号，没有就按终点站名存（口径不变）
      const od = data?.directions.find((d) => d.terminal === otherTerminal);
      onSetDirection(od ? od.direction : 0, otherTerminal);
      setTriHint("");
    } else if (pickQ.isLoading || pickQ.isFetching) {
      setTriHint("正在找这条线的另一个方向，稍等一下再点。");
    } else {
      setTriHint("另一方向未知，先点查一次或在方向面板里选。");
    }
  };
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
    <div className="mt-2 flex gap-1.5">
      <button
        type="button"
        onClick={() => {
          setPicker(null);
          startEdit(field, field === "station" ? mod.station : field === "line" ? mod.line : mod.terminal);
        }}
        className="min-h-11 flex-1 border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm font-medium text-[var(--dim)] [border-radius:8px]"
      >
        手动输入
      </button>
      <button
        type="button"
        onClick={() => setPicker(null)}
        className="min-h-11 flex-1 bg-[var(--surface)] px-2 py-2 text-sm font-medium text-[var(--dim)] [border-radius:8px]"
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
              className={`min-w-0 flex-1 truncate py-1 text-lg font-bold ${
                mod.station
                  ? "text-[var(--text)] underline decoration-[var(--border)] decoration-dotted underline-offset-4"
                  : "text-[var(--dim)]"
              }`}
            >
              {mod.station || "点这里选站名"}
            </span>
          )}
        </div>
        {picker === "station" && editField !== "station" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-1.5 w-full max-w-full border border-[var(--border)] bg-[var(--surface2)] p-2 [border-radius:8px]"
          >
            {pickQ.isLoading ? (
              <p className="px-1 py-1 text-sm text-[var(--dim)]">
                正在找这条线的站点…
              </p>
            ) : (
              <>
                <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                  {pickStops.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        onSaveStation(s);
                        setPicker(null);
                      }}
                      aria-label={`选择站名 ${s}`}
                      className={`min-h-11 px-3.5 py-2 text-base font-medium [border-radius:999px] ${
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
            className="mt-1.5 w-full max-w-full border border-[var(--border)] bg-[var(--surface2)] p-2 [border-radius:8px]"
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
                        className="min-h-11 border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-base font-bold text-[var(--text)] [border-radius:999px]"
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
      {/* 第 3 行：方向（点 ◀ ▶ 直接在两个终点站间切换；点文字出终点站大按钮二选一，可留空） */}
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
                className="min-w-0 flex-1 truncate py-1 text-base text-[var(--dim)] underline decoration-[var(--border)] decoration-dotted underline-offset-4"
              >
                {mod.terminal
                  ? `开往 ${mod.terminal}`
                  : dir
                    ? `开往 ${dir.terminal}`
                    : "方向未填（点我选，可留空）"}
              </span>
              {mod.line && (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={flipDirection}
                    aria-label="上一个方向"
                    className="flex min-h-11 min-w-11 items-center justify-center border border-[var(--border)] bg-[var(--surface2)] px-2 py-2 text-base text-[var(--accent)] [border-radius:8px]"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={flipDirection}
                    aria-label="下一个方向"
                    className="flex min-h-11 min-w-11 items-center justify-center border border-[var(--border)] bg-[var(--surface2)] px-2 py-2 text-base text-[var(--accent)] [border-radius:8px]"
                  >
                    ▶
                  </button>
                </span>
              )}
            </>
          )}
        </div>
        {triHint && (
          <p className="mt-1 text-xs text-[var(--amber)]">{triHint}</p>
        )}
        {picker === "terminal" && editField !== "terminal" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-1.5 w-full max-w-full border border-[var(--border)] bg-[var(--surface2)] p-2 [border-radius:8px]"
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
                      className={`min-h-12 px-3 py-2.5 text-left text-lg font-bold [border-radius:8px] ${
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
          已停止 · 待机中，不查车。点下面「开始」只查一次，之后点「点查」才再更新。
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
                          <span className="shrink-0 text-sm font-medium text-[var(--dim)]">
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

      {/* 常驻操作行（一行三个，约 40px 高）：开始/停止、点查、更多。
          存库/删除/备注/挂接都在「更多」展开区里，卡面不再摊开。
          实时口径：不做自动定时轮询——点「开始」只立即查一次，之后
          只有点「点查/刷新」才再查（继续走服务端 90 秒缓存）；「停止」
          回到待机、不查询。 */}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            if (stopped) {
              // 开始：恢复启用，并立即查一次；之后不再自动刷新
              onToggleEnabled(true);
              if (mod.line && mod.station) {
                setRtFail("");
                rtM.mutate();
              }
            } else {
              // 停止：只回待机，不发起任何查询
              onToggleEnabled(false);
            }
          }}
          aria-label={
            stopped
              ? `开始 ${mod.line} 在 ${mod.station} 的模块（开始时查一次）`
              : `停止 ${mod.line} 在 ${mod.station} 的模块`
          }
          aria-pressed={!stopped}
          className={`min-h-10 flex-1 px-2.5 text-base font-bold whitespace-nowrap [border-radius:8px] ${
            stopped
              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
              : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
          }`}
        >
          {stopped ? "▶ 开始" : "■ 停止"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRtFail("");
            rtM.mutate();
          }}
          disabled={stopped || rtM.isPending || !mod.line || !mod.station}
          aria-label={`刷新 ${mod.line} 在 ${mod.station} 的实时到站`}
          className="min-h-10 flex-1 bg-[var(--accent)] px-2.5 text-base font-bold whitespace-nowrap text-[var(--accent-ink)] [border-radius:8px] disabled:opacity-40"
        >
          {rtM.isPending ? "查询中…" : data ? "↻ 刷新" : "↻ 点查"}
        </button>
        <button
          type="button"
          onClick={onToggleMore}
          aria-expanded={moreOpen}
          aria-label={
            moreOpen
              ? `收起 ${mod.line} 在 ${mod.station} 的更多操作`
              : `展开 ${mod.line} 在 ${mod.station} 的更多操作（存库、删除、备注、挂接）`
          }
          className={`min-h-10 shrink-0 px-3 text-base font-bold whitespace-nowrap [border-radius:8px] ${
            moreOpen
              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
              : "bg-[var(--surface2)] text-[var(--text)]"
          }`}
        >
          更多 ⋯
        </button>
      </div>
      {moreOpen && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <CanvasCardMoreTools
            label={`${mod.line} ${mod.station}`}
            onStartLink={onStartLink}
            onSaveTemplate={onSaveTemplate}
            saveTemplatePending={saveTemplatePending}
            onDeleteRequest={onDeleteRequest}
          />
          {flowTools}
          <input
            {...FIELDS.updateCanvasModule.note}
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
            className="mt-1 min-h-10 w-full border-b border-dashed border-[var(--border)] bg-transparent px-1 py-1.5 text-sm text-[var(--dim)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
          />
        </div>
      )}
    </div>
  );
}

function CanvasTextCard({
  mod,
  onStartLink,
  onSaveTemplate,
  saveTemplatePending,
  onSaveText,
  moreOpen,
  onToggleMore,
  onDeleteRequest,
  flowTools,
}: {
  mod: CanvasModule;
  onStartLink?: () => void;
  onSaveTemplate: () => void;
  saveTemplatePending: boolean;
  onSaveText: (text: string) => void;
  // 「更多」展开区：与到站卡同一套结构（存库/连线/删除 + 流模式路线树工具）
  moreOpen: boolean;
  onToggleMore: () => void;
  onDeleteRequest: () => void;
  flowTools?: ReactNode;
}) {
  return (
    <div>
      <textarea
        {...FIELDS.updateCanvasModule.text}
        defaultValue={mod.text}
        key={`${mod.id}:${mod.text}`}
        rows={2}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== mod.text) onSaveText(v);
        }}
        aria-label="文本卡内容（改完点别处保存）"
        className="w-full resize-none bg-transparent text-lg font-bold text-[var(--text)] outline-none"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--dim)]">
          文本卡 · 改完点别处自动保存
        </span>
        <button
          type="button"
          onClick={onToggleMore}
          aria-expanded={moreOpen}
          aria-label={
            moreOpen
              ? `收起文本卡 ${mod.text} 的更多操作`
              : `展开文本卡 ${mod.text} 的更多操作（存库、删除、挂接）`
          }
          className={`min-h-10 shrink-0 px-3 text-base font-bold whitespace-nowrap [border-radius:8px] ${
            moreOpen
              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
              : "bg-[var(--surface2)] text-[var(--text)]"
          }`}
        >
          更多 ⋯
        </button>
      </div>
      {moreOpen && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <CanvasCardMoreTools
            label={`文本卡 ${mod.text}`}
            onStartLink={onStartLink}
            onSaveTemplate={onSaveTemplate}
            saveTemplatePending={saveTemplatePending}
            onDeleteRequest={onDeleteRequest}
          />
          {flowTools}
        </div>
      )}
    </div>
  );
}
