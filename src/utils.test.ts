import { describe, it, expect, vi } from "vitest";
import {
  DebugLog,
  deduplicateMovements,
  dropDuplicateInterestLines,
  normalizeDate,
} from "./utils.js";
import { MOVEMENT_SOURCE } from "./types.js";
import type { BankMovement } from "./types.js";

// ─── DebugLog ────────────────────────────────────────────────────

describe("DebugLog", () => {
  it("behaves as a regular array when no callback is given", () => {
    const log = new DebugLog();
    log.push("line 1");
    log.push("line 2");
    expect(log).toEqual(["line 1", "line 2"]);
    expect(log.length).toBe(2);
  });

  it("calls onDebug for each pushed item", () => {
    const onDebug = vi.fn();
    const log = new DebugLog(onDebug);
    log.push("a");
    log.push("b");
    expect(onDebug).toHaveBeenCalledTimes(2);
    expect(onDebug).toHaveBeenNthCalledWith(1, "a");
    expect(onDebug).toHaveBeenNthCalledWith(2, "b");
  });

  it("calls onDebug for each item in a multi-argument push", () => {
    const onDebug = vi.fn();
    const log = new DebugLog(onDebug);
    log.push("x", "y", "z");
    expect(onDebug).toHaveBeenCalledTimes(3);
    // Array.from avoids comparison quirks with Array subclasses
    expect(Array.from(log)).toEqual(["x", "y", "z"]);
  });

  it("stores items in the array regardless of callback", () => {
    const onDebug = vi.fn();
    const log = new DebugLog(onDebug);
    log.push("stored");
    expect(log[0]).toBe("stored");
    expect([...log]).toEqual(["stored"]);
  });

  it("join() works as a plain string array", () => {
    const log = new DebugLog();
    log.push("step 1");
    log.push("step 2");
    expect(log.join("\n")).toBe("step 1\nstep 2");
  });
});

// ─── normalizeDate ───────────────────────────────────────────────

describe("normalizeDate", () => {
  it("converts ISO yyyy-mm-dd to dd-mm-yyyy (BCI checking API source)", () => {
    // The BCI checking-account API returns ISO dates; every other source
    // scrapes dd/mm/yyyy. Without this branch, ISO passed through unchanged
    // and consumers reading [day, month, year] = date.split("-") got 1906.
    expect(normalizeDate("2026-06-29")).toBe("29-06-2026");
  });

  it("still normalizes scraped dd/mm/yyyy (credit-card source)", () => {
    expect(normalizeDate("29/06/2026")).toBe("29-06-2026");
  });

  it("leaves an already-normalized dd-mm-yyyy date unchanged", () => {
    // ISO branch must not hijack dd-mm-yyyy: the year is last here, not first.
    expect(normalizeDate("29-06-2026")).toBe("29-06-2026");
  });
});

// ─── deduplicateMovements ────────────────────────────────────────

function movement(overrides: Partial<BankMovement> = {}): BankMovement {
  return {
    date: "01-01-2026",
    description: "Pago supermercado",
    amount: -15000,
    balance: 100000,
    source: MOVEMENT_SOURCE.account,
    ...overrides,
  };
}

