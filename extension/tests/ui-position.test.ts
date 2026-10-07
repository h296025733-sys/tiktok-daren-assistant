import { describe, expect, it } from "vitest";

import { chooseOverlayPosition } from "../src/content/overlayPosition";

const video = { left: 300, top: 40, right: 700, bottom: 740, width: 400, height: 700 };

describe("主浮层自动定位", () => {
  it("优先视频右侧，右侧有障碍时改到左侧", () => {
    expect(
      chooseOverlayPosition({
        videoRect: video,
        viewportWidth: 1_200,
        viewportHeight: 800,
        panelWidth: 82,
        panelHeight: 250,
      }).placement,
    ).toBe("right");

    expect(
      chooseOverlayPosition({
        videoRect: video,
        viewportWidth: 1_200,
        viewportHeight: 800,
        panelWidth: 82,
        panelHeight: 250,
        obstacles: [{ left: 705, top: 40, right: 820, bottom: 500, width: 115, height: 460 }],
      }).placement,
    ).toBe("left");
  });

  it("两侧空间不足时回退到视频内部右上角", () => {
    const result = chooseOverlayPosition({
      videoRect: { left: 20, top: 40, right: 380, bottom: 700, width: 360, height: 660 },
      viewportWidth: 400,
      viewportHeight: 740,
      panelWidth: 82,
      panelHeight: 250,
    });
    expect(result.placement).toBe("inside");
    expect(result.left).toBeGreaterThanOrEqual(20);
  });

  it("手动位置可用时遵循设置，不可用时安全回退", () => {
    expect(
      chooseOverlayPosition({
        videoRect: video,
        viewportWidth: 1_200,
        viewportHeight: 800,
        panelWidth: 82,
        panelHeight: 250,
        preference: "left",
      }).placement,
    ).toBe("left");
    expect(
      chooseOverlayPosition({
        videoRect: { left: 4, top: 40, right: 700, bottom: 740, width: 696, height: 700 },
        viewportWidth: 1_200,
        viewportHeight: 800,
        panelWidth: 82,
        panelHeight: 250,
        preference: "left",
      }).placement,
    ).not.toBe("left");
  });
});
