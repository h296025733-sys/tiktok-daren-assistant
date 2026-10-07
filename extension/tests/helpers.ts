export function mockRect(
  element: Element,
  { left, top, width, height }: { left: number; top: number; width: number; height: number },
): void {
  const rect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

export function mockVideoState(
  video: HTMLVideoElement,
  { paused, readyState, duration }: { paused: boolean; readyState: number; duration: number },
): void {
  Object.defineProperty(video, "paused", { configurable: true, value: paused });
  Object.defineProperty(video, "readyState", { configurable: true, value: readyState });
  Object.defineProperty(video, "duration", { configurable: true, value: duration });
}

