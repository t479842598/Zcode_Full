/**
 * 无限四代（infinite-gen-4）内核的宿主 ↔ 渲染进程契约。
 *
 * 内核由内置插件 `apps/zcode-cli/packages/infinite-gen-4-plugin` 通过 hook 的
 * `hookSpecificOutput.additionalContext` 注入（等价 DSH 的 systemPrompt.section）。
 * hook 是独立进程，无法直接与渲染进程通信，因此以 `~/.zcode/infinite-gen-4/state.json`
 * 作为共享面：hook 每次注入写状态，UI 读取展示并把开关写回。
 *
 * 字段全部可选：状态文件可能尚未生成（装了但没跑过会话），或被手工删除；
 * UI 必须对缺失字段做默认值处理，不得因此崩溃。
 */
export interface InfiniteGen4State {
  /** 注入总开关的真值（config.json 优先，其次此处）。 */
  enabled?: boolean;
  /** 上一次 hook 是否真的产出了注入载荷。 */
  injected?: boolean;
  /** 最近一次注入所属的会话 id。 */
  sessionId?: string;
  /** 触发原因（SessionStart/startup、compact、UserPromptSubmit 等）。 */
  source?: string;
  /** 是否双层注入（Order 100 + Order 200）。 */
  dualLayer?: boolean;
  /** 最近一次注入是否附加了拒绝闭环纠偏段。 */
  corrective?: boolean;
  /** 载荷字节数（UI 状态条显示“真的注入了多少”）。 */
  payloadBytes?: number;
  /** 载荷字符数。 */
  chars?: number;
  /** 本次注入的说明（disabled / compact-skip 等）。 */
  reason?: string;
  /** 上一轮助手回复的判定：pass / refusal / fallback。 */
  lastVerdict?: string;
  /** 状态写入时间（ISO 字符串）。 */
  updatedAt?: string;
}

/** 切换注入开关的请求体。 */
export interface WriteInfiniteGen4EnabledRequest {
  enabled: boolean;
}
