export type OverlayPositionPreference = "auto" | "left" | "right" | "inside";
export type OverlayPlacement = "left" | "right" | "inside";

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface OverlayPositionInput {
  videoRect: RectLike;
  viewportWidth: number;
  viewportHeight: number;
  panelWidth: number;
  panelHeight: number;
  preference?: OverlayPositionPreference;
  obstacles?: readonly RectLike[];
  gap?: number;
  viewportPadding?: number;
}

export interface OverlayPositionResult {
  placement: OverlayPlacement;
  left: number;
  top: number;
}

interface Candidate extends OverlayPositionResult {
  priority: number;
}

export function chooseOverlayPosition(input: OverlayPositionInput): OverlayPositionResult {
  const gap = input.gap ?? 12;
  const padding = input.viewportPadding ?? 8;
  const top = clamp(
    input.videoRect.top + Math.min(68, Math.max(12, input.videoRect.height * 0.12)),
    padding,
    Math.max(padding, input.viewportHeight - input.panelHeight - padding),
  );
  const candidates: Candidate[] = [
    {
      placement: "right",
      left: input.videoRect.right + gap,
      top,
      priority: 300,
    },
    {
      placement: "left",
      left: input.videoRect.left - input.panelWidth - gap,
      top,
      priority: 200,
    },
    {
      placement: "inside",
      left: input.videoRect.right - input.panelWidth - 12,
      top: clamp(
        input.videoRect.top + 12,
        padding,
        Math.max(padding, input.viewportHeight - input.panelHeight - padding),
      ),
      priority: 100,
    },
  ];

  const preference = input.preference ?? "auto";
  const preferred = preference === "auto" ? null : candidates.find((item) => item.placement === preference);
  if (preferred && isUsable(preferred, input, padding)) {
    return rounded(preferred);
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: candidateScore(candidate, input, padding),
    }))
    .sort((left, right) => right.score - left.score);
  return rounded(ranked[0]?.candidate ?? candidates[2]!);
}

function candidateScore(
  candidate: Candidate,
  input: OverlayPositionInput,
  padding: number,
): number {
  let score = candidate.priority;
  if (!fitsViewport(candidate, input, padding)) score -= 10_000;
  if (candidate.placement === "inside" && !fitsInsideVideo(candidate, input)) score -= 5_000;
  const rect = candidateRect(candidate, input.panelWidth, input.panelHeight);
  for (const obstacle of input.obstacles ?? []) {
    const overlap = overlapArea(rect, obstacle);
    if (overlap > 0) score -= 2_000 + Math.min(2_000, overlap / 20);
  }
  return score;
}

function isUsable(
  candidate: Candidate,
  input: OverlayPositionInput,
  padding: number,
): boolean {
  if (!fitsViewport(candidate, input, padding)) return false;
  if (candidate.placement === "inside" && !fitsInsideVideo(candidate, input)) return false;
  const rect = candidateRect(candidate, input.panelWidth, input.panelHeight);
  return !(input.obstacles ?? []).some((obstacle) => overlapArea(rect, obstacle) > 0);
}

function fitsViewport(
  candidate: Candidate,
  input: OverlayPositionInput,
  padding: number,
): boolean {
  return (
    candidate.left >= padding &&
    candidate.top >= padding &&
    candidate.left + input.panelWidth <= input.viewportWidth - padding &&
    candidate.top + input.panelHeight <= input.viewportHeight - padding
  );
}

function fitsInsideVideo(candidate: Candidate, input: OverlayPositionInput): boolean {
  return (
    candidate.left >= input.videoRect.left + 8 &&
    candidate.top >= input.videoRect.top + 8 &&
    candidate.left + input.panelWidth <= input.videoRect.right - 8 &&
    candidate.top + input.panelHeight <= input.videoRect.bottom - 48
  );
}

function candidateRect(candidate: Candidate, width: number, height: number): RectLike {
  return {
    left: candidate.left,
    top: candidate.top,
    right: candidate.left + width,
    bottom: candidate.top + height,
    width,
    height,
  };
}

function overlapArea(left: RectLike, right: RectLike): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function rounded(candidate: OverlayPositionResult): OverlayPositionResult {
  return {
    placement: candidate.placement,
    left: Math.round(candidate.left),
    top: Math.round(candidate.top),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
