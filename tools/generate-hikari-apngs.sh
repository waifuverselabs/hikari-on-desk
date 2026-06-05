#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

THEME_DIR="${THEME_DIR:-"${REPO_ROOT}/themes/hikari"}"
ASSETS_DIR="${ASSETS_DIR:-"${THEME_DIR}/assets"}"
SHEETS_DIR="${SHEETS_DIR:-"${THEME_DIR}/source-sheets"}"

CANVAS_W="${CANVAS_W:-266}"
CANVAS_H="${CANVAS_H:-200}"
PNGQUANT_QUALITY="${PNGQUANT_QUALITY:-75-95}"
KEY_COLOR="${KEY_COLOR:-#00ff00}"
KEY_FUZZ="${KEY_FUZZ:-25%}"
FULL_CELL_SHAVE_X="${FULL_CELL_SHAVE_X:-30}"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick is required. Install it with: brew install imagemagick" >&2
  exit 1
fi

if ! command -v apngasm >/dev/null 2>&1; then
  echo "apngasm is required. Install it with: brew install apngasm" >&2
  exit 1
fi

if ! command -v pngquant >/dev/null 2>&1; then
  echo "pngquant is required. Install it with: brew install pngquant" >&2
  exit 1
fi

mkdir -p "${ASSETS_DIR}"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT

sheet_file() {
  case "$1" in
    typing) echo "hikari-typing.png" ;;
    dance) echo "hikari-dance.png" ;;
    idle) echo "hikari-idle.png" ;;
    sleep) echo "hikari-sleep.png" ;;
    thinking) echo "hikari-thinking.png" ;;
    building) echo "hikari-building.png" ;;
    sweeping) echo "hikari-sweeping.png" ;;
    juggling) echo "hikari-juggling.png" ;;
    hula) echo "hikari-hula.png" ;;
    raver) echo "hikari-raver-dance.png" ;;
    error) echo "hikari-error-alert.png" ;;
    work) echo "hikari-work-utility.png" ;;
    status) echo "hikari-status-special.png" ;;
    react) echo "hikari-reactions.png" ;;
    mini) echo "hikari-mini.png" ;;
    *) echo "unknown sheet key: $1" >&2; exit 1 ;;
  esac
}

sheet_frames() {
  case "$1" in
    typing) echo 4 ;;
    thinking|building|sweeping|juggling) echo 8 ;;
    hula|raver) echo 16 ;;
    dance|idle|sleep|error|work|status|react|mini) echo 6 ;;
    *) echo "unknown sheet key: $1" >&2; exit 1 ;;
  esac
}

sheet_crop_w() {
  case "$1" in
    typing) echo 480 ;;
    work|status) echo 300 ;;
    react|error) echo 330 ;;
    mini) echo 320 ;;
    thinking|building|sweeping|juggling|hula|raver) echo full ;;
    dance|idle|sleep|thinking) echo 340 ;;
    *) echo "" ;;
  esac
}

for key in typing dance idle sleep thinking building sweeping juggling hula raver error work status react mini; do
  file="$(sheet_file "${key}")"
  if [[ ! -f "${SHEETS_DIR}/${file}" ]]; then
    echo "source sheet not found: ${SHEETS_DIR}/${file}" >&2
    exit 1
  fi
done

source_cell() {
  local sheet_key="$1"
  local frame_index="$2"
  local out="$3"
  local sheet="${SHEETS_DIR}/$(sheet_file "${sheet_key}")"
  local count
  count="$(sheet_frames "${sheet_key}")"
  local split_dir="${TMP_ROOT}/split-${sheet_key}"
  mkdir -p "${split_dir}"

  if [[ ! -f "${split_dir}/frame_00.png" ]]; then
    local sheet_w sheet_h cell_w norm_w
    read -r sheet_w sheet_h < <(magick identify -format "%w %h" "${sheet}")
    cell_w=$(((sheet_w + count - 1) / count))
    norm_w=$((cell_w * count))

    local normalized="${split_dir}/normalized.png"
    magick "${sheet}" \
      -gravity center -background "${KEY_COLOR}" -extent "${norm_w}x${sheet_h}" \
      "${normalized}"

    local split_index split_out
    for ((split_index = 0; split_index < count; split_index++)); do
      printf -v split_out "%s/frame_%02d.png" "${split_dir}" "${split_index}"
      magick "${normalized}" \
        -crop "${cell_w}x${sheet_h}+$((split_index * cell_w))+0" +repage \
        "${split_out}"
    done
  fi

  local idx=$((frame_index - 1))
  local cell
  printf -v cell "%s/frame_%02d.png" "${split_dir}" "${idx}"
  if [[ ! -f "${cell}" ]]; then
    echo "missing ${sheet_key} frame ${frame_index}" >&2
    exit 1
  fi

  local crop_w
  crop_w="$(sheet_crop_w "${sheet_key}")"
  if [[ "${crop_w}" == "full" ]]; then
    magick "${cell}" -shave "${FULL_CELL_SHAVE_X}x0" "${out}"
  elif [[ -n "${crop_w}" ]]; then
    magick "${cell}" \
      -gravity center -crop "${crop_w}x9999+0+0" +repage \
      "${out}"
  else
    magick "${cell}" -shave 4x0 "${out}"
  fi
}

