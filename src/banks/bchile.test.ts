import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import type { BankMovement } from "../types.js";
import { dropRepeatedCardMovements } from "./bchile.js";
import type { BchileCardPayload } from "./bchile.js";

// ─── dropRepeatedCardMovements ───────────────────────────────────

function mov(description: string, amount: number, card: string, date = "14-09-2026"): BankMovement {
  return { date, description, amount, balance: 0, source: MOVEMENT_SOURCE.credit_card_unbilled, card };
}

function payload(label: string, titular: boolean, movements: BankMovement[]): BchileCardPayload {
  return { label, titular, movements };
}

describe("dropRepeatedCardMovements", () => {
  it("keeps the list on the titular card and clears the additional cards", () => {
    const cards = [
      payload("Mastercard Black ****3058", false, [mov("MERPAGOMERCADOLIBRE", -129544, "****3058")]),
      payload("Mastercard Black ****1755", true, [mov("MERPAGOMERCADOLIBRE", -129544, "****1755")]),
      payload("Mastercard Black ****3082", false, [mov("MERPAGOMERCADOLIBRE", -129544, "****3082")]),
    ];

    const out = dropRepeatedCardMovements(cards);

    expect(out.map(c => c.movements.length)).toEqual([0, 1, 0]);
    expect(out[1].movements[0].card).toBe("****1755");
  });

  it("keeps the list on the same card whatever the order of the answer", () => {
    const cards = [
      payload("Mastercard Black ****3082", true, [mov("MERPAGOMERCADOLIBRE", -129544, "****3082")]),
      payload("Mastercard Black ****1755", true, [mov("MERPAGOMERCADOLIBRE", -129544, "****1755")]),
      payload("Mastercard Black ****3058", true, [mov("MERPAGOMERCADOLIBRE", -129544, "****3058")]),
    ];

    const keeper = (order: BchileCardPayload[]) =>
      dropRepeatedCardMovements(order).find(c => c.movements.length > 0)?.label;

    expect(keeper(cards)).toBe("Mastercard Black ****1755");
    expect(keeper([...cards].reverse())).toBe("Mastercard Black ****1755");
    expect(keeper([cards[1], cards[2], cards[0]])).toBe("Mastercard Black ****1755");
  });

  it("keeps the list on the card with the lowest label when no card is titular", () => {
    const cards = [
      payload("Mastercard ****2222", false, [mov("COPEC APP", -4646, "****2222")]),
      payload("Mastercard ****1111", false, [mov("COPEC APP", -4646, "****1111")]),
    ];

    const out = dropRepeatedCardMovements(cards);

    expect(out.map(c => c.movements.length)).toEqual([0, 1]);
  });

  it("ignores the order of the movements inside each list", () => {
    const a = [mov("COPEC APP", -4646, "****1111"), mov("FUDO", -15400, "****1111")];
    const b = [mov("FUDO", -15400, "****2222"), mov("COPEC APP", -4646, "****2222")];

    const out = dropRepeatedCardMovements([payload("A", false, a), payload("B", false, b)]);

    expect(out.map(c => c.movements.length)).toEqual([2, 0]);
  });

  it("keeps cards that report different movements", () => {
    const cards = [
      payload("Visa ****1111", true, [mov("COPEC APP", -4646, "****1111")]),
      payload("Visa ****2222", false, [mov("FUDO", -15400, "****2222")]),
    ];

    const out = dropRepeatedCardMovements(cards);

    expect(out.map(c => c.movements.length)).toEqual([1, 1]);
  });

  it("keeps a card whose list differs only in the amount", () => {
    const cards = [
      payload("Visa ****1111", true, [mov("COPEC APP", -4646, "****1111")]),
      payload("Visa ****2222", false, [mov("COPEC APP", -4647, "****2222")]),
    ];

    expect(dropRepeatedCardMovements(cards).map(c => c.movements.length)).toEqual([1, 1]);
  });

  it("does not group the empty lists", () => {
    const cards = [
      payload("Visa ****1111", true, []),
      payload("Visa ****2222", false, []),
    ];

    expect(dropRepeatedCardMovements(cards).map(c => c.movements.length)).toEqual([0, 0]);
  });

  it("returns the same objects when nothing repeats", () => {
    const cards = [payload("Visa ****1111", true, [mov("COPEC APP", -4646, "****1111")])];

    expect(dropRepeatedCardMovements(cards)[0]).toBe(cards[0]);
  });

  it("groups two pairs of cards independently", () => {
    const cards = [
      payload("Visa ****1111", false, [mov("COPEC APP", -4646, "****1111")]),
      payload("Visa ****2222", true, [mov("COPEC APP", -4646, "****2222")]),
      payload("Amex ****3333", false, [mov("FUDO", -15400, "****3333")]),
      payload("Amex ****4444", false, [mov("FUDO", -15400, "****4444")]),
    ];

    expect(dropRepeatedCardMovements(cards).map(c => c.movements.length)).toEqual([0, 1, 1, 0]);
  });
});
