// Serverless function chamada pelo card ao abrir a aba do Ticket.
// Retorna: (1) as propriedades atuais do Ticket relacionadas ao FEE,
// e (2) o mapa de empresas disponíveis, lido diretamente do arquivo Excel
// de tarifas hospedado no File Manager (nenhuma tabela HubDB é usada
// neste projeto — ver README.md para a diferença em relação ao projeto
// "calculadora-fee").

const TARIFAS_XLSX_URL =
  "https://20414094.fs1.hubspotusercontent-na1.net/hubfs/20414094/TARIFAS/tarifas_clientes_real%20(3).xlsx";

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

  // HUBSPOT_APP_TOKEN_FILES é um Private App Token exclusivo deste projeto
  // (secret separado de HUBSPOT_APP_TOKEN, usado pelo projeto "calculadora-fee").
  // Secrets do HubSpot são por CONTA, não por projeto — se os dois projetos
  // usassem o mesmo nome de secret, atualizar um quebraria o outro.
  // Aqui ele só é usado para ler/gravar o Ticket (scope de CRM); o Excel é
  // buscado sem nenhuma autenticação (arquivo público no File Manager).
  const token = process.env.HUBSPOT_APP_TOKEN_FILES || context.userToken;
  const hs = new Client({ accessToken: token });
  const { ticketId } = context.parameters;

  try {
    // ── Propriedades do Ticket ────────────────────────────────────────────
    const ticket = await hs.crm.tickets.basicApi.getById(ticketId, TICKET_PROPS);
    const props  = ticket.properties;

    // ── Tarifas (Excel, File Manager, arquivo público) ────────────────────
    const allRows = await fetchXlsxRows(TARIFAS_XLSX_URL);

    // ── Agrupa por empresa ─────────────────────────────────────────────────
    // O nome da empresa já vem no próprio arquivo (coluna nome_cliente),
    // então não precisamos de uma chamada extra à API de Companies como no
    // projeto HubDB — reduz uma dependência de scope/chamada de API.
    const empresasMap = {};
    for (const row of allRows) {
      const id = String(row.hubspot_company_id || "").trim();
      if (!id) continue;
      if (!empresasMap[id]) {
        empresasMap[id] = {
          nomeEmpresa: row.nome_cliente || `ID ${id}`,
          canais:  [],
          ofertas: [],
          tiposFL: [],
        };
      }
      const info = empresasMap[id];
      if (row.canal   && !info.canais.includes(row.canal))     info.canais.push(row.canal);
      if (row.oferta  && !info.ofertas.includes(row.oferta))   info.ofertas.push(row.oferta);
      if (row.tipo_fl && !info.tiposFL.includes(row.tipo_fl))  info.tiposFL.push(row.tipo_fl);
    }

    return {
      status: "ok",
      empresasMap,
      totalXlsxRows: allRows.length,
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
    return { status: "error", message: `getTicketContext: ${err.message}` };
  }
};

// Baixa o .xlsx público do File Manager e retorna as linhas como array de
// objetos { coluna: valor }.
//
// A leitura da linha de cabeçalho é feita de forma resiliente: em vez de
// assumir que a linha 1 sempre tem os nomes das colunas, procuramos a
// primeira linha com 2+ células preenchidas. Isso evita quebrar quando o
// arquivo é re-exportado/re-salvo do Excel com uma linha de título extra
// (ex: o nome do arquivo) antes do cabeçalho real — já aconteceu uma vez
// com o arquivo real e por isso essa proteção existe.
async function fetchXlsxRows(url) {
  const XLSX = require("xlsx");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao buscar Excel (HTTP ${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const wb  = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]]; // sempre lê a primeira aba

  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const headerRowIndex = raw.findIndex(
    (row) =>
      Array.isArray(row) &&
      row.filter((c) => c !== null && c !== undefined && String(c).trim() !== "").length >= 2
  );
  if (headerRowIndex === -1) {
    throw new Error("Não foi possível localizar a linha de cabeçalho no arquivo Excel.");
  }

  const headers = raw[headerRowIndex].map((h) => (h === null || h === undefined ? "" : String(h).trim()));
  return raw
    .slice(headerRowIndex + 1)
    .filter((row) => Array.isArray(row) && row.some((c) => c !== null && c !== undefined && c !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = row[i] !== undefined ? row[i] : null;
      });
      return obj;
    });
}
