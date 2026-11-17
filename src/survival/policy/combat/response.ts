import type { Position3 } from "../../../utils/index.js";
export interface HostileThreat {
  readonly id: number;
  readonly name: string;
  readonly position: Position3;
  readonly distance: number;
}

export type EvadeReason = "hurt" | "explosive" | "outmatched" | "unreachable" | "observed_aggression" | "withdraw";

export type HideReason = "hurt" | "cornered";

export type HostileDirective =
  | { readonly kind: "none" }
  | { readonly kind: "constrained"; readonly reason: string }
  | {
      readonly kind: "deflect";
      readonly targetId: number;
      readonly threats: readonly HostileThreat[];
      readonly reason: "incoming_fireball";
    }
  | {
      readonly kind: "fight";
      readonly targetId: number;
      readonly threats: readonly HostileThreat[];
      /**
       * Set only on a defend-only fight admitted because its target is in reach while withdrawal is still open: the
       * target out of reach would have been `evade("withdraw")`, so the fight ends `contact_ended` once the target
       * stays out of reach, even a target (a shooter) that does not itself attack on contact.
       */
      readonly endsOnContactLoss?: true;
    }
  | { readonly kind: "hide"; readonly threats: readonly HostileThreat[]; readonly reason: HideReason }
  | {
      readonly kind: "evade";
      readonly threats: readonly HostileThreat[];
      readonly safeRange: number;
      readonly reason: EvadeReason;
    };

export type HostileResponse = Exclude<HostileDirective, { kind: "none" | "constrained" }>;
