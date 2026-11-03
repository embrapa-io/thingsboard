# Acesso por laboratório (RBAC)

Modelo de acesso da Central no ThingsBoard 4.4. A proposta completa, com diagramas, está em
`proposta-rbac-thingsboard-4.4.pdf`, na raiz do projeto.

| Perfil | Authority | No ThingsBoard |
| --- | --- | --- |
| Equipe técnica | `TENANT_ADMIN` | Tudo: regras, catálogo, Edge, automações |
| Gestor da unidade | `CUSTOMER_USER` | Lê a unidade inteira; cria laboratórios e põe pessoas nos grupos |
| Responsável | `CUSTOMER_USER` | No laboratório: cadastra dispositivos, lê o token, monta painéis |
| Integrante | `CUSTOMER_USER` | Lê os dispositivos e painéis do laboratório |

Um laboratório é um asset da unidade, com perfil `Laboratório`, `Casa de vegetação` ou
`Campo experimental`, e 4 grupos da unidade:

| Grupo | Responsáveis | Equipe |
| --- | --- | --- |
| `<lab> · Dispositivos` | Laboratório · Edição | Laboratório · Leitura |
| `<lab> · Painéis` | Laboratório · Edição | Laboratório · Leitura |

Os grupos de pessoas são `<lab> · Responsáveis` e `<lab> · Equipe`. Os dois recebem
também o papel genérico `Interface`. Os gestores ficam no grupo `Gestores` da unidade, com
`Unidade · Leitura`, `Unidade · Criação de laboratórios` e `Interface`.

Nenhum papel concede `RPC_CALL`, campos calculados, rule chains, `IMPERSONATE`,
`CHANGE_OWNER`, chave de API, Edge ou escrita em papéis e permissões.

## Como um laboratório nasce

1. O gestor cria o asset com um dos perfis acima, dentro da unidade.
2. A rule chain `Embrapa · Criar laboratório`, ligada a esses perfis, cria os 4 grupos e
   os 6 vínculos. Ela grava `laboratorioStatus` e `laboratorioGrupos` no asset.
3. O gestor grava o atributo de servidor `responsavel` (e-mail). A regra confere se a pessoa
   é da mesma unidade e a põe em Responsáveis, gravando `responsavelStatus`. Se der erro,
   grava o motivo em `responsavelErro`.
4. O gestor põe os integrantes em `<lab> · Equipe`.

A regra repassa toda mensagem à rule chain raiz, então o resto do processamento não muda.
As chamadas à API usam a conta de serviço `servico.laboratorios@embrapa.local`, com o papel
mínimo `Serviço · Laboratórios`. A chave dela fica no cabeçalho dos nós REST: o Secrets
storage desta instalação não tem chave de criptografia ("Encryption failed"). Só os admins
do tenant leem rule chains. Ainda assim, trate exportações da regra como sigilosas.

## Scripts

Todos usam a chave de API do tenant do `backend/.env` e nunca a imprimem. Sem `--aplicar`,
só simulam.

```powershell
cd thingsboard\rbac
..\..\_tools\node.exe instalar.mjs [--aplicar]   # papéis, conta de serviço, regra e perfis (só acrescenta)
..\..\_tools\node.exe testar.mjs                 # ponta a ponta com o token de cada pessoa (cria e apaga uma unidade de teste)
..\..\_tools\node.exe migrar.mjs [--aplicar]     # leva os laboratórios "LOC · ..." para este modelo
..\..\_tools\node.exe servico-telemetria.mjs [--aplicar]  # conta de serviço do telemetry-gateway e TB_TELEMETRY_TOKEN
..\..\_tools\node.exe conferir-telemetria.mjs    # confere que essa conta só lê telemetria
```

### Conta de serviço da telemetria

O telemetry-gateway lê a telemetria com `servico.telemetria@embrapa.local`, do grupo do tenant
`Serviço · Telemetria`, cujo único papel dá `READ` e `READ_TELEMETRY` em `DEVICE`. Antes, ele usava
a chave pessoal de um administrador do tenant. `servico-telemetria.mjs --aplicar` cria a conta, gera
a chave dela e a grava em `TB_TELEMETRY_TOKEN` no `thingsboard/.env`; depois, recrie o contêiner
(`docker compose up -d telemetry-gateway`). Conferência de 2026-11-02: lê a telemetria das 3
unidades e recebe 403 em credencial MQTT, gravação de telemetria, RPC, rule chains e papéis; a
lista de usuários vem vazia.

Antes de `migrar.mjs --aplicar`, faça o backup do banco, com `pg_dump` dentro do contêiner e `-f`.

## Resultado do teste (2026-11-02): 29 de 29

