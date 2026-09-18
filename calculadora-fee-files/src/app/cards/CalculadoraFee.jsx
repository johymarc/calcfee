// Card de UI Extension exibido na aba do Ticket. Fluxo:
//   1. loadContext()  -> carrega propriedades do Ticket + empresas (Excel)
//   2. usuário preenche o formulário e clica em "Calcular FEE"
//   3. handleCalcular() chama a function calcularFee (não grava nada ainda)
//   4. usuário revisa o resultado e confirma
//   5. handleConfirmar() chama a function salvarFee (grava no Ticket)
//
// A tela atual é controlada por um único state `screen`, funcionando como
// uma máquina de estados simples:
//   loading -> form_new | form_recalc -> calculating -> result -> saving -> saved
//
// Este card é idêntico ao do projeto "calculadora-fee" (mesma UI/UX) — a
// única diferença entre os dois projetos está nas serverless functions:
// aqui os dados de tarifas vêm de um arquivo Excel no File Manager, não de
// uma tabela HubDB. Ver README.md.
import {
  hubspot,
  Text,
  Button,
  NumberInput,
  Select,
  MultiSelect,
  SearchInput,
  Icon,
  Flex,
  Box,
  Alert,
  LoadingSpinner,
  Divider,
  Heading,
  Tag,
  DateInput,
} from "@hubspot/ui-extensions";
import React, { useState, useEffect, useCallback, useMemo } from "react";

const BRL = (n) =>
  Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const ESCOPO_OPTIONS = [
  { label: "Escrituração", value: "escrituracao" },
  { label: "Depósito",     value: "deposito"     },
  { label: "Custódia",     value: "custodia"     },
];

const MAX_EMPRESA_RESULTS = 6; // limite de resultados exibidos no buscador de empresa

const toSelectOptions = (arr) =>
  arr.map((v) => ({ label: v.charAt(0).toUpperCase() + v.slice(1), value: v }));

