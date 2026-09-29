import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";

/**
 * 无限四代内核状态条 + 开关。
 *
 * 数据源：`~/.zcode/infinite-gen-4/state.json`，由内置插件
 * `infinite-gen-4-plugin` 的 hooks 在每次注入时写入（见 lib/common.mjs 的 writeState）。
 * 开关写入后，下一次 SessionStart / UserPromptSubmit hook 立即按新值行事。
 *
 * 设计取舍：
 * - 只读状态文件、不引入 IPC：hook 与 UI 在同一台机器上，文件是最低耦合的共享面。
 *   代价是刷新有延迟，故用 3s 轮询（与项目里其他状态卡片同款节奏）。
 * - 关闭态用灰点，开启态按是否命中拒绝显示绿/橙，并给出载荷大小，便于确认「真的注入了」。
 */

export interface Gen4State {
  enabled?: boolean;
  injected?: boolean;
  sessionId?: string;
  source?: string;
  dualLayer?: boolean;
  corrective?: boolean;
  payloadBytes?: number;
  chars?: number;
  reason?: string;
  lastVerdict?: string;
  updatedAt?: string;
}

interface Props {
  /** 状态文件读取器；桌面端注入，Web 端可缺省（则不渲染）。 */
  readState?: () => Promise<Gen4State | null>;
  /** 写入开关；缺省时开关只读（仅展示）。 */
  writeEnabled?: (enabled: boolean) => Promise<void>;
  className?: string;
}

export function InfiniteGen4Badge({ readState, writeEnabled, className }: Props) {
  const [state, setState] = useState<Gen4State | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!readState) return;
    try {
      setState((await readState()) ?? null);
    } catch {
      setState(null);
    }
  }, [readState]);

  useEffect(() => {
    if (!readState) return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [readState, refresh]);

  if (!readState) return null;

  const enabled = state?.enabled ?? false;
  const corrective = state?.corrective ?? false;
  const bytes = state?.payloadBytes ?? 0;

  const label = enabled
    ? `无限四代 ${corrective ? "· 已纠偏" : ""}`.trim()
    : "无限四代 已关闭";

  const dotClass = !enabled
    ? "bg-muted-foreground/40"
    : corrective
      ? "bg-amber-500"
      : "bg-emerald-500";

  const toggle = async () => {
    if (!writeEnabled || busy) return;
    setBusy(true);
    try {
      await writeEnabled(!enabled);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-center gap-2 rounded-full border border-border/60",
        "bg-background/80 px-2.5 py-1 text-[11px] leading-none text-muted-foreground",
        "[app-region:no-drag] backdrop-blur",
        className,
      )}
      data-gen4-enabled={enabled ? "on" : "off"}
      data-gen4-corrective={corrective ? "on" : "off"}
      title={
        enabled
          ? `已注入 ${bytes} 字节${corrective ? "，上一轮出现拒绝已追加纠偏" : ""}`
          : "内核注入已关闭，点击开启"
      }
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden />
      <span className="whitespace-nowrap">{label}</span>
      {writeEnabled ? (
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-label={enabled ? "关闭无限四代注入" : "开启无限四代注入"}
          role="switch"
          aria-checked={enabled}
          data-testid="gen4-toggle"
          className={cn(
            "relative h-3.5 w-6 shrink-0 rounded-full transition-colors",
            enabled ? "bg-emerald-500/80" : "bg-muted-foreground/30",
            busy && "opacity-50",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-2.5 rounded-full bg-white transition-all",
              enabled ? "left-3" : "left-0.5",
            )}
          />
        </button>
      ) : null}
    </div>
  );
}
