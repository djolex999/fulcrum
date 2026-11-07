import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, loadDataset } from "../../src/data/csv.js";

const USERS_HEADER =
  "user_id,platform,country,device,os,locale,install_at,acquisition_channel,onboarding_goal,ai_edits_first_day,photos_imported,push_opt_in,app_version,placement,flow,ab_test";
const TXN_HEADER =
  "user_id,seq,purchase_type,product,store_product_id,purchased_at,expires_at,originally_purchased_at,price_local,currency,price_usd,offer,renew_status,renew_status_changed_at,billing_issue_detected_at,refunded_at,cancellation_reason";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("loadDataset", () => {
  it("parses quoted fields", async () => {
    dir = mkdtempSync(join(tmpdir(), "fulcrum-csv-"));
    const users = [
      USERS_HEADER,
      'u1,ios,US,iPhone,17,en,2026-08-04T07:40:23Z,organic,"edit, share",1.0,10,true,1.0,onboarding,onb_trial,"Onboarding: annual trial vs weekly first"',
      'u2,ios,DE,iPhone,17,de,2026-08-05T10:00:00Z,ads,fun,3,5,false,1.0,onboarding,onb_weekly,"Onboarding: annual trial vs weekly first"',
      'u3,android,FR,Pixel,15,fr,2026-09-01T00:00:00Z,ads,"say ""hi""",0,0,true,1.0,settings,main_lifetime,Settings test',
    ].join("\n");
    const txns = [
      TXN_HEADER,
      'u1,1,trial,"Annual, promo",sku1,2026-08-05T07:40:23Z,2026-08-12T07:40:23Z,2026-08-05T07:40:23Z,49.99,USD,49.99,,on,,,,',
      "u2,1,paid,Weekly,sku2,2026-08-06T10:00:00Z,2026-08-13T10:00:00Z,2026-08-06T10:00:00Z,4.99,USD,4.99,,off,,,2026-11-03T12:00:00Z,refund",
    ].join("\n");
    writeFileSync(join(dir, "users.csv.gz"), gzipSync(users));
    writeFileSync(join(dir, "transactions.csv.gz"), gzipSync(txns));

    const ds = await loadDataset(dir);
    expect(ds.users).toHaveLength(3);
    expect(ds.users[0]).toEqual({
      userId: "u1",
      installAt: new Date("2026-08-04T07:40:23Z"),
      flow: "onb_trial",
      abTest: "Onboarding: annual trial vs weekly first",
      aiEditsFirstDay: 1,
    });
    expect(ds.users[2]?.abTest).toBe("Settings test");
    expect(ds.txns).toHaveLength(2);
    expect(ds.txns[0]).toEqual({
      userId: "u1",
      purchasedAt: new Date("2026-08-05T07:40:23Z"),
      priceUsd: 49.99,
      refundedAt: null,
    });
    expect(ds.txns[1]?.refundedAt).toEqual(new Date("2026-11-03T12:00:00Z"));
    expect(ds.dataEnd).toEqual(new Date("2026-11-03T12:00:00Z"));
    expect(await loadDataset(dir)).toBe(ds);
  });

  it.skipIf(!existsSync(join(DEFAULT_DATA_DIR, "users.csv.gz")))("real dataset counts", async () => {
    const t0 = performance.now();
    const ds = await loadDataset();
    const ms = performance.now() - t0;
    const count = (test: string, flow: string): number =>
      ds.users.filter((u) => u.abTest.startsWith(test) && u.flow === flow).length;
    expect(count("Onboarding", "onb_trial")).toBe(13771);
    expect(count("Onboarding", "onb_weekly")).toBe(13798);
    expect(count("Settings", "settings")).toBe(1785);
    expect(count("Settings", "main_lifetime")).toBe(1722);
    expect(ds.dataEnd.toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(ms).toBeLessThan(5000);
  });
});
