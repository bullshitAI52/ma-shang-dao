# Data Plan

## Context provenance
- `部署公交空间，参考机器人的功能特点` (verbatim build request)
- 功能规格由主代理下发，参照用户自己的 Telegram 机器人 @Xmbus_bot，源码在 ~/workspace/bus-bot-src/（bus_bot.py、bus_engine.py、route_engine.py 三文件已逐字读完，接口格式以引擎源码为准）
- 地铁静态数据来自 bus_bot.py 的 METRO 字典（1/2/3 号线首末班与间隔、4/6 号线建设中、5 号线规划中），原样内置
- API key 运行时从 ~/.apizero_key 与 ~/.amap_key 读取（与引擎同法），不写入代码；两文件均已确认存在（apizero 56 字符、amap 32 字符）

## Tested sources
### apizero 实时公交 API（POST https://v1.apizero.cn/api/bus-realtime，Header X-API-Key）
**Used by**: getLineDetail、queryRealtime、searchStations 三个 action（服务端 fetch 转发，浏览器不直连）
**Test command**: python3 urllib POST，body 分别为 {type:line, city:厦门, line:33路, direction:1}、{type:stations, city:厦门, station:SM}、{type:query, city:厦门, station:SM城市广场2, direction:1}
**Sample output**: line → code 0，data 含 start=公园东门、end=高崎公交场站、price=1元、first_time=06:15、last_time=23:10、stop_count=30、stops 为 [{order,name,lat,lng}] 数组（注意：与机器人 fmt_line_detail 假设的 stops 为字符串数组不同，实际是对象数组，取 name 字段）；stations → 5 个站（SM海沧/SM兴山路/SM城市广场/SM城市广场2/地铁林埭•SM海沧，含 kind 与 lat/lng）；query → data 含 platforms（按方向列出经过线路）、lines 数组，每条含 line/terminal/first_time/last_time/buses（buses 内字段 stops_remaining/travel_minutes/arrival_time/bus_id 以 bus_engine.py 的 fmt_realtime 为准），凌晨 03:43 实测 buses 为空数组（真实无车状态，如实展示）
**Processing**: 服务端按引擎逻辑实现 query_line_realtime 等价流程：search_stations 找候选站 → 逐站 query 匹配目标线路 → 双向 query 筛选目标线路的 buses；错误（code!=0）原样转成可读报错返回 UI，不编造到站时间。按次计费：仅用户点击查询/手动刷新时调用，禁止自动轮询、无定时刷新

### 高德地图 API（restapi.amap.com，key 参数）
**Used by**: planRoute action（服务端 fetch 转发）
**Test command**: python3 urllib GET /v3/assistant/inputtips（keywords=SM城市广场, city=厦门）与 /v3/direction/transit/integrated（厦门市内两点）
**Sample output**: inputtips 返回 tips 数组含 name/district/location（经度,纬度字符串）；transit 返回 status=1、route.transits 数组含 duration（秒）/walking_distance/distance/cost/segments（bus.buslines[0] 含 type/name/departure_stop/arrival_stop，walking 含 distance）
**Processing**: 严格按 route_engine.py：geocode 先 inputtips（优先含「公交站/地铁站」的 tip）再 geocode/geo 兜底；transit 参数 city=厦门、strategy=0、nightflag=0；方案按机器人 _plan_score（分钟 + 步行每100米1分 + 每次换乘3分）标最优

### 高德周边搜索（GET https://restapi.amap.com/v3/place/around，key 参数）
**Used by**: findNearbyStations action（服务端经 amapGet 转发，浏览器定位坐标由客户端在用户点击时一次性传入）
**Test command**: python3 urllib GET /v3/place/around（location=118.1155,24.6197 即 SM 城市广场附近，types=150700，radius=1500，sortrule=distance）
**Sample output**: status=1、count=7；POI 名形如「福泽园(公交站)」，distance 为米数字符串，address 字段为经过线路（如「491路」），location 为经纬度字符串
**Processing**: 去掉站名后缀「(公交站)」得公交官方站名（与 apizero 站名同名，可直接复用 queryStationArrivals）；按距离升序去重取最多 10 个；定位被拒/失败时客户端如实提示，不编造站点

