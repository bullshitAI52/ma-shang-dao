import { spaceQueryClient } from "@hatch/space-sdk/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// 顶层错误兜底：以前没有任何错误边界，渲染期只要有一处抛错（例如
// 设备本地存的界面状态与新版对不上），React 会把整棵树卸掉、只剩
// 白屏，用户连一个能点的恢复入口都没有（「界面都出不了」）。这里
// 捕获后显示恢复页：先直接重载；还不行就清掉本应用在本地存的界面
// 状态（城市/画布项目/显示模式/折叠状态这几项 UI 记录）再重载——
// 收藏、画布项目与模块都存在服务端，清本地状态不会动它们。
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("界面渲染出错，已显示恢复页：", error);
  }

  private reload = () => {
    window.location.reload();
  };

  private resetLocalStateAndReload = () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        if (
          k === "transit-city" ||
          k.startsWith("canvas-project:") ||
          k.startsWith("canvas-mode:") ||
          k.startsWith("canvas-collapsed:")
        ) {
          window.localStorage.removeItem(k);
        }
      }
    } catch {
      // 清不掉也照样重载，让用户至少回到默认状态试一次
    }
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--bg)] px-6 py-10 text-center">
        <p className="text-lg font-bold text-[var(--text)]">
          页面出了点问题，没能打开
        </p>
        <p className="max-w-sm text-sm leading-relaxed text-[var(--dim)]">
          先点「重新加载」试一次；如果还是打不开，点下面第二个按钮：它只清掉这台设备上存的界面设置（选过的城市、画布停在哪个项目和显示模式），你的收藏、常用路线和画布内容都存在服务器上，不会丢。
        </p>
        <button
          type="button"
          onClick={this.reload}
          className="min-h-11 w-full max-w-xs bg-[var(--accent)] px-5 text-base font-bold text-[var(--accent-ink)] [border-radius:8px]"
        >
          重新加载
        </button>
        <button
          type="button"
          onClick={this.resetLocalStateAndReload}
          className="min-h-11 w-full max-w-xs bg-[var(--surface2)] px-5 text-base font-bold text-[var(--accent)] [border-radius:8px]"
        >
          清除本地界面设置并重载
        </button>
      </div>
    );
  }
}

// If you edit this file: keep `<QueryClientProvider client={spaceQueryClient}>`
// wrapping the app (every space shares the SDK's QueryClient), and keep
// BOTH the `hatch-space-root` class AND the `data-hatch-space-root`
// attribute on the outer div. The SDK styles select on
// `.hatch-space-root[data-hatch-space-root]` to apply mobile safe-area
// insets (notches, gesture bars, etc.), correct viewport sizing, and the
// hosting header/chrome offsets — dropping either breaks layout silently.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={spaceQueryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
