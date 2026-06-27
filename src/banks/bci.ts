import type { Page, Frame } from "puppeteer-core";
import type { AccountBalance, BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE, type MovementSource } from "../types.js";
import { closePopups, delay, formatRut, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { detectLoginError } from "../actions/login.js";
import { createInterceptor } from "../intercept.js";

// ─── BCI-specific constants ──────────────────────────────────────

const LOGIN_URL = "https://www.bci.cl/corporativo/banco-en-linea/personas";

const BCI_CHECKING_API_PREFIX =
  "https://apilocal.bci.cl/bci-produccion/api-bci/bff-saldosyultimosmovimientoswebpersonas";

// ─── API response normalizers ────────────────────────────────────

interface BciApiMovement {
  fechaMovimiento: string;
  monto: string;
  tipo: string; // 'C' = cargo (debit), 'A' = abono (credit)
  glosa: string;
}

export function normalizeBciApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { movimientos?: BciApiMovement[] };
    const list = obj?.movimientos;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const raw = Math.round(parseFloat(m.monto));
      if (!raw || isNaN(raw)) continue;
      const amount = m.tipo === "C" ? -raw : raw;
      const dateStr = m.fechaMovimiento?.split("T")[0] ?? "";
      movements.push({
        date: normalizeDate(dateStr),
        description: m.glosa ?? "",
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.account,
      });
    }
  }
  return movements;
}

const IFRAME_PATTERNS = {
  content: ["miBanco.jsf", "vistaSupercartola"],
  movements: "fe-saldosultimosmov",
  tcMovements: "fe-mismovimientos",
  tcCupo: "vistaSaldosTDC.jsf",
} as const;

const TWO_FACTOR_CONFIG = {
  keywords: ["bci pass", "segundo factor", "aprobación en tu app", "autorizar en tu app", "confirmar en tu app"],
  timeoutEnvVar: "BCI_2FA_TIMEOUT_SEC",
};

const TC_COMBINATIONS = [
  { tab: "Nacional $", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Nacional $", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
  { tab: "Internacional USD", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Internacional USD", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
];

const NEXT_PAGE_TEXTS = ["navigate_next", "siguiente"];
const ACCOUNT_SELECT = "bci-wk-select#cuenta select, select";

// ─── BCI-specific helpers ────────────────────────────────────────

async function clickByTitle(page: Page, title: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const link = document.querySelector(`a[title="${t}"]`) as HTMLElement | null;
    if (link) { link.click(); return true; }
    return false;
  }, title);
}

async function waitForFrame(page: Page, urlPattern: string, timeoutMs = 10000): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find((f) => f.url().includes(urlPattern));
    if (frame) return frame;
    await delay(500);
  }
  return null;
}

