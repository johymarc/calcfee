# Calculadora de FEE (HubDB)

Card de UI Extension do HubSpot que calcula o FEE de uma operação e grava o
resultado nas propriedades do Ticket. As tarifas de cada cliente vêm de
tabelas **HubDB**.

> Existe um segundo projeto irmão, [`calculadora-fee-files`](../calculadora-fee-files),
> com a mesma interface mas lendo as tarifas de um arquivo Excel no File
> Manager em vez de HubDB. Os dois projetos estão instalados na mesma conta
> e não dependem um do outro — se só for usar um dos dois, desinstale o
> outro para não haver duas abas de card duplicadas no Ticket.

## Estrutura

```
src/app/
├── app-hsmeta.json              # config do app: scopes, auth, distribuição
├── cards/
│   ├── CalculadoraFee.jsx       # UI Extension (card exibido na aba do Ticket)
│   └── calculadora-fee-hsmeta.json
└── functions/
    ├── getTicketContext.js      # carrega Ticket + empresas ao abrir o card
    ├── calcularFee.js           # calcula o FEE (não grava nada)
    ├── salvarFee.js             # grava o resultado no Ticket
    └── *-hsmeta.json            # config de cada function (endpoint, secrets)
```

## Fonte de dados (HubDB)

| Tabela | ID | Conteúdo |
|---|---|---|
| Tarifas Clientes | `412478026` | uma linha por combinação empresa + canal + oferta + tipo_fl + faixa de volume |
| Feriados Brasil | `412478027` | feriados nacionais, usados no cálculo de dias úteis |

Colunas relevantes da tabela de tarifas: `hubspot_company_id`, `nome_cliente`,
`canal`, `oferta`, `tipo_fl`, `vol_min`/`vol_max`, `pct_escrituracao`,
`pct_deposito`, `pct_custodia`, `indexador` (`volume_emissao` ou `prazo`),
`fee_minimo`, `cap_fee`, `imposto` (`mais_impostos` aplica gross-up).

## Autenticação — por que existe o secret `HUBSPOT_APP_TOKEN`

O app usa `auth.type: "static"` (app privado, sem fluxo OAuth). Isso dá ao
card um `context.userToken` com scopes de **CRM** (ticket/company), mas
**não** com os scopes de HubDB (`hubdb.tables.read`, `hubdb.rows.read`) —
mesmo declarando esses scopes em `app-hsmeta.json`. Na prática, qualquer
chamada a `/cms/v3/hubdb/...` com esse token retorna `401 Authentication
credentials not found`.

A solução foi usar um **Private App Token** guardado no secret
`HUBSPOT_APP_TOKEN`, com scope de HubDB e de CRM:

```js
const token = process.env.HUBSPOT_APP_TOKEN || context.userToken;
```

Isso é usado nas 3 functions. Se o token expirar ou for revogado, atualize
o secret (não precisa redeploy — a mudança vale em ~10s):

```bash
hs secret update HUBSPOT_APP_TOKEN --account=<nome-da-conta>
```

⚠️ **Secrets são por conta, não por projeto.** Se outro projeto na mesma
conta usar um secret com o mesmo nome, atualizar aqui afeta o outro
também. Por isso o projeto `calculadora-fee-files` usa um nome de secret
diferente (`HUBSPOT_APP_TOKEN_FILES`).

## Fórmula de cálculo (resumo)

1. Encontra a linha de tarifa cuja faixa `vol_min..vol_max` contém o volume
   informado, para a combinação exata empresa + canal + oferta + tipo_fl.
2. Soma os percentuais dos escopos contratados (`escrituracao`, `deposito`,
   `custodia`) × volume.
3. Se `indexador = "prazo"`, multiplica por `dias_úteis / 360` (dias úteis
   calculados a partir da tabela de feriados).
4. Aplica `fee_minimo` (piso) e `cap_fee` (teto, se > 0).
5. Se `imposto = "mais_impostos"`, aplica gross-up dividindo por
   `(1 - 0.1125)`.

## Deploy

```bash
hs project upload --account=<nome-da-conta>
```

## Erros conhecidos já resolvidos (histórico)

- `hs.cms.hubdb.rowsApi.getTableRows()` do SDK tem um bug ("data is not
  iterable") — por isso as functions usam `hs.apiRequest()` direto no
  endpoint REST `/cms/v3/hubdb/tables/{id}/rows`.
- O endpoint legado `/hubdb/api/v3/...` não deve ser usado — o atual é
  `/cms/v3/hubdb/...`.
