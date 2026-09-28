import { useCallback, useEffect, useMemo, useState } from "react";
import { compareSemverVersions, ZCODE_VERSION } from "@zcode/shared";
import type { ISystemService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type ReleaseInfo = NonNullable<
  Awaited<ReturnType<NonNullable<ISystemService["getOfficialReleaseInfo"]>>>
>;

/**
 * 自动轮询间隔。官方发版不频繁，1 小时足够及时；设置页打开期间才轮询，
 * 不在后台常驻定时器（F-15 要求「不增加系统后台定时任务」）。
 */
const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function OfficialReleaseSection({ systemService }: { systemService: ISystemService }) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!systemService.getOfficialReleaseInfo) return;
    setLoading(true);
    setError(false);
    try {
      setRelease(await systemService.getOfficialReleaseInfo(locale));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [locale, systemService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 设置页挂载期间定时自动检查：用户停在这一页就能看到官方发版，
  // 不需要手动点。卸载即清除，不留下后台定时器。
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const comparison = release ? compareSemverVersions(release.version, ZCODE_VERSION) : null;
  const hasNewerOfficialRelease = comparison !== null && comparison > 0;

  // 更新内容按行渲染成列表，保留官方 markdown 的标题/条目结构；
  // 官方 notes 里已有 `## 新功能` / `- xxx`，直接按行去符号展示比塞进 <pre> 更可读。
  const noteLines = useMemo(() => {
    const raw = release?.releaseNotes?.trim() ?? "";
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({
        heading: line.startsWith("#"),
        text: line.replace(/^#+\s*/u, "").replace(/^[-*]\s+/u, ""),
      }));
  }, [release?.releaseNotes]);

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.officialRelease.title" })}
        description={intl.formatMessage({ id: "settings.officialRelease.description" })}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !systemService.getOfficialReleaseInfo}
            onClick={() => void refresh()}
          >
            {intl.formatMessage({
              id: loading
                ? "settings.officialRelease.checking"
                : "settings.officialRelease.refresh",
            })}
          </Button>
        }
        detail={
          <div className="space-y-2 text-ui-base text-foreground-subtle">
            <p>
              {intl.formatMessage(
                { id: "settings.officialRelease.localVersion" },
                { version: ZCODE_VERSION },
              )}
            </p>
            {release ? (
              <>
                <p className="font-medium text-foreground">
                  {intl.formatMessage(
                    { id: "settings.officialRelease.officialVersion" },
                    { version: release.version },
                  )}
                </p>
                <p>
                  {intl.formatMessage(
                    { id: "settings.officialRelease.releaseDate" },
                    { date: release.releaseDate || "—" },
                  )}
                </p>
                <p>
                  {intl.formatMessage(
                    { id: "settings.officialRelease.checkedAt" },
                    { time: new Date(release.checkedAt).toLocaleString(locale) },
                  )}
                </p>
                <p
                  role={hasNewerOfficialRelease ? "status" : undefined}
                  className={hasNewerOfficialRelease ? "font-medium text-primary" : undefined}
                >
                  {intl.formatMessage({
                    id:
                      comparison === null
                        ? "settings.officialRelease.unknown"
                        : comparison > 0
                          ? "settings.officialRelease.newer"
                          : comparison === 0
                            ? "settings.officialRelease.same"
                            : "settings.officialRelease.older",
                  })}
                </p>
                {noteLines.length > 0 ? (
                  <div className="space-y-1" data-testid="official-release-notes">
                    {noteLines.map((line, index) =>
                      line.heading ? (
                        <p key={index} className="pt-1 font-medium text-foreground">
                          {line.text}
                        </p>
                      ) : (
                        <p key={index} className="pl-3">
                          · {line.text}
                        </p>
                      ),
                    )}
                  </div>
                ) : (
                  <p>{intl.formatMessage({ id: "settings.officialRelease.noNotes" })}</p>
                )}
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => platform.openExternal(release.sourceUrl)}
                >
                  {intl.formatMessage({ id: "settings.officialRelease.source" })}
                </Button>
              </>
            ) : null}
            {loading ? (
              <p>{intl.formatMessage({ id: "settings.officialRelease.loading" })}</p>
            ) : null}
            {error ? (
              <p role="alert">{intl.formatMessage({ id: "settings.officialRelease.error" })}</p>
            ) : null}
          </div>
        }
      />
    </SettingsGroupCard>
  );
}
