#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LIVETALKING_ROOT="${PROJECT_ROOT}/integrations/LiveTalking"
# WSL NAT cannot reach the Windows API through its own loopback address.
if grep -qi microsoft /proc/sys/kernel/osrelease; then
  export INTERVIEW_AUTH_MODE="local-ticket"
  export INTERVIEW_PROJECT_ROOT="${PROJECT_ROOT}"
  if ! /opt/miniconda/envs/livetalking/bin/python -c "import jwt" >/dev/null 2>&1; then
    echo "Missing PyJWT in LiveTalking environment; install PyJWT>=2.9 before starting." >&2
    exit 2
  fi
fi
PYTHON_BIN="/opt/miniconda/envs/livetalking/bin/python"
LOG_DIR="${PROJECT_ROOT}/logs"
AVATAR_ID="wav2lip_avatar_female_model"
# Natural-blink interviewer is the approved default. The mode file can still
# explicitly select "stable" for an emergency rollback.
AVATAR_MODE="expression-test"
MODE_FILE="${PROJECT_ROOT}/data/avatar-mode.txt"
TTS_MODE="edgetts"
TTS_ARGS=()
MAX_SESSIONS="${LIVETALKING_MAX_SESSIONS:-2}"

if [[ -f "${MODE_FILE}" ]]; then
  AVATAR_MODE="$(tr -d '\r\n ' < "${MODE_FILE}")"
fi

if [[ "${AVATAR_MODE}" == "expression-test" && -f "${LIVETALKING_ROOT}/data/avatars/interviewer_expression_test_v1/coords.pkl" ]]; then
  AVATAR_ID="interviewer_expression_test_v1"
elif [[ -f "${LIVETALKING_ROOT}/data/avatars/interviewer_realtime_v2/coords.pkl" ]]; then
  AVATAR_ID="interviewer_realtime_v2"
elif [[ -f "${LIVETALKING_ROOT}/data/avatars/interviewer_original_v1/coords.pkl" ]]; then
  AVATAR_ID="interviewer_original_v1"
fi

if "${PYTHON_BIN}" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:50000/docs', timeout=1)" >/dev/null 2>&1; then
  REF_FILE="${PROJECT_ROOT}/data/tts/interviewer-reference.wav"
  REF_TEXT_FILE="${PROJECT_ROOT}/data/tts/interviewer-reference.txt"
  if [[ ! -f "${REF_FILE}" ]]; then
    REF_FILE="${PROJECT_ROOT}/integrations/CosyVoice/asset/zero_shot_prompt.wav"
  fi
  REF_TEXT="希望你以后能够做的比我还好呦。"
  if [[ -f "${REF_TEXT_FILE}" ]]; then
    REF_TEXT="$(tr '\r\n' ' ' < "${REF_TEXT_FILE}")"
  fi
  TTS_MODE="cosyvoice"
  TTS_ARGS=(--TTS_SERVER "http://127.0.0.1:50000" --REF_FILE "${REF_FILE}" --REF_TEXT "${REF_TEXT}")
fi

mkdir -p "${LOG_DIR}"
cd "${LIVETALKING_ROOT}"
printf 'avatar_mode=%s avatar_id=%s\n' "${AVATAR_MODE}" "${AVATAR_ID}" >> "${LOG_DIR}/livetalking.log"
printf '{"pid":%s,"name":"livetalking","marker":"app.py --transport webrtc","started_at":"%s","project_root":"%s"}\n' \
  "$$" \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "${PROJECT_ROOT}" \
  > "${LOG_DIR}/livetalking.pid"

exec "${PYTHON_BIN}" app.py \
  --transport webrtc \
  --model wav2lip \
  --avatar_id "${AVATAR_ID}" \
  --tts "${TTS_MODE}" \
  --max_session "${MAX_SESSIONS}" \
  "${TTS_ARGS[@]}" \
  --listenport 8010 \
  >> "${LOG_DIR}/livetalking.log" 2>&1
