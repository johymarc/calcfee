# Calculadora de FEE (File Manager / Excel)

Card de UI Extension do HubSpot que calcula o FEE de uma operação e grava o
resultado nas propriedades do Ticket. As tarifas de cada cliente vêm de
**arquivos Excel públicos hospedados no File Manager** — não usa HubDB.

> Existe um projeto irmão, [`calculadora-fee`](../calculadora-fee), com a
> mesma interface mas lendo as tarifas de tabelas HubDB. Os dois projetos
> estão instalados na mesma conta e não dependem um do outro — se só for
> usar um dos dois, desinstale o outro para não haver duas abas de card
> duplicadas no Ticket.

## Por que Excel em vez de HubDB?

Esse projeto existe porque o cliente pode não ter acesso/permissão para
gerenciar tabelas HubDB, e porque manter os dados num arquivo Excel no File
Manager é mais simples para quem não é técnico: basta editar a planilha e
subir de novo. Também evita depender de um Private App Token com limites
de rate limit — as duas únicas chamadas autenticadas são leitura/escrita do
Ticket (CRM), com scope mínimo.

## Estrutura

```
src/app/
├── app-hsmeta.json              # config do app: scopes, auth, distribuição
├── cards/
│   ├── CalculadoraFee.jsx       # UI Extension (mesmo card do projeto HubDB)
│   └── calculadora-fee-hsmeta.json
└── functions/
    ├── getTicketContext.js      # carrega Ticket + empresas ao abrir o card
    ├── calcularFee.js           # calcula o FEE (não grava nada)
    ├── salvarFee.js             # grava o resultado no Ticket
    └── *-hsmeta.json            # config de cada function (endpoint, secrets)
```

## Fonte de dados (File Manager)

| Arquivo | URL |
|---|---|
| Tarifas Clientes | `https://20414094.fs1.hubspotusercontent-na1.net/hubfs/20414094/TARIFAS/tarifas_clientes_real%20(3).xlsx` |
| Feriados Brasil | `https://20414094.fs1.hubspotusercontent-na1.net/hubfs/20414094/TARIFAS/feriados_br.xlsx` |

Ambos os arquivos são **públicos** (sem exigir autenticação) — as
functions fazem `fetch()` direto na URL, sem token.

Colunas esperadas na planilha de tarifas (primeira aba): `hubspot_company_id`,
`nome_cliente`, `canal`, `oferta`, `tipo_fl`, `vol_min`/`vol_max`,
`pct_escrituracao`, `pct_deposito`, `pct_custodia`, `indexador`
(`volume_emissao` ou `prazo`), `fee_minimo`, `cap_fee`, `imposto`
(`mais_impostos` aplica gross-up). A planilha de feriados tem `data` e
`descricao`.

### ⚠️ Atualizando os arquivos

Ao subir uma nova versão da planilha no File Manager, use sempre
**"Replace"** no arquivo existente — nunca faça upload como arquivo novo.
Um upload novo gera uma URL diferente (ex: sufixo `(2)`, `(3)`), e as
functions ficariam apontando para a URL antiga até o código ser
atualizado manualmente com a nova URL.

O parser (`fetchXlsxRows` em `getTicketContext.js` e `calcularFee.js`) é
resiliente a uma linha de título extra antes do cabeçalho (comum quando o
Excel é re-exportado/re-salvo): ele procura a primeira linha com 2+ células
preenchidas para usar como cabeçalho, em vez de assumir que é sempre a
linha 1.

## Autenticação — secret `HUBSPOT_APP_TOKEN_FILES`

O app usa `auth.type: "static"`, então `context.userToken` só tem scopes de
CRM por padrão. Isso é suficiente para ler/gravar o Ticket, mas mesmo assim
usamos um Private App Token guardado no secret `HUBSPOT_APP_TOKEN_FILES`
como fallback (não é usado para acessar os arquivos Excel, que são
públicos e não exigem token):

```js
const token = process.env.HUBSPOT_APP_TOKEN_FILES || context.userToken;
```

Para atualizar o token (não precisa redeploy — a mudança vale em ~10s):

```bash
hs secret update HUBSPOT_APP_TOKEN_FILES --account=<nome-da-conta>
```

⚠️ **Secrets são por conta, não por projeto.** Esse secret tem nome
diferente do usado no projeto `calculadora-fee` (`HUBSPOT_APP_TOKEN`)
exatamente para evitar que atualizar o token de um projeto quebre o outro.

## Fórmula de cálculo (resumo)

Idêntica ao projeto HubDB — ver [`../calculadora-fee/README.md`](../calculadora-fee/README.md#fórmula-de-cálculo-resumo).

## Deploy

```bash
hs project upload --account=<nome-da-conta>
```
