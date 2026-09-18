// Serverless function chamada pelo card ao abrir a aba do Ticket.
// Retorna: (1) as propriedades atuais do Ticket relacionadas ao FEE,
// e (2) o mapa de empresas disponíveis (lido da tabela HubDB de tarifas),
// que o card usa para popular o buscador de "Empresa".

const HUBDB_TARIFAS_TABLE = "412478026"; // tabela HubDB "Tarifas Clientes"

const TICKET_PROPS = [
  "volume_emissao",
  "escopo_contratado",
  "canal_operacao",
  "tipo_oferta",
  "tipo_fl",
  "data_inicial_operacao",
  "data_final_operacao",
  "fee_calculado",
  "fee_escrituracao",
  "fee_deposito",
  "fee_custodia",
];

exports.main = async (context) => {
  const { Client } = require("@hubspot/api-client");

  // context.userToken tem apenas os scopes de CRM (ticket/company).
  // HubDB exige scopes próprios (hubdb.tables.read / hubdb.rows.read) que o
  // token de usuário não carrega — por isso usamos o Private App Token
  // salvo no secret HUBSPOT_APP_TOKEN (ver README para detalhes e como
  // trocar esse token caso ele seja revogado).
  const token = process.env.HUBSPOT_APP_TOKEN || context.userToken;
  const hs = new Client({ accessToken: token });
  const { ticketId } = context.parameters;

  try {
    // ── Propriedades do Ticket ────────────────────────────────────────────
    const ticket = await hs.crm.tickets.basicApi.getById(ticketId, TICKET_PROPS);
    const props  = ticket.properties;

    // ── Linhas da tabela HubDB "Tarifas Clientes" ─────────────────────────
    // Usamos hs.apiRequest (chamada REST direta) em vez do método
    // hs.cms.hubdb.rowsApi do SDK porque esse método tem um bug conhecido
    // ("data is not iterable") na versão do @hubspot/api-client usada aqui.
    // O endpoint correto é /cms/v3/hubdb/... (o antigo /hubdb/api/v3/... é legado).
    const hubdbRes  = await hs.apiRequest({
      method: "GET",
      path:   `/cms/v3/hubdb/tables/${HUBDB_TARIFAS_TABLE}/rows`,
      qs:     { limit: 200 },
    });
    const hubdbBody = await hubdbRes.json();
    const allRows   = Array.isArray(hubdbBody.results) ? hubdbBody.results : [];

    // ── IDs de empresa únicos presentes na tabela ─────────────────────────
    const uniqueIds = [
      ...new Set(
        allRows
          .map((r) => r.values && r.values.hubspot_company_id)
          .filter((v) => v !== null && v !== undefined && v !== "")
          .map(String)
      ),
    ];

    // ── Busca em lote o nome de cada empresa (Companies) ──────────────────
    // Agrupamos por hubspot_company_id e coletamos os valores distintos de
    // canal/oferta/tipo_fl disponíveis para cada empresa — o card usa isso
    // para popular os selects de Canal/Oferta/Tipo depois que o usuário
    // escolhe a empresa.
    let empresasMap = {};
    if (uniqueIds.length > 0) {
      try {
        const batchRes  = await hs.apiRequest({
          method: "POST",
          path:   "/crm/v3/objects/companies/batch/read",
          body:   {
            properties: ["name"],
            inputs:     uniqueIds.map((id) => ({ id })),
          },
        });
        const batchBody = await batchRes.json();
        for (const company of Array.isArray(batchBody.results) ? batchBody.results : []) {
          const id    = String(company.id);
          const cRows = allRows.filter((r) => String(r.values && r.values.hubspot_company_id) === id);
          empresasMap[id] = {
            nomeEmpresa:  company.properties && company.properties.name,
            canais:  [...new Set(cRows.map((r) => r.values.canal).filter(Boolean))],
            ofertas: [...new Set(cRows.map((r) => r.values.oferta).filter(Boolean))],
            tiposFL: [...new Set(cRows.map((r) => r.values.tipo_fl).filter(Boolean))],
          };
        }
      } catch (_) {
        // Fallback: se a busca de nome falhar (ex: company sem permissão de
        // leitura), mostra o ID no lugar do nome em vez de quebrar o card.
        for (const id of uniqueIds) {
          const cRows = allRows.filter((r) => String(r.values && r.values.hubspot_company_id) === id);
          empresasMap[id] = {
            nomeEmpresa:  `ID ${id}`,
            canais:  [...new Set(cRows.map((r) => r.values.canal).filter(Boolean))],
            ofertas: [...new Set(cRows.map((r) => r.values.oferta).filter(Boolean))],
            tiposFL: [...new Set(cRows.map((r) => r.values.tipo_fl).filter(Boolean))],
          };
        }
      }
    }

    return {
      status: "ok",
      empresasMap,
      totalHubdbRows: allRows.length,
      volume_emissao:        props.volume_emissao         || null,
      escopo_contratado:     props.escopo_contratado
                               ? props.escopo_contratado.split(";")
                               : [],
      canal_operacao:        props.canal_operacao         || null,
      tipo_oferta:           props.tipo_oferta            || null,
      tipo_fl:               props.tipo_fl                || "FL",
      data_inicial_operacao: props.data_inicial_operacao  || null,
      data_final_operacao:   props.data_final_operacao    || null,
      fee_calculado:    props.fee_calculado    ? parseFloat(props.fee_calculado)    : null,
      fee_escrituracao: props.fee_escrituracao ? parseFloat(props.fee_escrituracao) : null,
      fee_deposito:     props.fee_deposito     ? parseFloat(props.fee_deposito)     : null,
      fee_custodia:     props.fee_custodia     ? parseFloat(props.fee_custodia)     : null,
    };
  } catch (err) {
    // O card mostra `message` diretamente ao usuário — por isso incluímos
    // texto legível em vez de deixar vazar o erro bruto do SDK.
    return { status: "error", message: err.message };
  }
};
