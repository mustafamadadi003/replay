New-NetFirewallRule -DisplayName "OpenReply v2 LAN 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
# also allow if exists update
Get-NetFirewallRule -DisplayName "OpenReply v2 LAN 3001" -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -Action Allow
"FIREWALL_DONE" | Out-File -FilePath "d:\open reply\openreply-v2\.firewall-ok.txt" -Encoding utf8
