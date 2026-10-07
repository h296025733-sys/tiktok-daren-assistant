const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 80;
const HARD_MAX_DEPTH = 6;
const HARD_MAX_NODES = 200;
const MAX_TEXT_SUMMARY = 80;
const MAX_TEXT_INSPECTION = 512;
const MAX_PATHNAME_LENGTH = 300;

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);
const SENSITIVE_KEY =
  "authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|session(?:id)?|csrf(?:token)?";

export type EvidenceRoot = Document | Element | ShadowRoot;

export interface ContainerStructureOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export interface ContainerStructureNode {
  tag: string;
  data_e2e: string | null;
  aria_label: string | null;
  role: string | null;
  href_pathname: string | null;
  text_length: number;
  text_summary: string | null;
  children: ContainerStructureNode[];
}

export interface ContainerStructureSummary {
  nodes: ContainerStructureNode[];
  node_count: number;
  truncated: boolean;
}

/**
 * 生成有限、脱敏的容器结构摘要。它只读取允许的公开 DOM 属性，绝不读取
 * innerHTML、表单值、请求头、Cookie 或页面存储。
 */
export function summarizeContainerStructure(
  input: EvidenceRoot | readonly (EvidenceRoot | null | undefined)[],
  options: ContainerStructureOptions = {},
): ContainerStructureSummary {
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 0, HARD_MAX_DEPTH);
  const maxNodes = boundedInteger(options.maxNodes, DEFAULT_MAX_NODES, 1, HARD_MAX_NODES);
  const roots = Array.isArray(input) ? input : [input];
  const seen = new Set<Element>();
  const nodes: ContainerStructureNode[] = [];
  let nodeCount = 0;
  let truncated = false;

  const visit = (element: Element, depth: number): ContainerStructureNode | null => {
    if (seen.has(element)) return null;
    if (nodeCount >= maxNodes) {
      truncated = true;
      return null;
    }

    seen.add(element);
    nodeCount += 1;

    const tag = element.tagName.toLowerCase();
    const directText = RAW_TEXT_TAGS.has(tag)
      ? { content: "", length: 0 }
      : collectDirectText(element);
    const children: ContainerStructureNode[] = [];
    const childElements = Array.from(element.children);

    if (depth < maxDepth) {
      for (const child of childElements) {
        if (nodeCount >= maxNodes) {
          truncated = true;
          break;
        }
        const summary = visit(child, depth + 1);
        if (summary) children.push(summary);
      }
    } else if (childElements.length > 0) {
      truncated = true;
    }

    return {
      tag,
      data_e2e: sanitizeEvidence(element.getAttribute("data-e2e")),
      aria_label: sanitizeEvidence(element.getAttribute("aria-label")),
      role: sanitizeEvidence(element.getAttribute("role")),
      href_pathname: sanitizePathname(element.getAttribute("href")),
      text_length: directText.length,
      text_summary: sanitizeEvidence(directText.content),
      children,
    };
  };

  for (const root of roots) {
    if (!root) continue;
    const rootElements = getRootElements(root);
    for (const element of rootElements) {
      if (nodeCount >= maxNodes) {
        truncated = true;
        break;
      }
      const summary = visit(element, 0);
      if (summary) nodes.push(summary);
    }
  }

  return { nodes, node_count: nodeCount, truncated };
}

/** 只保留 URL pathname；query、hash、凭据和敏感路径段均不会进入结果。 */
export function sanitizePathname(
  href: string | null | undefined,
  baseUrl = "https://www.tiktok.com/",
): string | null {
  if (!href?.trim()) return null;

  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    // `%3F` 可能把 query 伪装进 pathname，仍应在导出前截断。
    const pathname = url.pathname.split(/%3f/i, 1)[0] ?? "/";
    return sanitizeSensitivePath(pathname).slice(0, MAX_PATHNAME_LENGTH) || "/";
  } catch {
    return null;
  }
}

/**
 * 对证据中的短文本统一脱敏并强制限制为 80 个 Unicode 字符。
 * 返回 null 表示没有可导出的内容。
 */
export function sanitizeEvidence(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  let sanitized = value
    .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => stripUrlQueryAndHash(candidate))
    .replace(/\?[^\s<>"']+/g, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[敏感信息已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[敏感信息已隐藏]")
    .replace(
      new RegExp(
        `\\b(?:${SENSITIVE_KEY})\\b(?:\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`,
        "gi",
      ),
      "[敏感信息已隐藏]",
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[长标识已隐藏]")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) return null;
  sanitized = Array.from(sanitized).slice(0, MAX_TEXT_SUMMARY).join("");
  return sanitized || null;
}

function getRootElements(root: EvidenceRoot): Element[] {
  if (root.nodeType === Node.DOCUMENT_NODE) {
    const documentRoot = (root as Document).documentElement;
    return documentRoot ? [documentRoot] : [];
  }
  if (root.nodeType === Node.ELEMENT_NODE) return [root as Element];
  return Array.from((root as ShadowRoot).children);
}

function collectDirectText(element: Element): { content: string; length: number } {
  let content = "";
  let length = 0;

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node.textContent ?? "";
    length += text.length;
    if (content.length < MAX_TEXT_INSPECTION) {
      content += `${content ? " " : ""}${text.slice(0, MAX_TEXT_INSPECTION - content.length)}`;
    }
  }

  return {
    content: content.replace(/\s+/g, " ").trim(),
    length,
  };
}

function stripUrlQueryAndHash(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "[链接已隐藏]";
    return `${url.origin}${sanitizeSensitivePath(url.pathname)}`;
  } catch {
    return candidate.split(/[?#]/, 1)[0] ?? "";
  }
}

function sanitizeSensitivePath(pathname: string): string {
  const sensitiveSegment = new RegExp(
    `/(?:${SENSITIVE_KEY})(?:/|=|%2f|%3d)[^/]*`,
    "gi",
  );
  return pathname
    .replace(sensitiveSegment, "/[敏感路径已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[长标识已隐藏]");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}
