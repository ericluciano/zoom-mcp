# Zoom MCP Server

MCP (Model Context Protocol) server para integração com o Zoom Team Chat. Permite que assistentes AI (Claude Code, Claude Desktop, etc.) enviem mensagens e interajam com canais do Zoom.

## Funcionalidades

- **Mensagens**: enviar mensagens em canais e chats
- **Canais**: buscar e listar canais disponíveis
- **Autenticação**: OAuth 2.0 via Zoom Marketplace (abre browser automaticamente)

## Pré-requisitos

- Node.js 18+
- Conta Zoom com acesso ao Marketplace
- App OAuth criado no [Zoom Marketplace](https://marketplace.zoom.us)

## Instalação

```bash
git clone https://github.com/ericluciano/zoom-mcp.git
cd zoom-mcp
npm install
```

## Configuração

### 1. Criar App no Zoom Marketplace

1. Acesse [marketplace.zoom.us](https://marketplace.zoom.us)
2. Crie um novo app do tipo **User-managed app** (OAuth)
3. Copie o **Client ID** e **Client Secret**
4. Configure o Redirect URL para `http://localhost:3000/callback`

### 2. Variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com seu Client ID e Client Secret
```

### 3. Autenticar

```bash
npm run auth
# Abrirá o browser para login OAuth com sua conta Zoom
# Tokens salvos automaticamente em tokens.json
```

### 4. Adicionar ao Claude Desktop

`C:\Users\SeuUsuario\AppData\Roaming\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zoom-mcp": {
      "command": "node",
      "args": ["C:\\caminho\\para\\zoom-mcp\\index.js"],
      "env": {
        "ZOOM_CLIENT_ID": "seu_client_id_aqui",
        "ZOOM_CLIENT_SECRET": "seu_client_secret_aqui"
      }
    }
  }
}
```

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm start` | Inicia o MCP server |
| `npm run auth` | Faz login OAuth com conta Zoom |

## Segurança

- Credenciais via variáveis de ambiente — nunca commitadas
- `tokens.json` (cache OAuth) está no `.gitignore`
- `.env` está no `.gitignore`

## Licença

MIT
