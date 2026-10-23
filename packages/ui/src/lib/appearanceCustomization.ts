/**
 * 自定义外观 —— 配色预设、强调色与背景图的偏好模型、持久化与 DOM 应用。
 *
 * 为什么单独成文件：主题（强调色）与背景图是两个正交维度，但都落在 documentElement 的
 * CSS 变量上；集中一处 apply 可以保证一次切换不出现"变量已改但类没切"的中间态，
 * 也便于单测覆盖夹紧、URL 白名单与跨窗口 storage 同步。
 *
 * 与既有主题的关系：`Theme`（light/dark/zai-light/zai-dark/system）继续决定明暗与基础令牌；
 * 本模块只在其之上叠加强调色与壁纸，不改写 Theme 联合类型。
 */
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export const APPEARANCE_PRESET_STORAGE_KEY = "zcode-appearance-preset";
export const APPEARANCE_ACCENT_STORAGE_KEY = "zcode-appearance-accent";
export const APPEARANCE_WALLPAPER_STORAGE_KEY = "zcode-appearance-wallpaper";

export const APPEARANCE_PRESET_ATTRIBUTE = "data-zcode-appearance-preset";
export const WALLPAPER_ATTRIBUTE = "data-zcode-wallpaper";

export type AppearancePreset = "default" | "aurora" | "ocean" | "sand" | "rose" | "forest";

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  "default",
  "aurora",
  "ocean",
  "sand",
  "rose",
  "forest",
];

/** 预设色相角（oklch h）。default 不写色相，沿用各主题原本的品牌色。 */
const PRESET_HUES: Record<Exclude<AppearancePreset, "default">, number> = {
  aurora: 300,
  ocean: 235,
  sand: 70,
  rose: 10,
  forest: 145,
};

export type WallpaperFit = "cover" | "contain" | "tile";

export const WALLPAPER_FITS: readonly WallpaperFit[] = ["cover", "contain", "tile"];

export interface WallpaperPreference {
  /** none 表示不启用壁纸层；image 的 source 是本地绝对路径，url 的 source 是 http(s)/data 地址。 */
  kind: "none" | "image" | "url";
  source: string;
  fit: WallpaperFit;
  /** 黑色遮罩浓度，百分比 0-90：越高文字越稳、壁纸越淡。 */
  dim: number;
  /** 高斯模糊半径，0-24 px。 */
  blur: number;
  /** 表面色不透明度 0.4-1：越低壁纸越透出，文字对比度越低。 */
  surfaceOpacity: number;
}

export interface AppearanceCustomization {
  preset: AppearancePreset;
  /** 归一化后的 #rgb/#rrggbb/#rrggbbaa，null 表示跟随预设。 */
  accent: string | null;
  wallpaper: WallpaperPreference;
}

export const MIN_WALLPAPER_DIM = 0;
export const MAX_WALLPAPER_DIM = 90;
export const MIN_WALLPAPER_BLUR = 0;
export const MAX_WALLPAPER_BLUR = 24;
export const MIN_SURFACE_OPACITY = 0.4;
export const MAX_SURFACE_OPACITY = 1;

export const DEFAULT_WALLPAPER: WallpaperPreference = {
  kind: "none",
  source: "",
  fit: "cover",
  dim: 55,
  blur: 0,
  surfaceOpacity: 0.86,
};

export const DEFAULT_APPEARANCE: AppearanceCustomization = {
  preset: "default",
  accent: null,
  wallpaper: DEFAULT_WALLPAPER,
};

const APPEARANCE_STORAGE_KEYS: readonly string[] = [
  APPEARANCE_PRESET_STORAGE_KEY,
  APPEARANCE_ACCENT_STORAGE_KEY,
  APPEARANCE_WALLPAPER_STORAGE_KEY,
];

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

export function normalizeAppearancePreset(value: unknown): AppearancePreset {
  return APPEARANCE_PRESETS.includes(value as AppearancePreset)
    ? (value as AppearancePreset)
    : DEFAULT_APPEARANCE.preset;
}

export function normalizeWallpaperFit(value: unknown): WallpaperFit {
  return WALLPAPER_FITS.includes(value as WallpaperFit)
    ? (value as WallpaperFit)
    : DEFAULT_WALLPAPER.fit;
}

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

/** 只接受 file/http/https 与 data:image；其他 scheme 一律丢弃，避免拼进 url() 时逃逸。 */
export function isSupportedWallpaperSource(source: string): boolean {
  const value = source.trim();
  if (!value) {
    return false;
  }
  if (/^data:/i.test(value)) {
    return /^data:image\//i.test(value);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return /^(file|https?):/i.test(value);
  }
  // 没有 scheme 时只接受 POSIX 绝对路径，相对路径会随 cwd 漂移。
  return value.startsWith("/");
}

