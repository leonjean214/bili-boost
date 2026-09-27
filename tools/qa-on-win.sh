#!/bin/bash
# tools/qa-on-win.sh — 把 QA 放到 Win 台式机上跑（qa-boost.mjs 会开 Chrome 真实播放 B 站视频，Mac 上吵）
#
#   tools/qa-on-win.sh            # 打包当前工作区 → 传到 Win → node tools/qa-boost.mjs → 输出原样回显，退出码透传
#   WIN_HOST=win-desktop  QA_ARGS="..."  可覆盖
#
# Win 侧要求：Node（winget OpenJS.NodeJS.LTS，2026-09-27 已装 v24）与 Chrome；不需要 git——
# 旧版 bili-cdn-fix.user.js 对照脚本在 Mac 上用 git show 取出后一起传过去（BILI_BOOST_QA_LEGACY）。
# 默认在 Win 的交互桌面会话里跑（schtasks /it）：有窗口的 Chrome 才能用 GPU 硬解，HUD 检查依赖 powerEfficient=true；
# Chrome 一律 --mute-audio。没人登录 Win（桌面会话不存在）时退回 ssh 会话里 --headless=new，此时 HUD 检查会因无硬解而失败。
# QA_MODE=headless 可强制无窗口。
set -euo pipefail
cd "$(dirname "$0")/.."
WIN_HOST=${WIN_HOST:-win-desktop}
REMOTE_DIR='bili-boost-qa'                       # 相对 Win 用户目录 C:\Users\game5090

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stage="$tmp/stage"; mkdir -p "$stage"
# 已跟踪 + 未跟踪但未忽略的文件（即当前工作区内容）拷进暂存目录
{ git ls-files; git ls-files --others --exclude-standard; } | sort -u | while IFS= read -r f; do
  if [ -f "$f" ]; then mkdir -p "$stage/$(dirname "$f")"; cp -p "$f" "$stage/$f"; fi
done
git show bb6d614:bili-cdn-fix.user.js > "$stage/legacy-cdn.user.js" 2>/dev/null || rm -f "$stage/legacy-cdn.user.js"
# 远端命令写成 .cmd 一起传（ssh 直接拼 cmd 链有 if/& 优先级与引号坑，见记忆 feedback_ssh_win_quoting）
printf '%s\r\n' '@echo off' 'cd /d %~dp0' 'if "%1"=="headless" set BILI_BOOST_QA_HEADLESS=1' \
  'if exist legacy-cdn.user.js set BILI_BOOST_QA_LEGACY=%~dp0legacy-cdn.user.js' \
  "\"C:\\Program Files\\nodejs\\node.exe\" tools\\qa-boost.mjs ${QA_ARGS:-}" > "$stage/run-qa.cmd"
tar -czf "$tmp/qa.tgz" -C "$stage" .
scp -q "$tmp/qa.tgz" "$WIN_HOST:qa.tgz"
ssh "$WIN_HOST" "rmdir /s /q $REMOTE_DIR" >/dev/null 2>&1 || true
ssh "$WIN_HOST" "mkdir $REMOTE_DIR" >/dev/null
ssh "$WIN_HOST" "tar -xzf qa.tgz -C $REMOTE_DIR"
ssh "$WIN_HOST" "del qa.tgz" >/dev/null 2>&1 || true
rc=0
started=0
if [ "${QA_MODE:-interactive}" != headless ]; then
  # 交互会话：计划任务 /it 跑 run-qa.cmd，输出写 qa.log，结束写 qa.done（内含退出码）
  printf '%s\r\n' '@echo off' 'call "%~dp0run-qa.cmd" > "%~dp0qa.log" 2>&1' 'echo %ERRORLEVEL% > "%~dp0qa.done"' > "$tmp/wrap.cmd"
  scp -q "$tmp/wrap.cmd" "$WIN_HOST:$REMOTE_DIR/wrap-qa.cmd"
  ssh "$WIN_HOST" "schtasks /create /tn BiliBoostQA /tr \"%USERPROFILE%\\$REMOTE_DIR\\wrap-qa.cmd\" /sc once /st 00:00 /it /f" >/dev/null 2>&1
  ssh "$WIN_HOST" "schtasks /run /tn BiliBoostQA" >/dev/null 2>&1
  for _ in $(seq 20); do                              # 20 秒内出现 qa.log 才算交互会话里起来了
    ssh "$WIN_HOST" "if exist $REMOTE_DIR\\qa.log echo yes" 2>/dev/null | grep -q yes && { started=1; break; }
    sleep 1
  done
  if [ $started = 1 ]; then
    echo "[qa-on-win] 在 Win 桌面会话里运行（有窗口 Chrome、静音）…" >&2
    until ssh "$WIN_HOST" "if exist $REMOTE_DIR\\qa.done echo yes" 2>/dev/null | grep -q yes; do sleep 5; done
    ssh "$WIN_HOST" "type $REMOTE_DIR\\qa.log"
    rc=$(ssh "$WIN_HOST" "type $REMOTE_DIR\\qa.done" | tr -dc '0-9'); rc=${rc:-1}
  else
    echo "[qa-on-win] Win 没有登录的桌面会话，退回无窗口模式（HUD 检查会因无硬解失败）" >&2
  fi
  ssh "$WIN_HOST" "schtasks /delete /tn BiliBoostQA /f" >/dev/null 2>&1 || true
fi
if [ $started = 0 ]; then
  ssh "$WIN_HOST" "$REMOTE_DIR\\run-qa.cmd headless" || rc=$?
fi
ssh "$WIN_HOST" "rmdir /s /q $REMOTE_DIR" >/dev/null 2>&1 || true
exit $rc
