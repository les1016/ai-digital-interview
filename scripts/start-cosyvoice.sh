#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COSYVOICE_ROOT="${PROJECT_ROOT}/integrations/CosyVoice"
PYTHON_BIN="/opt/miniconda/envs/cosyvoice/bin/python"
MODEL_DIR="${COSYVOICE_ROOT}/pretrained_models/CosyVoice2-0.5B"
LOG_DIR="${PROJECT_ROOT}/logs"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "CosyVoice Python environment is missing: ${PYTHON_BIN}" >&2
  exit 2
fi
if [[ ! -f "${MODEL_DIR}/cosyvoice.yaml" ]]; then
  echo "CosyVoice model is missing: ${MODEL_DIR}" >&2
  exit 3
fi

mkdir -p "${LOG_DIR}"
cd "${COSYVOICE_ROOT}/runtime/python/fastapi"
printf '{"pid":%s,"name":"cosyvoice","marker":"server.py --port 50000","started_at":"%s","project_root":"%s"}\n' \
  "$$" \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "${PROJECT_ROOT}" \
  > "${LOG_DIR}/cosyvoice.pid"

exec "${PYTHON_BIN}" server.py \
  --port 50000 \
  --model_dir "${MODEL_DIR}" \
  >> "${LOG_DIR}/cosyvoice.log" 2>&1
