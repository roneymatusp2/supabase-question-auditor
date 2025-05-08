# Supabase Question Auditor

Automated system for auditing and correcting math questions about monomials stored in Supabase.

## Features

- 🔍 Automatic validation of monomial questions in Supabase
- 🤖 Uses DeepSeek Reasoner AI to detect and fix mathematical errors
- 🔄 Daily automatic checks via GitHub Actions
- 📝 Detailed logs for each validation run
- 🛠️ Self-healing system that automatically fixes correctable issues

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
- `DEEPSEEK_API_KEY` - Your DeepSeek API key

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
npm run audit:questions
```

By default, the script audits questions with the topic "monomio". To audit a different topic, you can modify the source code.

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

| Name | Description |
|------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase project's service role key |
| `SUPABASE_ACCESS_TOKEN` | Supabase access token for CLI operations |
| `DEEPSEEK_API_KEY` | DeepSeek API key for AI validation |

### Example workflow run:

The workflow will run automatically, and you'll see output similar to this in the Actions tab:

```
==== Starting Question Validation (monomios) ====
[2025-05-07T12:00:00.000Z] Found 15 questions with topic="monomio". Starting analysis...
[2025-05-07T12:00:01.234Z] [ID: 1] OK - Correction applied!
[2025-05-07T12:00:02.345Z] [ID: 2] No changes needed.
...
[2025-05-07T12:00:15.678Z] ==== End of validation! ====
```

## Implementation Details

The main implementation is in two TypeScript files:

1. `src/scripts/validateQuestions.ts` - The core logic for fetching, validating, and updating questions
2. `src/scripts/audit-questions.ts` - A small wrapper that imports and executes the validation script

The validation process:

1. Connects to Supabase and retrieves questions with topic="monomio"
2. For each question, sends it to DeepSeek Reasoner via the OpenAI-compatible API
3. Processes DeepSeek's response to extract corrections
4. Updates the question in Supabase if corrections are needed
5. Logs all activity to a file named `curation-audit.log`

## Logs and Artifacts

After running GitHub Actions, an artifact called `audit-log` will be available with detailed results of the validation. This artifact contains:

- Which questions were checked
- Which issues were found
- What automatic fixes were applied
- A summary of validation results

## Troubleshooting

- **Missing Questions**: Ensure your Supabase database has questions with the topic you're auditing.
- **Authentication Errors**: Verify your Supabase service key and access token are correctly configured.
- **API Limits**: If you encounter DeepSeek API rate limits, consider adding delays between requests.
- **JSON Parsing Errors**: If DeepSeek returns unexpected formats, check the regex parsing in the validateQuestions.ts file.

## Further Customization

To adjust the behavior of the auditor:

1. Modify the prompt for DeepSeek in the `buildPrompt()` function
2. Update the table name, filters, or fields in the Supabase queries
3. Change the topic filter in `fetchQuestionsForTopic()` function
4. Adjust logging format or verbosity in the `log()` function