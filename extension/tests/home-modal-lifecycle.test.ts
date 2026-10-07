import { beforeEach, describe, expect, it } from "vitest";

import { ActiveVideoSession } from "../src/content/session";
import { ActiveVideoResolver } from "../src/extractors/activeVideo";
import { collectHomePage } from "../src/extractors/pageData";
import { resolveHomeActiveVideo } from "../src/extractors/surfaces";
import { VideoItemRegistry } from "../src/registry/videoItemRegistry";
import { mockRect, mockVideoState } from "./helpers";

const CURRENT_ID = "7662425054923214093";
const PREVIOUS_ID = "7651590753136397589";
const PAGE_URL = "https://www.tiktok.com/";

describe("home-feed comment modal lifecycle", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_520 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    document.body.innerHTML = `
      <article id="feed-item" data-e2e="recommend-list-item-container">
        <video id="feed-video" src="https://cdn.example/current-feed.mp4"></video>
        <a data-e2e="browse-username" href="/@vibemorph1">vibemorph1</a>
        <p data-e2e="browse-video-desc">Part 01 #aistory #fruitstory #foodstory #sadstory #aifruit</p>
        <strong data-e2e="browse-like-count">8K</strong>
        <strong data-e2e="browse-comment-count">164</strong>
        <strong data-e2e="browse-bookmark-count">747</strong>
        <strong data-e2e="browse-share-count">157</strong>
      </article>
      <div id="comments-modal" role="dialog" style="display:none;z-index:1000">
        <article data-e2e="recommend-list-item-container">
          <a href="/@vibemorph1/video/${CURRENT_ID}">
            <video id="modal-video" src="https://cdn.example/current-modal.mp4"></video>
          </a>
          <a data-e2e="browse-username" href="/@vibemorph1">vibemorph1</a>
          <strong data-e2e="browser-nickname">VibeMorph</strong>
          <p data-e2e="browse-video-desc">Part 01 #aistory #fruitstory #foodstory #sadstory #aifruit</p>
          <strong data-e2e="video-views">277.2K</strong>
          <strong data-e2e="browse-like-count">8K</strong>
          <strong data-e2e="browse-comment-count">164</strong>
          <strong data-e2e="browse-bookmark-count">747</strong>
          <strong data-e2e="browse-share-count">157</strong>
        </article>
      </div>
    `;
  });

  it("keeps the same confirmed video after closed -> open -> closed despite a one-second duration delta", () => {
    const feedVideo = document.querySelector<HTMLVideoElement>("#feed-video")!;
    const modalVideo = document.querySelector<HTMLVideoElement>("#modal-video")!;
    const modal = document.querySelector<HTMLElement>("#comments-modal")!;
    mockRect(feedVideo, { left: 88, top: 18, width: 490, height: 868 });
    mockRect(modalVideo, { left: 22, top: 12, width: 490, height: 868 });
    mockVideoState(feedVideo, { paused: false, readyState: 4, duration: 92.51 });
    mockVideoState(modalVideo, { paused: false, readyState: 4, duration: 92.49 });

    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: PREVIOUS_ID,
      author: { unique_id: "vibemorph1", nickname: "Old VibeMorph" },
      description: "A previous post by the same author",
      created_at: 1_750_000_000,
      duration_seconds: 93,
      metrics: {
        play_count: 9_900_000,
        like_count: 90_000,
        comment_count: 1_640,
        collect_count: 7_470,
        share_count: 1_570,
      },
    }, "network_response");
    registry.upsert({
      video_id: CURRENT_ID,
      author: { unique_id: "vibemorph1", nickname: "VibeMorph" },
      description: "Part 01 #aistory #fruitstory #foodstory #sadstory #aifruit",
      created_at: 1_752_537_600,
      duration_seconds: 92,
      metrics: {
        play_count: 277_200,
        like_count: 8_039,
        comment_count: 164,
        collect_count: 747,
        share_count: 157,
      },
    }, "network_response");

    const resolver = new ActiveVideoResolver(document, window);
    const session = new ActiveVideoSession();
    resolver.setVisibilityRatio(feedVideo, 1);
    resolver.setVisibilityRatio(modalVideo, 1);

    const closedBefore = resolveHomeActiveVideo(resolver)!;
    expect(closedBefore.mediaElement).toBe(feedVideo);
    expect(closedBefore.videoId).toBeNull();
    session.observe(`home:${closedBefore.identity}`);
    const beforeSnapshot = collectHomePage(PAGE_URL, closedBefore, registry, 0, true).snapshot;
    session.store(`home:${closedBefore.identity}`, beforeSnapshot);
    expect(beforeSnapshot).toMatchObject({
      video_id: CURRENT_ID,
      author: { nickname: "VibeMorph", unique_id: "vibemorph1" },
      created_at: 1_752_537_600,
      metrics: { play_count: 277_200 },
    });

    modal.style.display = "block";
    const opened = resolveHomeActiveVideo(resolver)!;
    expect(opened.mediaElement).toBe(modalVideo);
    expect(opened.videoId).toBe(CURRENT_ID);
    expect(session.observe(`home:${opened.identity}`)).toBe(true);
    const openedSnapshot = collectHomePage(PAGE_URL, opened, registry, 1, true).snapshot;
    session.store(`home:${opened.identity}`, openedSnapshot);
    expect(openedSnapshot.video_id).toBe(CURRENT_ID);
    expect(openedSnapshot.metrics.play_count).toBe(277_200);

    modal.style.display = "none";
    const closedAfter = resolveHomeActiveVideo(resolver)!;
    expect(closedAfter.mediaElement).toBe(feedVideo);
    expect(closedAfter.identity).toBe(closedBefore.identity);
    expect(session.observe(`home:${closedAfter.identity}`)).toBe(true);
    expect(session.get(`home:${closedAfter.identity}`, PAGE_URL)).toBeNull();
    const afterSnapshot = collectHomePage(PAGE_URL, closedAfter, registry, 2, true).snapshot;
    session.store(`home:${closedAfter.identity}`, afterSnapshot);

    expect(afterSnapshot).toMatchObject({
      video_id: CURRENT_ID,
      author: { nickname: "VibeMorph", unique_id: "vibemorph1" },
      created_at: 1_752_537_600,
      duration_seconds: 92,
      metrics: {
        play_count: 277_200,
        like_count: 8_039,
        comment_count: 164,
        collect_count: 747,
        share_count: 157,
      },
    });
    expect(afterSnapshot.video_id).not.toBe(PREVIOUS_ID);
    expect(afterSnapshot.metrics.play_count).not.toBe(9_900_000);
    expect(afterSnapshot.raw_data.registry_match).toBe(CURRENT_ID);
  });
});
