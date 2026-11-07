export type AbTestState = "live" | "completed" | "draft" | "archived" | "inactive";

export interface AbTestSummary {
  abTestId: string;
  title: string;
  state: AbTestState;
  placementTitle: string;
  /** The placement id; live-test policy matches on this, never on the title. Absent only in fakes. */
  placementId?: string;
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

export type Audience = "all" | { segmentId: string };

/** Constructible only by the proposal queue (src/gate/proposals.ts), after a human approved a proposed test. */
export type ApprovedCreate = {
  readonly [approvedBrand]: true;
  placementId: string;
  /** Two arms: the control first, the challenger second. Weights add up to 100. */
  flows: [{ flowId: string; weight: number; title: string }, { flowId: string; weight: number; title: string }];
  audience: Audience;
  title: string;
  goal: string;
};

export interface Placement {
  id: string;
  /** The name the code uses, e.g. "ai_limit_reached". Policy allows placements by this. */
  developerId: string;
  title: string;
}

export interface Flow {
  id: string;
  name: string;
  status: string;
}