compose_frame() {
  local token="$1"
  local fit_w="$2"
  local fit_h="$3"
  local out="$4"
  local mode="${5:-trim}"
  local fixed_geometry="${6:-}"

  IFS=':' read -r sheet_key frame_index dx dy _hold <<< "${token}"
  dx="${dx:-0}"
  dy="${dy:-0}"

  local raw="${TMP_ROOT}/raw-${sheet_key}-${frame_index}-$$.png"
  local sprite="${TMP_ROOT}/sprite-${sheet_key}-${frame_index}-$$.png"
  source_cell "${sheet_key}" "${frame_index}" "${raw}"

  if [[ "${mode}" == "cellbox" ]]; then
    if [[ -z "${fixed_geometry}" ]]; then
      echo "cellbox mode requires a common crop geometry for ${token}" >&2
      exit 1
    fi

    magick "${raw}" \
      -alpha set -fuzz "${KEY_FUZZ}" -transparent "${KEY_COLOR}" \
      -crop "${fixed_geometry}" +repage \
      -resize "${fit_w}x${fit_h}>" \
      "${sprite}"
  elif [[ "${mode}" == "box" ]]; then
    if [[ -z "${fixed_geometry}" ]]; then
      echo "box mode requires a common size for ${token}" >&2
      exit 1
    fi

    local box_w="${fixed_geometry%%x*}"
    local box_h="${fixed_geometry#*x}"
    local trimmed="${TMP_ROOT}/trimmed-${sheet_key}-${frame_index}-$$.png"
    local boxed="${TMP_ROOT}/boxed-${sheet_key}-${frame_index}-$$.png"

    magick "${raw}" \
      -alpha set -fuzz "${KEY_FUZZ}" -transparent "${KEY_COLOR}" \
      -trim +repage \
      "${trimmed}"

    magick -size "${box_w}x${box_h}" canvas:none \
      "${trimmed}" \
      -gravity center \
      -composite \
      "${boxed}"

    magick "${boxed}" \
      -resize "${fit_w}x${fit_h}>" \
      "${sprite}"
  else
    magick "${raw}" \
      -alpha set -fuzz "${KEY_FUZZ}" -transparent "${KEY_COLOR}" \
      -trim +repage \
      -resize "${fit_w}x${fit_h}>" \
      "${sprite}"
  fi

  magick -size "${CANVAS_W}x${CANVAS_H}" canvas:none \
    "${sprite}" \
    -gravity center -geometry "$(printf "%+d%+d" "${dx}" "${dy}")" \
    -composite \
    "${out}"
}

trim_geometry_for_token() {
  local token="$1"
  local out_var="$2"
  local dims_var="$3"

  IFS=':' read -r sheet_key frame_index _dx _dy _hold <<< "${token}"

  local raw="${TMP_ROOT}/geom-${sheet_key}-${frame_index}-$$.png"
  source_cell "${sheet_key}" "${frame_index}" "${raw}"

  local trim_bounds
  trim_bounds="$(magick "${raw}" \
    -alpha set -fuzz "${KEY_FUZZ}" -transparent "${KEY_COLOR}" \
    -format "%@" info:)"

  local raw_dims
  raw_dims="$(magick identify -format "%w %h" "${raw}")"

  printf -v "${out_var}" "%s" "${trim_bounds}"
  printf -v "${dims_var}" "%s" "${raw_dims}"
}

box_sequence_size() {
  local sequence="$1"
  local pad="${BOX_PAD:-8}"
  local tokens=()
  IFS=',' read -ra tokens <<< "${sequence}"

  local max_w=0
  local max_h=0

  local token
  for token in "${tokens[@]}"; do
    local geometry dims
    trim_geometry_for_token "${token}" geometry dims

    local w="${geometry%%x*}"
    local rest="${geometry#*x}"
    local h="${rest%%+*}"

    if (( w > max_w )); then max_w="${w}"; fi
    if (( h > max_h )); then max_h="${h}"; fi
  done

  echo "$((max_w + pad * 2))x$((max_h + pad * 2))"
}

