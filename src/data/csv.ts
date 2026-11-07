import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

export const DEFAULT_DATA_DIR = join(homedir(), "Projects", "adapty-seed-data-hack", "data", "offline");

export interface User {
  userId: string;
  installAt: Date;
  flow: string;
  abTest: string;
  aiEditsFirstDay: number;
}

export interface Txn {
  userId: string;
  purchasedAt: Date;
  priceUsd: number;
  refundedAt: Date | null;
}

export type Dataset = { users: User[]; txns: Txn[]; dataEnd: Date };

/** RFC 4180 parser: quoted fields, "" escapes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function readTable(path: string): Promise<{ col: (name: string) => number; rows: string[][] }> {
  const text = (await gunzipAsync(await readFile(path))).toString("utf8");
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error(`${path} is empty`);
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${path} is missing column "${name}"`);
    return i;
  };
  return { col, rows };
}

function toDate(value: string | undefined, what: string): Date {
  const d = new Date(value ?? "");
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp for ${what}: "${value ?? ""}"`);
  return d;
}

async function load(dir: string): Promise<Dataset> {
  const [u, t] = await Promise.all([
    readTable(join(dir, "users.csv.gz")),
    readTable(join(dir, "transactions.csv.gz")),
  ]);
  const uId = u.col("user_id");
  const uInstall = u.col("install_at");
  const uFlow = u.col("flow");
  const uTest = u.col("ab_test");
  const uEdits = u.col("ai_edits_first_day");
  const users: User[] = u.rows.map((r) => ({
    userId: r[uId] ?? "",
    installAt: toDate(r[uInstall], "install_at"),
    flow: r[uFlow] ?? "",
    abTest: r[uTest] ?? "",
    aiEditsFirstDay: Number(r[uEdits] || 0),
  }));

  const tId = t.col("user_id");
  const tBought = t.col("purchased_at");
  const tPrice = t.col("price_usd");
  const tRefund = t.col("refunded_at");
  let end = 0;
  const txns: Txn[] = t.rows.map((r) => {
    const purchasedAt = toDate(r[tBought], "purchased_at");
    const refundRaw = r[tRefund] ?? "";
    const refundedAt = refundRaw === "" ? null : toDate(refundRaw, "refunded_at");
    end = Math.max(end, purchasedAt.getTime(), refundedAt?.getTime() ?? 0);
    return { userId: r[tId] ?? "", purchasedAt, priceUsd: Number(r[tPrice] || 0), refundedAt };
  });
  return { users, txns, dataEnd: new Date(end) };
}

const cache = new Map<string, Promise<Dataset>>();

export function loadDataset(dir: string = DEFAULT_DATA_DIR): Promise<Dataset> {
  let p = cache.get(dir);
  if (!p) {
    p = load(dir);
    cache.set(dir, p);
    p.catch(() => cache.delete(dir));
  }
  return p;
}
