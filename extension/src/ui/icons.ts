export const iconLabels = {
  play: "播放",
  heart: "点赞",
  comment: "评论",
  bookmark: "收藏",
  share: "分享",
  clock: "时长",
  calendar: "发布时间",
  refresh: "刷新",
  save: "保存",
  copy: "复制",
  data: "数据",
  settings: "设置",
  chevronDown: "展开",
  chevronUp: "收起",
  chevronLeft: "向左",
  chevronRight: "向右",
  close: "关闭",
  pin: "固定",
  unpin: "取消固定",
  filter: "筛选",
  sort: "排序",
  export: "导出",
  check: "完成",
  warning: "警告",
  info: "信息",
  menu: "更多",
  video: "下载视频",
  music: "提取音频",
  subtitle: "生成字幕",
  translate: "自动翻译",
  document: "下载评论",
} as const;

export type IconName = keyof typeof iconLabels;

const iconPaths: Record<IconName, string> = {
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
  comment: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/>',
  bookmark: '<path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4V4Z"/>',
  share: '<path d="m12 3 5 5-5 5"/><path d="M17 8H9a6 6 0 0 0-6 6v4a7 7 0 0 1 7-5h7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.7-2.6L20 9M4 15l2.2 2.6A7 7 0 0 0 17.9 15"/>',
  save: '<path d="M5 3h12l2 2v16H5V3Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  data: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  pin: '<path d="m15 4 5 5-3 1-4 4 1 4-2 2-3-5-5-3 2-2 4 1 4-4 1-3Z"/><path d="m8 16-5 5"/>',
  unpin: '<path d="m15 4 5 5-3 1-2 2M10 11l4-4 1-3M9 15l-5-3 2-2M12 20l2-2-1-4M8 16l-5 5M3 3l18 18"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  sort: '<path d="M8 6h13M8 12h9M8 18h5M3 4v16M1 18l2 2 2-2"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M10.3 3.7 2.7 18a2 2 0 0 0 1.8 3h15a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  menu: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  video: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2M8 9v6M5.5 12H10.5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  subtitle: '<path d="M5 3h10l4 4v14H5V3Z"/><path d="M15 3v5h5M8 12h8M8 16h6"/>',
  translate: '<path d="M4 5h9M8.5 3v2M6 5c.4 3 2.2 5.6 5 7M12 5c-.7 3.8-3.5 6.8-7 8"/><path d="m14 20 3.5-9 3.5 9M15.3 17h4.4"/>',
  document: '<path d="M5 3h10l4 4v14H5V3Z"/><path d="M15 3v5h5M8 12h8M8 16h8M8 8h3"/>',
};

export interface IconOptions {
  size?: number | string;
  title?: string;
  ariaLabel?: string;
  className?: string;
  strokeWidth?: number;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSize(size: number | string): string {
  if (typeof size === "number") return String(Math.max(1, Math.min(128, size)));
  return /^(?:\d+(?:\.\d+)?(?:px|em|rem|%)?|var\(--[a-z0-9-]+\))$/i.test(size) ? size : "16";
}

/** 返回完全内联、使用 currentColor 的统一线性 SVG。 */
export function iconSvg(name: IconName, options: IconOptions = {}): string {
  const size = safeSize(options.size ?? 16);
  const strokeWidth = Math.max(1, Math.min(3, options.strokeWidth ?? 1.8));
  const label = options.ariaLabel ?? options.title;
  const classAttribute = options.className ? ` class="${escapeAttribute(options.className)}"` : "";
  const accessibility = label
    ? ` role="img" aria-label="${escapeAttribute(label)}"`
    : ' aria-hidden="true" focusable="false"';
  const title = options.title ? `<title>${escapeAttribute(options.title)}</title>` : "";

  return `<svg${classAttribute} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${accessibility}>${title}${iconPaths[name]}</svg>`;
}

/** 创建可直接插入轻量 DOM/Shadow DOM 的 SVG 节点。 */
export function createIconElement(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = iconSvg(name, options);
  const icon = template.content.firstElementChild;
  if (!(icon instanceof SVGSVGElement)) throw new Error("无法创建图标");
  return icon;
}
