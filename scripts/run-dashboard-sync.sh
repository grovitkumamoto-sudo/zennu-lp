#!/bin/bash
# 集客ダッシュボードのPostHog・GA4・LINE Harness・GBP・Search Console分を毎朝launchdから同期する。
# (Claudeの定期タスクだとコマンドの確認待ちで止まることがあるため、Metaコネクタが要らない部分はここで動かす)
# 期間は5日分。Macが寝ていて1〜2日飛んでも、次の実行で埋まる。
export PATH="/Users/moritakeaki/.nvm/versions/node/v22.22.2/bin:$PATH"
cd /Users/moritakeaki/Downloads/ClaudeCode || exit 1

echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
node scripts/dashboard-sync.mjs --days 5
status=$?
node scripts/search-sync.mjs || status=1
exit $status