function toFileUrl(absolutePath: string): string {
  // 逐段编码：encodeURI 不处理 # 和 ?，会让带这两个字符的文件名被当成片段/查询串。
  return `file://${absolutePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function toWallpaperCssUrl(source: string): string | null {
  const value = source.trim();
  if (!isSupportedWallpaperSource(value)) {
    return null;
  }
  const href = value.startsWith("/") ? toFileUrl(value) : value;
  return `url("${href.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

export function normalizeWallpaperPreference(raw: unknown): WallpaperPreference {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_WALLPAPER };
  }
  const candidate = raw as Partial<WallpaperPreference>;
  const source = typeof candidate.source === "string" ? candidate.source.trim() : "";
  const requestedKind =
    candidate.kind === "image" || candidate.kind === "url" || candidate.kind === "none"
      ? candidate.kind
      : DEFAULT_WALLPAPER.kind;
  // 没有可用来源时强制回落到 none：否则会留下一个"已启用但画不出图"的空层。
  const kind = requestedKind !== "none" && !isSupportedWallpaperSource(source) ? "none" : requestedKind;

  return {
    kind,
    source: kind === "none" ? "" : source,
    fit: normalizeWallpaperFit(candidate.fit),
    dim: clamp(candidate.dim, MIN_WALLPAPER_DIM, MAX_WALLPAPER_DIM, DEFAULT_WALLPAPER.dim),
    blur: clamp(candidate.blur, MIN_WALLPAPER_BLUR, MAX_WALLPAPER_BLUR, DEFAULT_WALLPAPER.blur),
    surfaceOpacity: clamp(
      candidate.surfaceOpacity,
      MIN_SURFACE_OPACITY,
      MAX_SURFACE_OPACITY,
      DEFAULT_WALLPAPER.surfaceOpacity,
    ),
  };
}

function setOrRemove(
  style: CSSStyleDeclaration,
  propertyName: string,
  value: string | null,
): void {
  if (value === null) {
    style.removeProperty?.(propertyName);
    return;
  }
  style.setProperty(propertyName, value);
}

export function applyAppearanceCustomization(customization: AppearanceCustomization): void {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const rootStyle = root?.style;
  if (!root || !rootStyle?.setProperty) {
    return;
  }

  const preset = normalizeAppearancePreset(customization.preset);
  root.setAttribute(APPEARANCE_PRESET_ATTRIBUTE, preset);
  const hue = preset === "default" ? null : PRESET_HUES[preset];
  setOrRemove(rootStyle, "--zcode-preset-hue", hue === null ? null : String(hue));

  const accent = normalizeAccentColor(customization.accent);
  setOrRemove(rootStyle, "--color-brand", accent);
  setOrRemove(rootStyle, "--color-resize-handle", accent);

  const wallpaper = normalizeWallpaperPreference(customization.wallpaper);
  const cssUrl = wallpaper.kind === "none" ? null : toWallpaperCssUrl(wallpaper.source);
  const enabled = cssUrl !== null;

  root.setAttribute(WALLPAPER_ATTRIBUTE, enabled ? "on" : "off");
  setOrRemove(rootStyle, "--zcode-wallpaper-image", cssUrl);
  setOrRemove(
    rootStyle,
    "--zcode-wallpaper-size",
    enabled ? (wallpaper.fit === "tile" ? "auto" : wallpaper.fit) : null,
  );
  setOrRemove(
    rootStyle,
    "--zcode-wallpaper-repeat",
    enabled && wallpaper.fit === "tile" ? "repeat" : null,
  );
  setOrRemove(rootStyle, "--zcode-wallpaper-blur", enabled ? `${wallpaper.blur}px` : null);
  setOrRemove(rootStyle, "--zcode-wallpaper-dim", enabled ? String(wallpaper.dim / 100) : null);
  setOrRemove(
    rootStyle,
    "--zcode-surface-alpha",
    enabled ? String(wallpaper.surfaceOpacity) : null,
  );
}

function readStoredWallpaper(): unknown {
  const raw = readSafeLocalStorage(APPEARANCE_WALLPAPER_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function loadAppearanceCustomization(): AppearanceCustomization {
  return {
    preset: normalizeAppearancePreset(readSafeLocalStorage(APPEARANCE_PRESET_STORAGE_KEY)),
    accent: normalizeAccentColor(readSafeLocalStorage(APPEARANCE_ACCENT_STORAGE_KEY)),
    wallpaper: normalizeWallpaperPreference(readStoredWallpaper()),
  };
}

/** 落盘并立即应用：设置页每次改动都走这里，保证 UI 与持久化不会分叉。 */
export function saveAppearanceCustomization(next: AppearanceCustomization): void {
  const preset = normalizeAppearancePreset(next.preset);
  const accent = normalizeAccentColor(next.accent);
  const wallpaper = normalizeWallpaperPreference(next.wallpaper);

  writeSafeLocalStorage(APPEARANCE_PRESET_STORAGE_KEY, preset);
  writeSafeLocalStorage(APPEARANCE_ACCENT_STORAGE_KEY, accent ?? "");
  writeSafeLocalStorage(APPEARANCE_WALLPAPER_STORAGE_KEY, JSON.stringify(wallpaper));

  applyAppearanceCustomization({ preset, accent, wallpaper });
}

export function subscribeToAppearanceStorageChanges(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    // key === null 代表 storage.clear()，此时也要回到默认外观。
    if (event.key !== null && !APPEARANCE_STORAGE_KEYS.includes(event.key)) {
      return;
    }
    applyAppearanceCustomization(loadAppearanceCustomization());
  };

  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
