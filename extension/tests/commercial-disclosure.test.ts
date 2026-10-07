// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  hasExplicitCommercialDisclosure,
  isExplicitCommercialDisclosureText,
} from "../src/extractors/commercialDisclosure";

describe("commercial disclosure", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    "付費合作關係",
    "符合佣金领取资格",
    "Paid partnership",
    "Promotional content",
    "Creator earns commission",
    "有料パートナーシップ",
    "プロモーションコンテンツ",
  ])("accepts the explicit TikTok label %s", (label) => {
    document.body.innerHTML = `<article><div data-e2e="sponsored-tag"><p>${label}</p></div></article>`;
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(true);
    expect(isExplicitCommercialDisclosureText(label)).toBe(true);
  });

  it("accepts TikTok's sponsored-tag selector when a new locale uses an unfamiliar label", () => {
    document.body.innerHTML = '<article><div data-e2e="sponsored-tag">Partenariat rémunéré</div></article>';
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(true);
  });

  it("accepts the live detail-page commission label inside TikTok's search-comment shell", () => {
    document.body.innerHTML = `
      <div data-e2e="search-comment-container">
        <div class="css-live--DivDescriptionContentWrapper">
          <div class="css-live--DivAnchorTagWrapper">
            <div class="css-live--DivAnchorTag">符合佣金領取資格</div>
          </div>
        </div>
      </div>
    `;
    const metadataRoot = document.querySelector<HTMLElement>(
      ".css-live--DivDescriptionContentWrapper",
    );
    expect(hasExplicitCommercialDisclosure(metadataRoot)).toBe(true);
  });

  it.each([
    "#ad new lipstick",
    "广告拍摄花絮",
    "商品很好用",
    "佣金",
    "auction_ad_invited",
    "adv_promotable",
  ])("does not upgrade ordinary caption text %s", (caption) => {
    document.body.innerHTML = `<article><div data-e2e="video-desc">${caption}</div></article>`;
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(false);
  });

  it("does not let a comment or this extension's own label contaminate the current video", () => {
    document.body.innerHTML = `
      <article>
        <div data-e2e="comment-item"><span>Paid partnership</span></div>
        <div data-e2e="comment-level-1"><span>符合佣金领取资格</span></div>
        <div data-tiktok-daren-assistant="commercial-badge">广告/推广</div>
      </article>
    `;
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(false);
  });

  it("does not read an explicit label from a hidden stale detail view", () => {
    document.body.innerHTML = `
      <article>
        <div aria-hidden="true">
          <div class="css-stale--DivAnchorTagWrapper">符合佣金領取資格</div>
        </div>
      </article>
    `;
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(false);
  });

  it("does not let class-only comment and reply containers contaminate the video", () => {
    document.body.innerHTML = `
      <article>
        <div class="css-live--DivCommentItemContainer"><span>Paid partnership</span></div>
        <div class="css-live--DivReplyContainer"><span>符合佣金领取资格</span></div>
      </article>
    `;
    expect(hasExplicitCommercialDisclosure(document.querySelector("article"))).toBe(false);
  });

  it("does not reuse a disclosure from a neighbouring card", () => {
    document.body.innerHTML = `
      <main>
        <article id="normal"><span>ordinary video</span></article>
        <article id="ad"><div data-e2e="sponsored-tag">付費合作關係</div></article>
      </main>
    `;
    expect(hasExplicitCommercialDisclosure(document.querySelector("#normal"))).toBe(false);
    expect(hasExplicitCommercialDisclosure(document.querySelector("#ad"))).toBe(true);
  });
});
