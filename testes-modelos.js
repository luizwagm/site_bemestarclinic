/* ==========================================================================
   MODELOS DE TESTE — a fonte única

   Gerado a partir dos 13 .docx de rastreio entregues pela clínica. O que vale
   é ESTE arquivo: o servidor não pode depender de um documento do Word na
   pasta de ninguém, e o .docx não sobrevive a um "salvar como".

   CADA MODELO TEM DOIS LADOS, e a separação não é enfeite:

     `secoes` / `abertas`  → o que o PACIENTE responde pelo link
     `terapeuta`           → o que a CLÍNICA preenche depois de ler

   Os blocos "prejuízos relatados", "intensidade percebida" e "conduta
   sugerida" estão no fim de oito documentos, e um deles diz na letra
   "ÁREA DE USO EXCLUSIVO DO TERAPEUTA". Se fossem para o link, o paciente
   responderia qual conduta o terapeuta sugere — e a resposta entraria no
   prontuário como se fosse dele.

   A ESCALA guarda VALOR e RÓTULO separados. Os documentos escrevem o mesmo
   eixo de cinco pontos de três jeitos (com "(0)", sem, e terminando ora em
   "Muito Frequentemente" ora em "Sempre"); quem soma é o valor, quem aparece
   na tela é o rótulo do próprio documento.

   NÃO HÁ FAIXA DE SEVERIDADE aqui, de propósito. A soma bruta é aritmética e
   sai calculada; dizer "acima de 40 é grave" seria inventar ponto de corte
   clínico, que nenhum destes documentos traz.

   Para acrescentar um teste: some um objeto nesta lista. Nada de banco.
   ========================================================================== */
"use strict";

