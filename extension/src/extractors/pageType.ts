import type { PageType } from "../types/snapshot";

export function detectPageType(urlValue: string): PageType {
  let path = "";
  try {
    path = new URL(urlValue).pathname;
  } catch {
    return "other";
  }

  if (/^\/@[^/]+\/(?:video|photo)\/\d+/.test(path)) return "video_detail";
  if (path === "/" || /^\/(?:foryou|following|friends|live)(?:\/|$)/.test(path)) {
    return "home_feed";
  }
  if (/^\/search(?:\/|$)/.test(path)) return "search";
  if (/^\/tag\/[^/]+/.test(path)) return "hashtag";
  if (/^\/music\/[^/]+/.test(path)) return "music";
  if (/^\/@[^/]+\/?$/.test(path)) return "profile";
  return "other";
}

export function videoIdFromUrl(urlValue: string): string | null {
  try {
    return new URL(urlValue).pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