const CalculadoraFee = ({ context, runServerlessFunction, actions }) => {
  const [screen,  setScreen]  = useState("loading");
  const [error,   setError]   = useState(null);

  // ── Empresa selecionada + dados carregados do arquivo Excel ────────────
  const [companyId,          setCompanyId]          = useState(null);
  const [nomeEmpresa,        setNomeEmpresa]        = useState(null);
  const [empresasMap,        setEmpresasMap]        = useState({}); // { companyId: { nomeEmpresa, canais, ofertas, tiposFL } }
  const [empresaSearch,      setEmpresaSearch]      = useState("");
  const [canaisDisponiveis,  setCanaisDisponiveis]  = useState([]);
  const [ofertasDisponiveis, setOfertasDisponiveis] = useState([]);
  const [tiposFL,            setTiposFL]            = useState(["FL", "FL2"]);
  const [feeAnterior,        setFeeAnterior]        = useState(null); // fee_calculado já salvo no Ticket, se houver

  // ── Campos do formulário de cálculo ─────────────────────────────────────
  const [volume,      setVolume]      = useState("");
  const [escopo,      setEscopo]      = useState([]);
  const [canal,       setCanal]       = useState("");
  const [oferta,      setOferta]      = useState("");
  const [tipoFL,      setTipoFL]      = useState("FL");
  const [dataInicial, setDataInicial] = useState("");
  const [dataFinal,   setDataFinal]   = useState("");

  const [resultado, setResultado] = useState(null); // resposta de calcularFee, pendente de confirmação

  useEffect(() => { loadContext(); }, []);

  // Carrega o contexto inicial do Ticket ao abrir o card: propriedades já
  // salvas (para permitir recálculo) e o mapa de empresas disponíveis.
  const loadContext = useCallback(async () => {
    setScreen("loading");
    setError(null);
    try {
      const { response } = await runServerlessFunction({
        name: "getTicketContext",
        parameters: { ticketId: context.crm.objectId },
      });
      if (!response || response.status === "error")
        throw new Error(response?.message || "Erro ao carregar contexto do Ticket");

      setEmpresasMap(response.empresasMap || {});
      setFeeAnterior(response.fee_calculado || null);

      // Se o Ticket já tiver dados de uma operação anterior, pré-popula o
      // formulário para permitir recalcular sem redigitar tudo.
      if (response.volume_emissao)            setVolume(String(response.volume_emissao));
      if (response.escopo_contratado?.length) setEscopo(response.escopo_contratado);
      if (response.canal_operacao)            setCanal(response.canal_operacao);
      if (response.tipo_oferta)               setOferta(response.tipo_oferta);
      if (response.tipo_fl)                   setTipoFL(response.tipo_fl);
      if (response.data_inicial_operacao)     setDataInicial(response.data_inicial_operacao);
      if (response.data_final_operacao)       setDataFinal(response.data_final_operacao);

      setScreen(response.fee_calculado ? "form_recalc" : "form_new");
    } catch (e) {
      setError(e.message);
      setScreen("form_new");
    }
  }, [context, runServerlessFunction]);

  // Chamado quando o usuário escolhe uma empresa no buscador: preenche os
  // selects de Canal/Oferta/Tipo com as opções específicas dessa empresa
  // (vindas de empresasMap) e pré-seleciona quando só há uma opção.
  const handleEmpresaSelect = (selectedId) => {
    const info = empresasMap[selectedId];
    if (!info) return;
    setCompanyId(selectedId);
    setNomeEmpresa(info.nomeEmpresa);
    setEmpresaSearch("");
    setCanaisDisponiveis(info.canais || []);
    setOfertasDisponiveis(info.ofertas || []);
    setTiposFL(info.tiposFL?.length ? info.tiposFL : ["FL", "FL2"]);
    setCanal(info.canais?.length === 1 ? info.canais[0] : "");
    setOferta(info.ofertas?.length === 1 ? info.ofertas[0] : "");
    setTipoFL(info.tiposFL?.length === 1 ? info.tiposFL[0] : "FL");
    setEscopo([]);
  };

  // Limpa a empresa selecionada para permitir buscar outra.
  const handleTrocarEmpresa = () => {
    setCompanyId(null);
    setNomeEmpresa(null);
    setEmpresaSearch("");
    setCanaisDisponiveis([]);
    setOfertasDisponiveis([]);
    setCanal("");
    setOferta("");
    setEscopo([]);
  };

  const canCalcular =
    companyId &&
    Number(volume) > 0 &&
    escopo.length > 0 &&
    canal &&
    oferta;

  // Chama a function calcularFee. Isso NÃO grava nada no Ticket ainda —
  // apenas retorna o resultado para revisão (tela "result").
  const handleCalcular = async () => {
    setScreen("calculating");
    setError(null);
    try {
      const { response } = await runServerlessFunction({
        name: "calcularFee",
        parameters: {
          companyId,
          nomeCliente: nomeEmpresa,
          volume:      Number(volume),
          escopo,
          canal,
          oferta,
          tipoFL,
          dataInicial: dataInicial || null,
          dataFinal:   dataFinal   || null,
        },
      });
      if (!response || response.status === "error")
        throw new Error(response?.message || "Erro ao calcular FEE");
      setResultado(response);
      setScreen("result");
    } catch (e) {
      setError(e.message);
      setScreen(feeAnterior ? "form_recalc" : "form_new");
    }
  };

  // Confirma e grava o `resultado` calculado nas propriedades do Ticket.
  const handleConfirmar = async () => {
    setScreen("saving");
    try {
      const { response } = await runServerlessFunction({
        name: "salvarFee",
        parameters: { ticketId: context.crm.objectId, resultado },
      });
      if (!response || response.status === "error")
        throw new Error(response?.message || "Erro ao salvar FEE");
      setFeeAnterior(resultado.fee_total);
      setScreen("saved");
      actions.addAlert({ type: "success", message: "FEE gravado com sucesso no Ticket!" });
    } catch (e) {
      setError(e.message);
      setScreen("result");
    }
  };

  const handleCancelar   = () => setScreen(feeAnterior ? "form_recalc" : "form_new");
  const handleRecalcular = () => setScreen("form_recalc");

  // Componente auxiliar: label + input, com espaçamento padrão.
  const Field = ({ label, children }) => (
    <Flex direction="column" gap="extra-small">
      <Text format={{ fontWeight: "demibold" }}>{label}</Text>
      {children}
    </Flex>
  );

  const empresaOptions = useMemo(
    () =>
      Object.entries(empresasMap).map(([id, info]) => ({
        label: info.nomeEmpresa,
        value: id,
      })),
    [empresasMap]
  );

  // Filtra empresaOptions pelo texto digitado no buscador (case-insensitive,
  // substring), limitado a MAX_EMPRESA_RESULTS para não poluir o card.
  const empresasFiltradas = useMemo(() => {
    const q = empresaSearch.trim().toLowerCase();
    const base = q
      ? empresaOptions.filter((o) => o.label.toLowerCase().includes(q))
      : empresaOptions;
    return base.slice(0, MAX_EMPRESA_RESULTS);
  }, [empresaSearch, empresaOptions]);

  // Total de matches (sem o corte de MAX_EMPRESA_RESULTS), usado só para
  // mostrar "Mostrando X de Y" quando há mais resultados do que o exibido.
  const totalEmpresasMatch = useMemo(() => {
    const q = empresaSearch.trim().toLowerCase();
    return q
      ? empresaOptions.filter((o) => o.label.toLowerCase().includes(q)).length
      : empresaOptions.length;
  }, [empresaSearch, empresaOptions]);

  // Seletor de empresa: tem 3 estados possíveis —
  //   1. arquivo sem empresas carregadas
  //   2. empresa já selecionada (mostra chip com nome + botão "Trocar")
  //   3. nenhuma selecionada ainda (mostra buscador + lista de resultados)
  const EmpresaPicker = () => {
    if (empresaOptions.length === 0) {
      return (
        <Field label="Empresa">
          <Box padding="small" backgroundColor="light">
            <Flex direction="row" align="center" gap="extra-small">
              <Icon name="warning" color="warning" />
              <Text format={{ color: "medium", italic: true }}>
                Nenhuma empresa encontrada no arquivo de tarifas.
              </Text>
            </Flex>
          </Box>
        </Field>
      );
    }

    if (companyId) {
      return (
        <Field label="Empresa">
          <Box padding="small" backgroundColor="light">
            <Flex direction="row" align="center" justify="between" gap="small">
              <Flex direction="row" align="center" gap="extra-small">
                <Icon name="bank" color="inherit" />
                <Text format={{ fontWeight: "demibold" }}>{nomeEmpresa}</Text>
              </Flex>
              <Button variant="transparent" size="xs" onClick={handleTrocarEmpresa}>
                <Icon name="refresh" size="sm" /> Trocar
              </Button>
            </Flex>
          </Box>
        </Field>
      );
    }

    return (
      <Field label="Empresa">
        <SearchInput
          name="empresaSearch"
          label="Empresa"
          placeholder="Buscar empresa por nome..."
          value={empresaSearch}
          onInput={(v) => setEmpresaSearch(v)}
          onChange={(v) => setEmpresaSearch(v)}
        />
        <Box padding="extra-small" backgroundColor="light">
          <Flex direction="column">
            {empresasFiltradas.length > 0 ? (
              empresasFiltradas.map((opt) => (
                <Button
                  key={opt.value}
                  variant="transparent"
                  size="sm"
                  onClick={() => handleEmpresaSelect(opt.value)}
                >
                  <Icon name="bank" size="sm" /> {opt.label}
                </Button>
              ))
            ) : (
              <Text format={{ color: "medium", italic: true }}>
                Nenhuma empresa encontrada para "{empresaSearch}".
              </Text>
            )}
          </Flex>
        </Box>
        {totalEmpresasMatch > MAX_EMPRESA_RESULTS && (
          <Text format={{ italic: true, color: "medium" }}>
            Mostrando {MAX_EMPRESA_RESULTS} de {totalEmpresasMatch} empresas. Refine a busca para ver outras.
          </Text>
        )}
      </Field>
    );
  };

  const FormInputs = () => (
    <Flex direction="column" gap="medium">
      <EmpresaPicker />

      <Flex direction="row" gap="medium">
        <Field label="Canal">
          <Select
            name="canal"
            value={canal}
            options={toSelectOptions(canaisDisponiveis)}
            onChange={(v) => setCanal(v)}
            disabled={!companyId}
          />
        </Field>
        <Field label="Oferta">
          <Select
            name="oferta"
            value={oferta}
            options={toSelectOptions(ofertasDisponiveis)}
            onChange={(v) => setOferta(v)}
            disabled={!companyId}
          />
        </Field>
        <Field label="Tipo">
          <Select
            name="tipoFL"
            value={tipoFL}
            options={toSelectOptions(tiposFL)}
            onChange={(v) => setTipoFL(v)}
            disabled={!companyId}
          />
        </Field>
      </Flex>

      <Field label="Volume da emissão (R$)">
        <NumberInput
          name="volume"
          value={Number(volume) || 0}
          min={0}
          precision={2}
          onChange={(v) => setVolume(String(v))}
          disabled={!companyId}
        />
      </Field>

      <Field label="Escopo contratado">
        <MultiSelect
          name="escopo"
          value={escopo}
          options={ESCOPO_OPTIONS}
          onChange={(v) => setEscopo(v)}
          disabled={!companyId}
        />
      </Field>

      {/* Data inicial/final só é relevante quando o indexador da tarifa é
          "prazo" — a function calcularFee valida isso e retorna erro se
          o cliente precisar dessas datas e elas não tiverem sido informadas. */}
      <Flex direction="row" gap="medium">
        <Field label="Data inicial">
          <DateInput
            name="dataInicial"
            value={dataInicial}
            onChange={(v) => setDataInicial(v)}
            disabled={!companyId}
          />
        </Field>
        <Field label="Data final">
          <DateInput
            name="dataFinal"
            value={dataFinal}
            onChange={(v) => setDataFinal(v)}
            disabled={!companyId}
          />
        </Field>
      </Flex>
    </Flex>
  );

  const CardHeader = () => (
    <Flex direction="row" align="center" gap="extra-small">
      <Icon name="gauge" color="inherit" />
      <Heading level={4}>Calculadora de FEE files</Heading>
    </Flex>
  );

  const FeeAnteriorBox = () =>
    feeAnterior ? (
      <Box padding="small" backgroundColor="light">
        <Text format={{ color: "medium" }}>
          Fee salvo anteriormente:{" "}
          <Text format={{ strikethrough: true }}>{BRL(feeAnterior)}</Text>
        </Text>
      </Box>
    ) : null;

  const ResultadoBox = () => (
    <Box padding="medium" backgroundColor="success-light">
      <Flex direction="row" align="center" gap="extra-small">
        <Icon name="checkCircle" color="success" />
        <Heading level={3}>{BRL(resultado.fee_total)}</Heading>
      </Flex>
      <Text format={{ color: "medium" }}>Fee Laqus calculado</Text>
      <Divider />
      <Flex direction="row" gap="large" wrap="wrap">
        <Text>Escrituração: {BRL(resultado.fee_escrituracao)}</Text>
        <Text>Depósito: {BRL(resultado.fee_deposito)}</Text>
        <Text>Custódia: {BRL(resultado.fee_custodia)}</Text>
        {resultado.grossUpAplicado && (
          <Text>Gross-up: {(resultado.aliquotaImposto * 100).toFixed(2)}%</Text>
        )}
        {resultado.indexador === "prazo" && (
          <Text>Dias úteis: {resultado.diasUteis}</Text>
        )}
      </Flex>
    </Box>
  );

  // ── Máquina de estados: cada `screen` renderiza uma tela distinta ───────
  if (screen === "loading") {
    return (
      <Flex direction="column" align="center" gap="medium">
        <LoadingSpinner />
        <Text>Carregando dados do Ticket...</Text>
      </Flex>
    );
  }

  if (screen === "form_new" || screen === "form_recalc") {
    return (
      <Flex direction="column" gap="medium">
        <CardHeader />
        {error && <Alert title="Erro" variant="error">{error}</Alert>}
        <FormInputs />
        {screen === "form_recalc" && <FeeAnteriorBox />}
        <Button
          variant="primary"
          disabled={!canCalcular}
          onClick={handleCalcular}
        >
          <Icon name="gauge" size="sm" /> {screen === "form_recalc" ? "Recalcular FEE" : "Calcular FEE"}
        </Button>
        {!canCalcular && (
          <Text format={{ color: "medium", italic: true }}>
            Selecione empresa, preencha volume e escopo para calcular.
          </Text>
        )}
      </Flex>
    );
  }

  if (screen === "calculating") {
    return (
      <Flex direction="column" align="center" gap="medium">
        <LoadingSpinner />
        <Text>Calculando FEE...</Text>
      </Flex>
    );
  }

  if (screen === "result") {
    return (
      <Flex direction="column" gap="medium">
        <CardHeader />
        {error && <Alert title="Erro ao calcular" variant="error">{error}</Alert>}
        <ResultadoBox />
        <Alert title="Salvar no Ticket?" variant="warning">
          O valor <Text format={{ fontWeight: "bold" }}>{BRL(resultado.fee_total)}</Text> será
          gravado na propriedade <Text format={{ italic: true }}>fee_calculado</Text> deste Ticket.
        </Alert>
        <Flex direction="row" gap="medium">
          <Button variant="secondary" onClick={handleCancelar}>
            <Icon name="remove" size="sm" /> Cancelar
          </Button>
          <Button variant="primary" onClick={handleConfirmar}>
            <Icon name="checkCircle" size="sm" /> Confirmar e salvar
          </Button>
        </Flex>
      </Flex>
    );
  }

  if (screen === "saving") {
    return (
      <Flex direction="column" align="center" gap="medium">
        <LoadingSpinner />
        <Text>Gravando no Ticket...</Text>
      </Flex>
    );
  }

  if (screen === "saved") {
    return (
      <Flex direction="column" gap="medium">
        <CardHeader />
        <Alert title="FEE gravado com sucesso" variant="success">
          As propriedades do Ticket foram atualizadas.
        </Alert>
        <ResultadoBox />
        <Box padding="small" backgroundColor="light">
          <Text format={{ fontWeight: "bold" }}>Propriedades gravadas:</Text>
          <Text>fee_calculado: {BRL(resultado.fee_total)}</Text>
          <Text>fee_escrituracao: {BRL(resultado.fee_escrituracao)}</Text>
          <Text>fee_deposito: {BRL(resultado.fee_deposito)}</Text>
          <Text>fee_custodia: {BRL(resultado.fee_custodia)}</Text>
        </Box>
        <Button variant="secondary" onClick={handleRecalcular}>
          <Icon name="refresh" size="sm" /> Recalcular FEE
        </Button>
      </Flex>
    );
  }

  return null;
};

hubspot.extend(({ context, runServerlessFunction, actions }) => (
  <CalculadoraFee
    context={context}
    runServerlessFunction={runServerlessFunction}
    actions={actions}
  />
));
