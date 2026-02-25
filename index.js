import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOKENS_PATH = join(__dirname, "tokens.json");

const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const BASE_URL = "https://api.zoom.us/v2";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "ERRO: Variáveis de ambiente obrigatórias não definidas.\n" +
    "Defina: ZOOM_CLIENT_ID e ZOOM_CLIENT_SECRET"
  );
  process.exit(1);
}

// ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

let cachedTokens = null;

const ONBOARDING_MSG =
  "⚠️ Zoom não autorizado. O usuário precisa fazer login na conta Zoom dele.\n\n" +
  "**Passo a passo:**\n" +
  "1. Abra o terminal na pasta do zoom-mcp\n" +
  "2. Execute:\n" +
  "```\n" +
  "cd \"" + __dirname.replace(/\\/g, "/") + "\"\n" +
  "npm run auth\n" +
  "```\n" +
  "(As credenciais ZOOM_CLIENT_ID e ZOOM_CLIENT_SECRET devem estar definidas como variáveis de ambiente)\n\n" +
  "3. O browser vai abrir — faça login na sua conta Zoom e autorize\n" +
  "4. Após autorizar, os tokens são salvos automaticamente\n" +
  "5. Volte aqui e tente novamente\n\n" +
  "Obs: cada usuário faz isso apenas **uma vez**. O token renova automaticamente depois.";

function isAuthorized() {
  return existsSync(TOKENS_PATH);
}

function loadTokens() {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(ONBOARDING_MSG);
  }
  const data = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  cachedTokens = data;
  return data;
}

function saveTokens(tokens) {
  cachedTokens = tokens;
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function isTokenExpired(tokens) {
  if (!tokens || !tokens.created_at || !tokens.expires_in) return true;
  const expiresAt = tokens.created_at + tokens.expires_in * 1000;
  // Renovar 60s antes de expirar
  return Date.now() > expiresAt - 60_000;
}

async function refreshAccessToken(tokens) {
  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Falha ao renovar token (HTTP ${response.status}): ${errText}\n` +
      "Execute `node auth.js` novamente para reautorizar."
    );
  }

  const data = await response.json();
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    scope: data.scope,
    created_at: Date.now(),
  };
  saveTokens(newTokens);
  return newTokens;
}

async function getAccessToken() {
  let tokens = cachedTokens || loadTokens();
  if (isTokenExpired(tokens)) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

function friendlyError(status, defaultMsg) {
  const messages = {
    400: "Requisição inválida. Verifique os parâmetros.",
    401: "Token expirado ou inválido. Execute `node auth.js` novamente.",
    403: "Sem permissão. Verifique os scopes do app no Zoom Marketplace.",
    404: "Recurso não encontrado no Zoom.",
    429: "Limite de requisições do Zoom atingido. Tente novamente em alguns segundos.",
    500: "Erro interno do servidor Zoom.",
    502: "Zoom temporariamente indisponível.",
    503: "Zoom em manutenção.",
  };
  return messages[status] || defaultMsg || `Erro ${status} na API do Zoom.`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz requisição à API do Zoom com auto-refresh e retry.
 */
async function zoomRequest(method, path, { query = {}, body = null, retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const accessToken = await getAccessToken();

    // Montar URL com query params
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    };

    if (body && method !== "GET" && method !== "DELETE") {
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url.toString(), options);
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.error(`[Zoom] Erro de rede (tentativa ${attempt}/${retries}): ${err.message}. Retry em ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Erro de conexão com Zoom após ${retries} tentativas: ${err.message}`);
    }

    // Se 401, tentar refresh uma vez
    if (response.status === 401 && attempt === 1) {
      try {
        const tokens = cachedTokens || loadTokens();
        await refreshAccessToken(tokens);
        continue;
      } catch {
        throw new Error(friendlyError(401));
      }
    }

    if (!response.ok && RETRYABLE_STATUSES.includes(response.status) && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.error(`[Zoom] HTTP ${response.status} (tentativa ${attempt}/${retries}). Retry em ${delay}ms...`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      let errDetail = "";
      try {
        const errJson = await response.json();
        errDetail = errJson.message || errJson.error || JSON.stringify(errJson);
      } catch {
        errDetail = await response.text().catch(() => "");
      }
      throw new Error(`${friendlyError(response.status)} ${errDetail}`.trim());
    }

    // 204 No Content
    if (response.status === 204) {
      return {};
    }

    return await response.json();
  }
}

/**
 * Busca todas as páginas de um endpoint paginado do Zoom.
 */
async function zoomRequestAllPages(path, { query = {}, resultKey = null, maxPages = 10 } = {}) {
  const allItems = [];
  let pageToken = "";
  let pages = 0;

  do {
    const q = { ...query, page_size: 50 };
    if (pageToken) q.next_page_token = pageToken;

    const data = await zoomRequest("GET", path, { query: q });

    // Detectar automaticamente a chave do array de resultados
    const key = resultKey || Object.keys(data).find(
      (k) => Array.isArray(data[k]) && k !== "page_size"
    );
    if (key && data[key]) {
      allItems.push(...data[key]);
    }

    pageToken = data.next_page_token || "";
    pages++;
  } while (pageToken && pages < maxPages);

  return allItems;
}

// ─── MCP SERVER ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "zoom-mcp",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING / STATUS
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "zoom_status",
  "Verifica o status da conexão com o Zoom Team Chat. Mostra se o usuário está autorizado e as informações da conta.",
  {},
  async () => {
    if (!isAuthorized()) {
      return { content: [{ type: "text", text: ONBOARDING_MSG }] };
    }

    try {
      const data = await zoomRequest("GET", "/users/me");
      return {
        content: [{
          type: "text",
          text:
            "✅ Zoom conectado!\n\n" +
            `**Usuário:** ${data.first_name || ""} ${data.last_name || ""}\n` +
            `**Email:** ${data.email || "N/A"}\n` +
            `**Conta:** ${data.account_id || "N/A"}\n` +
            `**Tipo:** ${data.type === 1 ? "Basic" : data.type === 2 ? "Licensed" : `Tipo ${data.type}`}\n` +
            `**Status:** ${data.status || "N/A"}`
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `⚠️ Tokens encontrados mas a conexão falhou: ${err.message}\n\nTente rodar \`node auth.js\` novamente.`
        }],
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CANAIS (5 tools)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TOOL 1: LISTAR CANAIS ──────────────────────────────────────────────────

