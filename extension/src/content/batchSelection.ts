export interface GridBatchCandidate {
  videoId: string;
  contentType: "video" | "photo";
}

export interface OrderedProfileBatchItem {
  video_id: string;
}

/**
 * 达人页传入工具栏已经筛选、排序且选中的结果；其他网格页保留 DOM 识别顺序。
 * 显式传入空数组代表用户取消全选，不能退回到整页全部卡片。
 */
export function selectGridCardsForBatch<T extends GridBatchCandidate>(
  cards: readonly T[],
  orderedProfileItems?: readonly OrderedProfileBatchItem[],
): T[] {
  const cardsById = new Map<string, T>();
  for (const card of cards) {
    if (card.contentType === "photo" || cardsById.has(card.videoId)) continue;
    cardsById.set(card.videoId, card);
  }

  const ordered = orderedProfileItems === undefined
    ? cards
    : orderedProfileItems.flatMap((item) => {
        const card = cardsById.get(item.video_id);
        return card ? [card] : [];
      });

  const selected: T[] = [];
  const seen = new Set<string>();
  for (const card of ordered) {
    if (card.contentType === "photo" || seen.has(card.videoId)) continue;
    seen.add(card.videoId);
    selected.push(card);
  }
  return selected;
}
