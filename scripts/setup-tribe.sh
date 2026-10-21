#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIBE_ROOT="$ROOT/vendor/tribev2"
VENV="$TRIBE_ROOT/.venv"

if [ ! -d "$TRIBE_ROOT/tribev2" ]; then
  echo "TRIBE source not found at $TRIBE_ROOT" >&2
  exit 1
fi

if [ -n "${PYTHON:-}" ]; then
  PYTHON_BIN="$PYTHON"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="python3.11"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "python3.11 or python3 is required." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv "$VENV"
# Official Python security bootstrap: verify the wheel before trusting old pip.
# https://discuss.python.org/t/109576
"$VENV/bin/python" -m pip install --upgrade "pip @ https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
SECURITY_REQUIREMENTS="$ROOT/scripts/requirements-tribe-security.txt"
"$VENV/bin/python" -m pip install --upgrade -r "$SECURITY_REQUIREMENTS"
"$VENV/bin/python" -m pip install -c "$SECURITY_REQUIREMENTS" -e "$TRIBE_ROOT"
"$VENV/bin/python" -m pip install -c "$SECURITY_REQUIREMENTS" \
  exca==0.5.20 \
  transformers==4.57.6 \
  hf_transfer==0.1.9 \
  bitsandbytes==0.49.2 \
  accelerate==1.13.0

echo "TRIBE environment ready at $VENV"
