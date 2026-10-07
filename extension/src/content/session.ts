import type { Snapshot } from "../types/snapshot";

export class ActiveVideoSession {
  private activeKey: string | null = null;
  private lastNonNullKey: string | null = null;
  private cached: Snapshot | null = null;
  private switches = 0;

  observe(key: string | null): boolean {
    if (this.activeKey === key) return false;
    this.activeKey = key;
    this.cached = null;
    if (key !== null && this.lastNonNullKey !== null && key !== this.lastNonNullKey) {
      this.switches += 1;
    }
    if (key !== null) this.lastNonNullKey = key;
    return true;
  }

  store(key: string | null, snapshot: Snapshot): void {
    if (this.activeKey === key) this.cached = snapshot;
  }

  get(key: string | null, pageUrl: string): Snapshot | null {
    return this.activeKey === key && this.cached?.page_url === pageUrl ? this.cached : null;
  }

  get switchCount(): number {
    return this.switches;
  }

  get currentKey(): string | null {
    return this.activeKey;
  }
}
