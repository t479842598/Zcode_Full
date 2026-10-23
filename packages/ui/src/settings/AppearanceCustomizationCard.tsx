import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  isSupportedWallpaperSource,
  loadAppearanceCustomization,
  MAX_SURFACE_OPACITY,
  MAX_WALLPAPER_BLUR,
  MAX_WALLPAPER_DIM,
  MIN_SURFACE_OPACITY,
  MIN_WALLPAPER_BLUR,
  MIN_WALLPAPER_DIM,
  saveAppearanceCustomization,
  WALLPAPER_FITS,
} from "@/lib/appearanceCustomization.js";
import type {
  AppearanceCustomization,
  AppearancePreset,
  WallpaperFit,
} from "@/lib/appearanceCustomization.js";
import { SettingsRangeControl, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 配色方案对应的取色器回显色。
 * 仅为「跟随预设」状态下给原生 color input 一个可读的初始值，
 * 真正的强调色由 CSS 里的 oklch(--zcode-preset-hue) 计算，不经过这里。
 */
const PICKER_SAFE_ACCENT = /^#[0-9a-f]{6}$/i;

/** 原生 color input 只接受 #rrggbb；手改 localStorage 写入 #rgb/#rrggbbaa 时要回落，否则控件显示成黑色。 */
function toPickerValue(accent: string | null, preset: AppearancePreset): string {
  return accent && PICKER_SAFE_ACCENT.test(accent) ? accent : PRESET_SWATCHES[preset];
}

const PRESET_SWATCHES: Record<AppearancePreset, string> = {
  default: "#38bdf8",
  aurora: "#c98bff",
  ocean: "#7c9cff",
  sand: "#d8b45a",
  rose: "#ff8080",
  forest: "#5fce9b",
};

export function AppearanceCustomizationCard() {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [customization, setCustomization] = useState<AppearanceCustomization>(() =>
    loadAppearanceCustomization(),
  );
  const [urlDraft, setUrlDraft] = useState(() =>
    customization.wallpaper.kind === "url" ? customization.wallpaper.source : "",
  );
  const [sourceRejected, setSourceRejected] = useState(false);

  // 唯一写入口：先落盘再回读，避免本地 state 与 localStorage 分叉。
  const commit = (next: AppearanceCustomization) => {
    saveAppearanceCustomization(next);
    setCustomization(loadAppearanceCustomization());
  };

  const wallpaper = customization.wallpaper;
  const wallpaperEnabled = wallpaper.kind !== "none" && wallpaper.source.length > 0;

  const handlePickFile = async () => {
    const selected = platform ? await platform.selectFile() : null;
    if (!selected) {
      return;
    }
    if (!isSupportedWallpaperSource(selected)) {
      setSourceRejected(true);
      return;
    }
    setSourceRejected(false);
    setUrlDraft("");
    commit({
      ...customization,
      wallpaper: { ...wallpaper, kind: "image", source: selected },
    });
  };

  const handleCommitUrl = () => {
    const value = urlDraft.trim();
    if (!value) {
      return;
    }
    if (!isSupportedWallpaperSource(value)) {
      setSourceRejected(true);
      return;
    }
    setSourceRejected(false);
    commit({
      ...customization,
      wallpaper: { ...wallpaper, kind: "url", source: value },
    });
  };

  const handleClearWallpaper = () => {
    setUrlDraft("");
    setSourceRejected(false);
    commit({
      ...customization,
      wallpaper: { ...wallpaper, kind: "none", source: "" },
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.appearance.customTitle" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.appearance.customDescription" })}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <SettingsRow
          label={intl.formatMessage({ id: "settings.appearance.customPreset" })}
          description={intl.formatMessage({
            id: "settings.appearance.customPresetDescription",
          })}
          control={
            <Select
              value={customization.preset}
              onValueChange={(value) =>
                commit({ ...customization, preset: value as AppearancePreset })
              }
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPEARANCE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-3 rounded-full border border-border"
                        style={{ backgroundColor: PRESET_SWATCHES[preset] }}
                      />
                      {intl.formatMessage({
                        id: `settings.appearance.customPreset.${preset}`,
                      })}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.appearance.customAccent" })}
          description={intl.formatMessage({
            id: "settings.appearance.customAccentDescription",
          })}
          control={
            <div className="flex items-center gap-2">
              <Input
                type="color"
                aria-label={intl.formatMessage({ id: "settings.appearance.customAccent" })}
                value={toPickerValue(customization.accent, customization.preset)}
                onChange={(event) =>
                  commit({ ...customization, accent: event.currentTarget.value })
                }
                className="h-8 w-14 cursor-pointer p-1"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={customization.accent === null}
                onClick={() => commit({ ...customization, accent: null })}
              >
                {intl.formatMessage({ id: "settings.appearance.customAccentFollow" })}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.appearance.customWallpaper" })}
          description={intl.formatMessage({
            id: "settings.appearance.customWallpaperDescription",
          })}
          controlLayout="wide"
          control={
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!platform}
                onClick={() => {
                  void handlePickFile();
                }}
              >
                {intl.formatMessage({ id: "settings.appearance.customWallpaperPick" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!wallpaperEnabled}
                onClick={handleClearWallpaper}
              >
                {intl.formatMessage({ id: "settings.appearance.customWallpaperClear" })}
              </Button>
            </div>
          }
          detail={
            <div className="space-y-2">
              <Input
                value={urlDraft}
                placeholder={intl.formatMessage({
                  id: "settings.appearance.customWallpaperUrlPlaceholder",
                })}
                aria-label={intl.formatMessage({ id: "settings.appearance.customWallpaperUrl" })}
                onChange={(event) => setUrlDraft(event.currentTarget.value)}
                onBlur={handleCommitUrl}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleCommitUrl();
                  }
                }}
                className="w-full"
              />
              {!platform ? (
                <p className="text-ui-sm leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "settings.appearance.customWallpaperUnavailable",
                  })}
                </p>
              ) : null}
              {sourceRejected ? (
                <p className="text-ui-sm leading-5 text-destructive">
                  {intl.formatMessage({ id: "settings.appearance.customWallpaperRejected" })}
                </p>
              ) : null}
            </div>
          }
        />
        {wallpaperEnabled ? (
          <>
            <SettingsRow
              label={intl.formatMessage({ id: "settings.appearance.customFit" })}
              control={
                <Select
                  value={wallpaper.fit}
                  onValueChange={(value) =>
                    commit({
                      ...customization,
                      wallpaper: { ...wallpaper, fit: value as WallpaperFit },
                    })
                  }
                >
                  <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WALLPAPER_FITS.map((fit) => (
                      <SelectItem key={fit} value={fit}>
                        {intl.formatMessage({ id: `settings.appearance.customFit.${fit}` })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.appearance.customDim" })}
              description={intl.formatMessage({
                id: "settings.appearance.customDimDescription",
              })}
              controlLayout="wide"
              control={
                <SettingsRangeControl
                  value={wallpaper.dim}
                  min={MIN_WALLPAPER_DIM}
                  max={MAX_WALLPAPER_DIM}
                  step={1}
                  valueLabel={`${wallpaper.dim}%`}
                  onChange={(dim) =>
                    commit({ ...customization, wallpaper: { ...wallpaper, dim } })
                  }
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.appearance.customBlur" })}
              controlLayout="wide"
              control={
                <SettingsRangeControl
                  value={wallpaper.blur}
                  min={MIN_WALLPAPER_BLUR}
                  max={MAX_WALLPAPER_BLUR}
                  step={1}
                  valueLabel={`${wallpaper.blur}px`}
                  onChange={(blur) =>
                    commit({ ...customization, wallpaper: { ...wallpaper, blur } })
                  }
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.appearance.customSurfaceOpacity" })}
              description={intl.formatMessage({
                id: "settings.appearance.customSurfaceOpacityDescription",
              })}
              controlLayout="wide"
              control={
                <SettingsRangeControl
                  value={wallpaper.surfaceOpacity}
                  min={MIN_SURFACE_OPACITY}
                  max={MAX_SURFACE_OPACITY}
                  step={0.02}
                  valueLabel={`${Math.round(wallpaper.surfaceOpacity * 100)}%`}
                  onChange={(surfaceOpacity) =>
                    commit({ ...customization, wallpaper: { ...wallpaper, surfaceOpacity } })
                  }
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.appearance.customReset" })}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setUrlDraft("");
                setSourceRejected(false);
                commit(DEFAULT_APPEARANCE);
              }}
            >
              {intl.formatMessage({ id: "settings.appearance.customResetAction" })}
            </Button>
          }
        />
      </div>
    </div>
  );
}
