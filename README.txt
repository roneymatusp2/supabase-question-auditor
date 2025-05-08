# SUPABASE QUESTION AUDITOR - GUIA DETALHADO

## VISÃO GERAL

Este sistema automatiza a validação e correção de questões matemáticas armazenadas no Supabase usando a API DeepSeek AI.

O processo:
1. Busca questões no Supabase por tópico (padrão: "monomios")
2. Envia cada questão ao modelo "deepseek-reasoner" para validação
3. Atualiza as questões no Supabase com as correções sugeridas
4. Mantém um log detalhado de todas as operações

## PRINCIPAIS CARACTERÍSTICAS

### 1. Processamento Paralelo e em Lotes
- Processa múltiplas questões simultaneamente (padrão: 5 concorrentes)
- Divide grandes conjuntos de questões em lotes gerenciáveis (padrão: 10 por lote)
- Ajuste através das variáveis de ambiente:
  * MAX_CONCURRENCY - número de chamadas paralelas à API
  * BATCH_SIZE - tamanho de cada lote de processamento

### 2. Sanitização Robusta de Dados
- Implementação de sanitização avançada para evitar erros JSON
- Sistema de fallback em três níveis para questões problemáticas
- Tratamento especial para caracteres de escape e caracteres especiais

### 3. Métricas e Estatísticas
- Rastreamento abrangente de progressão com estatísticas em tempo real
- Relatórios regulares de progresso durante a execução
- Relatório final detalhado com métricas de desempenho
- Monitoramento de taxa de sucesso/falha e velocidade de processamento

### 4. Sistema de Retry Inteligente
- Tentativas alternativas para questões com formato problemático
- Redução de delay entre tentativas para otimizar desempenho
- Registros detalhados para diagnóstico de problemas

## ARQUIVOS PRINCIPAIS

1. `src/scripts/validateQuestions.ts` - Implementação principal com todos os componentes
2. `src/scripts/audit-questions.ts` - Arquivo de entrada que importa a implementação
3. `.github/workflows/validate-questions.yml` - Configuração do GitHub Actions
4. `curation-audit.log` - Log gerado durante a execução (criado automaticamente)

## VARIÁVEIS DE AMBIENTE

Configure estas variáveis no arquivo `.env` ou nos secrets do GitHub:

```
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_KEY=sua-chave-de-servico
DEEPSEEK_API_KEY=sua-chave-deepseek
BATCH_SIZE=10
MAX_CONCURRENCY=5
```

## EXECUÇÃO LOCAL

```bash
# Instalar dependências
npm install

# Compilar o TypeScript
npm run build

# Executar o processo de auditoria
npm run audit:questions

# Para especificar um tópico diferente
npm run audit:questions -- --topic=binomios
```

## MONITORAMENTO E RESULTADOS

Durante a execução, o sistema gera mensagens de log como:

```
2025-05-08T03:10:00.000Z • 🚀 Iniciando curadoria de questões...
2025-05-08T03:10:01.000Z • 🔍 Buscando questões para o tópico: monomios
2025-05-08T03:10:02.000Z • ✔️ 1000 questões encontradas.
2025-05-08T03:10:03.000Z • 📦 Dividindo 1000 questões em 100 lotes de até 10
2025-05-08T03:10:04.000Z • 🔄 Processando lote 1/100 (10 questões)...
...
2025-05-08T03:15:00.000Z • 📊 Progresso: 500/1000 questões (50.0%)
...
2025-05-08T03:20:00.000Z • 📊 RESUMO DA EXECUÇÃO:
2025-05-08T03:20:00.000Z •    Total de questões: 1000
2025-05-08T03:20:00.000Z •    Processadas: 1000 (100.0%)
2025-05-08T03:20:00.000Z •    Sucesso: 950
2025-05-08T03:20:00.000Z •    Falhas: 30
2025-05-08T03:20:00.000Z •    Puladas: 20
2025-05-08T03:20:00.000Z •    Erros de API: 35
2025-05-08T03:20:00.000Z •    Erros de atualização: 5
2025-05-08T03:20:00.000Z •    Tempo total: 600.0 segundos
2025-05-08T03:20:00.000Z •    Velocidade: 1.67 questões/segundo
```

## INTEGRAÇÃO GITHUB ACTIONS

O workflow é executado automaticamente:
- A cada push para a branch principal
- A cada pull request para a branch principal
- Diariamente às 05:00 UTC
- Sob demanda através da interface do GitHub Actions

## PRÓXIMOS PASSOS E APRIMORAMENTOS

1. Implementar sistema de cache para evitar reprocessamento
2. Adicionar suporte para mais tópicos além de monômios
3. Desenvolver um painel de controle para visualização dos resultados
4. Implementar notificações por email ou webhooks

---

Desenvolvido por Claude para o projeto Algebraticamente, 2025.