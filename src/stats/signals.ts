// Read-only signal for the agent: do users who use the AI a lot on day one pay more often?
// "Paid" means net revenue above zero over everything we have for the user (a refunded purchase
// nets to zero, so it does not make someone a payer).

import type { Dataset } from "../data/csv.js";
import { userRevenue } from "./rpi.js";

export interface EditBucket {
  bucket: "0" | "1-4" | "5+";
  n: number;
  payers: number;
  pay_rate: number;
}

export interface AiEditSignal {
  metric: "pay_rate";
  by: "ai_edits_first_day";
  buckets: EditBucket[];
  /** Pay rate of the 5+ bucket divided by the 1-4 bucket. */
  ratio_5plus_vs_1to4: number | null;
  source: "export_csv";
}

const bucketOf = (edits: number): EditBucket["bucket"] => (edits >= 5 ? "5+" : edits >= 1 ? "1-4" : "0");

export function aiEditSignal(data: Dataset): AiEditSignal {
  const revenue = userRevenue(data.users, data.txns, { cutoff: data.dataEnd, horizonDays: null });
  const acc = new Map<EditBucket["bucket"], { n: number; payers: number }>([
    ["0", { n: 0, payers: 0 }],
    ["1-4", { n: 0, payers: 0 }],
    ["5+", { n: 0, payers: 0 }],
  ]);
  for (const u of data.users) {
    const net = revenue.get(u.userId);
    if (net === undefined) continue;
    const b = acc.get(bucketOf(u.aiEditsFirstDay));
    if (!b) continue;
    b.n += 1;
    if (net > 0) b.payers += 1;
  }
  const buckets = [...acc.entries()].map(([bucket, { n, payers }]) => ({
    bucket,
    n,
    payers,
    pay_rate: n === 0 ? 0 : payers / n,
  }));
  const low = buckets.find((b) => b.bucket === "1-4");
  const high = buckets.find((b) => b.bucket === "5+");
  return {
    metric: "pay_rate",
    by: "ai_edits_first_day",
    buckets,
    ratio_5plus_vs_1to4: low && high && low.pay_rate > 0 ? high.pay_rate / low.pay_rate : null,
    source: "export_csv",
  };
}
