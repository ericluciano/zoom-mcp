/**
 * Zoom OAuth 2.0 Authentication Script
 *
 * Rode uma vez para autorizar o MCP a acessar sua conta Zoom:
 *   node auth.js
 *
 * Isso abre o browser, pede login no Zoom, e salva os tokens em tokens.json.
 * O MCP renova automaticamente usando o refresh_token.
 */

import { createServer } from "http";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import open from "open";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOKENS_PATH = join(__dirname, "tokens.json");

const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || "http://localhost:4488/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "ERRO: Variáveis de ambiente obrigatórias não definidas.\n" +
    "Defina: ZOOM_CLIENT_ID e ZOOM_CLIENT_SECRET\n\n" +
    "Exemplo:\n" +
    '  ZOOM_CLIENT_ID=xxx ZOOM_CLIENT_SECRET=yyy node auth.js'
  );
  process.exit(1);
}

// Scopes necessários para o Zoom Team Chat MCP (nomes granulares)
const SCOPES = [
  // Canais
  "team_chat:read:list_user_channels",
  "team_chat:read:channel",
  "team_chat:read:list_members",
  "team_chat:write:user_channel",
  "team_chat:write:members",
  // Mensagens
  "team_chat:read:list_user_messages",
  "team_chat:read:user_message",
  "team_chat:read:thread_message",
  "team_chat:write:user_message",
  "team_chat:update:user_message",
  "team_chat:delete:user_message",
  "team_chat:update:message_emoji",
  // Contatos e sessões
  "team_chat:read:list_contacts",
  "team_chat:read:contact",
  "team_chat:read:list_user_sessions",
  // Emojis customizados
  "team_chat:read:list_custom_emojis",
  // Usuário
  "user:read:user",
  "user:read:email",
].join(" ");

const AUTH_URL =
  `https://zoom.us/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;

console.log("Abrindo browser para autorização do Zoom...\n");
console.log(`Se o browser não abrir, acesse manualmente:\n${AUTH_URL}\n`);

// Servidor HTTP local para capturar o callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:4488`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>Erro na autorização</h1><p>${error}</p>`);
    console.error(`Erro: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Erro</h1><p>Código de autorização não recebido.</p>");
    server.close();
    process.exit(1);
  }

  console.log("Código de autorização recebido. Trocando por tokens...");

  try {
    // Trocar authorization code por access_token + refresh_token
    const tokenResponse = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`HTTP ${tokenResponse.status}: ${errText}`);
    }

    const tokenData = await tokenResponse.json();

    // Salvar tokens com timestamp
    const tokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
      scope: tokenData.scope,
      created_at: Date.now(),
    };

    writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));

    console.log("\nTokens salvos em tokens.json!");
    console.log(`  access_token: ${tokens.access_token.substring(0, 20)}...`);
    console.log(`  refresh_token: ${tokens.refresh_token.substring(0, 20)}...`);
    console.log(`  expira em: ${tokens.expires_in}s`);
    console.log(`  scopes: ${tokens.scope}`);
    console.log("\nAutorização concluída! O MCP pode ser usado agora.");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>" +
      "<h1 style='color:#2D8CFF'>&#10004; Zoom MCP Autorizado!</h1>" +
      "<p>Tokens salvos com sucesso. Você pode fechar esta aba.</p>" +
      "</body></html>"
    );
  } catch (err) {
    console.error("Erro ao trocar código por tokens:", err.message);
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>Erro</h1><p>${err.message}</p>`);
  }

  // Fechar servidor após 1s
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 1000);
});

server.listen(4488, () => {
  console.log("Servidor de callback ouvindo em http://localhost:4488/callback\n");
  open(AUTH_URL);
});
