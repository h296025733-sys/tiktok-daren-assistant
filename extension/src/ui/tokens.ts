/**
 * TikTok 达人助手的轻量设计令牌。
 *
 * 页面浮层会在 Shadow DOM 中使用这些变量，因此这里不直接写入 document，
 * 也不会污染 TikTok 或其他扩展的样式。
 */
export const uiTokens = {
  color: {
    canvas: "#f5f7fa",
    surface: "#ffffff",
    surfaceMuted: "#f1f3f6",
    surfaceElevated: "rgba(24, 27, 34, 0.94)",
    surfaceOverlay: "rgba(17, 20, 26, 0.88)",
    scrim: "rgba(0, 0, 0, 0.42)",
    text: "#15171a",
    textSecondary: "#5f6672",
    textMuted: "#8a919d",
    textInverse: "#f8fafc",
    textInverseMuted: "#b9c0ca",
    border: "#dfe3e8",
    borderStrong: "#c7cdd5",
    borderInverse: "rgba(255, 255, 255, 0.14)",
    accent: "#fe2c55",
    accentHover: "#e9274d",
    accentSoft: "rgba(254, 44, 85, 0.12)",
    focus: "#4b8cff",
  },
  status: {
    success: "#168a4b",
    successSoft: "#e6f7ee",
    warning: "#b46a00",
    warningSoft: "#fff4d6",
    danger: "#d73545",
    dangerSoft: "#ffe9ec",
    info: "#2869d8",
    infoSoft: "#eaf2ff",
    loading: "#88909c",
    unknown: "#a0a6af",
  },
  fontSize: {
    xs: "10px",
    sm: "12px",
    md: "13px",
    lg: "14px",
    xl: "16px",
    title: "18px",
    display: "24px",
  },
  fontWeight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  lineHeight: {
    tight: "1.2",
    normal: "1.5",
    relaxed: "1.65",
  },
  radius: {
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "11px",
    xl: "14px",
    pill: "999px",
  },
  shadow: {
    subtle: "0 2px 8px rgba(0, 0, 0, 0.12)",
    floating: "0 8px 28px rgba(0, 0, 0, 0.24)",
    panel: "0 14px 40px rgba(0, 0, 0, 0.28)",
    focus: "0 0 0 3px rgba(75, 140, 255, 0.28)",
  },
  space: {
    zero: "0",
    xxs: "2px",
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "12px",
    xl: "16px",
    xxl: "20px",
    xxxl: "24px",
  },
  iconSize: {
    xs: "12px",
    sm: "14px",
    md: "16px",
    lg: "18px",
    xl: "20px",
    button: "34px",
  },
  zIndex: {
    cardLabel: "2147483200",
    toolbar: "2147483300",
    overlay: "2147483400",
    popover: "2147483500",
    tooltip: "2147483600",
  },
  motion: {
    instant: "0ms",
    fast: "120ms",
    normal: "180ms",
    slow: "240ms",
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  },
} as const;

export type UiTokens = typeof uiTokens;
export type CssVariableMap = Record<`--${string}`, string>;

export interface TokenTree {
  readonly [key: string]: string | number | TokenTree;
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/^--/, "");
  if (!/^[a-z][a-z0-9-]*$/i.test(normalized)) {
    throw new Error("CSS 变量前缀只能包含字母、数字和连字符");
  }
  return normalized.toLowerCase();
}

/** 将设计令牌展开为可注入 Shadow DOM 的 CSS 变量。 */
export function createCssVariables(
  tokens: TokenTree = uiTokens,
  prefix = "tda",
): CssVariableMap {
  const variables: CssVariableMap = {};
  const safePrefix = normalizePrefix(prefix);

  const visit = (node: TokenTree, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const nextPath = [...path, toKebabCase(key)];
      if (typeof value === "string" || typeof value === "number") {
        variables[`--${safePrefix}-${nextPath.join("-")}`] = String(value);
      } else {
        visit(value, nextPath);
      }
    }
  };

  visit(tokens, []);
  return variables;
}

/** 生成完整的 CSS 变量声明块；默认用于 Shadow DOM 的 :host。 */
export function createTokenStyleText(selector = ":host", prefix = "tda"): string {
  const declarations = Object.entries(createCssVariables(uiTokens, prefix))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}`;
}
