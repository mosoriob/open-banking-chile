import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import type { BankMovement } from "../types.js";
import {
  buildBilledMovements,
  buildUnbilledMovements,
  dropRepeatedCardMovements,
  unbilledMovementCurrency,
} from "./bchile.js";
import type { ApiMovNoFactur, ApiResumenFacturado, ApiTransaccionFacturada, BchileCardPayload } from "./bchile.js";

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

// ─── currency of a credit-card movement ──────────────────────────

function noFactur(over: Partial<ApiMovNoFactur> = {}): ApiMovNoFactur {
  return {
    origenTransaccion: "NACIONAL",
    fechaTransaccionString: "22-08-2026",
    montoCompra: 37970,
    glosaTransaccion: "MERCADOPAGO *MERC**OL COMPRAS",
    despliegueCuotas: "01/01",
    ...over,
  };
}

function facturada(over: Partial<ApiTransaccionFacturada> = {}): ApiTransaccionFacturada {
  return {
    fechaTransaccionString: "22-08-2026",
    montoTransaccion: 69,
    descripcion: "WM SUPERCENTER #571 COMPRAS INT.MA",
    cuotas: "01/01",
    grupo: "operaciones",
    ...over,
  };
}

function resumen(txs: ApiTransaccionFacturada[]): ApiResumenFacturado {
  return { existeEstadoCuenta: true, seccionOperaciones: { transaccionesTarjetas: txs } };
}

describe("unbilledMovementCurrency", () => {
  it("reads the international line as USD in every spelling", () => {
    for (const origen of ["I", "i", "INT", "int", "INTERNACIONAL", " Internacional "]) {
      expect(unbilledMovementCurrency(origen)).toBe("USD");
    }
  });

  it("reads the national line as CLP", () => {
    for (const origen of ["N", "NACIONAL", "Nacional", "", undefined]) {
      expect(unbilledMovementCurrency(origen)).toBe("CLP");
    }
  });

  it("reads an unknown value as CLP", () => {
    expect(unbilledMovementCurrency("OTRO")).toBe("CLP");
  });
});

describe("buildUnbilledMovements", () => {
  it("marks an international purchase with the currency USD", () => {
    const out = buildUnbilledMovements([noFactur({ origenTransaccion: "INTERNACIONAL", montoCompra: 69, glosaTransaccion: "WM SUPERCENTER #571 COMPRAS INT.MA" })], "****1755");

    expect(out[0].currency).toBe("USD");
    expect(out[0].amount).toBe(-69);
    expect(out[0].card).toBe("****1755");
  });

  it("leaves a national purchase without a currency", () => {
    const out = buildUnbilledMovements([noFactur()], "****1755");

    expect(out[0].currency).toBeUndefined();
    expect(out[0].amount).toBe(-37970);
  });

  it("keeps the two lines apart inside one list", () => {
    const out = buildUnbilledMovements([
      noFactur(),
      noFactur({ origenTransaccion: "I", montoCompra: 2, glosaTransaccion: "CTLP*INREACH COMPRAS INT.MA" }),
    ], "****1755");

    expect(out.map(m => m.currency)).toEqual([undefined, "USD"]);
  });
});

describe("buildBilledMovements", () => {
  it("marks the international statement with the currency USD", () => {
    const out = buildBilledMovements(resumen([facturada()]), "USD", "****1755");

    expect(out[0].currency).toBe("USD");
    expect(out[0].amount).toBe(-69);
  });

  it("leaves the national statement without a currency", () => {
    const out = buildBilledMovements(resumen([facturada({ montoTransaccion: 37970 })]), "CLP", "****1755");

    expect(out[0].currency).toBeUndefined();
  });

  it("drops the subtotal rows", () => {
    const out = buildBilledMovements(resumen([
      facturada({ descripcion: "TOTAL PAGOS A LA CUENTA" }),
      facturada({ descripcion: "DELTA COMPRAS INT.MA" }),
    ]), "USD");

    expect(out.map(m => m.description)).toEqual(["DELTA COMPRAS INT.MA"]);
  });

  it("makes a payment positive and a purchase negative", () => {
    const out = buildBilledMovements(resumen([
      facturada({ grupo: "pagos", montoTransaccion: 500 }),
      facturada({ grupo: "operaciones", montoTransaccion: 230 }),
    ]), "USD");

    expect(out.map(m => m.amount)).toEqual([500, -230]);
  });
});

describe("dropRepeatedCardMovements with two currencies", () => {
  it("keeps two lists that differ only in the currency", () => {
    const usd: BankMovement = { ...mov("DELTA COMPRAS INT.MA", -230, "****1111"), currency: "USD" };
    const clp: BankMovement = mov("DELTA COMPRAS INT.MA", -230, "****2222");

    const out = dropRepeatedCardMovements([payload("A", true, [usd]), payload("B", false, [clp])]);

    expect(out.map(c => c.movements.length)).toEqual([1, 1]);
  });
});
