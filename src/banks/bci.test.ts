import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import type { BankMovement, CreditCardBalance } from "../types.js";
import { normalizeBciApiMovements, assembleBciResult, routeBciCardMovements, assignBciCupos, planCupoReads } from "./bci.js";

describe("normalizeBciApiMovements", () => {
  it("returns empty array for empty captures", () => {
    expect(normalizeBciApiMovements([])).toEqual([]);
  });

  it("skips captures without a movimientos array", () => {
    expect(normalizeBciApiMovements([{ other: "data" }])).toEqual([]);
    expect(normalizeBciApiMovements([null])).toEqual([]);
    expect(normalizeBciApiMovements([{}])).toEqual([]);
  });

  it("parses a cargo movement (tipo=C → negative amount)", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-01-15T00:00:00", monto: "15990", tipo: "C", glosa: "Supermercado Lider" },
      ],
    };
    const result = normalizeBciApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-15990);
    expect(result[0].description).toBe("Supermercado Lider");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.account);
    expect(result[0].balance).toBe(0);
  });

  it("parses an abono movement (tipo=A → positive amount)", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-02-10T00:00:00", monto: "500000", tipo: "A", glosa: "Depósito sueldo" },
      ],
    };
    const result = normalizeBciApiMovements([capture]);
    expect(result[0].amount).toBe(500000);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("strips the time portion from fechaMovimiento to produce a date-only string", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-03-22T14:30:00", monto: "1000", tipo: "C", glosa: "Test" },
      ],
    };
    const result = normalizeBciApiMovements([capture]);
    // normalizeDate doesn't handle YYYY-MM-DD (no regex match), passes through as-is
    expect(result[0].date).toBe("2026-03-22");
  });

  it("rounds float amounts to the nearest integer", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-01-01T00:00:00", monto: "1499.9", tipo: "C", glosa: "Float test" },
      ],
    };
    const result = normalizeBciApiMovements([capture]);
    expect(result[0].amount).toBe(-1500);
  });

  it("skips movements with zero or NaN monto", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-01-01T00:00:00", monto: "0", tipo: "C", glosa: "Zero" },
        { fechaMovimiento: "2026-01-01T00:00:00", monto: "abc", tipo: "C", glosa: "NaN" },
      ],
    };
    expect(normalizeBciApiMovements([capture])).toHaveLength(0);
  });

  it("always sets balance to 0 (API does not provide running balance)", () => {
    const capture = {
      movimientos: [
        { fechaMovimiento: "2026-01-01T00:00:00", monto: "5000", tipo: "A", glosa: "Abono" },
      ],
    };
    const result = normalizeBciApiMovements([capture]);
    expect(result[0].balance).toBe(0);
  });

  it("accumulates movements across multiple captures", () => {
    const makeCapture = (glosa: string) => ({
      movimientos: [
        { fechaMovimiento: "2026-01-01T00:00:00", monto: "1000", tipo: "C", glosa },
      ],
    });
    const result = normalizeBciApiMovements([makeCapture("A"), makeCapture("B")]);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.description)).toEqual(["A", "B"]);
  });
});

describe("assembleBciResult", () => {
  const acct = (description: string): BankMovement => ({
    date: "01-06-2026", description, amount: -1000, balance: 0, source: MOVEMENT_SOURCE.account,
  });
  const cardTx = (description: string): BankMovement => ({
    date: "01-06-2026", description, amount: -2000, balance: 0, source: MOVEMENT_SOURCE.credit_card_billed,
  });

  it("keeps credit-card movements out of the checking account", () => {
    const accountMovements = [acct("Giro cajero automatico")];
    const creditCards: CreditCardBalance[] = [
      { label: "bciplus visa gold - 0043", movements: [cardTx("DECATHLON VINA"), cardTx("MUBI.COM MUBI")] },
    ];

    const { accounts, creditCards: out } = assembleBciResult(454969, accountMovements, creditCards);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe(454969);
    expect(accounts[0].movements.map((m) => m.description)).toEqual(["Giro cajero automatico"]);
    // The original bug dumped every card transaction onto the account.
    expect(accounts[0].movements.some((m) => m.source !== MOVEMENT_SOURCE.account)).toBe(false);

    expect(out).toHaveLength(1);
    expect(out![0].movements!.map((m) => m.description)).toEqual(["DECATHLON VINA", "MUBI.COM MUBI"]);
  });

  it("routes each card's movements to its own entry", () => {
    const creditCards: CreditCardBalance[] = [
      { label: "bciplus visa gold - 0043", movements: [cardTx("VISA PURCHASE")] },
      { label: "bciplus mastercard gold - 3725", movements: [cardTx("MASTERCARD PURCHASE")] },
    ];

    const { creditCards: out } = assembleBciResult(0, [], creditCards);

    expect(out).toHaveLength(2);
    expect(out![0].movements!.map((m) => m.description)).toEqual(["VISA PURCHASE"]);
    expect(out![1].movements!.map((m) => m.description)).toEqual(["MASTERCARD PURCHASE"]);
  });

  it("returns undefined creditCards when there are none", () => {
    const { accounts, creditCards: out } = assembleBciResult(0, [acct("x")], []);
    expect(accounts[0].movements).toHaveLength(1);
    expect(out).toBeUndefined();
  });
});

