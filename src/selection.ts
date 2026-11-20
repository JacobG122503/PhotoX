import type { Photo } from './data';

type Listener = () => void;

/** The photos at the spot you clicked, and which one of them is showing. */
class Selection {
  group: Photo[] = [];
  index = 0;
  private listeners = new Set<Listener>();

  get current(): Photo | null {
    return this.group[this.index] ?? null;
  }

  set(group: Photo[], index = 0) {
    this.group = group;
    this.index = Math.max(0, Math.min(index, group.length - 1));
    this.emit();
  }

  go(index: number) {
    if (!this.group.length) return;
    this.index = ((index % this.group.length) + this.group.length) % this.group.length;
    this.emit();
  }

  step(d: number) {
    this.go(this.index + d);
  }

  clear() {
    this.group = [];
    this.index = 0;
    this.emit();
  }

  on(l: Listener) {
    this.listeners.add(l);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const sel = new Selection();
