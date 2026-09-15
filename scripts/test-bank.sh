#!/usr/bin/env bash
#
# Corre un scraper contra el sitio real del banco.
#
#   ./scripts/test-bank.sh bchile [--headful] [--screenshots]
#
# El script pide la clave en cada corrida y no la guarda en ningún archivo.
# Solo el RUT sale de .env. La clave viaja al proceso hijo por el entorno,
# nunca por los argumentos, así que no aparece en `ps`.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BANK="${1:-}"
if [ -z "$BANK" ]; then
  echo "Uso: ./scripts/test-bank.sh <banco> [--headful] [--screenshots]" >&2
  echo "Para ver los bancos:  node dist/cli.js --list" >&2
  exit 1
fi
shift

PREFIX="$(echo "$BANK" | tr '[:lower:]' '[:upper:]')"
OUT="debug/${BANK}-result.json"

# El RUT y las opciones salen de .env. La clave no.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ ! -t 0 ]; then
  echo "Este script necesita un terminal interactivo para pedir la clave." >&2
  exit 1
fi

RUT="$(printenv "${PREFIX}_RUT" || true)"
if [ -z "$RUT" ]; then
  printf 'RUT para %s (ej: 12345678-9): ' "$BANK"
  read -r RUT
fi
if [ -z "$RUT" ]; then
  echo "No escribiste un RUT. No se corrió nada." >&2
  exit 1
fi
export "${PREFIX}_RUT=$RUT"

printf 'Clave de internet de %s: ' "$BANK"
read -rs PASS
printf '\n'
if [ -z "$PASS" ]; then
  echo "No escribiste una clave. No se corrió nada." >&2
  exit 1
fi
export "${PREFIX}_PASS=$PASS"
unset PASS

echo "Compilando..."
npm run build >/dev/null

echo "Abriendo $BANK. Ten el teléfono a mano para aprobar el 2FA."
umask 077
mkdir -p debug
node dist/cli.js --bank "$BANK" --pretty "$@" > "$OUT"
chmod 600 "$OUT"

echo
node scripts/summarize-result.mjs "$OUT"

echo
echo "El resultado completo está en $OUT. Tiene tus movimientos reales."
echo "Bórralo cuando termines:  rm $OUT"