describe("routeBciCardMovements", () => {
  const tagged = (description: string, card: string): BankMovement => ({
    date: "01-06-2026", description, amount: -2000, balance: 0,
    source: MOVEMENT_SOURCE.credit_card_billed, card,
  });
  const cards = (): CreditCardBalance[] => [
    { label: "bciplus visa gold - 0043", movements: [] },
    { label: "bciplus mastercard gold - 3725", movements: [] },
  ];

  it("routes by brand when the card-type column carries the brand", () => {
    const movements = [tagged("VISA TX", "VISA"), tagged("MC TX", "MASTERCARD")];
    const out = routeBciCardMovements(cards(), movements);
    expect(out[0].movements!.map((m) => m.description)).toEqual(["VISA TX"]);
    expect(out[1].movements!.map((m) => m.description)).toEqual(["MC TX"]);
  });

  it("routes by last-4 when the card-type column carries a masked number", () => {
    const movements = [tagged("VISA TX", "**** 0043"), tagged("MC TX", "**** 3725")];
    const out = routeBciCardMovements(cards(), movements);
    expect(out[0].movements!.map((m) => m.description)).toEqual(["VISA TX"]);
    expect(out[1].movements!.map((m) => m.description)).toEqual(["MC TX"]);
  });

  it("does not duplicate a movement onto a non-matching card", () => {
    const movements = [tagged("VISA TX", "VISA")];
    const out = routeBciCardMovements(cards(), movements);
    expect(out[0].movements).toHaveLength(1);
    expect(out[1].movements).toHaveLength(0);
  });

  it("leaves movements unassigned when the tag matches no card", () => {
    const movements = [tagged("MYSTERY", "DINERS")];
    const out = routeBciCardMovements(cards(), movements);
    expect(out[0].movements).toHaveLength(0);
    expect(out[1].movements).toHaveLength(0);
  });
});

