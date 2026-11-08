# Personalizações do CineDrive

Revisado em **7 de novembro de 2026**. Este documento registra as mudanças funcionais discutidas para este checkout em relação ao CineDrive original, e separa alterações no código de procedimentos feitos fora do repositório.

## Reprodução de séries

Na página de uma série há **Playback settings**, com configurações padrão para os episódios:

- posição inicial em segundos, para pular a abertura;
- posição em segundos para marcar o episódio como concluído;
- regra para marcar o episódio como concluído quando faltar uma quantidade configurada de segundos para o fim;
- até 20 pontos de salto, cada um com um tempo de disparo e um tempo de destino.

O tempo fixo e o tempo restante são alternativas exclusivas para a conclusão. Cada episódio pode herdar a regra da série ou sobrescrevê-la com uma dessas opções. A regra do episódio prevalece sobre a série. Quando nenhuma regra está configurada, permanece o padrão de conclusão de séries de **99%**. Se o player não tiver uma duração válida ou o tempo restante configurado for maior ou igual à duração, o padrão de 99% é mantido.

Cada episódio também pode sobrescrever o início e os pontos de salto. O início em branco herda o valor da série; `0` é um valor explícito. Para os pontos de salto, o episódio pode herdar os da série ou usar sua própria lista. Sem configuração, o episódio começa em `0` e não tem saltos adicionais.

As seções de Playback settings e anotações da série, assim como os detalhes de override dos episódios, começam recolhidas para reduzir a altura da página.

O padrão de conclusão para séries foi alterado de **92% para 98% e depois para 99%**, após a análise dos tempos de The Good Doctor. O padrão de filmes continua em 92%. Um tempo de conclusão explicitamente configurado na série ou no episódio prevalece sobre o percentual padrão, e o valor do episódio tem prioridade sobre o da série.

Após a anomalia em que o segundo episódio começava perto do fim, o fluxo foi reforçado para isolar a troca de fonte, a posição inicial, os estados de conclusão e os pontos de salto por episódio. O usuário relatou depois que não estava encontrando novos problemas. O início em 88 segundos, a conclusão em 1305 segundos e os pontos de salto também foram testados manualmente e relatados como funcionando.

## Anotações por série

Foi adicionado um campo de anotação na página da série. A anotação é pessoal, associada ao usuário e à série; não há anotação por episódio.

## Tela cheia e cursor

- A navegação automática para o próximo episódio mantém a tela cheia: a página conserva o contêiner de tela cheia enquanto troca a instância do player.
- Quando os controles se ocultam por inatividade, o cursor também recebe `cursor-none`. Movimento do mouse ou toque revela os controles e o cursor. O temporizador atual dos controles é de 3,5 segundos durante a reprodução.

## Modo de compatibilidade de reprodução

O player inicia no modo de compatibilidade por padrão. O modo inicial é escolhido pelo navegador: `audio` (transcodificação de áudio) em navegadores que não são Safari e `hls` no Safari/WebKit. Portanto, no Chrome, isso corresponde à opção “Play in audio / Safari compatibility mode”. Essa escolha está definida no código e é reaplicada ao montar o player; não é uma variável de ambiente nem uma preferência gravada nas configurações do usuário. O controle do player ainda permite alternar o modo durante a reprodução.

## Preferência e seleção de faixa de áudio

Em **Settings > Playback**, cada usuário pode escolher o idioma preferido. O padrão é **Português (Brasil) — pt-BR**; também há pt-PT, inglês e seleção automática. A preferência fica no banco de dados por usuário.

O player mostra um seletor manual quando o arquivo tem várias faixas. O servidor cataloga as faixas de arquivos locais e do Google Drive e aplica a faixa escolhida ao fluxo transcodificado/HLS. A cópia local do episódio S02E02 de The Good Doctor foi examinada com FFmpeg: ela contém áudio em português (`por`) e inglês, mas o inglês está marcado como padrão. A seleção explícita da faixa portuguesa foi validada com FFmpeg. A reprodução completa dessa faixa no navegador, usando a origem do Google Drive, ainda precisa de validação manual autenticada.

## Banco de dados

As alterações usam migrações Prisma versionadas:

- `20261029000000_series_playback_settings` — início e conclusão na série e no episódio;
- `20261030000000_playback_skip_breakpoints` — pontos de salto na série e no episódio;
- `20261030010000_personal_series_notes` — anotações pessoais por série;
- `20261103000000_audio_track_selection` — idioma preferido e cache de metadados das faixas;
- `20261107000000_series_completion_before_end` — regra de conclusão baseada no tempo restante, para séries e episódios.

Ao levar o código para outra máquina com um banco existente, gere o cliente Prisma, aplique as migrações e reinicie o servidor:

```bash
pnpm prisma:generate
pnpm --filter @cinedrive/server prisma:deploy
```

Isso atualiza o schema mantendo os dados e históricos existentes; não recrie nem apague `apps/server/data/app.db` para aplicar essas alterações.

## Investigações que não alteraram o código

- **Autorização do Google Drive:** o erro de escopos insuficientes foi resolvido marcando a caixa de autorização na tela de consentimento do Google. A investigação do diff não encontrou alteração no fluxo OAuth ou em escopos do projeto relacionada a esse caso.
- **Nomes dos episódios de Tomb Raider King:** os arquivos foram renomeados manualmente na pasta Downloads para facilitar o teste. Não houve alteração de nomes de vídeos no repositório nem mudança do algoritmo de identificação de séries por causa dessa renomeação.

## Validação registrada

Os builds do servidor e do web, o typecheck, o lint e a validação do schema Prisma passaram durante o trabalho. O usuário confirmou o funcionamento dos tempos de início/conclusão e dos pontos de salto em seus testes. O código do cursor e da preservação de tela cheia foi inspecionado nesta revisão; esta revisão não executou uma sessão autenticada do player no navegador.

Para a regra de tempo restante, os typechecks e builds do servidor, web e pacote compartilhado passaram; o lint direcionado e o Prettier também passaram. A migração `20261107000000_series_completion_before_end` foi aplicada ao banco local. A reprodução em uma sessão autenticada ainda precisa da conferência manual do usuário.
