# 一次性探针:用 SPA 的 access token 直接打 /api/office/ai/chat,验证 SSE 全链路。
$tok = (Get-Content "$PSScriptRoot\.e2e-token" -Raw).Trim()
$uuid = [guid]::NewGuid().ToString()
$body = '{"capability":"chat","messages":[{"role":"user","content":"只回复两个字:你好"}]}'
$bodyFile = "$PSScriptRoot\.e2e-body.json"
[IO.File]::WriteAllText($bodyFile, $body)
curl.exe -N -s -X POST 'http://127.0.0.1:3001/api/office/ai/chat' `
  -H "Authorization: Bearer $tok" `
  -H "idempotency-key: $uuid" `
  -H 'Content-Type: application/json' `
  --data-binary "@$bodyFile" `
  --max-time 90
""
"exit=$LASTEXITCODE"
