-- ==========================================================================
--  008 — O DESAFIO É DE UM PACIENTE, e de mais ninguém
--
--  ==========================================================================
--  O QUE MUDOU DE ENTENDIMENTO
--
--  A 006 tratou o desafio como mais um item de catálogo: aparecia na lista de
--  Testes/desafios, era escolhido no "Enviar" como qualquer rastreio, e nada
--  impedia mandá-lo a outra pessoa.
--
--  Estava errado, e a diferença não é de arrumação de tela. Um rastreio é o
--  MESMO instrumento para todo mundo — é o que permite comparar a mesma escala
--  ao longo do tratamento. Um desafio é escrito para UMA pessoa, na realidade
--  dela, naquela semana: "observar o que acontece antes de deixar para depois"
--  foi escrito olhando para um caso. Reaproveitá-lo em outro paciente não é
--  economia, é enviar a alguém uma tarefa pensada para outra pessoa.
--
--  Daí esta coluna. Com ela:
--
--    · o catálogo (Cadastros → Testes) volta a ser só dos treze rastreios;
--    · "Enviar teste" oferece só rastreio;
--    · o desafio nasce DENTRO do prontuário do paciente, já para ele.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  paciente_id — nulo nos rastreios, obrigatório no desafio (regra da
--  aplicação, não do banco: uma NOT NULL aqui exigiria inventar um paciente
--  para as treze linhas que já existem).
--
--  Sem FOREIGN KEY, como o resto do esquema (ver o achado registrado na
--  documentação: NENHUM vínculo deste banco é mantido pelo Postgres). O que
--  protege é a aplicação — e, no caminho que importa, a recusa de apagar um
--  item do catálogo que ainda tem envio apontando para ele.
-- --------------------------------------------------------------------------
ALTER TABLE testes ADD COLUMN IF NOT EXISTS paciente_id INTEGER;

-- A tela do prontuário lista os desafios daquele paciente. Sem índice, essa
-- consulta varre a tabela inteira a cada pasta aberta.
CREATE INDEX IF NOT EXISTS idx_testes_paciente ON testes(paciente_id)
  WHERE paciente_id IS NOT NULL;

COMMENT ON COLUMN testes.paciente_id IS
  'Dono do desafio. NULO nos 13 rastreios, que são de todos. Desafio sem dono não deve existir.';