cellbox_sequence_geometry() {
  local sequence="$1"
  local pad="${CELLBOX_PAD:-8}"
  local tokens=()
  IFS=',' read -ra tokens <<< "${sequence}"

  local min_y=999999
  local max_y=0
  local raw_w=0
  local raw_h=0

  local token
  for token in "${tokens[@]}"; do
    local geometry dims
    trim_geometry_for_token "${token}" geometry dims

    local _w="${geometry%%x*}"
    local rest="${geometry#*x}"
    local h="${rest%%+*}"
    rest="${rest#*+}"
    local _x="${rest%%+*}"
    local y="${rest#*+}"

    raw_w="${dims%% *}"
    raw_h="${dims#* }"

    if (( y < min_y )); then min_y="${y}"; fi
    if (( y + h > max_y )); then max_y=$((y + h)); fi
  done

  min_y=$((min_y - pad))
  max_y=$((max_y + pad))
  if (( min_y < 0 )); then min_y=0; fi
  if (( max_y > raw_h )); then max_y="${raw_h}"; fi

  echo "${raw_w}x$((max_y - min_y))+0+${min_y}"
}

make_apng() {
  local filename="$1"
  local fps="$2"
  local total_frames="$3"
  local fit_w="$4"
  local fit_h="$5"
  local sequence="$6"
  local mode="${7:-trim}"

  local out="${ASSETS_DIR}/${filename}"
  local work_dir="${TMP_ROOT}/${filename%.apng}"
  mkdir -p "${work_dir}"

  IFS=',' read -ra raw_tokens <<< "${sequence}"
  local tokens=()
  local raw_token
  for raw_token in "${raw_tokens[@]}"; do
    local _sheet_key _frame_index _dx _dy hold
    IFS=':' read -r _sheet_key _frame_index _dx _dy hold <<< "${raw_token}"
    hold="${hold:-1}"
    local repeat
    for ((repeat = 0; repeat < hold; repeat++)); do
      tokens+=("${raw_token}")
    done
  done

  local token_count="${#tokens[@]}"
  if [[ "${token_count}" -eq 0 ]]; then
    echo "empty frame sequence for ${filename}" >&2
    exit 1
  fi

  local fixed_geometry=""
  if [[ "${mode}" == "cellbox" ]]; then
    fixed_geometry="$(cellbox_sequence_geometry "${sequence}")"
  elif [[ "${mode}" == "box" ]]; then
    fixed_geometry="$(box_sequence_size "${sequence}")"
  fi

  echo "Generating ${filename} (${fps} fps, ${total_frames} frames, ${mode})"
  for ((i = 0; i < total_frames; i++)); do
    local token="${tokens[$((i % token_count))]}"
    local frame_path
    printf -v frame_path "%s/frame_%04d.png" "${work_dir}" "$((i + 1))"
    compose_frame "${token}" "${fit_w}" "${fit_h}" "${frame_path}" "${mode}" "${fixed_geometry}"
  done

  if ! pngquant --force --speed 1 --quality "${PNGQUANT_QUALITY}" --ext .png "${work_dir}"/frame_*.png; then
    echo "pngquant quality target was not met for ${filename}; keeping truecolor frames" >&2
  fi
  apngasm -F -o "${out}" "${work_dir}"/frame_*.png -d "1:${fps}" -l 0 >/dev/null

  if command -v oxipng >/dev/null 2>&1; then
    oxipng -q -o 4 --strip safe --alpha "${out}" || \
      echo "oxipng could not optimize ${filename}; keeping assembled APNG" >&2
  fi
}

