export type AbTestState = "live" | "completed" | "draft" | "archived" | "inactive";

export interface AbTestSummary {
  abTestId: string;
  title: string;
  state: AbTestState;
  placementTitle: string;
}

export interface AbTestDetail extends AbTestSummary {
  /** armId is the flow id that `--winner` expects. */
  arms: { armId: string; name: string }[];
}

declare const approvedBrand: unique symbol;

/** Constructible only by the gate (src/gate/pending.ts, Task 3). */
export type ApprovedStop = {
  readonly [approvedBrand]: true;
  abTestId: string;
  winnerArmId: string;
};
