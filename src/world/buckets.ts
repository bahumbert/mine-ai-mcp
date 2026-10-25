/** The bucket items: the empty bucket and each liquid's full one. */
import { LIQUIDS, type LiquidName } from "./liquid.js";

/** The empty bucket's item name. A code-only fact: no data file says which item a liquid is carried in. */
export const EMPTY_BUCKET = "bucket";

/** The item a bucket is: the liquid's full one, or the empty bucket. */
export function bucketItem(liquid: LiquidName, full: boolean): string {
  return full ? `${liquid}_bucket` : EMPTY_BUCKET;
}

/** Every bucket item a bot can carry: the empty bucket, then each liquid's full one. */
export function bucketItems(): readonly string[] {
  return [EMPTY_BUCKET, ...LIQUIDS.map((liquid) => bucketItem(liquid, true))];
}
