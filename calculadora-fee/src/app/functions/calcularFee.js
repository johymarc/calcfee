// Serverless function que calcula o FEE de uma operação, com base na
// tarifa correspondente encontrada na tabela HubDB "Tarifas Clientes".
// Não grava nada — apenas retorna o resultado para o card exibir e o
// usuário confirmar (a gravação acontece em salvarFee.js).

const HUBDB_TARIFAS_TABLE  = "412478026"; // tabela "Tarifas Clientes"
const HUBDB_FERIADOS_TABLE = "412478027"; // tabela "Feriados Brasil"
const ALIQUOTA_IMPOSTO     = 0.1125;      // usada no gross-up quando imposto = "mais_impostos"

exports.main = async (context) => {
  const { Client } = require("@hubspot/api-client");

  // Ver getTicketContext.js: precisamos do Private App Token porque
  // context.userToken não tem os scopes de HubDB.
  const token = process.env.HUBSPOT_APP_TOKEN || context.userToken;
  const hs = new Client({ accessToken: token });

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
    const rowsRes  = await hs.apiRequest({
      method: "GET",
      path:   `/cms/v3/hubdb/tables/${HUBDB_TARIFAS_TABLE}/rows`,
      qs:     { limit: 200 },
    });
    const rowsBody = await rowsRes.json();
    const allRows  = Array.isArray(rowsBody.results) ? rowsBody.results : [];

    // Localiza a linha de tarifa cuja faixa de volume (vol_min..vol_max)
    // contém o volume informado, para a combinação exata de
    // empresa + canal + oferta + tipo_fl.
    const matchingRow = allRows.find((r) => {
      const v = r.values;
      const volMin = v.vol_min === "sem_restricao" ? 0        : Number(v.vol_min);
      const volMax = v.vol_max === "sem_restricao" ? Infinity : Number(v.vol_max);
      return (
        v.hubspot_company_id === String(companyId) &&
        v.canal              === canal             &&
        v.oferta              === oferta           &&
        v.tipo_fl            === tipoFL            &&
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
          `Verifique se o hubspot_company_id está preenchido na tabela HubDB.`,
      };
    }

    const t = matchingRow.values;

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

    // Duas formas de indexador na tabela:
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
      diasUteis    = await calcularDiasUteis(hs, dataInicial, dataFinal);
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
    const capFee   = Number(t.cap_fee) || 0;
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
    return { status: "error", message: err.message };
  }
};

function round(n) {
  return Math.round(n * 100) / 100;
}

// Conta dias úteis (seg-sex, excluindo feriados da tabela HubDB
// "Feriados Brasil") entre dataInicial (inclusive) e dataFinal (exclusive).
async function calcularDiasUteis(hs, dataInicial, dataFinal) {
  const res      = await hs.apiRequest({
    method: "GET",
    path:   `/cms/v3/hubdb/tables/${HUBDB_FERIADOS_TABLE}/rows`,
    qs:     { limit: 2000 },
  });
  const resBody  = await res.json();
  const feriadoSet = new Set(
    (Array.isArray(resBody.results) ? resBody.results : [])
      .map((r) => {
        const d = r.values && r.values.data;
        if (d === null || d === undefined) return null;
        // Campos de data no HubDB retornam como epoch em milissegundos.
        return new Date(Number(d)).toISOString().split("T")[0];
      })
      .filter(Boolean)
  );

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
