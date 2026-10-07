import { beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeEvidence,
  sanitizePathname,
  summarizeContainerStructure,
} from "../src/content/evidence";

describe("脱敏容器结构证据", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  it("href 只导出 pathname，文本中的 query、Cookie 和 token 值不会泄露", () => {
    document.body.innerHTML = `
      <article data-e2e="feed-video" role="article" aria-label="当前视频">
        <a
          href="https://www.tiktok.com/@tester/video/7654321?token=query-secret&cursor=private-cursor#comments"
        >查看 https://api.tiktok.com/item/detail?id=1&access_token=url-secret token=text-secret Cookie: cookie-secret</a>
      </article>
    `;

    const article = document.querySelector("article");
    if (!article) throw new Error("fixture article 缺失");
    const summary = summarizeContainerStructure(article);
    const serialized = JSON.stringify(summary);
    const link = summary.nodes[0]?.children[0];

    expect(link?.href_pathname).toBe("/@tester/video/7654321");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("private-cursor");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("text-secret");
    expect(serialized).not.toContain("cookie-secret");
    expect(serialized).not.toContain("access_token=");
    expect(serialized).not.toContain("?token=");
  });

  it("节点、深度和摘要长度均受硬上限约束", () => {
    const root = document.createElement("section");
    let parent: Element = root;
    for (let depth = 0; depth < 12; depth += 1) {
      const child = document.createElement("div");
      child.textContent = "这是一段用于验证摘要硬上限的文本".repeat(20);
      parent.append(child);
      parent = child;
    }
    for (let index = 0; index < 260; index += 1) {
      root.append(document.createElement("span"));
    }

    const summary = summarizeContainerStructure(root, {
      maxDepth: Number.MAX_SAFE_INTEGER,
      maxNodes: Number.MAX_SAFE_INTEGER,
    });
    const flattened = flatten(summary.nodes);

    expect(summary.node_count).toBeLessThanOrEqual(200);
    expect(flattened).toHaveLength(summary.node_count);
    expect(summary.truncated).toBe(true);
    expect(flattened.every((node) => Array.from(node.text_summary ?? "").length <= 80)).toBe(true);
    expect(maxTreeDepth(summary.nodes)).toBeLessThanOrEqual(7);
  });

  it("Document 输入也不会复制 HTML、script 内容或非白名单属性", () => {
    document.body.innerHTML = `
      <main id="private-id" class="private-class" data-e2e="page-root">
        <script>const token = "script-secret";</script>
        <input value="password-secret" data-private="private-value" />
        <a href="/api/token/path-secret?authorization=bearer-secret">入口</a>
      </main>
    `;

    const summary = summarizeContainerStructure(document, { maxDepth: 6, maxNodes: 30 });
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain("script-secret");
    expect(serialized).not.toContain("password-secret");
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("private-class");
    expect(serialized).not.toContain("private-id");
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("<main");
  });

  it("独立脱敏函数拒绝 query、JWT 和长令牌", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-secret";
    const text = sanitizeEvidence(
      `接口 https://www.tiktok.com/api/item?cursor=cursor-secret Bearer bearer-secret ${jwt}`,
    );

    expect(sanitizePathname("/api/list?token=pathname-secret#hash")).toBe("/api/list");
    expect(text).not.toContain("cursor-secret");
    expect(text).not.toContain("bearer-secret");
    expect(text).not.toContain("eyJhbGci");
    expect(Array.from(text ?? "").length).toBeLessThanOrEqual(80);
  });
});

function flatten(nodes: ReturnType<typeof summarizeContainerStructure>["nodes"]): typeof nodes {
  const result: typeof nodes = [];
  const queue = [...nodes];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    result.push(node);
    queue.push(...node.children);
  }
  return result;
}

function maxTreeDepth(nodes: ReturnType<typeof summarizeContainerStructure>["nodes"]): number {
  const visit = (
    node: ReturnType<typeof summarizeContainerStructure>["nodes"][number],
    depth: number,
  ): number => Math.max(depth, ...node.children.map((child) => visit(child, depth + 1)));
  return nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => visit(node, 1)));
}

