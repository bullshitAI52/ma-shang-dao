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
    request: z.object({ paramsJson: z.string() }),
    response: z.object({
      ok: z.boolean(),
      // Raw JSON text of the upstream `data` payload.
      body: z.string(),
      error: z.string(),
    }),
    timeoutMs: 30000,
  },
  amapGet: {
    request: z.object({ path: z.string(), paramsJson: z.string() }),
    response: z.object({
      ok: z.boolean(),
      // Raw JSON text of the full upstream response body.
      body: z.string(),
      error: z.string(),
    }),
    timeoutMs: 30000,
  },
});

function readKeyFile(name: string): string {
  const p = join(homedir(), name);
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  return "";
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async apizeroCall(args) {
    const key = readKeyFile(".apizero_key");
    if (!key) {
      return { ok: false, body: "", error: "服务器上没有找到公交数据密钥文件" };
    }
    try {
      const res = await fetch("https://v1.apizero.cn/api/bus-realtime", {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: args.paramsJson,
        signal: AbortSignal.timeout(20000),
      });
      const data = (await res.json()) as {
        code?: number;
        msg?: string;
        data?: unknown;
      };
      if (data.code !== 0) {
        return {
          ok: false,
          body: "",
          error: `公交数据接口错误 ${data.code ?? "?"}：${data.msg ?? "未知错误"}`,
        };
      }
      return { ok: true, body: JSON.stringify(data.data ?? {}), error: "" };
    } catch (e) {
      return { ok: false, body: "", error: `公交数据接口请求失败：${String(e)}` };
    }
  },

  async amapGet(args) {
    const key = readKeyFile(".amap_key");
    if (!key) {
      return { ok: false, body: "", error: "服务器上没有找到高德地图密钥文件" };
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
    } catch (e) {
      return { ok: false, body: "", error: `高德地图接口请求失败：${String(e)}` };
    }
  },
});
