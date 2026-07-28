-- ===========================================================================
-- 003 — de quem é o prontuário e a anamnese
--
-- REGRA NOVA DA CLÍNICA: o profissional vê APENAS os prontuários e as anamneses
-- dele. Não pode, em hipótese alguma, ver os de outro profissional.
--
-- Até aqui a pasta do prontuário era visível a todos os profissionais (só os
-- lançamentos eram privados) e a anamnese era visível a todos. Para aplicar a
-- regra nova faltava o essencial: uma ligação de verdade entre o registro e o
-- profissional.
--
-- O QUE EXISTIA E POR QUE NÃO SERVIA:
--
--  · `profissional` (TEXT) — guarda o NOME digitado. Comparar nome é frágil:
--    muda a grafia, entra um "Dr.", e o registro escapa do filtro. Um recorte
--    de acesso não pode depender de string livre.
--
--  · `usuario_id` — guarda QUEM CRIOU o registro. Erra nos dois sentidos: se a
--    recepção abre a pasta, o profissional deixa de ver o próprio prontuário;
--    e se um profissional cadastra algo para outro, passa a ver o que não é
--    dele. É registro de autoria, não de responsabilidade.
--
-- `profissional_id` aponta para a tabela `profissionais` e é o mesmo vínculo
-- que a agenda já usa (g_usuarios.profissional_id → atendimentos.profissional_id).
-- É o que torna o recorte verificável.
-- ===========================================================================

ALTER TABLE prontuario ADD COLUMN IF NOT EXISTS profissional_id INTEGER;
ALTER TABLE anamneses  ADD COLUMN IF NOT EXISTS profissional_id INTEGER;

-- Preenche os registros que já existem, casando pelo NOME do profissional.
-- É a única ligação disponível no histórico. O que não casar fica NULL — e
-- NULL, na regra nova, significa "sem dono", que NENHUM profissional vê.
-- É o lado seguro do erro: esconder demais se conserta atribuindo a pasta;
-- mostrar de menos não expõe prontuário de ninguém.
UPDATE prontuario SET profissional_id = pf.id
  FROM profissionais pf
 WHERE prontuario.profissional_id IS NULL
   AND prontuario.profissional IS NOT NULL
   AND TRIM(prontuario.profissional) <> ''
   AND LOWER(TRIM(pf.nome)) = LOWER(TRIM(prontuario.profissional));

UPDATE anamneses SET profissional_id = pf.id
  FROM profissionais pf
 WHERE anamneses.profissional_id IS NULL
   AND anamneses.profissional IS NOT NULL
   AND TRIM(anamneses.profissional) <> ''
   AND LOWER(TRIM(pf.nome)) = LOWER(TRIM(anamneses.profissional));

-- O filtro por dono passa a entrar em quase toda consulta de prontuário e
-- anamnese: sem índice, cada tela do profissional varreria a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_pront_prof ON prontuario(profissional_id);
CREATE INDEX IF NOT EXISTS idx_anam_prof  ON anamneses(profissional_id);
