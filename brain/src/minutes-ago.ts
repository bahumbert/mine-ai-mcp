/** How long ago an ISO time was, in words for the situation the models read (`14 min ago`, `just now`, `3 h ago`). */
export function minutesAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "some time ago";
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