describe("deduplicateMovements", () => {
  it("removes exact duplicates from HTML-scraped movements (balance > 0)", () => {
    const m = movement({ balance: 100000 });
    const result = deduplicateMovements([m, m, m]);
    expect(result).toHaveLength(1);
  });

  it("keeps all API-sourced movements with balance=0, even if identical", () => {
    // Two identical toll charges on the same day are both real transactions
    const m = movement({ balance: 0, description: "Peaje autopista", amount: -1800 });
    const result = deduplicateMovements([m, m]);
    expect(result).toHaveLength(2);
  });

  it("does not deduplicate when amount differs", () => {
    const a = movement({ amount: -1000, balance: 99000 });
    const b = movement({ amount: -2000, balance: 97000 });
    expect(deduplicateMovements([a, b])).toHaveLength(2);
  });

  it("does not deduplicate when date differs", () => {
    const a = movement({ date: "01-01-2026", balance: 99000 });
    const b = movement({ date: "02-01-2026", balance: 98000 });
    expect(deduplicateMovements([a, b])).toHaveLength(2);
  });

  it("does not deduplicate when description differs", () => {
    const a = movement({ description: "Comercio A", balance: 99000 });
    const b = movement({ description: "Comercio B", balance: 99000 });
    expect(deduplicateMovements([a, b])).toHaveLength(2);
  });

  it("deduplicates movements from paginated HTML (same balance key)", () => {
    // When the same page is fetched twice, the balance is identical
    const m = movement({ balance: 87500 });
    expect(deduplicateMovements([m, m])).toHaveLength(1);
  });

  it("keeps legitimately repeated transactions with different balances", () => {
    // Two coffees at $3000 each produce different running balances
    const first = movement({ description: "Café", amount: -3000, balance: 97000 });
    const second = movement({ description: "Café", amount: -3000, balance: 94000 });
    expect(deduplicateMovements([first, second])).toHaveLength(2);
  });

  it("handles an empty array", () => {
    expect(deduplicateMovements([])).toEqual([]);
  });

  it("preserves order of first occurrences", () => {
    const a = movement({ description: "A", balance: 100 });
    const b = movement({ description: "B", balance: 200 });
    const result = deduplicateMovements([a, b, a]);
    expect(result.map((m) => m.description)).toEqual(["A", "B"]);
  });
});

// ─── dropDuplicateInterestLines ──────────────────────────────────

// A credit-card line (API-sourced: balance 0). Installment purchases arrive as
// two rows with the same date+amount — the real purchase and a "tasa int." sub-line.
function ccLine(date: string, description: string, amount: number): BankMovement {
  return {
    date,
    description,
    amount,
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_billed,
  };
}