### 城市切换（2026-11-18 加）
- **apizero 多城市**: 三种调用（line/stations/query）本来就带 city 参数（机器人 bus_engine.py 里写死 CITY="厦门"），现全部透传当前所选城市，缺省厦门；某城市无数据/报错时页面原样显示接口返回，不编造
- **高德多城市**: geocode（inputtips/geocode）与 transit 规划本来就有 city 参数（route_engine 默认厦门），现透传所选城市，transit 同时传 cityd
- **其他城市地铁（getMetroLines）**: 高德 GET /v3/bus/linename（extensions=all）按城市检索——实测上海：keywords=地铁1号线 返回双向两条（地铁1号线(莘庄--富锦路)/(富锦路--莘庄)，type=地铁，start_stop/end_stop 齐全，busstops 28 站，distance 36.71km）；keywords=地铁 返回 0 条、轨道交通 返回 0 条，故按「地铁N号线」逐号检索、无果再试「轨道交通N号线」，连续 3 号无果停（上限 30），另补「地铁浦江线」「磁浮线」命名线（实测浦江线 type=地铁、磁浮线 type=磁悬浮列车且 start_time=0702/end_time=2142）；start_time/end_time 对地铁线多为空数组，首末班与间隔改从 timedesc（URL 编码 JSON 的 rule_group/time_group：start_time/end_time/interval_time）解析（实测上海 1 号线可得 05:30 起、末班 22:32/00:00、间隔 3–12 分钟）；北京实测命名为「地铁1号线八通线」「地铁1号线支线」，按基础名（括号前）分组即各自成线。结果服务端缓存 7 天（空结果 1 天）。厦门仍用内置静态数据（source=builtin）
- **广州/深圳地铁补全（2026-11-18 修）**: 主代理实测旧版广州返回 19 条缺 1/3/14/18/21/22 号线、APM 线、广佛线，深圳 24 条缺 3/8 号线。逐项直连高德核对（key 从 ~/.amap_key 读、只打印线路名与计数）：缺的线逐号检索全都查得到（广州 1 号线 count=2「西塱↔广州东站」、3 号线 count=4、14/18/21/22 均有，APM 线/广佛线 type=地铁 齐全），故根因在旧检索逻辑不在数据源——①旧版「连续 3 个号线无果即停」：广州 15/16/17 号线不存在，循环到 17 就停，18/21/22 根本没被搜（旧算法离线模拟复现）；②APM 线/广佛线这类命名线旧版从未检索（只补了浦江线/磁浮线）；③深圳 8 号线高德只以贯通运营名「地铁2号线(8号线)(溪涌--赤湾)」收录（搜「8号线」count=6 内只有它 type=地铁），旧版按括号前基础名去重被 2 号线吞掉；深圳 3 号线为「地铁3号线(龙岗线)(福保--坪地六联)」。另实测 linename 支持分页：宽关键词「号线」广州 count=100、默认只回 20 条，offset=25&page=N 可翻页（offset/page 参数有效）。新版检索：逐号 1–30 不早停（接口正常应答无果才试「轨道交通N号线」）+ 命名线清单（浦江线/磁浮线/APM线/广佛线/机场线/亦庄线/房山线/昌平线/八通线/燕房线/西郊线/S1线）+「号线」宽口径兜底，每个关键词 offset=25 翻完所有分页后合并去重；同名先到先得但无首末班者可被有首末班的同名条目替换；「地铁X号线(Y号线)」贯通条目额外按 Y 号线单独成条并标注「与X号线贯通运营」。缓存键升版 v2|城市，旧残缺缓存作废。健壮性：检索中被接口拒绝（status≠1）记 degraded，残缺列表不进缓存、全空时动作返回 ok:false 带高德 info 原文（如 USER_DAILY_QUERY_OVER_LIMIT），不再伪装成「该城市无地铁」；连续 3 个关键词被拒即中止检索。注意：2026-11-18 上午定位期间反复直连模拟把该 key 的 linename 当日额度打满（infocode 10044 USER_DAILY_QUERY_OVER_LIMIT），新版全量清单待额度按日恢复后由用户首开各城自动拉齐验证
- **上海实时未实测**: 2026-11-18 07:26 直连 apizero 测上海返回 HTTP 429（额度/限流未恢复，预计北京时间 08:00 后恢复），按接口契约实现，未据此判定上海不支持
- **收藏带城市**: favorites 与 favorite_routes 加 city 列（迁移 0004，旧行默认 '厦门'），列表/新增/去重都按城市过滤；所选城市存客户端 localStorage（键 transit-city），刷新不丢

