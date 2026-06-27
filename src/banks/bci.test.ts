import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import type { BankMovement, CreditCardBalance } from "../types.js";
import { normalizeBciApiMovements, assembleBciResult, routeBciCardMovements } from "./bci.js";

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
    expect(out![0].movements.map((m) => m.description)).toEqual(["DECATHLON VINA", "MUBI.COM MUBI"]);
  });

  it("routes each card's movements to its own entry", () => {
    const creditCards: CreditCardBalance[] = [
      { label: "bciplus visa gold - 0043", movements: [cardTx("VISA PURCHASE")] },
      { label: "bciplus mastercard gold - 3725", movements: [cardTx("MASTERCARD PURCHASE")] },
    ];

    const { creditCards: out } = assembleBciResult(0, [], creditCards);

    expect(out).toHaveLength(2);
    expect(out![0].movements.map((m) => m.description)).toEqual(["VISA PURCHASE"]);
    expect(out![1].movements.map((m) => m.description)).toEqual(["MASTERCARD PURCHASE"]);
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