const MODELOS_TESTE = [
    {
      "chave": "autoconhecimento",
      "sigla": "RPA-30",
      "nome": "Questionário Psicanalítico de Autoconhecimento",
      "instrucoes": "Este questionário tem como objetivo auxiliar no processo de autoconhecimento e avaliação emocional inicial.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Sempre"
        }
      ],
      "secoes": [
        {
          "titulo": "AUTOIMAGEM E IDENTIDADE",
          "itens": [
            "Tenho dificuldade em me sentir valorizado(a).",
            "Costumo esconder o que realmente sinto.",
            "Sinto necessidade constante de aprovação.",
            "Tenho medo de decepcionar as pessoas.",
            "Sinto que não sou compreendido(a)."
          ]
        },
        {
          "titulo": "ANSIEDADE E CONFLITOS INTERNOS",
          "itens": [
            "Minha mente fica acelerada com frequência.",
            "Tenho pensamentos repetitivos difíceis de controlar.",
            "Tenho dificuldade em relaxar ou descansar.",
            "Sinto medo sem motivo claro.",
            "Sinto culpa mesmo quando não fiz algo errado."
          ]
        },
        {
          "titulo": "HUMOR E VIDA EMOCIONAL",
          "itens": [
            "Tenho momentos frequentes de tristeza.",
            "Sinto vazio emocional ou falta de sentido.",
            "Perco facilmente o interesse pelas coisas.",
            "Tenho dificuldade para sentir prazer ou alegria.",
            "Sinto que estou emocionalmente cansado(a)."
          ]
        },
        {
          "titulo": "RELACIONAMENTOS E AFETIVIDADE",
          "itens": [
            "Tenho medo de abandono ou rejeição.",
            "Sofro por situações do passado.",
            "Tenho dificuldade em confiar nas pessoas.",
            "Guardo sentimentos sem conseguir expressá-los.",
            "Me envolvo emocionalmente de forma intensa."
          ]
        },
        {
          "titulo": "CORPO, ROTINA E COMPORTAMENTO",
          "itens": [
            "Meu sono é ruim ou não reparador.",
            "Sinto tensão física constante no corpo.",
            "Tenho alterações de apetite por ansiedade ou emoção.",
            "Tenho dificuldade em manter equilíbrio emocional na rotina.",
            "Sinto que estou sobrecarregado(a) emocionalmente."
          ]
        }
      ],
      "abertas": [
        "Qual situação emocional mais lhe causa sofrimento atualmente?",
        "Existe alguma experiência do passado que ainda lhe machuca?",
        "O que você gostaria de mudar em sua vida emocional?",
        "Como você se sente em relação a si mesmo(a)?",
        "O que espera alcançar através do acompanhamento terapêutico?"
      ],
      "terapeuta": []
    },
    {
      "chave": "ansiedade",
      "sigla": "RTA-20",
      "nome": "Rastreio Terapêutico de Ansiedade",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se sentido nos últimos 30 dias. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sentiu-se nervoso(a), ansioso(a) ou excessivamente preocupado(a)?",
            "Teve dificuldade para controlar preocupações?",
            "Preocupou-se com situações mesmo sem evidências concretas?",
            "Sentiu dificuldade para relaxar?",
            "Sentiu-se inquieto(a) ou agitado(a)?",
            "Ficou irritado(a) com facilidade?",
            "Sentiu medo de que algo ruim pudesse acontecer?",
            "Teve dificuldade para dormir devido a preocupações?",
            "Acordou já preocupado(a) com tarefas ou problemas?",
            "Sentiu tensão muscular sem causa física aparente?",
            "Teve dificuldade de concentração devido às preocupações?",
            "Sentiu necessidade constante de controlar situações ou pessoas?",
            "Pensou excessivamente sobre problemas futuros?",
            "Sentiu-se sobrecarregado(a) pelas responsabilidades?",
            "Evitou situações por medo ou insegurança?",
            "Sentiu aperto no peito, falta de ar ou palpitações relacionadas ao nervosismo?",
            "Teve sensação constante de estar em alerta?",
            "Sentiu dificuldade para aproveitar momentos de lazer devido às preocupações?",
            "Percebeu que a ansiedade afetou seus relacionamentos?",
            "Percebeu que a ansiedade prejudicou seu desempenho profissional ou acadêmico?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "assinale_o_s_prejuizo_s_relatado_s_pelo",
          "titulo": "Assinale o(s) prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Não identificados",
            "Profissional",
            "Acadêmico",
            "Social",
            "Familiar",
            "Relacionamento Conjugal",
            "Financeiro",
            "Emocional",
            "Autocuidado"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        },
        {
          "chave": "conduta_sugerida_pelo_terapeuta",
          "titulo": "Conduta Sugerida pelo Terapeuta",
          "tipo": "check",
          "opcoes": [
            "Psicoeducação",
            "Psicoterapia",
            "Encaminhamento Médico",
            "Avaliação Complementar",
            "Terapia",
            "Complemento com Fitoterápico"
          ]
        }
      ]
    },
    {
      "chave": "apego_emocional",
      "sigla": "RTAE-20",
      "nome": "Rastreio Terapêutico de Apego Emocional",
      "instrucoes": "Marque apenas uma alternativa para cada afirmação, considerando como você costuma sentir e agir em seus relacionamentos afetivos, familiares e sociais.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Tenho medo de perder pessoas importantes para mim.",
            "Sinto ansiedade quando alguém demora para responder minhas mensagens.",
            "Preciso sentir que sou constantemente amado(a).",
            "Tenho dificuldade em ficar sozinho(a).",
            "Sinto necessidade constante de aprovação das pessoas.",
            "Tenho medo de ser abandonado(a).",
            "Permaneço em relacionamentos mesmo quando me fazem mal.",
            "Faço sacrifícios excessivos para não perder alguém.",
            "Tenho dificuldade para dizer \"não\" às pessoas que amo.",
            "Sinto ciúmes com facilidade.",
            "Fico inseguro(a) quando a pessoa demonstra necessidade de espaço.",
            "Costumo colocar as necessidades do outro acima das minhas.",
            "Tenho dificuldade para encerrar relacionamentos.",
            "Sinto-me vazio(a) quando estou sem um relacionamento.",
            "Idealizo pessoas com facilidade.",
            "Tenho medo de decepcionar quem amo.",
            "Sinto que minha felicidade depende de outra pessoa.",
            "Tenho dificuldade para tomar decisões sem a opinião de alguém importante.",
            "Sinto necessidade de controlar o relacionamento para evitar perdas.",
            "Percebo que meu medo de perder pessoas interfere na minha qualidade de vida."
          ]
        }
      ],
      "abertas": [],
      "terapeuta": []
    },
    {
      "chave": "autoestima",
      "sigla": "RTAE-15",
      "nome": "Rastreio Terapêutico de Autoestima",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se sentido nos últimos 30 dias. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sente-se satisfeito(a) consigo mesmo(a)?",
            "Reconhece suas qualidades pessoais?",
            "Acredita que possui valor como pessoa?",
            "Sente-se capaz de enfrentar desafios da vida?",
            "Aceita seus erros como parte do processo de crescimento?",
            "Sente-se confiante em suas capacidades pessoais?",
            "Considera-se uma pessoa importante para sua família e amigos?",
            "Tem confiança em suas decisões?",
            "Acredita que merece respeito das outras pessoas?",
            "Consegue receber elogios com naturalidade?",
            "Valoriza suas conquistas pessoais?",
            "Sente orgulho das dificuldades que já superou?",
            "Reconhece seus pontos fortes e talentos?",
            "Sente-se seguro(a) ao expressar suas opiniões?",
            "Considera-se uma pessoa digna de amor, carinho e aceitação?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "observacao_clinica",
          "titulo": "Observação clínica",
          "tipo": "texto",
          "opcoes": []
        },
        {
          "chave": "prejuizo_s_relatado_s_pelo_paciente",
          "titulo": "Prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Não identificados",
            "Profissional",
            "Acadêmico",
            "Social",
            "Familiar",
            "Relacionamento Conjugal",
            "Financeiro",
            "Emocional",
            "Autocuidado"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    },
    {
      "chave": "caracteristicas_associadas_ao_transtorno",
      "sigla": "RTB-25",
      "nome": "Rastreio Terapêutico de Características Associadas ao Transtorno de Personalidade Borderline",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se sentido e se comportado nos últimos 12 meses. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Tem medo intenso de ser abandonado(a) por pessoas importantes para você?",
            "Sofre excessivamente quando alguém se afasta ou demora a responder mensagens?",
            "Faz grandes esforços para evitar rejeição ou abandono?",
            "Seus relacionamentos costumam ser muito intensos e instáveis?",
            "Costuma mudar rapidamente sua opinião sobre as pessoas?",
            "Sente-se extremamente decepcionado(a) com pessoas que antes admirava?",
            "Tem dificuldade em definir quem realmente é?",
            "Sua imagem sobre si mesmo(a) muda frequentemente?",
            "Sente-se perdido(a) quanto aos seus objetivos ou identidade?",
            "Toma decisões impulsivas das quais se arrepende depois?",
            "Faz compras, gastos ou escolhas impulsivas?",
            "Tem dificuldade para pensar nas consequências antes de agir?",
            "Apresenta mudanças intensas de humor ao longo do dia?",
            "Pequenos acontecimentos afetam intensamente seu estado emocional?",
            "Tem dificuldade para recuperar o equilíbrio emocional após conflitos?",
            "Sente um vazio emocional persistente?",
            "Tem a sensação de que algo está faltando em sua vida, mesmo quando tudo parece estar bem?",
            "Sente-se sozinho(a) mesmo quando está acompanhado(a)?",
            "Tem explosões de raiva difíceis de controlar?",
            "Arrepende-se de coisas ditas ou feitas durante momentos de irritação?",
            "Costuma interpretar críticas como rejeição pessoal?",
            "Sofre intensamente quando se sente incompreendido(a)?",
            "Tem dificuldade para confiar que as pessoas permanecerão ao seu lado?",
            "Seus relacionamentos frequentemente passam por conflitos intensos?",
            "Percebe que suas emoções afetam significativamente suas decisões e relacionamentos?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "prejuizo_s_relatado_s_pelo_paciente",
          "titulo": "Prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Relacionamentos Afetivos",
            "Relacionamentos Familiares",
            "Relacionamentos Sociais",
            "Controle Emocional",
            "Impulsividade",
            "Autoimagem",
            "Trabalho",
            "Estudos",
            "Tomada de Decisão",
            "Controle da Raiva",
            "Não identificados"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    },
    {
      "chave": "crencas_centrais",
      "sigla": "RTCC-30",
      "nome": "Rastreio Terapêutico de Crenças Centrais",
      "instrucoes": "Marque apenas uma alternativa para cada afirmação",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sinto que não sou bom(a) o suficiente.",
            "Acredito que outras pessoas são melhores que eu.",
            "Tenho medo de ser rejeitado(a).",
            "Acredito que vou fracassar antes mesmo de tentar.",
            "Tenho dificuldade em aceitar elogios.",
            "Preciso agradar as pessoas para ser aceito(a).",
            "Tenho medo constante de ser abandonado(a).",
            "Costumo me sentir culpado(a) facilmente.",
            "Acredito que devo fazer tudo perfeitamente.",
            "Quando erro, sinto que sou um fracasso.",
            "Tenho dificuldade para confiar nas pessoas.",
            "Acredito que ninguém realmente me compreende.",
            "Sinto que não mereço ser feliz.",
            "Tenho medo de decepcionar as pessoas.",
            "Preciso controlar tudo para me sentir seguro(a).",
            "Assumo responsabilidades que não são minhas.",
            "Tenho dificuldade para decidir sozinho(a).",
            "Espero que algo ruim aconteça.",
            "Não consigo resolver meus problemas sozinho(a).",
            "Preciso provar meu valor constantemente.",
            "Não aceito minhas limitações.",
            "Só serei amado(a) se for perfeito(a).",
            "Escondo meus sentimentos por medo de rejeição.",
            "Acredito que as pessoas irão me decepcionar.",
            "Coloco as necessidades dos outros acima das minhas.",
            "Tenho dificuldade em dizer \"não\".",
            "Preciso da aprovação dos outros para me sentir bem.",
            "Acredito que dificilmente terei sucesso.",
            "Tenho dificuldade para reconhecer minhas conquistas.",
            "Sinto que não sou importante."
          ]
        }
      ],
      "abertas": [],
      "terapeuta": []
    },
    {
      "chave": "depressao",
      "sigla": "RTD-20",
      "nome": "Rastreio Terapêutico de Depressão",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se sentido nos últimos 30 dias. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sentiu-se triste na maior parte do tempo?",
            "Perdeu o interesse por atividades que antes gostava?",
            "Sentiu falta de motivação para realizar tarefas?",
            "Sentiu-se sem esperança em relação ao futuro?",
            "Teve vontade de se isolar das pessoas?",
            "Sentiu-se cansado(a) sem motivo aparente?",
            "Teve dificuldade para sentir alegria ou prazer?",
            "Sentiu-se inútil ou incapaz?",
            "Teve dificuldade de concentração?",
            "Sentiu culpa excessiva por situações do dia a dia?",
            "Chorou com facilidade?",
            "Teve alterações significativas no sono?",
            "Teve alterações significativas no apetite?",
            "Sentiu-se emocionalmente vazio(a)?",
            "Percebeu diminuição da autoestima?",
            "Sentiu dificuldade para tomar decisões simples?",
            "Percebeu queda de rendimento profissional ou acadêmico?",
            "Sentiu-se sem energia para enfrentar o dia?",
            "Pensou que sua vida perdeu o sentido?",
            "Sentiu que os problemas pareciam maiores do que realmente eram?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "prejuizos_relatados_pelo_paciente",
          "titulo": "Prejuízos relatados pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Não identificados",
            "Profissional",
            "Acadêmico",
            "Social",
            "Familiar",
            "Relacionamento Conjugal",
            "Financeiro",
            "Emocional",
            "Autocuidado"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    },
    {
      "chave": "estresse",
      "sigla": "RTE-20",
      "nome": "Rastreio Terapêutico de Estresse",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se sentido nos últimos 30 dias. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sentiu-se sobrecarregado(a) pelas responsabilidades diárias?",
            "Teve dificuldade para relaxar ao final do dia?",
            "Sentiu-se mentalmente cansado(a)?",
            "Ficou irritado(a) por situações pequenas?",
            "Sentiu que havia mais tarefas do que conseguia realizar?",
            "Teve dificuldade para dormir devido às preocupações?",
            "Sentiu dores de cabeça relacionadas à tensão emocional?",
            "Percebeu tensão muscular frequente?",
            "Sentiu-se impaciente com familiares, colegas ou amigos?",
            "Teve dificuldade para se concentrar em suas atividades?",
            "Sentiu-se esgotado(a) emocionalmente?",
            "Sentiu que não tinha tempo suficiente para si mesmo(a)?",
            "Teve dificuldade para aproveitar momentos de descanso?",
            "Sentiu-se pressionado(a) por expectativas externas?",
            "Percebeu queda de rendimento profissional ou acadêmico?",
            "Sentiu necessidade constante de resolver problemas imediatamente?",
            "Sentiu-se sem energia para atividades que normalmente realiza?",
            "Percebeu alterações no apetite relacionadas ao estresse?",
            "Sentiu que perdeu o controle sobre algumas situações da sua vida?",
            "Percebeu que o estresse prejudicou sua qualidade de vida?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "observacao_clinica",
          "titulo": "Observação clínica",
          "tipo": "texto",
          "opcoes": []
        },
        {
          "chave": "prejuizo_s_relatado_s_pelo_paciente",
          "titulo": "Prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Não identificados",
            "Profissional",
            "Acadêmico",
            "Social",
            "Familiar",
            "Relacionamento Conjugal",
            "Financeiro",
            "Emocional",
            "Autocuidado"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    },
    {
      "chave": "funcionalidade_diaria",
      "sigla": "RTFD-20",
      "nome": "Rastreio Terapêutico de Funcionalidade Diária",
      "instrucoes": "Leia cada afirmação e marque a alternativa que melhor representa como você tem se sentido nas últimas duas semanas.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Tenho dificuldade para levantar da cama e iniciar o dia.",
            "Adio tarefas simples mesmo sabendo que são importantes.",
            "Tenho dificuldade para cuidar da minha higiene pessoal.",
            "Sinto falta de energia para realizar atividades do dia a dia.",
            "Tenho dificuldade para manter minha casa organizada.",
            "Deixo acumular tarefas por falta de disposição.",
            "Tenho dificuldade para preparar refeições ou me alimentar adequadamente.",
            "Perco o interesse por atividades que antes realizava normalmente.",
            "Tenho dificuldade para cumprir horários.",
            "Sinto que pequenas tarefas parecem grandes esforços.",
            "Tenho dificuldade para iniciar uma atividade sem que alguém me incentive.",
            "Evito responsabilidades por me sentir incapaz de realizá-las.",
            "Costumo interromper tarefas antes de terminá-las.",
            "Tenho dificuldade para manter minha rotina diária.",
            "Tenho dificuldade para cuidar das minhas obrigações financeiras ou pessoais.",
            "Sinto que meu rendimento diminuiu significativamente.",
            "Preciso fazer muito esforço para concluir tarefas simples.",
            "Tenho dificuldade para cuidar da minha saúde ou seguir tratamentos.",
            "Percebo que minha dificuldade para realizar tarefas interfere nos meus relacionamentos.",
            "Sinto que minha dificuldade para realizar atividades básicas prejudica minha qualidade de vida."
          ]
        }
      ],
      "abertas": [],
      "terapeuta": []
    },
    {
      "chave": "padroes_de_infancia",
      "sigla": "RTPI-20",
      "nome": "Rastreio Terapêutico de Padrões de Infância",
      "instrucoes": "Marque apenas uma alternativa para cada afirmação, considerando suas lembranças e experiências predominantes durante a infância e adolescência.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Senti que recebia pouco carinho ou demonstrações de afeto.",
            "Sentia que minhas emoções não eram compreendidas.",
            "Recebia críticas com mais frequência do que elogios.",
            "Sentia medo de errar por causa das reações dos adultos.",
            "Precisava agradar para receber atenção ou carinho.",
            "Sentia-me rejeitado(a) ou excluído(a) na família.",
            "Fui comparado(a) negativamente com irmãos ou outras crianças.",
            "Sentia que precisava ser perfeito(a) para ser aceito(a).",
            "Meus sentimentos eram ignorados ou minimizados.",
            "Tinha medo de decepcionar meus pais ou responsáveis.",
            "Faltava segurança emocional dentro de casa.",
            "Sentia que precisava resolver problemas de adultos.",
            "Recebia poucas palavras de incentivo.",
            "Sentia que precisava esconder minhas emoções.",
            "Fui educado(a) com excesso de controle ou rigidez.",
            "Sentia medo de ser abandonado(a).",
            "Sentia que minhas necessidades vinham depois das dos outros.",
            "Assumia responsabilidades incompatíveis com minha idade.",
            "Sentia que precisava \"merecer\" o amor da minha família.",
            "Hoje percebo que muitas experiências da infância ainda influenciam minha vida."
          ]
        }
      ],
      "abertas": [],
      "terapeuta": []
    },
    {
      "chave": "perfil_de_personalidade",
      "sigla": "RTPP-25",
      "nome": "Rastreio Terapêutico de Perfil de Personalidade",
      "instrucoes": "Responda às perguntas abaixo considerando seu comportamento habitual. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Gosta de conhecer pessoas novas?",
            "Sente-se confortável em ambientes sociais?",
            "Costuma organizar suas tarefas com antecedência?",
            "Cumpre compromissos assumidos?",
            "Demonstra empatia pelas dificuldades dos outros?",
            "Procura compreender diferentes pontos de vista?",
            "Mantém a calma diante de situações difíceis?",
            "Consegue lidar com críticas de forma equilibrada?",
            "Gosta de aprender coisas novas?",
            "Tem interesse por novos conhecimentos e experiências?",
            "Costuma assumir a liderança quando necessário?",
            "Consegue trabalhar bem em equipe?",
            "É persistente diante dos desafios?",
            "Costuma finalizar o que começa?",
            "Demonstra respeito pelas diferenças das pessoas?",
            "Consegue controlar impulsos em situações difíceis?",
            "Mantém equilíbrio emocional na maior parte do tempo?",
            "Aceita mudanças com relativa facilidade?",
            "Busca soluções criativas para problemas?",
            "Demonstra responsabilidade em suas decisões?",
            "Costuma refletir antes de agir?",
            "Consegue adaptar-se a diferentes situações?",
            "Sente-se à vontade para iniciar conversas com pessoas que não conhece?",
            "Mantém relacionamentos interpessoais saudáveis?",
            "Considera-se uma pessoa emocionalmente madura?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": []
    },
    {
      "chave": "relacionamento_conjugal",
      "sigla": "RTRC-20",
      "nome": "Rastreio Terapêutico de Relacionamento Conjugal",
      "instrucoes": "Marque apenas uma alternativa para cada pergunta, considerando como você tem se sentido nos últimos 30 dias.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Sente-se respeitado(a) por seu parceiro(a)?",
            "Existe diálogo saudável entre vocês?",
            "Consegue expressar seus sentimentos livremente?",
            "Sente-se ouvido(a) quando fala sobre suas necessidades?",
            "Existe demonstração de carinho entre vocês?",
            "Há confiança mútua no relacionamento?",
            "Conseguem resolver conflitos de forma respeitosa?",
            "Sentem-se parceiros na resolução dos problemas?",
            "Existe apoio emocional mútuo?",
            "Sentem-se satisfeitos com o tempo que passam juntos?",
            "Há respeito pelas individualidades de cada um?",
            "Existe cooperação nas responsabilidades familiares?",
            "Sentem-se valorizados dentro do relacionamento?",
            "Conseguem conversar sobre assuntos difíceis?",
            "Existe transparência nas decisões importantes?",
            "Sentem-se emocionalmente seguros no relacionamento?",
            "Conseguem demonstrar gratidão um pelo outro?",
            "Existe respeito durante divergências e discussões?",
            "Sentem-se felizes com a relação de forma geral?",
            "Acreditam que o relacionamento contribui positivamente para suas vidas?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "prejuizo_s_relatado_s_pelo_paciente",
          "titulo": "Prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Comunicação",
            "Confiança",
            "Intimidade",
            "Convivência Familiar",
            "Ciúmes",
            "Gestão Financeira",
            "Resolução de Conflitos",
            "Outros"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    },
    {
      "chave": "tdah_adulto",
      "sigla": "RTDA-20",
      "nome": "Rastreio Terapêutico de TDAH Adulto",
      "instrucoes": "Responda às perguntas abaixo considerando como você tem se comportado nos últimos 6 meses. Assinale apenas uma alternativa para cada item.",
      "escala": [
        {
          "v": 0,
          "r": "Nunca"
        },
        {
          "v": 1,
          "r": "Raramente"
        },
        {
          "v": 2,
          "r": "Às Vezes"
        },
        {
          "v": 3,
          "r": "Frequentemente"
        },
        {
          "v": 4,
          "r": "Muito Frequentemente"
        }
      ],
      "secoes": [
        {
          "titulo": null,
          "itens": [
            "Tem dificuldade para manter a atenção em tarefas longas ou repetitivas?",
            "Comete erros por distração em atividades importantes?",
            "Tem dificuldade para ouvir atentamente quando alguém está falando?",
            "Inicia tarefas e não consegue concluí-las?",
            "Tem dificuldade para organizar compromissos ou atividades?",
            "Costuma evitar tarefas que exigem esforço mental prolongado?",
            "Perde objetos importantes com frequência?",
            "Distrai-se facilmente com estímulos externos?",
            "Esquece compromissos ou responsabilidades?",
            "Tem dificuldade para administrar o tempo?",
            "Sente inquietação ou necessidade constante de se movimentar?",
            "Tem dificuldade para permanecer sentado por longos períodos?",
            "Sente-se agitado(a) mesmo em momentos de descanso?",
            "Fala excessivamente em determinadas situações?",
            "Interrompe pessoas durante conversas?",
            "Tem dificuldade para esperar sua vez?",
            "Toma decisões impulsivamente?",
            "Inicia atividades sem pensar nas consequências?",
            "Percebe que a desatenção afeta seu trabalho ou estudos?",
            "Percebe que impulsividade ou distração afetam seus relacionamentos?"
          ]
        }
      ],
      "abertas": [],
      "terapeuta": [
        {
          "chave": "prejuizo_s_relatado_s_pelo_paciente",
          "titulo": "Prejuízo(s) relatado(s) pelo paciente",
          "tipo": "check",
          "opcoes": [
            "Não identificados",
            "Profissional",
            "Acadêmico",
            "Social",
            "Familiar",
            "Relacionamento Conjugal",
            "Financeiro",
            "Organização Pessoal",
            "Gestão do Tempo",
            "Emocional"
          ]
        },
        {
          "chave": "intensidade_percebida",
          "titulo": "Intensidade percebida",
          "tipo": "radio",
          "opcoes": [
            "Leve",
            "Moderada",
            "Elevada"
          ]
        }
      ]
    }
  ];

module.exports = { MODELOS_TESTE };
