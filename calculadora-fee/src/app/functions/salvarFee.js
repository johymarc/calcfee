// Serverless function chamada quando o usuário clica em "Confirmar e
// salvar" no card. Grava o resultado do cálculo (retornado por
// calcularFee.js) diretamente nas propriedades do Ticket.

const PROP_FEE_TOTAL        = "fee_calculado";
const PROP_FEE_ESCRITURACAO = "fee_escrituracao";
const PROP_FEE_DEPOSITO     = "fee_deposito";
const PROP_FEE_CUSTODIA     = "fee_custodia";
const PROP_FEE_SALVO_EM     = "fee_calculado_em";

exports.main = async (context) => {
  const { Client } = require("@hubspot/api-client");

  // Aqui usamos o mesmo fallback de token que as outras funções por
  // consistência, embora esta função só precise de escopo de CRM
  // (crm.objects.tickets.write) — não toca em HubDB.
  const token = process.env.HUBSPOT_APP_TOKEN || context.userToken;
  const hs = new Client({ accessToken: token });

  const { ticketId, resultado } = context.parameters;

  try {
    await hs.crm.tickets.basicApi.update(ticketId, {
      properties: {
        // Propriedades numéricas do HubSpot são armazenadas como string.
        [PROP_FEE_TOTAL]:        String(resultado.fee_total),
        [PROP_FEE_ESCRITURACAO]: String(resultado.fee_escrituracao),
        [PROP_FEE_DEPOSITO]:     String(resultado.fee_deposito),
        [PROP_FEE_CUSTODIA]:     String(resultado.fee_custodia),
        // Guarda registro de quando o cálculo foi salvo, só se a
        // propriedade fee_calculado_em existir no portal.
        ...(PROP_FEE_SALVO_EM
          ? { [PROP_FEE_SALVO_EM]: new Date().toISOString() }
          : {}),
      },
    });

    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: err.message };
  }
};
