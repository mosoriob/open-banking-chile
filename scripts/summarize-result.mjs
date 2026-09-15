#!/usr/bin/env node
/**
 * Resume el JSON que devuelve un scraper, sin imprimir cada movimiento.
 *
 * Muestra el conteo por cuenta y por tarjeta, la moneda de los movimientos y
 * las líneas del log de debug. Así se revisa una corrida real sin dejar los
 * movimientos en la pantalla ni en el historial del terminal.
 *
 *   node scripts/summarize-result.mjs debug/bchile-result.json
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Uso: node scripts/summarize-result.mjs <archivo.json>");
  process.exit(1);
}

// Una versión antigua del CLI dejaba el banner de dotenv antes del JSON.
// Empieza a leer en la primera llave para aceptar esos archivos.
const raw = readFileSync(path, "utf8");
const start = raw.indexOf("{");
if (start < 0) {
  console.error(`${path} no tiene JSON.`);
  process.exit(1);
}
const result = JSON.parse(raw.slice(start));

if (!result.success) {
  console.error(`Error: ${result.error}`);
  if (result.debug) console.error(`\nDebug:\n${result.debug}`);
  process.exit(1);
}

const money = (m) => `${m.currency === "USD" ? "US$" : "$"}${Math.abs(m.amount).toLocaleString("es-CL")}`;

console.log("─── cuentas ───");
for (const acct of result.accounts ?? []) {
  console.log(`  ${acct.label ?? "(sin etiqueta)"} — ${acct.movements.length} movimientos, saldo ${acct.balance ?? "?"}`);
}

console.log("\n─── tarjetas ───");
for (const card of result.creditCards ?? []) {
  const movs = card.movements ?? [];
  const usd = movs.filter((m) => m.currency === "USD");
  console.log(`  ${card.label} — ${movs.length} movimientos (${usd.length} en USD)`);
  for (const m of usd.slice(0, 10)) {
    console.log(`      ${m.date}  ${money(m)}  ${m.description}`);
  }
  if (usd.length > 10) console.log(`      … y ${usd.length - 10} más`);
}

console.log("\n─── log de debug ───");
console.log((result.debug ?? "(vacío)").split("\n").map((l) => `  ${l}`).join("\n"));
