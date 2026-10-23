import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_PRESET_ATTRIBUTE,
  APPEARANCE_PRESET_STORAGE_KEY,
  APPEARANCE_WALLPAPER_STORAGE_KEY,
  applyAppearanceCustomization,
  DEFAULT_APPEARANCE,
  DEFAULT_WALLPAPER,
  isSupportedWallpaperSource,
  loadAppearanceCustomization,
  MAX_WALLPAPER_DIM,
  normalizeAccentColor,
  normalizeAppearancePreset,
  normalizeWallpaperFit,
  normalizeWallpaperPreference,
  saveAppearanceCustomization,
  subscribeToAppearanceStorageChanges,
  toWallpaperCssUrl,
  WALLPAPER_ATTRIBUTE,
} from "../src/lib/appearanceCustomization.js";

interface FakeRoot {
  attributes: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
  style: {
    properties: Map<string, string>;
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
}

function stubDocument(): FakeRoot {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const root: FakeRoot = {
    attributes,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    style: {
      properties,
      setProperty: (name, value) => {
        properties.set(name, value);
      },
      removeProperty: (name) => {
        properties.delete(name);
      },
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  return root;
}

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeAppearancePreset", () => {
  it("保留已知预设并回落 default", () => {
    expect(normalizeAppearancePreset("ocean")).toBe("ocean");
    expect(normalizeAppearancePreset("nope")).toBe("default");
    expect(normalizeAppearancePreset(null)).toBe("default");
  });
});

describe("normalizeWallpaperFit", () => {
  it("保留已知填充方式并回落 cover", () => {
    expect(normalizeWallpaperFit("tile")).toBe("tile");
    expect(normalizeWallpaperFit("stretch")).toBe("cover");
  });
});

describe("normalizeAccentColor", () => {
  it("接受 3/6/8 位十六进制并小写化", () => {
    expect(normalizeAccentColor("#ABC")).toBe("#abc");
    expect(normalizeAccentColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeAccentColor("  #11223344 ")).toBe("#11223344");
  });

  it("拒绝非十六进制与空值", () => {
    expect(normalizeAccentColor("rgb(1,2,3)")).toBeNull();
    expect(normalizeAccentColor("")).toBeNull();
    expect(normalizeAccentColor(undefined)).toBeNull();
  });
});

describe("isSupportedWallpaperSource", () => {
  it("接受本地绝对路径、file/http(s) 与 data:image", () => {
    expect(isSupportedWallpaperSource("/Users/me/a.png")).toBe(true);
    expect(isSupportedWallpaperSource("file:///tmp/a.png")).toBe(true);
    expect(isSupportedWallpaperSource("https://x.test/a.png")).toBe(true);
    expect(isSupportedWallpaperSource("data:image/png;base64,AAA")).toBe(true);
  });

  it("拒绝相对路径、javascript: 与非图片 data", () => {
    expect(isSupportedWallpaperSource("a.png")).toBe(false);
    expect(isSupportedWallpaperSource("javascript:alert(1)")).toBe(false);
    expect(isSupportedWallpaperSource("data:text/html,<script>")).toBe(false);
    expect(isSupportedWallpaperSource("   ")).toBe(false);
  });
});

describe("toWallpaperCssUrl", () => {
  it("把绝对路径转成编码过的 file url", () => {
    expect(toWallpaperCssUrl("/tmp/a b#1.png")).toBe('url("file:///tmp/a%20b%231.png")');
  });

  it("原样保留 http 地址并转义引号", () => {
    expect(toWallpaperCssUrl('https://x.test/a"b.png')).toBe('url("https://x.test/a\\"b.png")');
  });

  it("不支持的来源返回 null", () => {
    expect(toWallpaperCssUrl("relative.png")).toBeNull();
  });
});

describe("normalizeWallpaperPreference", () => {
  it("非法来源强制回落 none 并清空 source", () => {
    const normalized = normalizeWallpaperPreference({
      kind: "url",
      source: "javascript:alert(1)",
      fit: "cover",
      dim: 10,
      blur: 2,
      surfaceOpacity: 0.9,
    });
    expect(normalized.kind).toBe("none");
    expect(normalized.source).toBe("");
  });

  it("夹紧 dim/blur/opacity 并保留合法来源", () => {
    const normalized = normalizeWallpaperPreference({
      kind: "image",
      source: "/tmp/a.png",
      fit: "tile",
      dim: 999,
      blur: -5,
      surfaceOpacity: 5,
    });
    expect(normalized.kind).toBe("image");
    expect(normalized.source).toBe("/tmp/a.png");
    expect(normalized.fit).toBe("tile");
    expect(normalized.dim).toBe(MAX_WALLPAPER_DIM);
    expect(normalized.blur).toBe(0);
    expect(normalized.surfaceOpacity).toBe(1);
  });

  it("非对象输入返回默认壁纸", () => {
    expect(normalizeWallpaperPreference(null)).toEqual(DEFAULT_WALLPAPER);
    expect(normalizeWallpaperPreference("x")).toEqual(DEFAULT_WALLPAPER);
  });
});

describe("applyAppearanceCustomization", () => {
  it("写入预设属性与壁纸变量", () => {
    const root = stubDocument();
    applyAppearanceCustomization({
      preset: "ocean",
      accent: "#123456",
      wallpaper: { ...DEFAULT_WALLPAPER, kind: "image", source: "/tmp/a.png", dim: 40, blur: 8 },
    });

    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBe("ocean");
    expect(root.attributes.get(WALLPAPER_ATTRIBUTE)).toBe("on");
    expect(root.style.properties.get("--zcode-preset-hue")).toBe("235");
    expect(root.style.properties.get("--color-brand")).toBe("#123456");
    expect(root.style.properties.get("--zcode-wallpaper-image")).toBe('url("file:///tmp/a.png")');
    expect(root.style.properties.get("--zcode-wallpaper-dim")).toBe("0.4");
    expect(root.style.properties.get("--zcode-wallpaper-blur")).toBe("8px");
  });

  it("回到默认外观时移除内联变量并关闭壁纸", () => {
    const root = stubDocument();
    applyAppearanceCustomization({
      preset: "rose",
      accent: "#ff0000",
      wallpaper: { ...DEFAULT_WALLPAPER, kind: "url", source: "https://x.test/a.png" },
    });
    applyAppearanceCustomization(DEFAULT_APPEARANCE);

    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBe("default");
    expect(root.attributes.get(WALLPAPER_ATTRIBUTE)).toBe("off");
    expect(root.style.properties.has("--zcode-preset-hue")).toBe(false);
    expect(root.style.properties.has("--color-brand")).toBe(false);
    expect(root.style.properties.has("--zcode-wallpaper-image")).toBe(false);
  });

  it("没有 document 时静默返回", () => {
    vi.stubGlobal("document", undefined);
    expect(() => applyAppearanceCustomization(DEFAULT_APPEARANCE)).not.toThrow();
  });
});

describe("saveAppearanceCustomization", () => {
  it("落盘三个 key 并立即应用", () => {
    const root = stubDocument();
    const store = stubStorage();

    saveAppearanceCustomization({
      preset: "forest",
      accent: "#0f0",
      wallpaper: { ...DEFAULT_WALLPAPER, kind: "url", source: "https://x.test/a.png" },
    });

    expect(store.get(APPEARANCE_PRESET_STORAGE_KEY)).toBe("forest");
    expect(store.get(APPEARANCE_WALLPAPER_STORAGE_KEY)).toContain("https://x.test/a.png");
    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBe("forest");
  });
});

describe("loadAppearanceCustomization", () => {
  it("读回已持久化的外观，损坏 JSON 回落默认壁纸", () => {
    stubStorage({
      [APPEARANCE_PRESET_STORAGE_KEY]: "sand",
      [APPEARANCE_WALLPAPER_STORAGE_KEY]: "{not json",
    });

    const loaded = loadAppearanceCustomization();
    expect(loaded.preset).toBe("sand");
    expect(loaded.wallpaper).toEqual(DEFAULT_WALLPAPER);
  });
});

describe("subscribeToAppearanceStorageChanges", () => {
  it("只在相关 key 变化时重放应用，并在取消订阅时移除监听", () => {
    const root = stubDocument();
    const store = new Map<string, string>([[APPEARANCE_PRESET_STORAGE_KEY, "rose"]]);
    const listeners = new Map<string, (event: StorageEvent) => void>();
    // browserEnvironment 优先读 window.localStorage，所以 window stub 必须自带 storage，
    // 否则回调里读到的永远是默认外观，断言会误判成「没重放」。
    const windowStub = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
      addEventListener: vi.fn((type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);

    const unsubscribe = subscribeToAppearanceStorageChanges();
    const listener = listeners.get("storage");
    expect(listener).toBeTypeOf("function");

    listener?.({ key: "unrelated-key" } as StorageEvent);
    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBeUndefined();

    listener?.({ key: APPEARANCE_PRESET_STORAGE_KEY } as StorageEvent);
    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBe("rose");

    store.set(APPEARANCE_PRESET_STORAGE_KEY, "forest");
    listener?.({ key: null } as StorageEvent);
    expect(root.attributes.get(APPEARANCE_PRESET_ATTRIBUTE)).toBe("forest");

    unsubscribe();
    expect(windowStub.removeEventListener).toHaveBeenCalledWith("storage", listener);
  });
});