async function bciLogin(
  page: Page, rut: string, password: string, debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to BCI login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  debugLog.push("2. Filling RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  const rutBody = cleanRut.slice(0, -1);
  const rutDv = cleanRut.slice(-1);
  const filled = await page.evaluate((formatted: string, body: string, dv: string) => {
    const rutAux = document.getElementById("rut_aux") as HTMLInputElement | null;
    const rutHidden = document.getElementById("rut") as HTMLInputElement | null;
    const digHidden = document.getElementById("dig") as HTMLInputElement | null;
    if (!rutAux) return false;
    rutAux.value = formatted;
    rutAux.dispatchEvent(new Event("input", { bubbles: true }));
    rutAux.dispatchEvent(new Event("change", { bubbles: true }));
    rutAux.dispatchEvent(new Event("blur", { bubbles: true }));
    if (rutHidden) rutHidden.value = body;
    if (digHidden) digHidden.value = dv;
    return true;
  }, formatRut(rut), rutBody, rutDv);
  if (!filled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de RUT no encontrado.", screenshot: ss as string };
  }

  debugLog.push("  Filling password...");
  const passFilled = await page.evaluate((pass: string) => {
    const clave = document.getElementById("clave") as HTMLInputElement | null;
    if (!clave) return false;
    clave.value = pass;
    clave.dispatchEvent(new Event("input", { bubbles: true }));
    clave.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, password);
  if (!passFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de clave no encontrado.", screenshot: ss as string };
  }

  await delay(500);
  debugLog.push("3. Submitting login...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const form = document.getElementById("frm") as HTMLFormElement | null;
    if (form) form.submit();
    else if (btn) btn.click();
  });
  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(page, "03-post-login");

  // 2FA
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    await doSave(page, "03b-2fa-challenge");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando BCI Pass.", screenshot: ss as string };
    }
    await delay(3000);
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error del banco: ${loginError}`, screenshot: ss as string };
  }

  if (page.url().includes("banco-en-linea/personas")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login no navegó fuera de la página.", screenshot: ss as string };
  }

  debugLog.push("4. Login OK!");
  return { success: true };
}

async function extractMovementsFromFrame(frame: Frame, debugLog: string[]): Promise<BankMovement[]> {
  await frame.evaluate(() => {
    for (const opt of document.querySelectorAll("a, button, span, option")) {
      if ((opt as HTMLElement).innerText?.trim() === "50") { (opt as HTMLElement).click(); return; }
    }
  });
  await delay(3000);

  const all: BankMovement[] = [];
  for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
    const raw = await frame.evaluate(() => {
      const results: Array<{ date: string; description: string; cargo: string; abono: string }> = [];
      for (const row of Array.from(document.querySelectorAll("table tbody tr"))) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 4) continue;
        const date = cells[0].textContent?.trim() || "";
        if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date)) continue;
        results.push({ date, description: cells[1].textContent?.trim() || "", cargo: cells[2].textContent?.trim() || "", abono: cells[3].textContent?.trim() || "" });
      }
      return results;
    });
    for (const r of raw) {
      const cargoAmount = r.cargo ? parseChileanAmount(r.cargo) : 0;
      const abonoAmount = r.abono ? parseChileanAmount(r.abono) : 0;
      const amount = cargoAmount > 0 ? -cargoAmount : abonoAmount;
      if (amount === 0) continue;
      all.push({ date: normalizeDate(r.date), description: r.description, amount, balance: 0, source: MOVEMENT_SOURCE.account });
    }
    debugLog.push(`  Page ${pageIndex + 1}: ${raw.length} raw movements`);

    const hasNext = await frame.evaluate((nextTexts: string[]) => {
      for (const btn of document.querySelectorAll("button, a")) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (nextTexts.some((t) => text === t || text.includes(t))) {
          if ((btn as HTMLButtonElement).disabled || btn.getAttribute("aria-disabled") === "true") return false;
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, [...NEXT_PAGE_TEXTS]);
    if (!hasNext) break;
    await delay(3000);
  }
  return all;
}

// ─── extractTCMovements — versión corregida ──────────────────────────────────
async function extractTCMovements(
  frame: Frame,
  tab: string,
  billingType: string,
  source: MovementSource,
  debugLog: string[],
): Promise<BankMovement[]> {

  // ── FASE 1: Seleccionar pestaña (Nacional $ / Internacional USD) ────────────
  await frame.evaluate((tabName: string) => {
    for (const el of document.querySelectorAll(".listTab span, .bci-wk-tab span, .listTab a span")) {
      if ((el as HTMLElement).textContent?.trim() === tabName) {
        const anchor = el.closest("a") as HTMLElement | null;
        if (anchor) { anchor.click(); return; }
      }
    }
  }, tab);
  await delay(2500);

  // ── FASE 2: Seleccionar tipo de facturación ─────────────────────────────────
  await frame.evaluate((btnText: string) => {
    for (const btn of document.querySelectorAll("button.btn_blue_border, button")) {
      if ((btn as HTMLElement).textContent?.trim() === btnText) {
        (btn as HTMLElement).click();
        return;
      }
    }
  }, billingType);
  await delay(2500);

  // ── Verificar si hay movimientos ────────────────────────────────────────────
  const hasNoMovements = await frame.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    return text.includes("no tienes movimientos") || text.includes("sin movimientos");
  });
  if (hasNoMovements) {
    debugLog.push(`    ${tab} / ${billingType}: sin movimientos`);
    return [];
  }

  // ── FASE 3: Paginación robusta ───────────────────────────────────────────────
  const allMovements: BankMovement[] = [];

  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {

    // Estructura real de la tabla (5 columnas):
    //   td[0]  fecha
    //   td[1]  descripción + opcional .cont-circle
    //   td[2]  tipo de tarjeta — identifica a qué tarjeta pertenece la fila
    //   td[3]  div.container_monto > p (monto) + img (alt="Cargo"|"Abono")
    //   td[4]  flecha de detalle  ← ignorar
    const rawRows = await frame.evaluate(() => {
      const results: Array<{
        date: string;
        description: string;
        cardType: string;
        rawAmount: string;
        isCargo: boolean;
        pendingConfirmation: boolean;
      }> = [];

      const rows = document.querySelectorAll("table.custom-table tbody tr, .wrapper-table table tbody tr");

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;

        const date = cells[0]?.textContent?.trim() ?? "";
        if (!date || !/\d/.test(date)) continue;

        const descP = cells[1]?.querySelector("p.customRow, p:first-child") as HTMLElement | null;
        const description = descP?.textContent?.trim() ?? cells[1]?.textContent?.trim() ?? "";

        const pendingConfirmation = !!cells[1]?.querySelector(".cont-circle");

        const cardType = cells[2]?.textContent?.trim() ?? "";

        const montoCell = cells[3];
        const montoP = montoCell?.querySelector(".container_monto p, p") as HTMLElement | null;
        const rawAmount = montoP?.textContent?.trim() ?? "";

        const img = montoCell?.querySelector("img") as HTMLImageElement | null;
        const isCargo = (img?.getAttribute("alt") ?? "").toLowerCase() === "cargo";

        if (!rawAmount) continue;

        results.push({ date, description, cardType, rawAmount, isCargo, pendingConfirmation });
      }
      return results;
    });

    debugLog.push(`    ${tab}/${billingType} página ${pageIndex + 1}: ${rawRows.length} filas`);
    const distinctCardTypes = [...new Set(rawRows.map((r) => r.cardType).filter(Boolean))];
    if (distinctCardTypes.length) {
      debugLog.push(`    ${tab}/${billingType} columna tipo-tarjeta: ${JSON.stringify(distinctCardTypes)}`);
    }

    for (const r of rawRows) {
      const absAmount = parseChileanAmount(r.rawAmount);
      if (absAmount === 0) continue;

      allMovements.push({
        date: normalizeDate(r.date),
        description: r.description,
        amount: r.isCargo ? -absAmount : absAmount,
        balance: 0,
        source,
        card: r.cardType || undefined,
      });
    }

    // Verificar si hay página siguiente
    const canAdvance = await frame.evaluate(() => {
      const btn = document.getElementById("btn-next");
      if (!btn) return false;
      return (
        !btn.classList.contains("disable") &&
        btn.getAttribute("aria-disabled") !== "true" &&
        !(btn as HTMLButtonElement).disabled
      );
    });

    if (!canAdvance) break;

    // frame.click() simula evento real del mouse; Angular ignora el .click()
    // nativo de JS lanzado desde evaluate().
    try {
      await frame.click("#btn-next");
    } catch {
      break;
    }

    // Esperar que la tabla cambie antes de leer la siguiente página
    const lastRow = rawRows[rawRows.length - 1];
    const pageSignature =
      (rawRows[0]?.date ?? "") +
      (rawRows[0]?.rawAmount ?? "") +
      (lastRow?.date ?? "") +
      (lastRow?.rawAmount ?? "");

    const changed = await waitForTableChange(frame, pageSignature, 8000);
    if (!changed) break;
  }

  debugLog.push(`    ${tab} / ${billingType}: ${allMovements.length} movimientos totales`);
  return allMovements;
}

async function waitForTableChange(
  frame: Frame,
  previousSignature: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentSignature = await frame.evaluate(() => {
      const rows = document.querySelectorAll("table.custom-table tbody tr, .wrapper-table table tbody tr");
      if (rows.length === 0) return "";
      const first = rows[0].querySelectorAll("td");
      const last  = rows[rows.length - 1].querySelectorAll("td");
      return (
        (first[0]?.textContent?.trim() ?? "") +
        (first[3]?.querySelector("p")?.textContent?.trim() ?? "") +
        (last[0]?.textContent?.trim() ?? "") +
        (last[3]?.querySelector("p")?.textContent?.trim() ?? "")
      );
    });

    if (currentSignature && currentSignature !== previousSignature) return true;
    await delay(400);
  }
  return false;
}

// ─── Cupo dropdown switching (browser-driven, no testable branching) ──

const CUPO_NATIONAL_PANEL = "tarjetasGeneral:saldosNac";
const CUPO_INTERNATIONAL_PANEL = "tarjetasGeneral:infoSaldosInternacional";

/** innerText of the national cupo panel, used as the change-poll snapshot signal. */
async function readCupoNationalText(frame: Frame): Promise<string> {
  return frame.evaluate((id: string) => {
    const el = document.getElementById(id) as HTMLElement | null;
    return el?.innerText ?? "";
  }, CUPO_NATIONAL_PANEL);
}

/**
 * After a card switch, poll the national cupo panel until its text differs from the
 * pre-switch snapshot (the AJAX partial-response has been applied), or the timeout
 * elapses — after which the response has certainly landed, so the read is still
 * correct even when two cards happen to share an identical national cupo.
 */
async function waitForCupoPanelChange(
  frame: Frame,
  previousText: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await readCupoNationalText(frame);
    if (current && current !== previousText) return true;
    await delay(400);
  }
  return false;
}

/** Read one card's raw cupo reading (label + both panel texts) from the displayed frame. */
async function readCupoReading(frame: Frame): Promise<BciCupoReading> {
  return frame.evaluate(
    (natId: string, intId: string) => {
      const select =
        (document.querySelector('select[name="tarjetasGeneral:select_cuenta"]') as HTMLSelectElement | null) ??
        (Array.from(document.querySelectorAll("select")).find((s) =>
          Array.from(s.options).some((o) => /bciplus|visa|mastercard|\d{4}/i.test(o.textContent || "")),
        ) ?? null);
      const label =
        select?.options[select.selectedIndex]?.textContent?.trim() ||
        select?.options[0]?.textContent?.trim() ||
        "";
      const panelText = (id: string) => {
        const el = document.getElementById(id) as HTMLElement | null;
        return el?.innerText ?? "";
      };
      const nationalText = panelText(natId) || (document.body?.innerText || "");
      const internationalText = panelText(intId) || (document.body?.innerText || "");
      return { label, nationalText, internationalText };
    },
    CUPO_NATIONAL_PANEL,
    CUPO_INTERNATIONAL_PANEL,
  );
}

/**
 * Enumerate the cupo frame's OWN card dropdown (not the separately-read card list) —
 * it is the source of truth for what is switchable on this page. Returns an empty
 * options list and `selectedIndex` of -1 when no dropdown is present.
 */
async function readCupoDropdown(
  frame: Frame,
): Promise<{ options: CupoDropdownOption[]; selectedIndex: number }> {
  return frame.evaluate(() => {
    const select =
      (document.querySelector('select[name="tarjetasGeneral:select_cuenta"]') as HTMLSelectElement | null) ??
      (Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => /bciplus|visa|mastercard|\d{4}/i.test(o.textContent || "")),
      ) ?? null);
    if (!select) return { options: [] as Array<{ value: string; label: string }>, selectedIndex: -1 };
    return {
      options: Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() || "" })),
      selectedIndex: select.selectedIndex,
    };
  });
}

/**
 * Switch the cupo dropdown to the card with the given option value, firing the JSF
 * `change` handler. A no-op if the dropdown can't be found. The change triggers an
 * AJAX partial postback that re-renders both panels in place without navigating the
 * iframe, so the caller's frame handle stays valid.
 */
async function selectCupoCard(frame: Frame, value: string): Promise<void> {
  await frame.evaluate((target: string) => {
    const select =
      (document.querySelector('select[name="tarjetasGeneral:select_cuenta"]') as HTMLSelectElement | null) ??
      (Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => /bciplus|visa|mastercard|\d{4}/i.test(o.textContent || "")),
      ) ?? null);
    if (!select) return;
    select.value = target;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

// ─── Result assembly ─────────────────────────────────────────────

/**
 * Build the final BCI scrape result from already-separated inputs.
 *
 * Account movements and per-card movements live in distinct buckets: credit-card
 * transactions must never leak into the checking account. (Previously every card
 * movement was pushed onto the single account, leaving the cards themselves empty.)
 */
/**
 * Distribute a flat list of credit-card movements across the known cards.
 *
 * BCI's "Mis movimientos" table lists every card's movements together; the
 * card-type column (tagged onto each movement as `card`) is what tells them
 * apart. We match a movement to a card by the card's last-4 digits (when the
 * tag carries a number) or by brand (visa / mastercard). A movement that
 * matches no card is left unassigned rather than duplicated onto every card.
 */
export function routeBciCardMovements(
  creditCards: CreditCardBalance[],
  movements: BankMovement[],
): CreditCardBalance[] {
  return creditCards.map((card) => {
    const last4 = card.label.match(/(\d{4})(?!.*\d)/)?.[1];
    const brand = /mastercard/i.test(card.label)
      ? "mastercard"
      : /visa/i.test(card.label)
        ? "visa"
        : undefined;
    const mine = movements.filter((m) => {
      const tag = (m.card ?? "").toLowerCase();
      if (!tag) return false;
      if (last4 && tag.replace(/\D/g, "").includes(last4)) return true;
      if (brand && tag.includes(brand)) return true;
      return false;
    });
    return { ...card, movements: deduplicateMovements(mine) };
  });
}

// ─── Cupo (credit limit) parsing & assignment ────────────────────

/** National amounts: digits only → integer. Dots are thousands separators. */
function parseClp(text: string): number {
  return parseInt(text.replace(/[^0-9]/g, ""), 10) || 0;
}

/**
 * International (USD) amounts: dots are thousands separators and the comma is the
 * decimal separator. Strip to `[\d.,]`, drop the thousands dots, turn the decimal
 * comma into a point, then parse as a float (stored as float dollars).
 * Fixes the prior bug where `US$363,68` was read as `36368` instead of `363.68`.
 */
function parseUsd(text: string): number {
  const cleaned = text.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(/,/g, ".");
  return parseFloat(cleaned) || 0;
}

/**
 * First occurrence of `<keyword> ... $<amount>` in a panel's text. Taking the
 * first match yields the regular cupo and ignores the `Avances` (cash-advance)
 * sub-limit, which appears later in the same panel.
 */
function firstCupoField(text: string, keyword: string): string | undefined {
  const match = text.match(new RegExp(`${keyword}[^\\d$]*\\$?\\s*([\\d.,]+)`, "i"));
  return match?.[1];
}

export interface BciCupoReading {
  label: string;
  nationalText: string;
  internationalText: string;
}

export interface CupoDropdownOption {
  value: string;
  label: string;
}

export interface CupoReadStep extends CupoDropdownOption {
  /** Whether this card must be switched to first (false for the default-selected card). */
  needsSwitch: boolean;
}

/**
 * Decide the order in which the cupo dropdown's cards are read.
 *
 * The default-selected card is read first with no switch (and no panel poll); every
 * other option follows in dropdown order, each requiring a switch + change-poll. This
 * is the only branching decision the browser loop needs, kept pure so it can be tested
 * without a browser. An empty options list (no dropdown) yields an empty plan, and the
 * caller degrades to a single read of whatever is displayed.
 */
export function planCupoReads(
  options: CupoDropdownOption[],
  selectedIndex: number,
): CupoReadStep[] {
  if (options.length === 0) return [];
  const defaultIndex = selectedIndex >= 0 && selectedIndex < options.length ? selectedIndex : 0;
  const ordered = [options[defaultIndex], ...options.filter((_, i) => i !== defaultIndex)];
  return ordered.map((opt, i) => ({ ...opt, needsSwitch: i > 0 }));
}

/**
 * Parse one cupo panel's text into a `{ used, available, total }` reading with
 * the given amount parser (parseClp for national, parseUsd for international).
 * Returns undefined when the total is 0 or unreadable, so the caller leaves that
 * cupo unset rather than emitting zeros.
 */
function parseCupoPanel(
  text: string,
  parseAmount: (t: string) => number,
): { used: number; available: number; total: number } | undefined {
  const total = parseAmount(firstCupoField(text, "total") ?? "");
  if (total <= 0) return undefined;
  return {
    used: parseAmount(firstCupoField(text, "utilizado") ?? ""),
    available: parseAmount(firstCupoField(text, "disponible") ?? ""),
    total,
  };
}

/** Last-4 digits of a card label (`(\d{4})(?!.*\d)`), the idiom routeBciCardMovements uses. */
function cardLast4(label: string): string | undefined {
  return label.match(/(\d{4})(?!.*\d)/)?.[1];
}

/**
 * Pure seam for BCI per-card cupo: bind each raw panel reading to its card and
 * assign that card its own national / international cupo.
 *
 * - Parsing: national via parseClp (integer pesos), international via parseUsd
 *   (float dollars, comma decimals).
 * - Field extraction: first total / utilizado / disponible match per panel — the
 *   regular cupo, not the Avances sub-limit.
 * - Binding: by last-4 of the label, falling back to exact-label match; reading
 *   order is irrelevant.
 * - Guards: national assigned only when its total > 0, international only when its
 *   total > 0. A card with no matching reading (or a total-0 read) is left with
 *   national/international undefined — never zeros, never another card's values.
 */
export function assignBciCupos(
  creditCards: CreditCardBalance[],
  readings: BciCupoReading[],
): CreditCardBalance[] {
  return creditCards.map((card) => {
    const last4 = cardLast4(card.label);
    const reading =
      (last4 ? readings.find((r) => cardLast4(r.label) === last4) : undefined) ??
      readings.find((r) => r.label === card.label);
    if (!reading) return { ...card };

    const result: CreditCardBalance = { ...card };

    const national = parseCupoPanel(reading.nationalText, parseClp);
    if (national) result.national = national;

    const international = parseCupoPanel(reading.internationalText, parseUsd);
    if (international) result.international = { ...international, currency: "USD" };

    return result;
  });
}

export function assembleBciResult(
  balance: number | undefined,
  accountMovements: BankMovement[],
  creditCards: CreditCardBalance[],
): { accounts: AccountBalance[]; creditCards: CreditCardBalance[] | undefined } {
  const accounts: AccountBalance[] = [
    { balance, movements: deduplicateMovements(accountMovements) },
  ];
  const cards = creditCards.map((c) => ({ ...c, movements: deduplicateMovements(c.movements ?? []) }));
  return { accounts, creditCards: cards.length > 0 ? cards : undefined };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBci(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const { onProgress } = options;
  const bank = "bci";
  const progress = onProgress || (() => {});

  // Install API interceptor before first page.goto()
  const interceptor = await createInterceptor(page, [
    { id: "bci-checking", urlPrefix: BCI_CHECKING_API_PREFIX },
  ]);

  progress("Abriendo sitio del banco...");
  const loginResult = await bciLogin(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, accounts: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  // Account movements
  progress("Extrayendo movimientos de cuenta...");
  debugLog.push("5. Fetching account movements...");
  const accountMovements: BankMovement[] = [];
  let balance: number | undefined;

  if (await clickByTitle(page, "Últimos Movimientos")) {
    const movFrame = await waitForFrame(page, IFRAME_PATTERNS.movements, 15000);
    if (movFrame) {
      await delay(3000);

      // Try API interception first
      const captured = await interceptor.waitFor("bci-checking", 10_000);
      if (captured.length > 0) {
        debugLog.push(`  Checking API: ${captured.length} response(s) captured`);
        const apiMovements = normalizeBciApiMovements(captured);
        debugLog.push(`  Checking API movements: ${apiMovements.length}`);
        if (apiMovements.length > 0) {
          accountMovements.push(...apiMovements);
          // Still extract balance from the iframe DOM
          balance = await movFrame.evaluate(() => {
            const el = document.querySelector("#saldoDis + div, .bci-h2-w800");
            if (!el) return undefined;
            const match = (el as HTMLElement).textContent?.trim().match(/\$\s*([\d.]+)/);
            if (match) return parseInt(match[1].replace(/\./g, ""), 10);
            return undefined;
          });
        }
      }

      if (accountMovements.length === 0) {
        debugLog.push("  Checking API: no data, falling back to HTML extraction");
        const accounts = await movFrame.evaluate((sel: string) => {
          const select = document.querySelector(sel) as HTMLSelectElement | null;
          if (!select) return [];
          return Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() || "" }));
        }, ACCOUNT_SELECT);
        debugLog.push(`  Found ${accounts.length} account(s)`);

        for (let i = 0; i < accounts.length; i++) {
          if (i > 0) {
            await movFrame.evaluate((value: string, sel: string) => {
              const select = document.querySelector(sel) as HTMLSelectElement | null;
              if (!select) return;
              select.value = value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }, accounts[i].value, ACCOUNT_SELECT);
            await delay(3000);
          }
          if (balance === undefined) {
            balance = await movFrame.evaluate(() => {
              const el = document.querySelector("#saldoDis + div, .bci-h2-w800");
              if (!el) return undefined;
              const match = (el as HTMLElement).textContent?.trim().match(/\$\s*([\d.]+)/);
              if (match) return parseInt(match[1].replace(/\./g, ""), 10);
              return undefined;
            });
          }
          const movements = await extractMovementsFromFrame(movFrame, debugLog);
          const prefixed = accounts.length > 1 ? movements.map(m => ({ ...m, description: `[${accounts[i].label}] ${m.description}`.trim() })) : movements;
          accountMovements.push(...prefixed);
        }
      }
    }
  }

  // Credit cards — BCI's "Mis movimientos" table lists every card's movements
  // together (the select.tdc dropdown does NOT filter the table), so we extract
  // the table once and route each movement to its card via the card-type column
  // captured in extractTCMovements. Movements never leak into the checking
  // account (handled by assembleBciResult), and routing keeps each card's
  // movements distinct instead of duplicating them onto every card.
  progress("Extrayendo datos de tarjeta de crédito...");
  debugLog.push("6. Navigating to credit cards...");
  let creditCards: CreditCardBalance[] = [];
  if (await clickByTitle(page, "Tarjetas")) {
    await delay(3000);
    const cardLabels = await page.evaluate(() => {
      const selects = document.querySelectorAll("select.tdc");
      if (selects.length === 0) return [];
      return Array.from((selects[0] as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "");
    });
    // One entry per card up front, so a card still surfaces even when its
    // movement extraction yields nothing.
    for (const label of cardLabels) creditCards.push({ label, movements: [] });

    if (cardLabels.length > 0 && await clickByTitle(page, "Mis movimientos")) {
      const tcFrame = await waitForFrame(page, IFRAME_PATTERNS.tcMovements, 15000);
      if (tcFrame) {
        await delay(3000);
        const tcMovements: BankMovement[] = [];
        for (const { tab, billingType, source } of TC_COMBINATIONS) {
          const movements = await extractTCMovements(tcFrame, tab, billingType, source, debugLog);
          tcMovements.push(...movements);
        }
        creditCards = routeBciCardMovements(creditCards, tcMovements);
        const routed = creditCards.reduce((s, c) => s + (c.movements?.length ?? 0), 0);
        debugLog.push(`  TC: ${tcMovements.length} movements extracted, ${routed} routed to ${creditCards.length} card(s)`);
        for (const c of creditCards) debugLog.push(`    Card "${c.label}": ${c.movements?.length ?? 0} movements`);
        if (tcMovements.length > routed) {
          debugLog.push(`  WARNING: ${tcMovements.length - routed} TC movement(s) matched no card (check tipo-tarjeta column values above)`);
        }
      }

      if (await clickByTitle(page, "Cupo disponible")) {
        const cupoFrame = await waitForFrame(page, IFRAME_PATTERNS.tcCupo, 15000);
        if (cupoFrame) {
          await delay(3000);

          const { options, selectedIndex } = await readCupoDropdown(cupoFrame);
          const plan = planCupoReads(options, selectedIndex);
          const readings: BciCupoReading[] = [];

          if (plan.length === 0) {
            // No card dropdown — degrade to a single read of whatever is displayed.
            const reading = await readCupoReading(cupoFrame);
            debugLog.push(`  Cupo: no dropdown, single read "${reading.label}"`);
            readings.push(reading);
          } else {
            debugLog.push(`  Cupo: ${plan.length} card(s) in dropdown, reading default first`);
            for (const step of plan) {
              if (step.needsSwitch) {
                // Snapshot the national panel, switch the dropdown, then poll saldosNac
                // until it changes. The DOM-change poll is the sole wait signal — the XHR
                // interceptor cannot read the XML partial-response and is not used here.
                const snapshot = await readCupoNationalText(cupoFrame);
                await selectCupoCard(cupoFrame, step.value);
                const changed = await waitForCupoPanelChange(cupoFrame, snapshot, 8000);
                debugLog.push(`  Cupo: switched to "${step.label}" (panel ${changed ? "updated" : "timeout"})`);
              }
              readings.push(await readCupoReading(cupoFrame));
            }
          }

          creditCards = assignBciCupos(creditCards, readings);
        }
      }
    }
  }

  const totalCardMovements = creditCards.reduce((s, c) => s + (c.movements?.length ?? 0), 0);
  debugLog.push(`  Total: ${accountMovements.length} account + ${totalCardMovements} card movements`);
  progress(`Listo — ${accountMovements.length + totalCardMovements} movimientos totales`);
  await doSave(page, "06-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  const { accounts, creditCards: cards } = assembleBciResult(balance, accountMovements, creditCards);
  return { success: true, bank, accounts, creditCards: cards, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bci: BankScraper = {
  id: "bci",
  name: "BCI",
  url: "https://www.bci.cl/personas",
  scrape: (options) => runScraper("bci", options, {}, scrapeBci),
};

export default bci;