### 「我的站牌」聚合页（2026-11-18 加）
- **位置与内容**: 收藏页顶部、收藏管理列表之前；数据源就是 favorites 表里当前城市的 lineStation 与 station 条目（不新增表、不新增数据源），每条一张卡：线路名+站名+双向各自最近一班（开往 X · 还有 N 站 / 约 M 分钟）+ 数据时间；纯 station 卡显示该站全部线路的最近一班摘要（最多 6 行）
- **省额度口径**: 打开页面不自动调 apizero——新增只读动作 getBoardSnapshot 按与 queryLineRealtime/queryStationArrivals 相同的缓存键（`rt|城市|线路|站名`、`sa|城市|站名`）查服务端 90 秒内存缓存，命中才返回（并标 cached），未命中返回 null、卡片显示「点查」；每张卡各自一个刷新按钮，走原有 query 动作继续吃 90 秒缓存，不做一键刷新全部。注意缓存键用收藏里存的官方站名，若用户当初用模糊关键词查询、缓存键对不上，快照未命中属正常，点查一次即对齐
- **空状态**: 无 lineStation/station 收藏时只显示一句引导，不放假数据；卡片删除沿用收藏管理列表的删除，不另做一套

### 设置页（2026-11-18 加）
- **入口**: 顶部栏齿轮图标进入，底部仍为五入口（查车/规划/附近/地铁/收藏），不新增导航项
- **存储**: 新增 settings 键值表（迁移 0005）：apizero_key、amap_key、default_city、cache_ttl_sec
- **取 key 顺序**: 服务端先读 settings 里界面存的 key（actions 取出后经 keyOverride 传给 privileged），没有再回退 privileged 读 ~/.apizero_key、~/.amap_key 文件；文件方式继续可用
- **安全口径**: key 只存服务端；getSettings 只回来源（ui/file/none）与生效 key 的末 4 位，绝不回完整值；keyFileStatus privileged 也只回文件 key 的存在与末 4 位。输入框留空 = 不修改；清除 = 删 settings 行回退文件
- **测试**: testApiKey——高德用一次 /v3/geocode/geo 轻量调用判 status；apizero 用一次 stations 搜索（消耗 1 次调用，按钮旁已注明），错误原文（含额度用完）如实回显；可测输入框里未保存的新值
- **默认城市**: 与顶部切换共用同一份 city 状态（设置页改城市即调用同一个 switchCity 并把该城市存为服务端 default_city）；本机 localStorage 从没存过城市时，首次打开用服务端 default_city 作初始城市
- **缓存时长**: cache_ttl_sec 预设 60/90/120/180 秒（默认 90），cacheSet 写入时按当前设置取 TTL，改后新写入条目即时生效

### 行程模式 + 常用地点（2026-11-18 加）
- **常用地点（favorite_places 表，迁移 0006）**: 名称+地点关键词+城市，按城市隔离；同城市同名再存更新地址。规划页起/终点上方各有 chips 点填对应输入框，可把当前起/终点存为常用地点（名字候选 家/公司/学校/车站 + 自定义）；收藏页统一列出可删除、可一键设为起点/终点跳规划。不新增底部导航入口
- **行程模式（active_trip 表，迁移 0006）**: 全表只存一行（id=1），同时只有一个进行中行程，新行程替换旧的；状态（segments_json 富化段、current_index、phase waiting/riding）存服务端，关页重开靠 getActiveTrip 续上；查车页顶部有进行中横条入口
- **段富化**: startTrip 时每个乘车段用既有站点序 12 小时缓存（只读优先、未命中才调一次线路详情）算出上车站→下车站的站序切片与站数（静态站数，页面明示不是车辆实时位置，防坐过站）；取不到站点序就留空如实显示未知，不编造
- **推进**: advanceTrip 服务端权威推进——乘车段 waiting→riding（已上车）→下一段，步行段直接下一段；最后一段完成删行并回 finished=true；endTrip 随时放弃删行
- **实时口径**: 当前段实时先走 getBoardSnapshot 只读缓存（零接口调用），真查询只在用户手动点「查实时/刷新」时走 queryLineRealtime（继续吃服务端缓存），禁止自动轮询；换乘段（第 2 段起的当前段）实时区用琥珀色醒目呈现

