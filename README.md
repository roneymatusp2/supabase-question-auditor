# Supabase Question Auditor

Automated system for auditing and correcting mathematics questions stored in Supabase. Supports multiple mathematical topics including monomials, polynomials, functions, and geometry.

## Features

- 🔍 Comprehensive validation of math questions in Supabase
- 🤖 Uses DeepSeek Reasoner AI to detect and fix mathematical errors
- 🔄 Daily automatic checks via GitHub Actions
- 📝 Detailed logs for each validation run
- 🛠️ Self-healing system that automatically fixes correctable issues
- ⚡ Multi-API key support for improved performance and reliability
- ⚖️ Smart load balancing between API keys with automatic failover
- 📊 Detailed metrics for API key usage and performance tracking
- 🧩 Support for multiple math topics (monomials, polynomials, functions, geometry)
- 🔀 Flexible topic selection via command-line arguments

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/roneymatusp2/supabase-question-auditor.git
cd supabase-question-auditor
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit the `.env` file and replace the placeholders:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Your Supabase service role key
- `SUPABASE_ACCESS_TOKEN` - Your Supabase access token
- `DEEPSEEK_API_KEY` - Your primary DeepSeek API key (required)
- `DEEPSEEK_API_KEY_2` through `DEEPSEEK_API_KEY_5` - Additional DeepSeek API keys (optional, for load balancing)
- `BATCH_SIZE` - Number of questions to process in each batch (optional, defaults to 20)
- `MAX_CONCURRENCY` - Maximum number of parallel API requests (optional, defaults to min(15, [number of API keys] * 3))

### 3. Install Dependencies

```bash
npm ci
```

### 4. Build the TypeScript Project

```bash
npm run build
```

### 5. Run the Validation Locally

```bash
# Audit questions with default topic (monomios)
npm run audit:questions

# Audit questions for a specific topic
npm run audit:questions -- --topic=polinomios

# Audit a limited number of questions for faster testing
npm run audit:questions -- --topic=funcoes --max=10
```

Supported topics:
- `monomios` - Monomial expressions and operations (default)
- `polinomios` - Polynomial expressions and equations
- `funcoes` - Functions, domains, ranges, and function operations
- `geometria` - Geometry, shapes, areas, volumes, and coordinate geometry

## GitHub Actions Configuration

This repository uses GitHub Actions to automatically run validations on:
- Every push to the main branch
- Every pull request
- Daily at 05:00 UTC
- Manual triggering via the Actions tab

### Adding Required Secrets

To enable GitHub Actions, add the following secrets in your repository:

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and Variables** → **Actions**
3. Click **New repository secret** and add the following secrets:

| Name | Description | Required |
|------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_SERVICE_KEY` | Your Supabase project's service role key | Yes |
| `SUPABASE_ACCESS_TOKEN` | Supabase access token for CLI operations | Yes |
| `DEEPSEEK_API_KEY` | Primary DeepSeek API key for AI validation | Yes |
| `DEEPSEEK_API_KEY_2` | Secondary DeepSeek API key | No |
| `DEEPSEEK_API_KEY_3` | Third DeepSeek API key | No |
| `DEEPSEEK_API_KEY_4` | Fourth DeepSeek API key | No |
| `DEEPSEEK_API_KEY_5` | Fifth DeepSeek API key | No |

### Example workflow run:

The workflow will run automatically, and you'll see output similar to this in the Actions tab:

```
🚀 Iniciando curadoria de questões com múltiplas chaves DeepSeek...
⚙️ Configuração: 3 chaves API disponíveis, MAX_CONCURRENCY=9, BATCH_SIZE=20
📚 Usando prompt específico para o tópico: polinomios
🔍 Buscando questões para o tópico: polinomios
✔️ 42 questões encontradas.
📦 Dividindo 42 questões em 3 lotes de até 20
🔄 Processando lote 1/3 (20 questões)...
🤖 Solicitando curadoria para a questão ID 123...
...
✅ Sucesso após 2 tentativas para questão ID 126
🔍 Questão ID 129 identificada como não sendo de polinomios. Tópico sugerido: funcoes
📊 Progresso: 20/42 questões (47.6%)
⏱️ Lote #1: 23.4s, 0.86 questões/s
...
📊 RESUMO DA EXECUÇÃO:
   Total de questões: 42
   Processadas: 42 (100.0%)
   Sucesso: 39
   Falhas: 3
   Puladas: 0
   Não monômios identificados: 5
   Erros de API: 2
   Retentativas bem-sucedidas: 4
   Erros de atualização: 0
   Tempo total: 68.2 segundos
   Tempo médio p/ chamada API: 1423.45ms
   Velocidade: 0.62 questões/segundo

🔑 USO DE CHAVES API:
   Chave #1 (abcd...wxyz): 18 chamadas, 0 erros (0.0%)
   Chave #2 (efgh...stuv): 15 chamadas, 1 erros (6.7%)
   Chave #3 (ijkl...opqr): 13 chamadas, 1 erros (7.7%)
🏁 Curadoria concluída.
```

## Implementation Details

The main implementation is in two TypeScript files:

1. `src/scripts/validateQuestions.ts` - The core logic for fetching, validating, and updating questions
2. `src/scripts/audit-questions.ts` - A small wrapper that imports and executes the validation script

The validation process:

1. Connects to Supabase and retrieves questions with the specified topic (e.g., "monomios", "polinomios", etc.)
2. Selects the appropriate specialized prompt for the chosen mathematical topic
3. Collects all available DeepSeek API keys from environment variables
4. Creates a pool of OpenAI clients with smart load balancing between keys
5. Processes questions in parallel batches for optimal performance
6. For each question, sends it to DeepSeek Reasoner via the most optimal API key
7. If an API error occurs, automatically retries with different API keys and simplified payloads
8. Updates the question in Supabase if corrections are needed
9. Logs all activity and API key metrics to a file named `curation-audit.log`

## Logs and Artifacts

After running GitHub Actions, an artifact called `audit-log` will be available with detailed results of the validation. This artifact contains:

- Which questions were checked
- Which issues were found
- What automatic fixes were applied
- A summary of validation results

## Troubleshooting

- **Missing Questions**: Ensure your Supabase database has questions with the topic you're auditing.
- **Authentication Errors**: Verify your Supabase service key and access token are correctly configured.
- **API Limits**: If you encounter DeepSeek API rate limits, add more API keys through the DEEPSEEK_API_KEY_2 to DEEPSEEK_API_KEY_5 environment variables to increase throughput and reliability.
- **JSON Parsing Errors**: If DeepSeek returns unexpected formats, the system will attempt to recover using advanced sanitization techniques. Check the log for details.
- **Performance Issues**: Adjust BATCH_SIZE and MAX_CONCURRENCY in the .env file to optimize for your specific API key limits.

## Further Customization

To adjust the behavior of the auditor:

1. Add new mathematical topics by adding prompts to the `SYSTEM_PROMPTS` object in validateQuestions.ts
2. Update existing prompts in the `SYSTEM_PROMPTS` object to improve classification and corrections
3. Update the table name, filters, or fields in the Supabase queries in `fetchQuestionsForTopic()`
4. Change the topic filter by passing `--topic=your_topic` when running the script
5. Adjust the API key selection algorithm in the `getNextDeepSeekClient()` function
6. Modify the multi-level fallback strategies in the `getCurationFromAI()` function
7. Adjust batch processing parameters through the BATCH_SIZE and MAX_CONCURRENCY environment variables
8. Update the metrics tracking in the `stats` object to collect additional data
9. Customize the AICurationResponse interface to support new topic response formats