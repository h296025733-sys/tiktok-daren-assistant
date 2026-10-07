import { describe, expect, it } from "vitest";

import {
  isTikTokVideoId,
  normalizeTikTokJson,
  normalizeTikTokPayload,
  normalizeVideoItems,
  type NormalizedVideoItem,
} from "../src/extractors/normalizer";
import { VideoItemRegistry } from "../src/registry/videoItemRegistry";

const VIDEO_A = "7648204047693909278";
const VIDEO_B = "7648988578118143262";
const VIDEO_C = "7648988578118143999";

describe("TikTok JSON normalizer", () => {
  it("normalizes nested itemInfo.itemStruct and copies only public fields", () => {
    const result = normalizeTikTokJson({
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              id: VIDEO_A,
              desc: "真实视频描述",
              createTime: "1720000000",
              author: { uniqueId: "@creator_a", nickname: "创作者 A", token: "author-secret" },
              stats: {
                playCount: "4600000",
                diggCount: 38900000,
                commentCount: 41200,
                collectCount: 201600,
                shareCount: 105600,
              },
              video: {
                duration: 40,
                width: 720,
                height: 1280,
                ratio: "720p",
                cover: {
                  urlList: [
                    "https://p16-sign.tiktokcdn.test/cover.jpeg?x-token=SUPER_SECRET_TOKEN#x",
                  ],
                },
                playAddr: {
                  urlList: ["https://v16.tiktokcdn.test/media/a.mp4?token=SUPER_SECRET_TOKEN"],
                },
                claInfo: {
                  originalLanguageInfo: { language: "eng-US" },
                },
                subtitleInfos: [
                  {
                    Format: "webvtt",
                    LanguageCodeName: "spa-ES",
                    Url: "https://v16.tiktokcdn.test/subtitles/spanish.vtt?token=SPANISH",
                  },
                  {
                    Format: "webvtt",
                    LanguageCodeName: "eng-US",
                    Url: "https://v16.tiktokcdn.test/subtitles/english.vtt?token=ENGLISH",
                  },
                ],
              },
              headers: { cookie: "cookie-secret" },
              access_token: "SUPER_SECRET_TOKEN",
            },
          },
        },
      },
    });

    expect(result.matched_video_ids).toEqual([VIDEO_A]);
    expect(result.scanned_node_count).toBeGreaterThan(0);
    expect(result.candidate_object_count).toBeGreaterThanOrEqual(1);
    expect(result.items).toEqual([
      {
        video_id: VIDEO_A,
        content_type: "video",
        is_ad: null,
        has_product: null,
        author: { unique_id: "creator_a", nickname: "创作者 A" },
        description: "真实视频描述",
        created_at: 1720000000,
        publish_time_text: null,
        duration_seconds: 40,
        metrics: {
          play_count: 4600000,
          like_count: 38900000,
          comment_count: 41200,
          collect_count: 201600,
          share_count: 105600,
        },
        cover_url: "https://p16-sign.tiktokcdn.test/cover.jpeg",
        media_signature:
          "media=v16.tiktokcdn.test/media/a.mp4;duration=40;width=720;height=1280;ratio=720p",
        media_sources: {
          play_url: "https://v16.tiktokcdn.test/media/a.mp4?token=SUPER_SECRET_TOKEN",
          download_url: null,
          background_music_url: null,
          music_title: null,
          subtitle_url: "https://v16.tiktokcdn.test/subtitles/english.vtt?token=ENGLISH",
          subtitle_language: "eng-US",
        },
      },
    ]);
    const { media_sources: mediaSources, ...publicItem } = result.items[0]!;
    expect(mediaSources?.play_url).toContain("SUPER_SECRET_TOKEN");
    expect(mediaSources?.subtitle_url).toContain("token=ENGLISH");
    expect(JSON.stringify(publicItem)).not.toContain("SUPER_SECRET_TOKEN");
    expect(JSON.stringify(publicItem)).not.toContain("cookie-secret");
  });

  it("prefers an explicit H264 play address for the registry media descriptor", () => {
    const h264Url = "https://v16.tiktokcdn.test/media/h264.mp4?token=H264_TOKEN";
    const genericUrl = "https://v16.tiktokcdn.test/media/hevc.mp4?token=HEVC_TOKEN";
    const result = normalizeTikTokJson({
      itemInfo: {
        itemStruct: {
          id: VIDEO_A,
          desc: "H264 source priority regression",
          author: { uniqueId: "creator_a" },
          video: {
            duration: 12,
            playAddr: { urlList: [genericUrl] },
            playAddrH264: { urlList: [h264Url] },
          },
        },
      },
    });

    expect(result.items[0]?.media_sources?.play_url).toBe(h264Url);

    const registry = new VideoItemRegistry();
    registry.upsertMany(result.items, "network_response");
    expect(registry.getMediaSources(VIDEO_A)?.play_url).toBe(h264Url);
  });

  it("recognizes itemId/aweme_id plus stats/statistics and deduplicates by video id", () => {
    const result = normalizeTikTokPayload({
      itemList: [
        {
          itemId: VIDEO_A,
          desc: "A 的描述足够明确",
          author: { unique_id: "creator_a" },
          statistics: { play_count: 100, like_count: 20, comment_count: 3 },
          video: { duration_seconds: 11 },
        },
        {
          itemId: VIDEO_A,
          desc: "A 的描述足够明确",
          author: { nickname: "A 昵称" },
          statistics: { share_count: 4 },
          video: { width: 720 },
        },
        {
          aweme_id: VIDEO_B,
          description: "B 的描述足够明确",
          author: { uniqueId: "creator_b", nickName: "B 昵称" },
          stats: { playCount: 200, favoriteCount: 12 },
          video: { duration: 22 },
        },
      ],
    });

    expect(result.matched_video_ids).toEqual([VIDEO_A, VIDEO_B]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.author.nickname).toBe("A 昵称");
    expect(result.items[0]?.metrics.play_count).toBe(100);
    expect(result.items[0]?.metrics.share_count).toBe(4);
    expect(result.items[1]?.metrics.collect_count).toBe(12);

    const sourced = normalizeVideoItems(
      {
        itemStruct: {
          id: VIDEO_A,
          desc: "来自网络响应",
          author: { uniqueId: "creator_a" },
          stats: { playCount: 100 },
          video: { duration: 11 },
        },
      },
      "network_response",
    );
    expect(sourced.source).toBe("network_response");
    expect(sourced.matched_video_ids).toEqual([VIDEO_A]);
  });

  it("uses statsV2 as a per-field fallback when the primary stats object is incomplete", () => {
    const result = normalizeTikTokJson({
      itemInfo: {
        itemStruct: {
          id: VIDEO_C,
          desc: "A/B 页面主 stats 缺少播放量",
          author: { uniqueId: "stats_v2_creator" },
          stats: { diggCount: 420100, commentCount: 2700 },
          statsV2: {
            playCount: "10600000",
            diggCount: "999999",
            collectCount: "40800",
            shareCount: "83200",
          },
          video: { duration: 14 },
        },
      },
    });

    expect(result.items[0]).toMatchObject({
      video_id: VIDEO_C,
      metrics: {
        play_count: 10_600_000,
        like_count: 420_100,
        comment_count: 2_700,
        collect_count: 40_800,
        share_count: 83_200,
      },
    });
  });

  it("rejects comment/user ids but preserves explicit advertisement items", () => {
    const result = normalizeTikTokJson({
      comments: [
        {
          id: "7641111111111111111",
          desc: "评论伪装描述",
          author: { uniqueId: "commenter" },
          stats: { playCount: 99999999 },
          video: { duration: 3 },
        },
      ],
      comment_list: {
        items: [
          {
            id: "7644444444444444444",
            desc: "嵌套 items 评论伪装描述",
            author: { uniqueId: "nested_commenter" },
            stats: { playCount: 66666666 },
            video: { duration: 4 },
          },
        ],
      },
      users: [
        {
          id: "7642222222222222222",
          nickname: "某个用户",
          stats: { playCount: 88888888 },
        },
      ],
      itemList: [
        {
          id: "7643333333333333333",
          isAd: true,
          productData: { product_id: "sku-1001" },
          desc: "广告",
          author: { uniqueId: "advertiser" },
          stats: { playCount: 77777777 },
          video: { duration: 8 },
        },
        {
          id: VIDEO_B,
          desc: "合法视频",
          author: { uniqueId: "creator_b" },
          stats: { playCount: 123 },
          video: { duration: 9 },
        },
      ],
    });

    expect(result.matched_video_ids).toEqual(["7643333333333333333", VIDEO_B]);
    expect(result.items[0]).toMatchObject({
      video_id: "7643333333333333333",
      content_type: "video",
      is_ad: true,
      has_product: true,
      metrics: { play_count: 77777777 },
    });
    expect(result.rejected_candidate_count).toBeGreaterThanOrEqual(2);
  });

  it("keeps explicit product anchors separate from paid-ad markers", () => {
    const result = normalizeTikTokJson({
      itemList: [
        {
          id: VIDEO_C,
          desc: "带商品锚点但没有广告标记",
          author: { uniqueId: "commerce_creator" },
          statsV2: { playCount: "950000", diggCount: "42000" },
          anchors: [{ extra: JSON.stringify({ product_id: "product-88" }) }],
          video: { duration: 19 },
        },
        {
          id: VIDEO_A,
          desc: "TikTok Shop 锚点但没有商业标签版本",
          author: { uniqueId: "shop_creator" },
          statsV2: { playCount: "850000", diggCount: "32000" },
          anchors: [{
            type: 35,
            extra: JSON.stringify([{
              component_key: "anchor_shop",
              type: 33,
              id: "1732477040164638868",
            }]),
          }],
          video: { duration: 21 },
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      video_id: VIDEO_C,
      is_ad: null,
      has_product: true,
      metrics: { play_count: 950_000 },
    });
    expect(result.items[1]).toMatchObject({
      video_id: VIDEO_A,
      is_ad: null,
      has_product: true,
      metrics: { play_count: 850_000 },
    });
  });

  it("recognizes only explicit structured commercial disclosures across TikTok payload variants", () => {
    const markers: Array<Record<string, unknown>> = [
      { promote_type: "1" },
      {
        adLabelVersion: 2,
        anchors: [{
          type: 35,
          extra: JSON.stringify([{
            component_key: "anchor_shop",
            type: 33,
            id: "1732477040164638868",
          }]),
        }],
      },
      {
        ad_label_version: "2",
        anchor_list: [{
          extra_info: [{ componentKey: "anchor_shop", type: 33, productId: "product-2" }],
        }],
      },
      { video_tag: { type: "Branded", number: 1 } },
      { videoTag: { video_tag_type: "Branded Type", video_tag_number: "7" } },
      { commerce_info: { branded_content_type: 1 } },
      { commerceInfo: { brandedContentType: "2" } },
      { commercial_video_info: { ad_id: "commercial-100" } },
      { commercialVideoInfo: JSON.stringify({ disclosureText: "Paid partnership" }) },
      { hybrid_label: [{ text: "Promotional content" }] },
      { hybridLabel: [{ text: "Creator earns commission" }] },
      { hybrid_label: [{ text: "符合佣金领取资格" }] },
      { hybrid_label: [{ text: "符合佣金領取資格" }] },
      { hybrid_label: [{ text: "符合领取佣金资格" }] },
    ];

    for (const marker of markers) {
      const result = normalizeTikTokJson({
        itemList: [{
          id: VIDEO_A,
          desc: "结构化商业披露测试",
          author: { uniqueId: "commercial_creator" },
          stats: { playCount: 100 },
          video: { duration: 9 },
          is_ad: false,
          ...marker,
        }],
      });
      expect(result.items[0]?.is_ad, JSON.stringify(marker)).toBe(true);
    }
  });

  it("does not infer advertisements from descriptions, generic commerce metadata or unrelated labels", () => {
    const result = normalizeTikTokJson({
      itemList: [
        {
          id: VIDEO_A,
          desc: "#ad Paid partnership 商品 佣金只是普通简介文字",
          author: { uniqueId: "ordinary_creator" },
          stats: { playCount: 100 },
          video: { duration: 9 },
          commerce_info: {
            adv_promotable: true,
            auction_ad_invited: true,
            branded_content_type: 0,
          },
          adLabelVersion: 0,
          commercial_video_info: { title: "A useful product", metadata: { id: "ordinary" } },
          hybrid_label: [{ text: "Friends only" }, { text: "商品" }],
          video_tag: { type: "AIGC Type", number: 1 },
        },
        {
          id: VIDEO_B,
          desc: "品牌标签编号不在官方商业披露范围内",
          author: { uniqueId: "unrelated_tag_creator" },
          stats: { playCount: 200 },
          video: { duration: 10 },
          videoTag: { type: "Branded", number: 2 },
          ad_label_version: "2",
          commercialVideoInfo: "non-empty but unstructured text",
        },
        {
          id: VIDEO_C,
          desc: "只有商品锚点",
          author: { uniqueId: "product_creator" },
          stats: { playCount: 300 },
          video: { duration: 11 },
          anchors: [{ extra: JSON.stringify({ product_id: "product-100" }) }],
        },
      ],
    });

    expect(result.items[0]?.is_ad).toBeNull();
    expect(result.items[1]?.is_ad).toBeNull();
    expect(result.items[2]).toMatchObject({ is_ad: null, has_product: true });
  });

  it("normalizes imagePost as a photo post and keeps its exact item id", () => {
    const result = normalizeTikTokJson({
      itemInfo: {
        itemStruct: {
          id: VIDEO_C,
          desc: "真实图文帖子",
          createTime: 1720000010,
          author: { uniqueId: "photo_creator", nickname: "图文作者" },
          stats: {
            playCount: 131800,
            diggCount: 17000,
            commentCount: 122,
            collectCount: 5048,
            shareCount: 2302,
          },
          imagePost: {
            images: [
              { imageURL: { urlList: ["https://p16-sign.tiktokcdn.test/photo.jpeg?token=secret"] } },
            ],
          },
        },
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      video_id: VIDEO_C,
      content_type: "photo",
      is_ad: null,
      duration_seconds: null,
      metrics: { play_count: 131800, like_count: 17000 },
      cover_url: "https://p16-sign.tiktokcdn.test/photo.jpeg",
    });
  });

  it("enforces traversal limits and terminates on cyclic framework state", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclic.deep = { one: { two: { three: { four: { id: VIDEO_A, video: {}, stats: {} } } } } };

    const result = normalizeTikTokJson(cyclic, { maxDepth: 2, maxNodes: 3 });
    expect(result.truncated).toBe(true);
    expect(result.scanned_node_count).toBeLessThanOrEqual(3);
    expect(result.items).toEqual([]);
  });

  it("rejects unsafe numeric ids and arbitrary numeric objects", () => {
    const result = normalizeTikTokJson({
      unsafe: {
        id: 7648204047693909278,
        desc: "已经丢失整数精度",
        author: { uniqueId: "creator" },
        stats: { playCount: 1 },
        video: { duration: 1 },
      },
      unrelated: { id: VIDEO_A, nickname: "这只是用户" },
    });

    expect(result.items).toEqual([]);
    expect(isTikTokVideoId(VIDEO_A)).toBe(true);
    expect(isTikTokVideoId("123")).toBe(false);
  });
});