# filename | fps | frame count | fit width | fit height | sheet:frame:dx:dy[:hold] sequence | mode
SPECS=(
  "calico-idle.apng|8|41|210|185|idle:1:0:0,idle:2:0:1,idle:3:0:0,idle:4:0:-1,idle:5:0:0,idle:6:0:1"
  "calico-yawning.apng|8|64|220|185|sleep:1:0:0,sleep:1:0:1,sleep:2:0:0,sleep:1:0:-1"
  "calico-dozing.apng|8|41|220|185|sleep:2:0:0,sleep:2:0:1,sleep:1:0:0,sleep:2:0:-1"
  "calico-collapsing.apng|8|41|230|185|sleep:2:0:0,sleep:3:0:2,sleep:3:0:4,sleep:4:0:3"
  "calico-sleeping.apng|8|40|235|175|sleep:4:0:2,sleep:4:0:3,sleep:4:0:2,sleep:4:0:1"
  "calico-waking.apng|8|41|225|185|sleep:4:0:2,sleep:5:0:1,sleep:5:0:0,sleep:6:0:-1,idle:1:0:0"
  "calico-thinking.apng|8|8|220|185|thinking:1:0:0,thinking:2:0:0,thinking:3:0:0,thinking:4:0:0,thinking:5:0:0,thinking:6:0:0,thinking:7:0:0,thinking:8:0:0|cellbox"
  "calico-error.apng|8|29|220|185|error:1:0:-2,error:2:-2:1,error:3:2:1,error:4:0:-1,error:5:-2:0,error:6:0:0"
  "calico-happy.apng|8|64|215|185|status:5:0:-2,dance:1:0:0,dance:2:0:-1,dance:4:0:-2,dance:6:0:0"
  "calico-notification.apng|8|41|215|185|status:4:0:-1,error:1:0:-2,status:4:2:0,status:4:-2:0"
  "calico-music.apng|8|41|215|185|dance:1:0:0,dance:2:0:-2,dance:3:0:0,dance:4:0:-2,dance:5:0:0,dance:6:0:-1"
  "calico-music-raver.apng|12|16|220|185|raver:1:0:0,raver:2:0:0,raver:3:0:0,raver:4:0:0,raver:5:0:0,raver:6:0:0,raver:7:0:0,raver:8:0:0,raver:9:0:0,raver:10:0:0,raver:11:0:0,raver:12:0:0,raver:13:0:0,raver:14:0:0,raver:15:0:0,raver:16:0:0|cellbox"
  "calico-working-typing.apng|16|61|240|185|typing:1:0:0,typing:2:0:0,typing:3:0:0,typing:4:0:0"
  "calico-working-building.apng|8|8|220|185|building:1:0:0,building:2:0:0,building:3:0:0,building:4:0:0,building:5:0:0,building:6:0:0,building:7:0:0,building:8:0:0|cellbox"
  "calico-working-juggling.apng|8|8|220|185|juggling:1:0:0,juggling:2:0:0,juggling:3:0:0,juggling:4:0:0,juggling:5:0:0,juggling:6:0:0,juggling:7:0:0,juggling:8:0:0|cellbox"
  "calico-working-hula-hoop.apng|12|16|220|185|hula:1:0:0,hula:2:0:0,hula:3:0:0,hula:4:0:0,hula:5:0:0,hula:6:0:0,hula:7:0:0,hula:8:0:0,hula:9:0:0,hula:10:0:0,hula:11:0:0,hula:12:0:0,hula:13:0:0,hula:14:0:0,hula:15:0:0,hula:16:0:0|cellbox"
  "calico-working-conducting.apng|8|41|220|185|status:3:0:-1,status:3:-2:0,status:3:2:0,status:3:0:1"
  "calico-working-sweeping.apng|8|8|220|185|sweeping:1:0:0,sweeping:2:0:0,sweeping:3:0:0,sweeping:4:0:0,sweeping:5:0:0,sweeping:6:0:0,sweeping:7:0:0,sweeping:8:0:0|cellbox"
  "calico-working-carrying.apng|8|41|220|185|work:5:-3:0,work:5:0:-1,work:5:3:0,work:5:0:1"
  "calico-react-drag.apng|8|32|220|185|react:5:-3:0,react:5:3:1,react:5:0:2,react:6:0:0"
  "calico-react-left.apng|8|41|220|185|react:3:-4:0,react:3:-2:1,react:4:2:0,react:6:0:0"
  "calico-react-poke.apng|8|41|220|185|react:1:0:-2,react:2:0:0,react:2:2:1,react:6:0:0"
  "calico-mini-idle.apng|8|41|165|135|mini:1:0:0,mini:1:0:1,mini:1:0:0,mini:1:0:-1"
  "calico-mini-alert.apng|8|28|165|135|mini:2:0:-2,mini:5:0:0,mini:2:2:-1,mini:5:-2:0"
  "calico-mini-happy.apng|8|41|165|135|mini:3:0:-3,mini:3:0:0,mini:3:0:-2,mini:1:0:0"
  "calico-mini-enter.apng|8|22|165|135|mini:4:-10:0,mini:4:-4:0,mini:5:0:0,mini:1:0:0"
  "calico-mini-peek.apng|8|12|170|135|mini:5:0:2,mini:5:0:0,mini:5:0:1,mini:5:0:0"
  "calico-mini-crabwalk.apng|8|31|165|135|mini:4:-8:0,mini:1:-3:1,mini:4:3:0,mini:1:8:1"
  "calico-mini-sleep.apng|8|41|170|130|mini:6:0:2,mini:6:0:3,mini:6:0:2,mini:6:0:1"
)

for spec in "${SPECS[@]}"; do
  IFS='|' read -r filename fps total_frames fit_w fit_h sequence mode <<< "${spec}"
  if [[ -n "${ONLY:-}" && ",${ONLY}," != *",${filename},"* ]]; then
    continue
  fi
  make_apng "${filename}" "${fps}" "${total_frames}" "${fit_w}" "${fit_h}" "${sequence}" "${mode:-trim}"
done
