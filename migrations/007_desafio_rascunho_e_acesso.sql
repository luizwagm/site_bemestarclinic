-- ==========================================================================
--  007 — O DESAFIO QUE REABRE, e a porta do link
--
--  Duas mudanças que vieram juntas porque uma depende da outra: reabrir só faz
--  sentido se o que foi escrito ficar guardado, e guardar por uma semana só é
--  aceitável se o link tiver dono.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  RASCUNHO — o que o paciente escreveu e ainda não concluiu
--
--  Um desafio é preenchido ao longo da semana: escolhe a tarefa na segunda,
--  anota a distração na terça, responde as três perguntas no fim de cada dia.
--  Sem rascunho, reabrir seria pior do que não reabrir — ele escreveria na
--  terça e encontraria tudo em branco na quarta.
--
--  Coluna SEPARADA de `respostas`, e não a mesma:
--
--    · `respostas` é o que foi ENTREGUE, com data de conclusão. É o que entra
--      no prontuário e o que a clínica lê como material da sessão;
--    · `rascunho` é trabalho em curso. Confundir os dois faria um formulário
--      pela metade aparecer no prontuário como se fosse resposta do paciente,
--      e ninguém saberia dizer se ele terminou ou parou no meio.
--
--  CIFRADO pela aplicação, pela razão óbvia: é o mesmo conteúdo de
--  `respostas`, só que ainda sendo escrito.
-- --------------------------------------------------------------------------
ALTER TABLE teste_envios ADD COLUMN IF NOT EXISTS rascunho TEXT;
ALTER TABLE teste_envios ADD COLUMN IF NOT EXISTS rascunho_em TEXT;

-- --------------------------------------------------------------------------
--  ACESSO — quando o paciente provou que é ele
--
--  O link passou a exigir a data de nascimento do paciente antes de mostrar
--  QUALQUER COISA. Não é só para proteger as respostas: até aqui, quem tivesse
--  o link lia o nome da pessoa e o nome do teste antes de qualquer barreira —
--  e "Rastreio Terapêutico de TDAH Adulto" é diagnóstico.
--
--  Esta coluna é registro, não permissão: quem decide se a pessoa entra é a
--  conferência da data + o cookie assinado do aparelho. Guardar o instante
--  serve à clínica ("ele conseguiu abrir?") e à auditoria.
-- --------------------------------------------------------------------------
ALTER TABLE teste_envios ADD COLUMN IF NOT EXISTS acesso_em TEXT;

COMMENT ON COLUMN teste_envios.rascunho IS
  'JSON CIFRADO: respostas parciais de um desafio em andamento. NÃO é o que foi entregue — isso é `respostas`.';
COMMENT ON COLUMN teste_envios.acesso_em IS
  'Primeira vez que alguém passou pela conferência da data de nascimento neste link.';
