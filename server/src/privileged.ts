// Privileged host functions: read the API key files from the user's home
// directory and call the external transit APIs. Action code cannot touch
// the filesystem or the `process` global, so all of that lives here.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  apizeroCall: {
    // keyOverride: 设置页里存的 key（服务端从设置存储取出后传入）；
    // 缺省/空时回退读 ~/.apizero_key 文件，保持原有文件方式可用。
    request: z.object({
      paramsJson: z.string(),
      keyOverride: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      // Raw JSON text of the upstream `data` payload.
      body: z.string(),
      error: z.string(),
    }),
    timeoutMs: 30000,
  },
  amapGet: {
    // keyOverride 同上，缺省/空时回退读 ~/.amap_key 文件。
    request: z.object({
      path: z.string(),
      paramsJson: z.string(),
      keyOverride: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      // Raw JSON text of the full upstream response body.
      body: z.string(),
      error: z.string(),
    }),
    timeoutMs: 30000,
  },
  keyFileStatus: {
    // 只回文件 key 是否存在与末 4 位（掩码用），绝不回完整 key。
    request: z.object({}),
    response: z.object({
      apizeroSet: z.boolean(),
      apizeroSuffix: z.string(),
      amapSet: z.boolean(),
      amapSuffix: z.string(),
    }),
    timeoutMs: 5000,
  },
});

// apizero 故障时给用户看的人话：原始程序错误（SyntaxError、
// TypeError、fetch failed 等）一律不外露。非 JSON / 5xx 是对方
// 服务器故障；超时 / 连不上是连接失败；接口正常返回的业务错误
// （code 非 0）不在这里翻译，仍用其原有中文提示。
const APIZERO_UNAVAILABLE =
  "公交数据接口暂时不可用（对方服务器故障），请稍后再试";
const APIZERO_CONN_FAILED = "公交数据接口连接失败，请稍后再试";

function readKeyFile(name: string): string {
  const p = join(homedir(), name);
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  return "";
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async keyFileStatus() {
    const a = readKeyFile(".apizero_key");
    const m = readKeyFile(".amap_key");
    return {
      apizeroSet: a !== "",
      apizeroSuffix: a ? a.slice(-4) : "",
      amapSet: m !== "",
      amapSuffix: m ? m.slice(-4) : "",
    };
  },

  async apizeroCall(args) {
    const key = (args.keyOverride ?? "").trim() || readKeyFile(".apizero_key");
    if (!key) {
      return {
        ok: false,
        body: "",
        error: "还没有设置公交数据密钥（设置页和服务器密钥文件都没有）",
      };
    }
    try {
      const res = await fetch("https://v1.apizero.cn/api/bus-realtime", {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: args.paramsJson,
        signal: AbortSignal.timeout(20000),
      });
      // 先拿原文再解析：对方宕机时返回的是 nginx 的 HTML 网页
      // （如 502），直接 res.json() 会把 SyntaxError 原文抛出去。
      const text = await res.text();
      if (res.status >= 500) {
        return { ok: false, body: "", error: APIZERO_UNAVAILABLE };
      }
      let data: { code?: number; msg?: string; data?: unknown };
      try {
        data = JSON.parse(text || "{}") as typeof data;
      } catch {
        return { ok: false, body: "", error: APIZERO_UNAVAILABLE };
      }
      if (data.code !== 0) {
        return {
          ok: false,
          body: "",
          error: `公交数据接口错误 ${data.code ?? "?"}：${data.msg ?? "未知错误"}`,
        };
      }
      return { ok: true, body: JSON.stringify(data.data ?? {}), error: "" };
    } catch {
      // fetch 本身失败：超时（AbortSignal.timeout）或网络连不上，
      // 原始错误文本不外露，统一翻成连接失败。
      return { ok: false, body: "", error: APIZERO_CONN_FAILED };
    }
  },

  async amapGet(args) {
    const key = (args.keyOverride ?? "").trim() || readKeyFile(".amap_key");
    if (!key) {
      return {
        ok: false,
        body: "",
        error: "还没有设置高德地图密钥（设置页和服务器密钥文件都没有）",
      };
    }
    try {
      const params = JSON.parse(args.paramsJson) as Record<string, string>;
      params.key = key;
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`https://restapi.amap.com${args.path}?${qs}`, {
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      return { ok: true, body: text, error: "" };
    } catch {
      return { ok: false, body: "", error: "高德地图接口请求失败，请稍后再试" };
    }
  },
});
