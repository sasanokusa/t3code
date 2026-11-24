import { describe, expect, it } from "@effect/vitest";

import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";

describe("faviconUrlForOrigin", () => {
  it("never asks a third-party favicon service about a link's host", () => {
    expect(faviconUrlForOrigin("https://github.com:8443/pingdotgg/t3code?private=query", 64)).toBe(
      null,
    );
  });

  // regression: #5838 no favicon request for missing or non-http origins
  it.each([null, "invalid URL", "file:///tmp/private"])(
    "rejects an invalid or unsupported origin %s",
    (origin) => {
      expect(faviconUrlForOrigin(origin)).toBeNull();
    },
  );
});

describe("toolActivityFaviconUrl", () => {
  it("does not fetch favicons from the page's origin", () => {
    expect(
      toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light"),
    ).toBeNull();
    expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/x" }, "dark")).toBeNull();
  });

  it("shows only inline provider icons", () => {
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "data:image/png;base64,AAAA" },
        "light",
      ),
    ).toBe("data:image/png;base64,AAAA");
  });
});
