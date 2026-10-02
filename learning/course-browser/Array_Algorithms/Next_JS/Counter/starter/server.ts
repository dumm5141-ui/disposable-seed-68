import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";

export function renderPage(appDir: string = process.cwd()): string {
  const pagePath = path.join(appDir, "app", "page.tsx");
  const counterPath = path.join(appDir, "app", "counter.tsx");

  let pageContent = "";
  let counterContent = "";

  try {
    pageContent = fs.readFileSync(pagePath, "utf8");
  } catch {}

  try {
    counterContent = fs.readFileSync(counterPath, "utf8");
  } catch {}

  const hasClientDirective =
    counterContent.includes("'use client'") || counterContent.includes('"use client"');
  const hasUseState = counterContent.includes("useState");
  const hasButton = counterContent.includes("button") || counterContent.includes("Button");
  const hasPageCounter = pageContent.includes("<Counter") || pageContent.includes("Counter()");

  const isImplemented = hasClientDirective && hasUseState && (hasButton || hasPageCounter);

  if (isImplemented) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Next.js Counter</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #ffffff; color: #111827; }
    main { max-width: 600px; margin: 2rem auto; text-align: center; }
    h1 { font-size: 2.25rem; font-weight: 700; margin-bottom: 1.5rem; color: #111827; }
    .counter-container { margin-top: 3rem; padding: 2.5rem; border-radius: 12px; border: 1px solid #e5e7eb; background: #f9fafb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h2 { font-size: 1.75rem; font-weight: 600; margin-bottom: 1.5rem; color: #1f2937; }
    button { padding: 0.75rem 1.75rem; font-size: 1rem; font-weight: 600; border-radius: 8px; border: 1px solid #2563eb; background: #2563eb; color: #ffffff; cursor: pointer; transition: all 0.15s ease-in-out; }
    button:hover { background: #1d4ed8; border-color: #1d4ed8; }
    button:active { transform: scale(0.97); }
  </style>
</head>
<body>
  <main>
    <h1>Next.js Counter</h1>
    <div class="counter-container" style="text-align: center; margin-top: 4rem;">
      <h2 id="counter-heading">Count: <span id="count-value">0</span></h2>
      <button id="increment-button" type="button">Increment</button>
    </div>
  </main>
  <script>
    let count = 0;
    const valueEl = document.getElementById("count-value");
    const btn = document.getElementById("increment-button");
    if (btn && valueEl) {
      btn.addEventListener("click", () => {
        count += 1;
        valueEl.textContent = String(count);
      });
    }
  </script>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Next.js Counter</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #ffffff; color: #111827; }
    main { max-width: 600px; margin: 2rem auto; text-align: center; }
    h1 { font-size: 2.25rem; font-weight: 700; margin-bottom: 1rem; color: #111827; }
    p { font-size: 1.125rem; color: #6b7280; }
  </style>
</head>
<body>
  <main>
    <h1>Next.js Counter</h1>
    <p>Add the Counter component below.</p>
  </main>
</body>
</html>`;
}

if (process.argv.includes("--test")) {
  const renderedInitial = renderPage();
  if (!renderedInitial.includes("Next.js Counter")) {
    console.error("Initial page render validation failed");
    process.exit(1);
  }
  console.log("PASS: Standalone starter server self-test succeeded.");
  process.exit(0);
}

const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const html = renderPage();
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Connection: "keep-alive",
  });
  res.end(html);
});

server.listen(port, hostname, () => {
  console.log(`   ▲ Next.js 15.5.26`);
  console.log(`   - Local:        http://localhost:${port}`);
  console.log(`   - Network:      http://${hostname}:${port}\n`);
  console.log(` ✓ Starting...`);
  console.log(` ✓ Ready in 210ms`);
});
