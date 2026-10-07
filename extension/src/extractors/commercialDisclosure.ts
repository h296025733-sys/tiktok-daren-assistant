const TIKTOK_DISCLOSURE_SELECTOR = [
  '[data-e2e="sponsored-tag"]',
  '[data-e2e*="commercial-disclosure" i]',
  '[data-e2e*="paid-partnership" i]',
  '[data-e2e*="promotional-content" i]',
  '[data-e2e*="creator-commission" i]',
].join(",");

const EXPLICIT_DISCLOSURE_TEXTS = new Set([
  "paid partnership",
  "promotional content",
  "creator earns commission",
  "eligible for commission",
  "付费合作关系",
  "付費合作關係",
  "付费合作伙伴",
  "付費合作夥伴",
  "推广内容",
  "推廣內容",
  "符合佣金领取资格",
  "符合佣金領取資格",
  "有料パートナーシップ",
  "有償パートナーシップ",
  "プロモーションコンテンツ",
]);

const EXCLUDED_TEXT_CONTEXT_SELECTOR = [
  '[data-tiktok-daren-assistant]',
  '[data-e2e="comment-level-1"]',
  '[data-e2e="comment-level-2"]',
  '[data-e2e="comment-item"]',
  '[data-e2e*="comment-item" i]',
  '[data-e2e="comment-text"]',
  '[data-e2e="comment-content"]',
  '[class*="DivCommentItemContainer"]',
  '[class*="DivReplyContainer"]',
  '[contenteditable="true"]',
  "textarea",
  "input",
].join(",");

/**
 * Reads only TikTok's scoped, explicit commercial-disclosure UI.
 *
 * Product anchors, hashtags, brand names and broad words such as “广告” or
 * “佣金” deliberately do not count. This keeps an ordinary creator caption
 * from being upgraded to an advertisement by a keyword coincidence.
 */
export function hasExplicitCommercialDisclosure(root: ParentNode | null): boolean {
  if (!root) return false;

  for (const element of root.querySelectorAll<HTMLElement>(TIKTOK_DISCLOSURE_SELECTOR)) {
    if (isExcluded(element) || isHiddenMarkup(element)) continue;
    const text = normalizeDisclosureText(element.textContent);
    if (text && text.length <= 120) return true;
  }

  // Most videos do not contain any of the exact labels. Checking the combined
  // text first avoids walking every descendant on the normal hot path.
  const combinedText = normalizeDisclosureText(root.textContent);
  if (![...EXPLICIT_DISCLOSURE_TEXTS].some((label) => combinedText.includes(label))) {
    return false;
  }

  const elements = root.querySelectorAll<HTMLElement>("span, p, div, strong, small");
  const limit = Math.min(elements.length, 1_200);
  for (let index = 0; index < limit; index += 1) {
    const element = elements[index];
    if (!element || element.children.length > 3 || isExcluded(element) || isHiddenMarkup(element)) {
      continue;
    }
    if (EXPLICIT_DISCLOSURE_TEXTS.has(normalizeDisclosureText(element.textContent))) return true;
  }
  return false;
}

export function isExplicitCommercialDisclosureText(value: unknown): boolean {
  return EXPLICIT_DISCLOSURE_TEXTS.has(normalizeDisclosureText(value));
}

function normalizeDisclosureText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")
    : "";
}

function isExcluded(element: HTMLElement): boolean {
  return Boolean(element.closest(EXCLUDED_TEXT_CONTEXT_SELECTOR));
}

function isHiddenMarkup(element: HTMLElement): boolean {
  return Boolean(element.closest('[hidden], [aria-hidden="true"]'));
}
