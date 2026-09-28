#!/bin/bash
# tools/qa-on-win.sh — 把 QA 放到 Win 台式机上跑（qa-boost.mjs 会开 Chrome 真实播放 B 站视频，Mac 上吵）
#
#   tools/qa-on-win.sh            # 打包当前工作区 → 传到 Win → node tools/qa-boost.mjs → 输出原样回显，退出码透传
#   WIN_HOST=win-desktop QA_ARGS="..." 可覆盖；QA_TIMEOUT_SECONDS 默认 900 秒
#
# Win 侧要求：Node（winget OpenJS.NodeJS.LTS，2026-09-27 已装 v24）与 Chrome；不需要 git——
# 旧版 bili-cdn-fix.user.js 对照脚本在 Mac 上用 git show 取出后一起传过去（BILI_BOOST_QA_LEGACY）。
# 默认在 Win 的交互桌面会话里跑（schtasks /it）：有窗口的 Chrome 才能用 GPU 硬解，HUD 检查依赖 powerEfficient=true；
# Chrome 一律 --mute-audio。没人登录 Win（桌面会话不存在）时退回 ssh 会话里 --headless=new，此时 HUD 检查会因无硬解而失败。
# 每次运行使用独立的远端目录、压缩包、计划任务名和 CDP 端口，允许多个验收进程并行。
# QA_MODE=headless 可强制无窗口。
set -euo pipefail
cd "$(dirname "$0")/.."
WIN_HOST=${WIN_HOST:-win-desktop}
QA_TIMEOUT_SECONDS=${QA_TIMEOUT_SECONDS:-900}
RUN_ID="$(date +%Y%m%d%H%M%S)-$$-${RANDOM:-0}"
REMOTE_DIR="bili-boost-qa-$RUN_ID"               # 相对 Win 用户目录 C:\Users\game5090
REMOTE_ARCHIVE="qa-$RUN_ID.tgz"
TASK_NAME="BiliBoostQA-$RUN_ID"
QA_PORT=${BILI_BOOST_QA_PORT:-$((20000 + (($$ + ${RANDOM:-0}) % 20000)))}

tmp=$(mktemp -d)
remote_ready=0
task_created=0
task_finished=0
cleanup() {
  saved=$?
  trap - EXIT INT TERM
  if [ "$task_created" = 1 ]; then
    if [ "$task_finished" = 0 ]; then
      ssh "$WIN_HOST" "schtasks /end /tn $TASK_NAME" >/dev/null 2>&1 || true
    fi
    ssh "$WIN_HOST" "schtasks /delete /tn $TASK_NAME /f" >/dev/null 2>&1 || true
  fi
  if [ "$remote_ready" = 1 ]; then
    # schtasks /end 不会终止已经派生的 node/chrome；按本次唯一参数只杀自己的进程。
    ssh "$WIN_HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\\$REMOTE_DIR\\cleanup-run.ps1" >/dev/null 2>&1 || true
    sleep 1
    ssh "$WIN_HOST" "rmdir /s /q $REMOTE_DIR & del $REMOTE_ARCHIVE" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  exit "$saved"
}
trap cleanup EXIT INT TERM

stage="$tmp/stage"; mkdir -p "$stage"
# 已跟踪 + 未跟踪但未忽略的文件（即当前工作区内容）拷进暂存目录
{ git ls-files; git ls-files --others --exclude-standard; } | sort -u | while IFS= read -r f; do
  if [ -f "$f" ]; then mkdir -p "$stage/$(dirname "$f")"; cp -p "$f" "$stage/$f"; fi
done
git show bb6d614:bili-cdn-fix.user.js > "$stage/legacy-cdn.user.js" 2>/dev/null || rm -f "$stage/legacy-cdn.user.js"
# 远端命令写成 .cmd 一起传（ssh 直接拼 cmd 链有 if/& 优先级与引号坑，见记忆 feedback_ssh_win_quoting）
printf '%s\r\n' '@echo off' 'chcp 65001 >nul' 'cd /d %~dp0' \
  "set BILI_BOOST_QA_PORT=$QA_PORT" \
  'if "%1"=="headless" set BILI_BOOST_QA_HEADLESS=1' \
  'if exist legacy-cdn.user.js set BILI_BOOST_QA_LEGACY=%~dp0legacy-cdn.user.js' \
  "\"C:\\Program Files\\nodejs\\node.exe\" tools\\qa-boost.mjs --qa-run-id=$RUN_ID ${QA_ARGS:-}" \
  'exit /b %ERRORLEVEL%' > "$stage/run-qa.cmd"
