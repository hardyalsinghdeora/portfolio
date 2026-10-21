# Minimal static server for local checks (no Node needed). Serves the repo root, so
#   http://localhost:8787/tests/       runs the test page
#   http://localhost:8787/dist/        previews the built site
# /api/ask answers with a canned reply in the real wire format (text, U+001E, meta JSON),
# so the page's sources and agent-trace UI can be checked without an API key.
# For the real agent locally, use: npx wrangler pages dev dist
param([int]$Port = 8787)
$root = Split-Path $PSScriptRoot -Parent
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8'; '.pdf'='application/pdf'; '.json'='application/json'; '.css'='text/css'; '.svg'='image/svg+xml'; '.png'='image/png'; '.ico'='image/x-icon' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
"serving $root on http://localhost:$Port/"
$utf8 = New-Object System.Text.UTF8Encoding($false)
while ($listener.IsListening) {
  $ctx = $listener.GetContext(); $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -like '*/api/ask') {
      $meta = '{"sources":[{"id":"agentic-agents","title":"Agentic AI: agents in production"},{"id":"project-0","title":"Project: Portfolio agent with hybrid RAG"}],"steps":[{"tool":"search_profile","args":{"query":"AI agents in production"},"found":["Agentic AI: agents in production","Project: Portfolio agent with hybrid RAG"]}],"retrieval":"hybrid"}'
      $bytes = $utf8.GetBytes("(Local mock) I run an unattended PR-review agent that uses MCP tools every 30 minutes." + [char]0x1e + $meta)
      $res.ContentType = 'text/plain; charset=utf-8'
    } else {
      $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
      if (Test-Path $file -PathType Container) { $file = Join-Path $file 'index.html' }
      $full = [IO.Path]::GetFullPath($file)
      if (-not $full.StartsWith($root) -or -not (Test-Path $full -PathType Leaf)) { $res.StatusCode = 404; $bytes = $utf8.GetBytes('not found') }
      else { $bytes = [IO.File]::ReadAllBytes($full); $ext = [IO.Path]::GetExtension($full).ToLower(); if ($types[$ext]) { $res.ContentType = $types[$ext] } }
    }
    $res.Headers.Add('cache-control', 'no-store')
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch { $res.StatusCode = 500 } finally { $res.Close() }
}
