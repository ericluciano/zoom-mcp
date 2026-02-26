# Zoom MCP Server

MCP (Model Context Protocol) server para integração com o Zoom Team Chat. Permite que assistentes AI (Claude Code, Claude Desktop, etc.) enviem mensagens e interajam com canais do Zoom.

> **Credenciais são pessoais.** Cada pessoa usa seu próprio App OAuth no Zoom Marketplace. Nenhuma credencial está incluída neste repositório.

## Funcionalidades

- **Mensagens**: enviar mensagens em canais e chats
- **Canais**: buscar e listar canais disponíveis
- **Autenticação**: OAuth 2.0 via Zoom Marketplace (abre browser automaticamente)

## Pré-requisitos

- Node.js 18+
- Conta Zoom
- App OAuth criado no [Zoom Marketplace](https://marketplace.zoom.us) (veja passo 2)

## Como usar

### 1. Clonar e instalar

```bash
git clone https://github.com/ericluciano/zoom-mcp.git
cd zoom-mcp
npm install
```

### 2. Criar App OAuth no Zoom Marketplace

1. Acesse [marketplace.zoom.us](https://marketplace.zoom.us) com **sua conta Zoom**
2. Clique em **Develop > Build App**
3. Escolha o tipo **User-managed app** (OAuth)
4. Copie o **Client ID** e **Client Secret** gerados
5. Configure o Redirect URL para `http://localhost:4488/callback`

### 3. Configurar suas credenciais

```bash
cp .env.example .env
# Abra o .env e preencha com seu Client ID e Client Secret
```

### 4. Autenticar com sua conta

```bash
npm run auth
```

O browser abrirá automaticamente para você autorizar o app com **sua conta Zoom**. Os tokens são salvos localmente em `tokens.json` (apenas na sua máquina, nunca no repositório).

### 5. Registrar no Claude Desktop

Edite `C:\Users\SeuUsuario\AppData\Roaming\Claude\claude_desktop_config.json` e adicione:

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

> Substitua pelos valores do **seu app OAuth**. Esse arquivo fica apenas na sua máquina.

### 6. Reiniciar o Claude Desktop

Feche e reabra o Claude Desktop para carregar o MCP.

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm start` | Inicia o MCP server |
| `npm run auth` | Faz login OAuth com sua conta Zoom |

## Segurança

- Credenciais via variáveis de ambiente — nunca commitadas no repositório
- `.env` está no `.gitignore`
- `tokens.json` (cache OAuth) está no `.gitignore`

## Licença

MIT
