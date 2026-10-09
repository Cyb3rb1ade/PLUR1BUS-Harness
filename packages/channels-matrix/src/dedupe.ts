/** Insertion-ordered set with a hard size bound: the oldest entry is evicted first. */
export class BoundedSet<T> {
  readonly #set = new Set<T>();
  readonly #max: number;
  constructor(max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
    this.#max = max;
  }
  has(v: T): boolean {
    return this.#set.has(v);
  }
  add(v: T): void {
    this.#set.delete(v);
    this.#set.add(v);
    if (this.#set.size > this.#max) this.#set.delete(this.#set.values().next().value as T);
  }
  delete(v: T): void {
    this.#set.delete(v);
  }
  get size(): number {
    return this.#set.size;
  }
  clear(): void {
    this.#set.clear();
  }
}
