import { describe, expect, it } from "vitest";

import { createCssVariables, createTokenStyleText, uiTokens } from "../src/ui/tokens";

describe("UI 设计令牌", () => {
  it("覆盖颜色、字号、圆角、阴影、间距、层级、动画和状态色", () => {
    expect(uiTokens.color.surfaceOverlay).toBeTruthy();
    expect(uiTokens.fontSize.md).toBeTruthy();
    expect(uiTokens.radius.lg).toBeTruthy();
    expect(uiTokens.shadow.floating).toBeTruthy();
    expect(uiTokens.space.lg).toBeTruthy();
    expect(uiTokens.zIndex.overlay).toBeTruthy();
    expect(uiTokens.motion.normal).toBeTruthy();
    expect(uiTokens.status.success).toBeTruthy();
  });

  it("为 Shadow DOM 生成稳定的 CSS 变量", () => {
    const variables = createCssVariables();
    expect(variables["--tda-color-surface-overlay"]).toBe("rgba(17, 20, 26, 0.88)");
    expect(variables["--tda-font-size-md"]).toBe("13px");
    expect(variables["--tda-z-index-tooltip"]).toBe("2147483600");
    expect(createTokenStyleText()).toContain(":host {");
    expect(createTokenStyleText()).toContain("--tda-motion-normal: 180ms;");
  });

  it("允许命名空间前缀，但拒绝可注入的选择器文本", () => {
    expect(createCssVariables(uiTokens, "assistant")["--assistant-radius-lg"]).toBe("11px");
    expect(() => createCssVariables(uiTokens, "x; color:red")).toThrowError();
  });
});