describe("VideoItemRegistry", () => {
  it("strictly isolates records by video_id and follows evidence source priority", () => {
    const registry = new VideoItemRegistry();
    registry.upsert(patch(VIDEO_A, 3_100_000, "A 描述"), "scoped_dom");
    registry.upsert(patch(VIDEO_B, 125_700, "B 描述"), "hydration_json");
    registry.upsert(patch(VIDEO_B, 9_999_999, "错误的低优先级描述"), "active_video");

    const itemA = registry.getItem(VIDEO_A);
    const recordB = registry.get(VIDEO_B);
    const itemB = registry.getItem(VIDEO_B);
    expect(itemA?.metrics.play_count).toBe(3_100_000);
    expect(itemB?.metrics.play_count).toBe(125_700);
    expect(itemB?.description).toBe("B 描述");
    expect(recordB?.fields["metrics.play_count"]?.source).toBe("hydration_json");
    expect(recordB?.fields["metrics.play_count"]?.raw_value).toBe(125_700);
    expect(recordB?.video_id).toBe(VIDEO_B);
  });

  it("keeps advertisement and product true evidence regardless of source arrival order", () => {
    const falseThenTrue = new VideoItemRegistry();
    falseThenTrue.upsert({ video_id: VIDEO_A, is_ad: false, has_product: false }, "hydration_json");
    falseThenTrue.upsert({ video_id: VIDEO_A, is_ad: true, has_product: true }, "network_response");
    falseThenTrue.upsert({ video_id: VIDEO_A, is_ad: false, has_product: false }, "hydration_json");
    expect(falseThenTrue.getItem(VIDEO_A)).toMatchObject({ is_ad: true, has_product: true });
    expect(falseThenTrue.get(VIDEO_A)?.fields.is_ad?.source).toBe("network_response");

    const trueThenFalse = new VideoItemRegistry();
    trueThenFalse.upsert({ video_id: VIDEO_B, is_ad: true, has_product: true }, "network_response");
    trueThenFalse.upsert({ video_id: VIDEO_B, is_ad: false, has_product: false }, "hydration_json");
    expect(trueThenFalse.getItem(VIDEO_B)).toMatchObject({ is_ad: true, has_product: true });
    expect(trueThenFalse.get(VIDEO_B)?.fields.is_ad?.source).toBe("network_response");

    const crossTabTrue = new VideoItemRegistry();
    crossTabTrue.upsert({ video_id: VIDEO_C, is_ad: false }, "hydration_json");
    crossTabTrue.upsert({ video_id: VIDEO_C, is_ad: true }, "extension_cache");
    crossTabTrue.upsert({ video_id: VIDEO_C, is_ad: false }, "hydration_json");
    expect(crossTabTrue.getItem(VIDEO_C)?.is_ad).toBe(true);
    expect(crossTabTrue.get(VIDEO_C)?.fields.is_ad?.source).toBe("extension_cache");
  });

  it("deduplicates repeated evidence and updates changing data from the same source", () => {
    let now = 10;
    const registry = new VideoItemRegistry({ now: () => now });
    registry.upsert(patch(VIDEO_A, 100, "A 描述"), "network_response");
    now = 20;
    registry.upsert(patch(VIDEO_A, 100, "A 描述"), "network_response");
    expect(registry.get(VIDEO_A)?.revision).toBe(1);
    expect(registry.getStats().deduplicated_count).toBeGreaterThan(0);

    now = 30;
    registry.upsert(patch(VIDEO_A, 101, "A 描述"), "network_response");
    expect(registry.getItem(VIDEO_A)?.metrics.play_count).toBe(101);
    expect(registry.get(VIDEO_A)?.revision).toBe(2);
  });

  it("uses access-order LRU at capacity and expires stale records by TTL", () => {
    let now = 0;
    const registry = new VideoItemRegistry({ maxEntries: 2, ttlMs: 100, now: () => now });
    registry.upsert(patch(VIDEO_A, 1, "A 描述"), "network_response");
    now = 1;
    registry.upsert(patch(VIDEO_B, 2, "B 描述"), "network_response");
    registry.get(VIDEO_A); // A becomes the most recently used entry.
    now = 2;
    registry.upsert(patch(VIDEO_C, 3, "C 描述"), "network_response");

    expect(registry.get(VIDEO_B)).toBeNull();
    expect(registry.get(VIDEO_A)).not.toBeNull();
    expect(registry.get(VIDEO_C)).not.toBeNull();
    expect(registry.getStats().evicted_count).toBe(1);

    now = 103;
    expect(registry.size).toBe(0);
    expect(registry.getStats().expired_count).toBe(2);
  });

  it("matches only a unique strong candidate and never merges ambiguous records", () => {
    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        ...patch(VIDEO_A, 10, "这是视频 A 的完整且唯一描述"),
        media_signature: "media=v16.tiktokcdn.test/media/a.mp4;duration=10",
      },
      "network_response",
    );
    registry.upsert(patch(VIDEO_B, 20, "这是视频 B 的完整且唯一描述"), "network_response");

    expect(
      registry.matchUnique({
        authorUniqueId: "creator",
        description: "这是视频 B 的完整且唯一描述",
      })?.video_id,
    ).toBe(VIDEO_B);
    expect(
      registry.matchUnique({
        mediaUrls: ["https://v16.tiktokcdn.test/media/a.mp4?token=short-lived"],
      })?.video_id,
    ).toBe(VIDEO_A);

    registry.upsert(
      { ...patch(VIDEO_C, 30, "这是视频 B 的完整且唯一描述"), cover_url: null },
      "network_response",
    );
    expect(
      registry.matchUnique({
        authorUniqueId: "creator",
        description: "这是视频 B 的完整且唯一描述",
      }),
    ).toBeNull();
  });

  it("缺少链接和描述时用作者与多个公开指标唯一回填，并容忍 K/M 展示舍入", () => {
    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: VIDEO_A,
        author: { unique_id: "backwithali" },
        duration_seconds: 14,
        metrics: {
          play_count: 9_876_543,
          like_count: 420_076,
          comment_count: 2_669,
          collect_count: 40_812,
          share_count: 83_161,
        },
      },
      "network_response",
    );
    registry.upsert(
      {
        video_id: VIDEO_B,
        author: { unique_id: "backwithali" },
        duration_seconds: 10,
        metrics: { like_count: 1_400_000, comment_count: 1_879, collect_count: 83_200, share_count: 110_800 },
      },
      "network_response",
    );

    expect(registry.matchUnique({
      authorUniqueId: "backwithali",
      durationSeconds: 14,
      likeCount: 420_100,
      commentCount: 2_700,
      collectCount: 40_800,
      shareCount: 83_200,
    })?.video_id).toBe(VIDEO_A);

    registry.upsert(
      {
        video_id: VIDEO_C,
        author: { unique_id: "backwithali" },
        duration_seconds: 14,
        metrics: { like_count: 420_090, comment_count: 2_680, collect_count: 40_790, share_count: 83_210 },
      },
      "network_response",
    );
    expect(registry.matchUnique({
      authorUniqueId: "backwithali",
      durationSeconds: 14,
      likeCount: 420_100,
      commentCount: 2_700,
      collectCount: 40_800,
      shareCount: 83_200,
    })).toBeNull();
  });

  it("accepts only a one-second media-duration rounding difference for a unique home item", () => {
    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: VIDEO_A,
      author: { unique_id: "vibemorph1", nickname: "VibeMorph" },
      created_at: 1_784_102_586,
      duration_seconds: 92,
      metrics: {
        play_count: 277_200,
        like_count: 8_039,
        comment_count: 164,
        collect_count: 747,
        share_count: 157,
      },
    }, "network_response");

    const visibleHomeContext = {
      authorUniqueId: "vibemorph1",
      durationSeconds: 93,
      durationSecondsRaw: 92.4,
      likeCount: 8_039,
      commentCount: 164,
      collectCount: 747,
      shareCount: 157,
    };
    expect(registry.matchUnique(visibleHomeContext)?.video_id).toBe(VIDEO_A);

    expect(registry.matchUnique({
      ...visibleHomeContext,
      durationSecondsRaw: 93.6,
    })).toBeNull();

    // Older callers without fractional evidence still receive the deliberately
    // narrow one-second fallback, never a wider fuzzy duration match.
    expect(registry.matchUnique({
      ...visibleHomeContext,
      durationSecondsRaw: undefined,
    })?.video_id).toBe(VIDEO_A);
    expect(registry.matchUnique({
      ...visibleHomeContext,
      durationSeconds: 94,
      durationSecondsRaw: undefined,
    })).toBeNull();
  });

  it("rejects invalid ids and never retains URL credentials, query tokens or arbitrary objects", () => {
    const registry = new VideoItemRegistry();
    expect(() => registry.upsert({ video_id: "not-a-video" }, "page_url")).toThrow();

    const record = registry.upsert(
      {
        video_id: VIDEO_A,
        cover_url: "https://name:password@cdn.test/cover.jpg?token=secret#fragment",
        media_signature: "media=cdn.test/video.mp4?token=secret;duration=10",
        media_sources: {
          play_url: "https://v16.tiktokcdn.com/video.mp4?token=ephemeral-secret",
          download_url: null,
          background_music_url: null,
          music_title: null,
        },
        description: "公开描述",
      },
      "network_response",
    );
    expect(record.fields.cover_url?.value).toBe("https://cdn.test/cover.jpg");
    expect(JSON.stringify(record)).not.toContain("password");
    expect(JSON.stringify(record)).not.toContain("token=secret");
    expect(record.fields.media_signature?.value).toBe("media=cdn.test/video.mp4;duration=10");
    expect(registry.getMediaSources(VIDEO_A)?.play_url).toContain("ephemeral-secret");
    expect(JSON.stringify(registry.list())).not.toContain("ephemeral-secret");
  });
});

function patch(videoId: string, playCount: number, description: string): NormalizedVideoItem {
  return {
    video_id: videoId,
    author: { unique_id: "creator", nickname: "创作者" },
    description,
    created_at: null,
    publish_time_text: null,
    duration_seconds: 10,
    metrics: {
      play_count: playCount,
      like_count: null,
      comment_count: null,
      collect_count: null,
      share_count: null,
    },
    cover_url: `https://cdn.test/${videoId}.jpg`,
    media_signature: "duration=10;width=720;height=1280",
  };
}