printf '%s\r\n' \
  "\$runNeedle = '*--qa-run-id=$RUN_ID*'" \
  "\$portNeedle = '*--remote-debugging-port=$QA_PORT*'" \
  'Get-CimInstance Win32_Process | Where-Object {' \
  '  $_.CommandLine -like $runNeedle -or $_.CommandLine -like $portNeedle' \
  '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' \
  > "$stage/cleanup-run.ps1"
tar -czf "$tmp/$REMOTE_ARCHIVE" -C "$stage" .
scp -q "$tmp/$REMOTE_ARCHIVE" "$WIN_HOST:$REMOTE_ARCHIVE"
remote_ready=1
ssh "$WIN_HOST" "mkdir $REMOTE_DIR" >/dev/null
ssh "$WIN_HOST" "tar -xzf $REMOTE_ARCHIVE -C $REMOTE_DIR"
ssh "$WIN_HOST" "del $REMOTE_ARCHIVE" >/dev/null 2>&1 || true

rc=0
started=0
if [ "${QA_MODE:-interactive}" != headless ]; then
  # 原子完成标记：先写 tmp 再 move，避免本机读到半个退出码；exit /b 让计划任务也记录同一结果。
  printf '%s\r\n' '@echo off' 'chcp 65001 >nul' \
    'call "%~dp0run-qa.cmd" > "%~dp0qa.log" 2>&1' \
    'set "QA_RC=%ERRORLEVEL%"' \
    '> "%~dp0qa.done.tmp" echo %QA_RC%' \
    'move /y "%~dp0qa.done.tmp" "%~dp0qa.done" >nul' \
    'exit /b %QA_RC%' > "$tmp/wrap.cmd"
  scp -q "$tmp/wrap.cmd" "$WIN_HOST:$REMOTE_DIR/wrap-qa.cmd"
  ssh "$WIN_HOST" "schtasks /create /tn $TASK_NAME /tr \"%USERPROFILE%\\$REMOTE_DIR\\wrap-qa.cmd\" /sc once /st 00:00 /it /f" >/dev/null 2>&1
  task_created=1
  ssh "$WIN_HOST" "schtasks /run /tn $TASK_NAME" >/dev/null 2>&1
  for _ in $(seq 20); do                              # 20 秒内出现 qa.log 才算交互会话里起来了
    ssh "$WIN_HOST" "if exist $REMOTE_DIR\\qa.log echo yes" 2>/dev/null | grep -q yes && { started=1; break; }
    sleep 1
  done
  if [ "$started" = 1 ]; then
    echo "[qa-on-win] 在 Win 桌面会话里运行（有窗口 Chrome、静音；run=${RUN_ID} port=${QA_PORT}）…" >&2
    deadline=$((SECONDS + QA_TIMEOUT_SECONDS))
    while ! ssh "$WIN_HOST" "if exist $REMOTE_DIR\\qa.done echo yes" 2>/dev/null | grep -q yes; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "[qa-on-win] 等待 qa.done 超过 ${QA_TIMEOUT_SECONDS}s；回显当前日志并失败（run=${RUN_ID}）" >&2
        ssh "$WIN_HOST" "if exist $REMOTE_DIR\\qa.log type $REMOTE_DIR\\qa.log" || true
        rc=124
        break
      fi
      sleep 5
    done
    if [ "$rc" = 0 ]; then
      ssh "$WIN_HOST" "type $REMOTE_DIR\\qa.log"
      raw_rc=$(ssh "$WIN_HOST" "type $REMOTE_DIR\\qa.done" | tr -d '\r\n ')
      case "$raw_rc" in
        ''|*[!0-9]*) echo "[qa-on-win] qa.done 退出码无效：$raw_rc" >&2; rc=1 ;;
        *) rc=$raw_rc ;;
      esac
      task_finished=1
    fi
  else
    echo "[qa-on-win] Win 没有登录的桌面会话，退回无窗口模式（HUD 检查会因无硬解失败）" >&2
    ssh "$WIN_HOST" "schtasks /end /tn $TASK_NAME" >/dev/null 2>&1 || true
    ssh "$WIN_HOST" "schtasks /delete /tn $TASK_NAME /f" >/dev/null 2>&1 || true
    task_created=0
  fi
fi
if [ "$started" = 0 ]; then
  ssh "$WIN_HOST" "$REMOTE_DIR\\run-qa.cmd headless" || rc=$?
fi
exit "$rc"