### 常用路线一键开始行程（2026-11-18 加）
- **入口**: 收藏页常用路线列表、首页快捷横排、规划页常用路线横排（FavRouteChips 共用组件），每条路线除原「点名去规划」外多一个小号「开始行程」按钮
- **流程**: 纯客户端串联既有动作——planRoute（该路线起点+终点+其城市，走高德、不耗 apizero）取 best 标记方案（无 best 取第一套）→ startTrip 直接开始并跳行程视图，不再手动选方案；不新增服务端动作、不新增表
- **不静默覆盖**: startTrip 服务端本身是替换语义，故客户端先拦：有进行中行程时只弹确认卡（顶部栏下方，琥珀色），「结束并开始新行程」才执行、「取消」不动现有行程
- **失败口径**: planRoute 返回 ok:false 或无方案时以其 error 原文报错（ErrorBox 停留在原页面），不建空行程

### 换乘步行时间可调 + 宽裕度提示（2026-11-18 加）
- **可调步行时间**: 规划方案详情与行程模式里，每个换乘点与步行段显示「步行约 X 分钟」，X 默认按步行距离 ÷ 80 米/分钟估算（四舍五入、上限 30）；旁边 − / + 步进（1 分钟一档）与直接输入，范围 0–30 分钟。两段车紧接、中间没有步行段的同站换乘（如下车过马路到对面站台）也合成一个换乘点，默认 0 分钟由用户调
- **记住设置（transfer_walk_times 表，迁移 0007）**: 调整按「城市 + 换乘站名 + 接驳线路」存服务端（getTransferWalkTimes/setTransferWalkTime，同键更新、不同换乘点互不影响）；步行段的换乘点取它后面第一段乘车的上车站+线路名，末尾步行段接驳线路存空串。下次规划或行程遇到同一换乘点自动套用并小字标注「按你的设置」；规划、行程、宽裕度读同一份设置，行程进行中改完立即生效（不另存进行程段 JSON）
- **宽裕度提示**: 只在行程模式的换乘接驳段实时框（及当前步行段提前亮出的下一段车实时框）里算：余量 = 下一班车 travelMinutes − 步行 X 分钟；余量 ≥3 显示「赶得上」、0–2 琥珀色「有点紧」、<0 显示「赶不上这班」并自动用再下一班的 travelMinutes 再算一遍余量（无再下一班数据时如实说明）。实时缺失、方向报错或班次没有分钟数时只显示步行设置、不给结论、不编造
- **实时口径不变**: 宽裕度只吃 TripRealtime 已有的缓存快照/手动刷新结果，不新增接口调用、不自动轮询

## Long-term data behavior
- **Refresh policy**: 无定时刷新、无自动轮询；所有实时数据只在用户主动查询/点刷新时向 API 拉取（apizero 按次计费）
- **额度保护缓存（2026-11-18 加）**: 服务端内存缓存——实时到站（线路+站名关键词）与站点到站（站名）结果缓存 90 秒，90 秒内重复查询直接返回缓存并标「缓存」，不调 apizero；客户端另有「强制刷新」按钮绕过缓存真调接口。线路站点序单独长缓存 12 小时，仅用于推导方向「下一站」，不额外烧额度（查线路详情时顺带填充；站点视图只读该缓存、有才标下一站）
- **Growth**: 收藏表 favorites（kind=line/station/lineStation、value、label）与常用路线表 favorite_routes（origin、destination、label 默认「起点 → 终点」，迁移 0003）只由用户手动增删，量小；统一智能搜索为纯客户端解析（照机器人 parse_input 规则分发），不新增数据源
- **Ordering**: 收藏按添加时间倒序；线路站点按 API 返回 order 顺序
- **Time semantics**: 到站预计时间用 API 返回的 arrival_time 原样展示；页面显示查询时刻（用户本地时间）

## Rejected approaches
- **Tried**: 假设 line 接口 stops 为字符串数组（机器人格式化代码如此写）
  **Why rejected**: 实测返回的是 {order,name,lat,lng} 对象数组，以实测为准取 name
- **Tried**: 客户端直连两个 API
  **Why rejected**: key 不能进前端代码，统一走服务端 action 转发

Imagery not needed: 公交查询工具型页面，无图片主体；视觉靠线路色带与排版，不使用照片。
