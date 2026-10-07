import { describe, expect, it } from "vitest";

import { createIconElement, iconLabels, iconSvg, type IconName } from "../src/ui/icons";

describe("统一 SVG 图标", () => {
  it("全部图标均为本地内联 SVG 且使用 currentColor", () => {
    for (const name of Object.keys(iconLabels) as IconName[]) {
      const svg = iconSvg(name);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).not.toMatch(/<(?:img|use)\b/i);
      expect(svg).not.toMatch(/\b(?:href|src)=/i);
      expect(svg).not.toMatch(/(?:data:|javascript:)/i);
    }
  });

  it("可生成带中文无障碍名称的 SVG 节点", () => {
    const icon = createIconElement("play", { title: "播放", size: 18 });
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("aria-label")).toBe("播放");
    expect(icon.getAttribute("width")).toBe("18");
    expect(icon.querySelector("title")?.textContent).toBe("播放");
  });

  it("转义用户传入的标题与类名", () => {
    const svg = iconSvg("info", { title: '<测试 & "信息">', className: 'x" onclick="bad' });
    expect(svg).not.toContain("<测试");
    expect(svg).not.toContain('onclick="bad"');
    expect(svg).toContain("&lt;测试 &amp; &quot;信息&quot;&gt;");
  });
});
