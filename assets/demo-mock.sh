#!/bin/bash
# Mock outputs for VHS demo recording
# These simulate real zalo-agent-cli outputs without needing actual Zalo connection

case "$1" in
  "install")
    echo ""
    echo "added 1 package in 2s"
    echo ""
    echo "  zalo-agent-cli@1.0.31"
    echo "  https://github.com/ardennguyen/zalo-agent-cli"
    echo ""
    ;;
  "login")
    echo ""
    echo "  🔐 Starting QR login..."
    echo "  📡 QR server started at http://localhost:18927/qr"
    echo "  🌐 Public URL: http://45.76.123.45:18927/qr"
    echo ""
    echo "  ⏳ Waiting for QR scan... (expires in 60s)"
    echo "  📱 Open Zalo app → QR Scanner to scan"
    sleep 3
    echo ""
    echo "  ✅ QR scanned! Logging in..."
    sleep 1
    echo "  ✅ Login successful!"
    echo "  👤 Phuc Minh Pham (0901****67)"
    echo "  💾 Credentials saved to ~/.zalo-agent-cli/"
    echo ""
    ;;
  "status")
    echo ""
    echo "  ✅ Logged in"
    echo "  👤 Phuc Minh Pham"
    echo "  📱 IMEI: ****-****-****-7f3a"
    echo "  🕐 Session: active (2h 15m)"
    echo ""
    ;;
  "send")
    echo ""
    echo "  ✅ Message sent!"
    echo "  📨 To: Nhóm Dev Team (threadId: 7284591036)"
    echo "  💬 \"Xin chào team! Đây là tin nhắn từ AI agent 🤖\""
    echo "  🆔 msgId: msg_a8f2k9x3"
    echo "  🔑 cliMsgId: cli_7n4m2p1q"
    echo ""
    ;;
  "listen")
    echo ""
    echo "  🎧 Listening for events (message, friend)..."
    echo "  🔗 Webhook: http://n8n.local/webhook/zalo"
    echo "  ⚡ Filter: DM only | No self"
    echo ""
    sleep 2
    echo "  📨 [15:42:01] Anh Tú: Anh ơi gửi báo giá qua Zalo nhé"
    sleep 1.5
    echo "  📨 [15:42:15] Hương: Ok em confirm đơn hàng #1234"
    sleep 1.5
    echo "  📨 [15:42:30] Minh: @All meeting 3pm nha mọi người"
    sleep 1
    echo ""
    ;;
  "claude-prompt")
    # Simulate Claude Code response
    echo ""
    echo "  I'll send the message to your Dev Team group."
    echo ""
    echo "  zalo-agent msg send 7284591036 \"Xin chào team! Đây là tin nhắn từ AI agent 🤖\" -t 1"
    echo ""
    sleep 1
    echo "  ✅ Message sent successfully!"
    echo "  📨 To: Nhóm Dev Team"
    echo "  💬 \"Xin chào team! Đây là tin nhắn từ AI agent 🤖\""
    echo ""
    ;;
esac
