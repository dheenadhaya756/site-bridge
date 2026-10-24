# Site Bridge

Turn any website into an **agentic website**. Paste a URL and Site Bridge:

1. **Crawls** every public page it can reach (robots.txt, sitemap.xml, navigation links), using open-source tools only.
2. **Understands** the site with one Gemini Flash-Lite call: what the business does, key facts, offerings, FAQs, contact details, and the tasks a visitor can do.
3. **Generates** an **MCP server** for the site, plus `llms.txt` and `agent.json`.
4. Opens a **live demo**: the customer's real website with an AI agent panel at the side. The agent answers from the site's content and *operates the UI*: it opens pages, scrolls, highlights, clicks and fills forms, with a visible cursor.
5. Gives you a **one-line embed** so the agent can go on the customer's own site.

## Run it

```bash
npm install
cp .env.example .env      # then put your key in GEMINI_API_KEY
npm start
```

Open http://localhost:4100, paste a website, then click **Open live demo**.

Without a key, crawling, MCP, llms.txt and the preview all still work. Only the AI understanding step and the chat need Gemini.

## Cost per scan

| Step | Tool | Cost |
|---|---|---|
| Crawl + extract | `fetch` + `cheerio` (open source) | free |
| Search index | BM25 in plain JS (no embeddings) | free |
| Site understanding | 1 × Gemini Flash-Lite call, about 12–20k tokens | about ₹0.15–0.40 |

The result screen shows the real token count and ₹ cost for every scan. Chat messages are billed separately, at roughly ₹0.05–0.2 per visitor message on Flash-Lite. Change the prices and exchange rate in `.env` if they move.

## How it works

```
URL ─► crawler.js ─► builder.js ─► Gemini (1 call) ─► data/sites/<id>.json
                                                   │
          ┌────────────────────────────────────────┼─────────────────────────┐
          ▼                                        ▼                         ▼
   /mcp/<id>  (MCP server)        /preview/<id>  (live demo)        widget.js (embed)
   search_site, get_page,         iframe ◄─ proxy.js on              same agent, on the
   list_offerings, how_to_*…      <id>.localhost:4101                customer's real site
                                  + bridge.js injected
```

- **`lib/proxy.js`**: reverse proxy that serves the real site on its own subdomain (`<id>.localhost:4101`) with paths mapped 1:1, so client-side routers and the site's own JavaScript keep working. It strips `X-Frame-Options`/CSP and injects `bridge.js`. The site's scripts stay isolated from the Site Bridge app because they run on a different origin.
- **`public/bridge.js`**: runs inside the page. Takes snapshots of interactive elements and does click, fill, highlight and scroll, and draws the agent cursor. In the demo, POST forms are blocked so no real data is sent.
- **`lib/agent.js`**: Gemini function-calling loop. Knowledge tools (`search_site`, `get_page_content`) run on the server. UI tools (`navigate`, `click`, `fill`, `highlight`…) go back to the browser, which runs them in the live page and returns the results.
- **`lib/mcp.js`**: stateless MCP server over Streamable HTTP (JSON-RPC 2.0). Tools are generated from the site: generic ones plus `how_to_<task>` and `form_<name>` per site.

## Guardrails and security

The chat agent is locked to the website it was built for. Everything below is on by default and lives in `lib/guardrails.js`.

- **Scope.** The agent only helps with the site: its offerings, pages, policies and contact details. Off-topic questions (general knowledge, coding, politics, other companies...) get a short, friendly decline and an offer to help with the site instead. It never says "I will not answer" or lectures the visitor.
- **No leaks.** Requests for the system prompt, instructions, API keys, model/provider or the code behind the assistant get a polite fixed reply without calling the model. Replies are also scanned on the way out: anything that looks like an API key is redacted, and a reply that quotes the instructions is replaced.
- **Prompt injection.** Page text, search results, snapshots and pasted text are treated as data, never as instructions. Jailbreak phrasings ("ignore previous instructions", "developer mode", "you are now...") are answered politely and the persona never changes.
- **Signed history.** The browser keeps the conversation, so every turn the server produced is HMAC-signed. Forged assistant turns or tool results are dropped; the visitor's last message is still answered.
- **Input hygiene.** Messages are capped (`CHAT_MAX_MESSAGE_CHARS`), hidden and bidirectional control characters are stripped, oversized tool results are rejected and only tool results the model actually asked for are accepted.
- **Safe actions.** UI tools can only open pages of the site's own domain. The agent never types into password, one-time-code, card, bank or ID fields (checked on the server and again in the page), never submits payments, and asks for confirmation before any final submit. Demo pages already block POST forms.
- **Content safety.** Gemini's harassment, hate, sexual and dangerous-content filters are on; a blocked reply becomes a polite redirect.
- **Rate limits.** Per visitor IP (`CHAT_RATE_PER_MIN` / `CHAT_RATE_PER_HOUR`) and per site (`CHAT_SITE_RATE_*`). Set `TRUST_PROXY=1` behind a reverse proxy so limits see real IPs.

Guardrail events are logged as `[guard] ...` lines without message content.

## Connect the MCP server

```bash
claude mcp add --transport http <site-id> http://localhost:4100/mcp/<site-id>
```

The **MCP server** tab shows ready-to-paste configs for Claude Code, Cursor, VS Code, and Claude Desktop.

## Deploying

- Set `PUBLIC_URL=https://agentify.yourdomain.com`.
- Point a wildcard DNS record such as `*.preview.yourdomain.com` at the server and set `PREVIEW_URL_TEMPLATE=https://{id}.preview.yourdomain.com`, with `PREVIEW_PORT` behind your reverse proxy.
- JS-only sites (empty HTML) are rendered in a headless browser if Playwright is installed: `npm i playwright && npx playwright install chromium`.

## Notes & limits

- Only pages on the same site are crawled. robots.txt is respected, and private/internal addresses are refused.
- Some sites block automated traffic or iframes in ways the proxy can't undo, such as bot walls or strict CORS on API calls. The MCP server and chat still work for those sites, since they use the crawled data.
- Use it on sites you own or have permission to demo.
