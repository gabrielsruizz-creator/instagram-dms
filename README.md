# Limpador de DMs do Instagram

App que roda no seu computador, conecta na sua conta do Instagram, mostra **todas** as
conversas (caixa de entrada + pedidos de mensagem) e deixa você **selecionar várias e
excluir de uma vez**.

## O que ele faz

- Lista todas as conversas, com foto, nome, última mensagem e data.
- Aba separada para **Pedidos de mensagem**.
- Busca por nome, @usuário ou texto da última mensagem.
- Filtros: individuais / grupos, conversas paradas há +7 dias, +30 dias, +3 meses, +6 meses, +1 ano,
  e quem mandou a última mensagem (você ou a outra pessoa).
- **Selecionar todas as visíveis** com um clique. Combina com os filtros: por exemplo,
  “grupos parados há +1 ano” → selecionar todas → excluir.
- Clique numa conversa para marcar; **Shift + clique** marca um intervalo inteiro.
- Exclusão em lote com barra de progresso, botão de parar e lista de erros.

“Excluir” aqui é o mesmo que o botão **Excluir conversa** do app: a conversa some da
**sua** caixa de entrada, mas a outra pessoa continua vendo. Não dá para desfazer.

## Como usar

Você precisa do **Python entre 3.10 e 3.14**. Versões mais novas ainda não funcionam porque
algumas dependências não têm pacote pronto para elas. No Windows, o jeito mais fácil é rodar no
PowerShell: `winget install -e --id Python.Python.3.13` (o `iniciar.bat` escolhe sozinho a versão
compatível, mesmo que você tenha outras instaladas).

1. Baixe este repositório (botão verde **Code → Download ZIP**) e descompacte.
2. Abra a pasta e rode:
   - **Windows:** dois cliques em `iniciar.bat`
   - **Mac / Linux:** no Terminal, `./iniciar.sh`
3. Na primeira vez ele instala as dependências (leva 1–2 minutos). Depois o navegador abre
   sozinho em <http://127.0.0.1:8765>.
4. Entre com seu usuário e senha. Se sua conta tiver verificação em duas etapas, ou se o
   Instagram mandar um código por e-mail/SMS, o app pede o código na tela.
5. Espere carregar as conversas, filtre/selecione e clique em **Excluir selecionadas**.

Para fechar, feche a janela do terminal (ou aperte `Ctrl+C`).

Rodando manualmente, sem os scripts:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt     # Windows: .venv\Scripts\pip
.venv/bin/python app.py                       # Windows: .venv\Scripts\python app.py
```

## Leia antes de usar

- **Não é a API oficial.** A API oficial do Instagram (Meta) não permite listar todas as DMs
  de uma conta pessoal nem excluir conversas. Este app usa a biblioteca
  [instagrapi](https://github.com/subzeroid/instagrapi), que conversa com o Instagram do mesmo
  jeito que o app do celular. Isso vai contra os Termos de Uso do Instagram e, se usado de forma
  exagerada, o Instagram pode pedir verificação ou bloquear ações temporariamente. Use por
  sua conta e risco.
- **Rode no seu computador, na sua internet de casa.** Não coloque em servidor/nuvem: o Instagram
  bloqueia logins vindos de data centers e pode travar a conta.
- **Vá com calma.** Existe uma pausa de 1,5 a 3,5 segundos entre cada exclusão (dá umas 20
  conversas por minuto). Para muitas conversas, prefira lotes de algumas centenas. Se aparecer
  “O Instagram limitou as requisições”, espere de 30 minutos a algumas horas antes de continuar.
  Dá para mudar a pausa com as variáveis de ambiente `DELETE_DELAY_MIN` e `DELETE_DELAY_MAX`.
- **Sua senha** vai direto do seu computador para o Instagram e não é gravada. O app guarda só
  a sessão de login em `session.json` (na pasta do projeto) para você não ter que entrar toda vez.
  Esse arquivo dá acesso à sua conta: não compartilhe e não suba para o GitHub
  (ele já está no `.gitignore`). Clicar em **Sair** apaga o arquivo.
- Conversas com **criptografia de ponta a ponta** podem não aparecer na lista, porque o
  Instagram não as entrega por esse caminho.
- O servidor só aceita conexões do próprio computador (`127.0.0.1`).

## Estrutura

```
app.py            servidor Flask (login, listagem, exclusão em lote)
static/           interface (HTML, CSS e JavaScript puro)
iniciar.bat/.sh   instalam as dependências e abrem o app
```
