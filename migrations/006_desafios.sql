-- ==========================================================================
--  006 — DESAFIOS: o formulário que a clínica escreve na hora
--
--  ==========================================================================
--  POR QUE A ESTRUTURA DO DESAFIO É DADO, e a do teste não
--
--  A migração 005 diz, com todas as letras, que pergunta é ESTRUTURA e por
--  isso mora em `testes-modelos.js`, fora do banco. Aquilo continua valendo —
--  para os treze rastreios. Eles são os mesmos para todo mundo, mudam quando
--  eu mudo o código, e guardá-los em tabela faria dois lugares responderem
--  "quais são as perguntas do RTA-20".
--
--  O desafio é outra coisa. Ele nasce de um texto que o terapeuta escreve
--  para UM paciente, na realidade daquela semana ("TDAH — observar o que
--  acontece antes de deixar para depois"). Não existe versão dele no código,
--  não dá para prever, e ninguém vai fazer deploy para mandar um desafio. Aí
--  pergunta É dado, e o lugar do dado é o banco.
--
--  Por isso as duas colunas abaixo, e nenhuma tabela nova: um desafio É uma
--  linha de `testes`. Assim ele atravessa de graça tudo o que já existe — o
--  envio, o link `/answer/<código>`, o prontuário, a impressão, a lista de
--  situações — sem um segundo caminho paralelo para manter.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  tipo — 'teste' ou 'desafio'
--
--  Com DEFAULT 'teste': as treze linhas que já existem continuam sendo o que
--  sempre foram, sem UPDATE nenhum. O valor serve para a tela etiquetar e
--  para o servidor saber onde procurar as perguntas.
-- --------------------------------------------------------------------------
ALTER TABLE testes ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'teste';

-- --------------------------------------------------------------------------
--  estrutura — o formulário interpretado, em JSON, CIFRADO pela aplicação
--
--  Guarda `abertas` (os rótulos dos campos), `roteiro` (a ordem de exibição:
--  seção, parágrafo, lista, citação, campo) e o texto original.
--
--  É CIFRADA, e a razão é a mesma das respostas: o desafio é escrito para uma
--  pessoa e diz do que ela sofre. "TDAH — observar o que acontece antes de
--  deixar para depois", parado numa coluna em texto puro, é diagnóstico
--  legível por quem abrir um dump — e o `nome` do catálogo já é o mínimo
--  necessário para a clínica encontrar o desafio na lista.
--
--  Fica NULA nos treze rastreios: neles quem responde é o arquivo JS.
-- --------------------------------------------------------------------------
ALTER TABLE testes ADD COLUMN IF NOT EXISTS estrutura TEXT;

-- --------------------------------------------------------------------------
--  Quem criou, e quando. Um teste do catálogo é do sistema; um desafio é de
--  alguém, escrito num dia — e daqui a seis meses essa é a primeira pergunta
--  de quem abre a lista.
-- --------------------------------------------------------------------------
ALTER TABLE testes ADD COLUMN IF NOT EXISTS criado_por INTEGER;

COMMENT ON COLUMN testes.tipo IS
  'teste = rastreio dos 13 modelos (perguntas em testes-modelos.js) | desafio = escrito pela clínica, perguntas em estrutura.';
COMMENT ON COLUMN testes.estrutura IS
  'JSON CIFRADO pela aplicação: { texto, roteiro, abertas }. Nulo nos testes de rastreio.';
