// Serverless function que calcula o FEE de uma operação, com base na
// tarifa correspondente encontrada no arquivo Excel de tarifas (File
// Manager). Não grava nada — apenas retorna o resultado para o card
// exibir e o usuário confirmar (a gravação acontece em salvarFee.js).
//
// Esta função não precisa de nenhum token/secret: os dois arquivos .xlsx
// são públicos, então fetch() funciona sem cabeçalho de autenticação.

const TARIFAS_XLSX_URL =
  "https://20414094.fs1.hubspotusercontent-na1.net/hubfs/20414094/TARIFAS/tarifas_clientes_real%20(3).xlsx";
const FERIADOS_XLSX_URL =
  "https://20414094.fs1.hubspotusercontent-na1.net/hubfs/20414094/TARIFAS/feriados_br.xlsx";
const ALIQUOTA_IMPOSTO = 0.1125; // usada no gross-up quando imposto = "mais_impostos"

exports.main = async (context) => {
  const {
    companyId,
    nomeCliente,
    volume,
    escopo,     // array: subconjunto de ["escrituracao","deposito","custodia"]
    canal,
    oferta,
    tipoFL,
    dataInicial,
    dataFinal,
  } = context.parameters;

  try {
    const allRows = await fetchXlsxRows(TARIFAS_XLSX_URL);

    // Localiza a linha de tarifa cuja faixa de volume (vol_min..vol_max)
    // contém o volume informado, para a combinação exata de
    // empresa + canal + oferta + tipo_fl.
    const matchingRow = allRows.find((r) => {
      const volMin = r.vol_min === "sem_restricao" ? 0        : Number(r.vol_min);
      const volMax = r.vol_max === "sem_restricao" ? Infinity : Number(r.vol_max);
      return (
        String(r.hubspot_company_id) === String(companyId) &&
        r.canal    === canal  &&
        r.oferta   === oferta &&
        r.tipo_fl  === tipoFL &&
        volume >= volMin                           &&
        volume <= volMax
      );
    });

    if (!matchingRow) {
      return {
        status: "error",
        message:
          `Nenhuma tarifa encontrada para ${nomeCliente} (ID: ${companyId}) ` +
          `| canal: ${canal} | oferta: ${oferta} | tipo: ${tipoFL} | volume: ${volume}. ` +
          `Verifique se o hubspot_company_id está preenchido no Excel.`,
      };
    }

    const t = matchingRow;

    // Cada percentual só entra na conta se o escopo correspondente foi
    // contratado (checkbox marcado no card).
    const pct = {
      escrituracao: escopo.includes("escrituracao") ? Number(t.pct_escrituracao) : 0,
      deposito:     escopo.includes("deposito")     ? Number(t.pct_deposito)     : 0,
      custodia:     escopo.includes("custodia")     ? Number(t.pct_custodia)     : 0,
    };
    const pctTotal = pct.escrituracao + pct.deposito + pct.custodia;

    let diasUteis = null;
    let multiplicador = 1;

    // Duas formas de indexador no arquivo:
    // - "volume_emissao": multiplicador = 1 (percentual aplicado direto sobre o volume)
    // - "prazo": o percentual é anualizado (base 360) e precisa ser
    //   proporcionalizado pelos dias úteis entre dataInicial e dataFinal
    if (t.indexador === "prazo") {
      if (!dataInicial || !dataFinal) {
        return {
          status: "error",
          message: "Este cliente usa indexador por prazo. Informe Data Inicial e Data Final.",
        };
      }
      diasUteis     = await calcularDiasUteis(dataInicial, dataFinal);
      multiplicador = diasUteis / 360;
    }

    const baseTotal        = volume * pctTotal        * multiplicador;
    const baseEscrituracao = volume * pct.escrituracao * multiplicador;
    const baseDeposito     = volume * pct.deposito     * multiplicador;
    const baseCustodia     = volume * pct.custodia     * multiplicador;

    // fee_minimo garante um piso mesmo se o cálculo percentual for menor.
    const feeMinimo = Number(t.fee_minimo) || 0;
    const feeBase   = Math.max(baseTotal, feeMinimo);

    // cap_fee (quando > 0) impõe um teto ao valor final.
    const capFee    = Number(t.cap_fee) || 0;
    const feeCapped = capFee > 0 ? Math.min(feeBase, capFee) : feeBase;

    // Gross-up: quando o cliente paga o FEE "por fora" dos impostos
    // (imposto = "mais_impostos"), dividimos pelo complemento da alíquota
    // para que o valor líquido recebido já contemple o imposto retido.
    const grossUpAplicado = t.imposto === "mais_impostos";
    const feeTotal = grossUpAplicado ? feeCapped / (1 - ALIQUOTA_IMPOSTO) : feeCapped;

    // Rateia o gross-up/cap proporcionalmente entre escrituração, depósito
    // e custódia, preservando a proporção original de cada componente.
    const fator = baseTotal > 0 ? feeTotal / baseTotal : 0;

    return {
      status: "ok",
      fee_total:        round(feeTotal),
      fee_escrituracao: round(baseEscrituracao * fator),
      fee_deposito:     round(baseDeposito     * fator),
      fee_custodia:     round(baseCustodia     * fator),
      grossUpAplicado,
      aliquotaImposto:  grossUpAplicado ? ALIQUOTA_IMPOSTO : 0,
      indexador:        t.indexador,
      diasUteis,
      feeMinimo,
      capFee,
      inputs: { nomeCliente, volume, escopo, canal, oferta, tipoFL, dataInicial, dataFinal },
    };
  } catch (err) {
    return { status: "error", message: `calcularFee: ${err.message}` };
  }
};

function round(n) {
  return Math.round(n * 100) / 100;
}

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

// Converte o valor bruto da coluna "data" (feriados) para "YYYY-MM-DD".
// O SheetJS pode retornar isso como string (célula formatada como texto),
// Date (célula formatada como data) ou número de série do Excel
// (dias desde 1899-12-30) — cobrimos os três casos.
function toDateStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (typeof v === "number") {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().split("T")[0];
  }
  return String(v).split("T")[0];
}

// Conta dias úteis (seg-sex, excluindo feriados do arquivo feriados_br.xlsx)
// entre dataInicial (inclusive) e dataFinal (exclusive).
async function calcularDiasUteis(dataInicial, dataFinal) {
  const rows = await fetchXlsxRows(FERIADOS_XLSX_URL);
  const feriadoSet = new Set(rows.map((r) => toDateStr(r.data)).filter(Boolean));

  let count = 0;
  const current = new Date(dataInicial + "T00:00:00Z");
  const end     = new Date(dataFinal   + "T00:00:00Z");

  while (current < end) {
    const dow     = current.getUTCDay(); // 0 = domingo, 6 = sábado
    const dateStr = current.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !feriadoSet.has(dateStr)) count++;
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}