describe("assignBciCupos", () => {
  const cards = (): CreditCardBalance[] => [
    { label: "bciplus visa gold - 0043", movements: [] },
    { label: "bciplus mastercard gold - 3725", movements: [] },
  ];

  // Realistic BCI "Cupo disponible" national panel copy. The regular cupo
  // comes first; the Avances (cash-advance) sub-limit follows and must be ignored.
  const natPanel = (total: string, used: string, avail: string) =>
    `Cupo Nacional\nCupo Total $${total}\nUtilizado $${used}\nDisponible $${avail}\n` +
    `Avances\nCupo Total $2.000.000\nUtilizado $1.000.000\nDisponible $1.000.000`;

  const intPanel = (total: string, used: string, avail: string) =>
    `Cupo Internacional\nCupo Total US$${total}\nUtilizado US$${used}\nDisponible US$${avail}`;

  it("binds distinct national cupos to each card by last-4", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "5.909.327", "4.090.673"), internationalText: "" },
      { label: "bciplus mastercard gold - 3725", nationalText: natPanel("1.000.000", "0", "1.000.000"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].national).toEqual({ total: 10000000, used: 5909327, available: 4090673 });
    expect(out[1].national).toEqual({ total: 1000000, used: 0, available: 1000000 });
  });

  it("parses national amounts as whole-peso integers", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "0", "10.000.000"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].national!.total).toBe(10000000);
  });

  it("parses international USD amounts as float dollars (decimal fix)", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: "", internationalText: intPanel("363,68", "0,00", "363,68") },
      { label: "bciplus mastercard gold - 3725", nationalText: "", internationalText: intPanel("1.234,56", "234,56", "1.000,00") },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].international).toEqual({ total: 363.68, used: 0, available: 363.68, currency: "USD" });
    expect(out[1].international).toEqual({ total: 1234.56, used: 234.56, available: 1000, currency: "USD" });
  });

  it("takes the regular cupo, not the Avances sub-limit", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "5.909.327", "4.090.673"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    // Avances values are 2.000.000 / 1.000.000 / 1.000.000 — must not leak in.
    expect(out[0].national).toEqual({ total: 10000000, used: 5909327, available: 4090673 });
  });

  it("binds by last-4 independent of reading order", () => {
    const readings = [
      { label: "bciplus mastercard gold - 3725", nationalText: natPanel("1.000.000", "0", "1.000.000"), internationalText: "" },
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "5.909.327", "4.090.673"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].national!.total).toBe(10000000); // visa card, first in cards()
    expect(out[1].national!.total).toBe(1000000); // mastercard card, second in cards()
  });

  it("leaves a card with no matching reading untouched (never another card's values)", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "5.909.327", "4.090.673"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].national!.total).toBe(10000000);
    expect(out[1].national).toBeUndefined();
    expect(out[1].international).toBeUndefined();
  });

  it("omits national when its total is 0", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: "Cupo Nacional\nNo disponible", internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].national).toBeUndefined();
  });

  it("omits international when its total is 0", () => {
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "0", "10.000.000"), internationalText: "" },
    ];
    const out = assignBciCupos(cards(), readings);
    expect(out[0].international).toBeUndefined();
  });

  it("keeps every card's label and movements intact", () => {
    const withTx: CreditCardBalance[] = [
      { label: "bciplus visa gold - 0043", movements: [{ date: "01-06-2026", description: "TX", amount: -1000, balance: 0, source: MOVEMENT_SOURCE.credit_card_billed }] },
    ];
    const readings = [
      { label: "bciplus visa gold - 0043", nationalText: natPanel("10.000.000", "0", "10.000.000"), internationalText: "" },
    ];
    const out = assignBciCupos(withTx, readings);
    expect(out[0].label).toBe("bciplus visa gold - 0043");
    expect(out[0].movements!.map((m) => m.description)).toEqual(["TX"]);
  });

  it("falls back to exact-label match when no last-4 is present", () => {
    const cardsNoDigits: CreditCardBalance[] = [{ label: "Tarjeta de Crédito", movements: [] }];
    const readings = [
      { label: "Tarjeta de Crédito", nationalText: natPanel("500.000", "100.000", "400.000"), internationalText: "" },
    ];
    const out = assignBciCupos(cardsNoDigits, readings);
    expect(out[0].national).toEqual({ total: 500000, used: 100000, available: 400000 });
  });
});

describe("planCupoReads", () => {
  const opts = () => [
    { value: "v0", label: "bciplus visa gold - 0043" },
    { value: "v1", label: "bciplus mastercard gold - 3725" },
    { value: "v2", label: "bciplus visa platinum - 9988" },
  ];

  it("reads the default-selected card first with no switch", () => {
    const plan = planCupoReads(opts(), 0);
    expect(plan[0]).toEqual({ value: "v0", label: "bciplus visa gold - 0043", needsSwitch: false });
  });

  it("switches to every non-default card after the default", () => {
    const plan = planCupoReads(opts(), 0);
    expect(plan.map((s) => s.value)).toEqual(["v0", "v1", "v2"]);
    expect(plan.map((s) => s.needsSwitch)).toEqual([false, true, true]);
  });

  it("puts the selected card first even when it is not the first option", () => {
    const plan = planCupoReads(opts(), 1);
    expect(plan.map((s) => s.value)).toEqual(["v1", "v0", "v2"]);
    expect(plan.map((s) => s.needsSwitch)).toEqual([false, true, true]);
  });

  it("treats an out-of-range selectedIndex as the first option being default", () => {
    const plan = planCupoReads(opts(), -1);
    expect(plan.map((s) => s.value)).toEqual(["v0", "v1", "v2"]);
    expect(plan[0].needsSwitch).toBe(false);
  });

  it("returns an empty plan when there are no options (no dropdown)", () => {
    expect(planCupoReads([], 0)).toEqual([]);
  });

  it("returns a single no-switch read for a single-card account", () => {
    const single = [{ value: "v0", label: "Tarjeta de Crédito" }];
    expect(planCupoReads(single, 0)).toEqual([{ value: "v0", label: "Tarjeta de Crédito", needsSwitch: false }]);
  });
});
