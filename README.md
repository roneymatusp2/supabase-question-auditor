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

Edit the `.env` file and replace the placeholder for `SUPABASE_SERVICE_KEY` with your actual Supabase service role key.

### 3. Install Dependencies

```bash
npm ci
```

### 4. Run the Validation Locally

```bash
npm run audit
```

By default, the script audits questions with the topic "monomios". To audit a different topic, use:

```bash
npm run audit -- --topic=another_topic
```

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
| `SUPABASE_SERVICE_KEY` | Your Supabase project's service role key |
| `SUPABASE_ACCESS_TOKEN` | Supabase access token for CLI operations |
| `DEEPSEEK_API_KEY` | DeepSeek API key for AI validation |

### Example workflow run:

The workflow will run automatically, and you'll see output similar to this in the Actions tab:

```
🔍 Starting validation at 2025-05-06T05:00:12.345Z
📚 Topic: monomios
📋 Found 15 questions to validate

🔢 Processing question ID: 1
✅ Question ID 1 is valid: The question is mathematically accurate as it correctly identifies the coefficient in a monomi...

🔢 Processing question ID: 2
❌ Question ID 2 is invalid: The question has an incorrect answer marked. The degree of the monomial 3x²y is actually 3...
🔧 Applying fixes to question ID: 2
✏️ Updated correct_option to: 1
✔️ Successfully updated question ID: 2

...

🏁 Validation complete for topic 'monomios'
📊 Summary: 15 questions processed, 0 invalid without fixes
✅ All questions are valid or were automatically fixed
```

## Modifying the Script

### Changing the Topic to Audit

To audit questions with a different topic, modify the script execution in one of these ways:

1. **Command line argument**:
   ```bash
   npm run audit -- --topic=new_topic
   ```

2. **GitHub Actions workflow**:
   Edit `.github/workflows/validate-questions.yml` and change:
   ```yaml
   - name: Run validation script
     run: npx ts-node scripts/validateQuestions.ts --topic=new_topic
   ```

### Modifying the Validation Logic

The validation logic is defined in the `systemPrompt` variable in `scripts/validateQuestions.ts`. You can modify this to:

- Change the validation criteria
- Adjust how fixes are applied
- Update the examples of valid and invalid questions

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