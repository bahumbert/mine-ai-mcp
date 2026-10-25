/** Who asked for routes to start as escapes: the session holds one around a pinned bot's movement action. */
export class EscapeHolds {
  #open = 0;

  get active(): boolean {
    return this.#open > 0;
  }

  /** One hold; releasing it twice releases it once. */
  hold(): Disposable {
    this.#open += 1;
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        this.#open -= 1;
      },
    };
  }
}