server.tool(
  "zoom_list_channels",
  "Lista todos os canais do Zoom Team Chat do usuário. Retorna ID, nome, tipo e número de membros de cada canal.",
  {
    page_size: z.number().optional().default(50).describe("Itens por página (máx 50)"),
  },
  async ({ page_size }) => {
    const channels = await zoomRequestAllPages("/chat/users/me/channels", {
      query: { page_size: Math.min(page_size, 50) },
      resultKey: "channels",
    });

    if (channels.length === 0) {
      return { content: [{ type: "text", text: "Nenhum canal encontrado." }] };
    }

    const formatted = channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type === 1 ? "Público" : ch.type === 2 ? "Privado" : ch.type === 3 ? "DM" : `Tipo ${ch.type}`,
      members: ch.channel_settings?.members_count ?? "N/A",
    }));

    return {
      content: [{ type: "text", text: `${channels.length} canal(is) encontrado(s):\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── TOOL 2: DETALHES DO CANAL ──────────────────────────────────────────────

server.tool(
  "zoom_get_channel",
  "Retorna detalhes de um canal específico do Zoom Team Chat (nome, tipo, configurações, membros).",
  {
    channel_id: z.string().describe("ID do canal (obtido via zoom_list_channels)"),
  },
  async ({ channel_id }) => {
    const data = await zoomRequest("GET", `/chat/channels/${channel_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── TOOL 3: CRIAR CANAL ────────────────────────────────────────────────────

server.tool(
  "zoom_create_channel",
  "Cria um novo canal no Zoom Team Chat.",
  {
    name: z.string().describe("Nome do canal"),
    type: z.number().optional().default(1).describe("Tipo: 1=Público (padrão), 2=Privado, 3=DM"),
    members: z.array(z.string()).optional().describe("Emails dos membros a adicionar (opcional)"),
  },
  async ({ name, type, members }) => {
    const body = { name, type };
    if (members && members.length > 0) {
      body.members = members.map((email) => ({ email }));
    }

    const data = await zoomRequest("POST", "/chat/users/me/channels", { body });
    return {
      content: [{ type: "text", text: `Canal criado!\nID: ${data.id}\nNome: ${data.name}` }],
    };
  }
);

// ─── TOOL 4: LISTAR MEMBROS DO CANAL ────────────────────────────────────────

server.tool(
  "zoom_list_channel_members",
  "Lista os membros de um canal do Zoom Team Chat.",
  {
    channel_id: z.string().describe("ID do canal"),
  },
  async ({ channel_id }) => {
    const members = await zoomRequestAllPages(`/chat/channels/${channel_id}/members`, {
      resultKey: "members",
    });

    if (members.length === 0) {
      return { content: [{ type: "text", text: "Nenhum membro encontrado neste canal." }] };
    }

    const formatted = members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : m.name || m.email,
      role: m.role,
    }));

    return {
      content: [{ type: "text", text: `${members.length} membro(s):\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── TOOL 5: CONVIDAR MEMBROS PARA CANAL ────────────────────────────────────

server.tool(
  "zoom_invite_channel_members",
  "Convida membros para um canal do Zoom Team Chat por email.",
  {
    channel_id: z.string().describe("ID do canal"),
    members: z.array(z.string()).describe("Emails dos membros a convidar"),
  },
  async ({ channel_id, members }) => {
    const body = {
      members: members.map((email) => ({ email })),
    };
    await zoomRequest("POST", `/chat/channels/${channel_id}/members`, { body });
    return {
      content: [{ type: "text", text: `${members.length} membro(s) convidado(s) para o canal.` }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// MENSAGENS (7 tools)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TOOL 6: ENVIAR MENSAGEM ────────────────────────────────────────────────

server.tool(
  "zoom_send_message",
  "Envia uma mensagem no Zoom Team Chat. Pode enviar para um canal (to_channel) ou como DM para um contato (to_contact). Para DM, use o email do destinatário.",
  {
    message: z.string().describe("Texto da mensagem"),
    to_channel: z.string().optional().describe("ID do canal destino (usar para mensagens em canal)"),
    to_contact: z.string().optional().describe("Email do contato destino (usar para DM)"),
    reply_main_message_id: z.string().optional().describe("ID da mensagem para responder em thread (opcional)"),
  },
  async ({ message, to_channel, to_contact, reply_main_message_id }) => {
    if (!to_channel && !to_contact) {
      return { content: [{ type: "text", text: "Erro: informe to_channel (ID do canal) ou to_contact (email) como destino." }] };
    }

    const body = { message };
    if (to_channel) body.to_channel = to_channel;
    if (to_contact) body.to_contact = to_contact;
    if (reply_main_message_id) body.reply_main_message_id = reply_main_message_id;

    const data = await zoomRequest("POST", "/chat/users/me/messages", { body });
    const dest = to_channel ? `canal ${to_channel}` : `contato ${to_contact}`;
    let msg = `Mensagem enviada para ${dest}.`;
    if (data.id) msg += ` ID: ${data.id}`;
    return { content: [{ type: "text", text: msg }] };
  }
);

// ─── TOOL 7: LISTAR MENSAGENS ───────────────────────────────────────────────

server.tool(
  "zoom_list_messages",
  "Lista mensagens de um canal ou conversa DM no Zoom Team Chat. Retorna as mensagens mais recentes.",
  {
    to_channel: z.string().optional().describe("ID do canal para listar mensagens"),
    to_contact: z.string().optional().describe("Email do contato para listar DMs"),
    date: z.string().optional().describe("Data para filtrar (YYYY-MM-DD). Padrão: hoje."),
    page_size: z.number().optional().default(50).describe("Quantidade de mensagens (máx 50)"),
    include_deleted_and_edited_message: z.boolean().optional().describe("Incluir mensagens editadas/deletadas"),
  },
  async ({ to_channel, to_contact, date, page_size, include_deleted_and_edited_message }) => {
    if (!to_channel && !to_contact) {
      return { content: [{ type: "text", text: "Erro: informe to_channel (ID do canal) ou to_contact (email)." }] };
    }

    const query = {
      page_size: Math.min(page_size, 50),
    };
    if (to_channel) query.to_channel = to_channel;
    if (to_contact) query.to_contact = to_contact;
    if (date) query.date = date;
    if (include_deleted_and_edited_message) query.include_deleted_and_edited_message = true;

    const data = await zoomRequest("GET", "/chat/users/me/messages", { query });
    const messages = data.messages || [];

    if (messages.length === 0) {
      return { content: [{ type: "text", text: "Nenhuma mensagem encontrada." }] };
    }

    const formatted = messages.map((m) => ({
      id: m.id,
      sender: m.sender || m.sender_display_name || "N/A",
      message: m.message || "",
      date_time: m.date_time || "",
      timestamp: m.timestamp || "",
    }));

    return {
      content: [{ type: "text", text: `${messages.length} mensagem(ns):\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── TOOL 8: DETALHES DA MENSAGEM ───────────────────────────────────────────

server.tool(
  "zoom_get_message",
  "Retorna detalhes de uma mensagem específica do Zoom Team Chat.",
  {
    message_id: z.string().describe("ID da mensagem"),
    to_channel: z.string().optional().describe("ID do canal onde está a mensagem"),
    to_contact: z.string().optional().describe("Email do contato (para DMs)"),
  },
  async ({ message_id, to_channel, to_contact }) => {
    const query = {};
    if (to_channel) query.to_channel = to_channel;
    if (to_contact) query.to_contact = to_contact;

    const data = await zoomRequest("GET", `/chat/users/me/messages/${message_id}`, { query });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── TOOL 9: EDITAR MENSAGEM ────────────────────────────────────────────────

server.tool(
  "zoom_update_message",
  "Edita uma mensagem já enviada no Zoom Team Chat.",
  {
    message_id: z.string().describe("ID da mensagem a editar"),
    message: z.string().describe("Novo texto da mensagem"),
    to_channel: z.string().optional().describe("ID do canal onde está a mensagem"),
    to_contact: z.string().optional().describe("Email do contato (para DMs)"),
  },
  async ({ message_id, message, to_channel, to_contact }) => {
    const body = { message };
    if (to_channel) body.to_channel = to_channel;
    if (to_contact) body.to_contact = to_contact;

    await zoomRequest("PUT", `/chat/users/me/messages/${message_id}`, { body });
    return { content: [{ type: "text", text: `Mensagem ${message_id} editada com sucesso.` }] };
  }
);

// ─── TOOL 10: DELETAR MENSAGEM ──────────────────────────────────────────────

server.tool(
  "zoom_delete_message",
  "Deleta uma mensagem no Zoom Team Chat.",
  {
    message_id: z.string().describe("ID da mensagem a deletar"),
    to_channel: z.string().optional().describe("ID do canal onde está a mensagem"),
    to_contact: z.string().optional().describe("Email do contato (para DMs)"),
  },
  async ({ message_id, to_channel, to_contact }) => {
    const query = {};
    if (to_channel) query.to_channel = to_channel;
    if (to_contact) query.to_contact = to_contact;

    await zoomRequest("DELETE", `/chat/users/me/messages/${message_id}`, { query });
    return { content: [{ type: "text", text: `Mensagem ${message_id} deletada.` }] };
  }
);

// ─── TOOL 11: REAGIR A MENSAGEM ─────────────────────────────────────────────

server.tool(
  "zoom_react_message",
  "Adiciona ou remove uma reação emoji em uma mensagem do Zoom Team Chat.",
  {
    message_id: z.string().describe("ID da mensagem"),
    emoji: z.string().describe("Emoji para reagir (ex: 'thumbsup', 'heart', '+1', ou emoji Unicode)"),
    action: z.enum(["add", "remove"]).optional().default("add").describe("Ação: add (padrão) ou remove"),
    to_channel: z.string().optional().describe("ID do canal"),
    to_contact: z.string().optional().describe("Email do contato (para DMs)"),
  },
  async ({ message_id, emoji, action, to_channel, to_contact }) => {
    const body = { emoji, action };
    if (to_channel) body.to_channel = to_channel;
    if (to_contact) body.to_contact = to_contact;

    await zoomRequest("PATCH", `/chat/users/me/messages/${message_id}/emoji_reactions`, { body });
    const actionText = action === "add" ? "adicionada" : "removida";
    return { content: [{ type: "text", text: `Reação ${emoji} ${actionText} na mensagem ${message_id}.` }] };
  }
);

// ─── TOOL 12: LISTAR THREAD ─────────────────────────────────────────────────

server.tool(
  "zoom_list_thread",
  "Lista as respostas de uma thread (conversa encadeada) de uma mensagem no Zoom Team Chat.",
  {
    message_id: z.string().describe("ID da mensagem principal da thread"),
    to_channel: z.string().optional().describe("ID do canal"),
    to_contact: z.string().optional().describe("Email do contato (para DMs)"),
    page_size: z.number().optional().default(50).describe("Quantidade de respostas (máx 50)"),
  },
  async ({ message_id, to_channel, to_contact, page_size }) => {
    const query = { page_size: Math.min(page_size, 50) };
    if (to_channel) query.to_channel = to_channel;
    if (to_contact) query.to_contact = to_contact;

    const data = await zoomRequest("GET", `/chat/users/me/messages/${message_id}/thread`, { query });
    const replies = data.messages || [];

    if (replies.length === 0) {
      return { content: [{ type: "text", text: "Nenhuma resposta encontrada nesta thread." }] };
    }

    const formatted = replies.map((m) => ({
      id: m.id,
      sender: m.sender || m.sender_display_name || "N/A",
      message: m.message || "",
      date_time: m.date_time || "",
    }));

    return {
      content: [{ type: "text", text: `${replies.length} resposta(s) na thread:\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CONTATOS E SESSÕES (3 tools)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TOOL 13: LISTAR CONTATOS ───────────────────────────────────────────────

server.tool(
  "zoom_list_contacts",
  "Lista os contatos do Zoom Team Chat do usuário.",
  {
    type: z.enum(["company", "external"]).optional().default("company").describe("Tipo: company (mesma org, padrão) ou external"),
    page_size: z.number().optional().default(50).describe("Itens por página (máx 50)"),
  },
  async ({ type, page_size }) => {
    const contacts = await zoomRequestAllPages("/chat/users/me/contacts", {
      query: { type, page_size: Math.min(page_size, 50) },
      resultKey: "contacts",
    });

    if (contacts.length === 0) {
      return { content: [{ type: "text", text: "Nenhum contato encontrado." }] };
    }

    const formatted = contacts.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : c.name || c.email,
      presence_status: c.presence_status || "N/A",
    }));

    return {
      content: [{ type: "text", text: `${contacts.length} contato(s):\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── TOOL 14: BUSCAR CONTATOS ───────────────────────────────────────────────

server.tool(
  "zoom_search_contacts",
  "Busca contatos na empresa pelo nome ou email no Zoom.",
  {
    search_key: z.string().describe("Termo de busca (nome ou email)"),
    page_size: z.number().optional().default(20).describe("Quantidade de resultados (máx 50)"),
  },
  async ({ search_key, page_size }) => {
    const data = await zoomRequest("GET", "/contacts", {
      query: {
        search_key,
        type: "company",
        page_size: Math.min(page_size, 50),
      },
    });

    const contacts = data.contacts || [];

    if (contacts.length === 0) {
      return { content: [{ type: "text", text: `Nenhum contato encontrado para "${search_key}".` }] };
    }

    const formatted = contacts.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : c.name || c.email,
      presence_status: c.presence_status || "N/A",
    }));

    return {
      content: [{ type: "text", text: `${contacts.length} resultado(s) para "${search_key}":\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── TOOL 15: LISTAR SESSÕES/CONVERSAS ──────────────────────────────────────

server.tool(
  "zoom_list_sessions",
  "Lista as sessões/conversas recentes do Zoom Team Chat (canais e DMs com atividade recente).",
  {
    from: z.string().optional().describe("Data inicial (YYYY-MM-DD)"),
    to: z.string().optional().describe("Data final (YYYY-MM-DD)"),
  },
  async ({ from, to }) => {
    const query = {};
    if (from) query.from = from;
    if (to) query.to = to;

    const data = await zoomRequest("GET", "/chat/users/me/sessions", { query });
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      return { content: [{ type: "text", text: "Nenhuma sessão recente encontrada." }] };
    }

    const formatted = sessions.map((s) => ({
      session_id: s.session_id,
      name: s.name || "N/A",
      type: s.type || "N/A",
      last_message_sent_time: s.last_message_sent_time || "N/A",
    }));

    return {
      content: [{ type: "text", text: `${sessions.length} sessão(ões) recente(s):\n\n${JSON.stringify(formatted, null, 2)}` }],
    };
  }
);

// ─── START ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
