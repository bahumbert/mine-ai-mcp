/** The facts the chat request states when a flood bound acted (spec 2026-11-18-chat-flood-bounds): the model reads them and chooses the reply. */

/** Tells the chat tier how many requests it holds for `speaker`, and at the cap that a new one cannot be taken on. */
export function speakerOrdersNote(orders: { readonly open: number; readonly max: number }, speaker: string): string {
  const held = `You hold ${orders.open} of ${speaker}'s requests (the most you take from one player is ${orders.max}).`;
  return orders.open >= orders.max ? `${held} A new request from them cannot be taken on until one of these ends: answer it with "talk".` : held;
}

/**
 * The send-back text for an `act` or `later` reply without a trade when the character already holds the most requests
 * it takes from the speaker, else null (a trade is no order; a stop with a request frees the cap first). The agent
 * refuses the order if the model repeats it.
 */
export function orderCapSendBack(route: string, carriesTrade: boolean, orders: { readonly open: number; readonly max: number } | undefined, speaker: string): string | null {
  if ((route !== "act" && route !== "later") || carriesTrade || orders === undefined || orders.open < orders.max) return null;
  return `"${route}" cannot take a new request: you already hold ${orders.open} of ${speaker}'s; answer with "talk"`;
}

/** Tells the chat tier that `count` earlier lines of `speaker` were left out of the message it reads. */
export function unreadLinesNote(count: number, speaker: string): string {
  const one = count === 1;
  return `(${count} earlier ${one ? "line" : "lines"} from ${speaker} ${one ? "was" : "were"} not read: they came faster than you read.)`;
}
