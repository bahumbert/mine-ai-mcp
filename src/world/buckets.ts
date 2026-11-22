/** The bucket items: the empty bucket and each liquid's full one. */
import { EMPTY_BUCKET } from "./empty-bucket.js";
import { LIQUIDS, type LiquidName } from "./liquid.js";

/** The empty bucket's item name: named once in `empty-bucket.ts` (a code-only fact), re-exported here for the runtime. */
export { EMPTY_BUCKET };

/** The item a bucket is: the liquid's full one, or the empty bucket. */
export function bucketItem(liquid: LiquidName, full: boolean): string {
  return full ? `${liquid}_bucket` : EMPTY_BUCKET;
}

/** Every bucket item a bot can carry: the empty bucket, then each liquid's full one. */
export function bucketItems(): readonly string[] {
  return [EMPTY_BUCKET, ...LIQUIDS.map((liquid) => bucketItem(liquid, true))];
}