- **Gestor:** cria o laboratório; põe pessoas nos grupos; lê os sensores da unidade. Recebe 403 para ler token, mandar RPC, criar papel e vincular papéis.
- **Regra:** cria os 4 grupos e os 6 vínculos; recusa responsável de outra unidade; põe o responsável certo no grupo.
- **Responsável:** cadastra sensor, lê o token e cria painel. Recebe 403 para RPC e rule chains.
- **Integrante:** vê o sensor e o painel. Recebe 403 para token, cadastro e gravação de atributo.
- **Outra unidade:** recebe 403 no sensor, no painel e no laboratório.

O gestor consegue se pôr em `Responsáveis` e ganhar Edição num laboratório. Isso é coerente
com ele administrar a unidade.

## Limpeza e migração da Central de desenvolvimento (2026-11-02)

Backup antes: `thingsboard/backup/thingsboard-20261102-161134-antes-limpeza-e-migracao.sql.gz`.

| Removido | Itens |
| --- | --- |
| Demonstração PAVAP DEMO | 3 dispositivos e os 2 campos calculados deles, 1 asset, 1 dashboard, 4 usuários `pavap.*@demo.invalid`, 9 grupos, 7 papéis |
| Unidade "PAVAP · Piloto de interface" (CAT) | 7 dispositivos, 8 assets, a unidade com usuários e dashboards, 11 papéis |
| Sobras | 2 rule chains "teste", "New Dashboard", papéis "teste" e "Leitor de dashboard", grupos de tenant criados pelo upgrade 4.3 → 4.4, papéis do modelo anterior, 7 perfis de asset e 2 de dispositivo sem uso |
| Acesso amplo | maxwell saiu de "Customer Administrators" (a conta continua, sem laboratório) |

Os 7 laboratórios `LOC · ...` foram migrados (`migrar.mjs --aplicar`): os assets passaram
para as unidades e os grupos foram renomeados para `<lab> · Dispositivos`, com os mesmos
sensores e a mesma atribuição ao Edge. O painel "PAVAP · Monitoramento" foi para o grupo de
painéis do PAVAP. O MVP (unidade "PAVAP · MVP operacional", Edge `pavap-mvp`) não foi tocado.

Depois, para ficar só com os dispositivos da qualificação (Tabela 3.1 e estudo de caso do
PAVAP), saíram também, com backup em `thingsboard-20261102-162156-antes-remover-mvp-e-extras.sql.gz`:

- o MVP inteiro: 14 dispositivos, o Edge "PAVAP MVP Edge", a unidade, 3 dashboards, papéis,
  perfis, rule chains e widgets. Os contêineres `pavap-mvp` foram parados, com os volumes preservados;
- `teste_tasmota`, `heltec-lora-v2-01`, `Estacao_Meteorologica_Triangulo_01` e `Balanca_Cocho_Lote_A_01`.
  Os dois últimos também saíram do simulador e do projeto `teste1`.

Ficaram os 11 dispositivos propostos, todos online. Os vínculos do Embrapa I/O apontavam para ids
anteriores à recarga da Central e foram reapontados pelo nome.

Por fim, saíram as relações do modelo anterior, com backup em
`thingsboard-20261102-164003-antes-remover-relacoes.sql.gz`: as 11 `Contains` dos laboratórios
migrados e as 7 `AccessibleBy`. O laboratório de cada dispositivo vem só do grupo. As
`AccessibleBy` indicavam acessos que, no modelo novo, dependem de pôr a pessoa no grupo:

| Pessoa | Tinha acesso a |
| --- | --- |
| fdsfds@embrapa.br | PAVAP, Casa de vegetação 01, Campo experimental Campo Grande, Fazenda Nhumirim |
| stage1.pilot@embrapa.br | Campo experimental Campo Grande; dispositivo Aquecedor_Ambiental_PAVAP_01 |
| mariana.pereira@embrapa.br | dispositivo Valvula_Agua_Remota_Pantanal_01 |

Conferência depois: o backend lista os 7 laboratórios. fdsfds vê os 6 sensores do PAVAP. O
gestor da Gado de Corte vê os 10 sensores da unidade. `testar.mjs` passou com 26 de 26.

## Integração com o Embrapa I/O

- O backend calcula o escopo pelo que a própria pessoa vê (`/api/user/devices` com o token
  dela, obtido por `/api/user/{id}/token`). Ele não lê mais as relações `AccessibleBy`.
- Dispositivos aparecem na aba Disponíveis pelo grupo `<lab> · Dispositivos`
  (`laboratorioGrupos`). As relações `Contains` do modelo anterior foram removidas.
- "Dados de conexão" pede o token do dispositivo como a própria pessoa: quem não tem Edição
  recebe `DEVICE_CREDENTIAL_ACCESS_FORBIDDEN`.
- A aba Aplicações dá a programas externos uma chave que só lê os sensores escolhidos
  (detalhes em `thingsboard/README.md`, "Camada de telemetria").
- O auth-gateway não exige mais `manager=true` (`TB_AUTH_GATEWAY_REQUIRE_MANAGER=false`).