describe("dropDuplicateInterestLines", () => {
  it("(a) drops a 0% 'tasa int.' line that has a matching purchase pair", () => {
    const result = dropDuplicateInterestLines([
      ccLine("12-06-2026", "Haulmer*vmv servici     san cc 02-03", -79667),
      ccLine("12-06-2026", "Haulmer*vmv servici     tasa int.  0,00%", -79667),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toContain("san cc 02-03");
  });

  it("(b) drops a >0% 'tasa int.' line too — the rate value is irrelevant, only the pair matters", () => {
    const result = dropDuplicateInterestLines([
      ccLine("10-01-2026", "Tienda X              san cc 01-03", -50000),
      ccLine("10-01-2026", "Tienda X              tasa int.  2,50%", -50000),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toContain("san cc 01-03");
  });

  it("(c) conserves a 'tasa int.' line with no purchase pair — it is the only record of that spend", () => {
    // Real BCI rows (id 463/464): standalone 0% installments, no matching purchase.
    const result = dropDuplicateInterestLines([
      ccLine("17-01-2026", "Mp     *kitchen cen     tasa int.  0,00%", -9165),
      ccLine("06-10-2025", "Mercado pago 4 tcom     tasa int.  0,00%", -13332),
    ]);
    expect(result).toHaveLength(2);
  });

  it("(d) conserves a 'tasa int.' line whose same date+amount sibling is a different merchant", () => {
    const result = dropDuplicateInterestLines([
      ccLine("30-03-2026", "Starbucks            san cc 01-03", -13165),
      ccLine("30-03-2026", "Apple.com cl apple      tasa int.  2,50%", -13165),
    ]);
    expect(result).toHaveLength(2);
  });

  it("(e) is installment-code-agnostic — pairs across mel cf / las cf, not just san cc", () => {
    const result = dropDuplicateInterestLines([
      ccLine("24-03-2026", "Muni de melipilla m mel cf 03-03", -42327),
      ccLine("24-03-2026", "Muni de melipilla m     tasa int.  0,00%", -42327),
      ccLine("08-05-2026", "Mercadopago*grylan  las cf 02-03", -47997),
      ccLine("08-05-2026", "Mercadopago*grylan      tasa int.  0,00%", -47997),
    ]);
    expect(result.map((m) => m.description)).toEqual([
      "Muni de melipilla m mel cf 03-03",
      "Mercadopago*grylan  las cf 02-03",
    ]);
  });

  it("keeps a legitimate 'tasa'-but-not-'tasa int.' charge (stamp tax) even with a same date+amount pair", () => {
    // The DL 3475 stamp tax contains "tasa" but not "tasa int." — it is a real charge.
    const result = dropDuplicateInterestLines([
      ccLine("19-06-2026", "Compra                san cc 01-03", -1621),
      ccLine("19-06-2026", "Impuesto decreto ley 3475 tasa 0,066 %", -1621),
    ]);
    expect(result).toHaveLength(2);
  });

  it("does not blanket-match a bare 'tasa int.' line with no merchant prefix", () => {
    // Guard: bareMerchant("tasa int. 0%") is empty; startsWith("") matches everything,
    // so an unqualified interest line must be conserved, never paired to an arbitrary row.
    const result = dropDuplicateInterestLines([
      ccLine("01-01-2026", "Farmacia Ahumada", -5000),
      ccLine("01-01-2026", "tasa int.  0,00%", -5000),
    ]);
    expect(result).toHaveLength(2);
  });

  it("(e/regression) reproduces the real BCI cartola verdict: 13 duplicates dropped, 2 standalones kept", () => {
    // date, purchase description | amount — the 13 verifiable installment pairs.
    const pairs: Array<[string, string, number]> = [
      ["16-03-2026", "Decathlon           san cf 04-06", -34000],
      ["24-03-2026", "Muni de melipilla m mel cf 03-03", -42327],
      ["28-03-2026", "Municipalidad de pe san cf 03-03", -63656],
      ["30-03-2026", "Apple.com cl apple  las cc 04-06", -69165],
      ["30-03-2026", "Apple.com cl apple  las cc 04-06", -13165],
      ["30-03-2026", "Apple.com cl apple  las cc 04-06", -10998],
      ["08-05-2026", "Flow   *e-certchile san cf 02-03", -10309],
      ["08-05-2026", "Mercadopago*grylan  las cf 02-03", -47997],
      ["29-05-2026", "Dib                 san cc 02-06", -85179],
      ["02-06-2026", "Lg electronics      san cc 02-06", -69330],
      ["12-06-2026", "Haulmer*vmv servici san cc 02-03", -79667],
      ["13-06-2026", "Haulmer*vmv servici san cc 02-03", -48720],
      ["15-06-2026", "Haulmer*vmv servici san cc 02-03", -69307],
    ];
    const merchantOf = (purchaseDesc: string) => purchaseDesc.split(/\s{2,}/)[0];
    const input: BankMovement[] = [];
    for (const [date, purchase, amount] of pairs) {
      input.push(ccLine(date, purchase, amount));
      input.push(ccLine(date, `${merchantOf(purchase)}     tasa int.  0,00%`, amount));
    }
    // Two standalone interest lines with no purchase pair.
    input.push(ccLine("17-01-2026", "Mp     *kitchen cen     tasa int.  0,00%", -9165));
    input.push(ccLine("06-10-2025", "Mercado pago 4 tcom     tasa int.  0,00%", -13332));

    const result = dropDuplicateInterestLines(input);

    // 13 interest duplicates dropped; 13 purchases + 2 standalone interest lines survive.
    expect(result).toHaveLength(15);
    const interestSurvivors = result.filter((m) => /tasa\s+int/i.test(m.description));
    expect(interestSurvivors).toHaveLength(2);
    expect(interestSurvivors.map((m) => m.description).sort()).toEqual([
      "Mercado pago 4 tcom     tasa int.  0,00%",
      "Mp     *kitchen cen     tasa int.  0,00%",
    ]);
  });
});
