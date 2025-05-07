# Scripts

This directory contains the TypeScript scripts for the Supabase Question Auditor.

## Files:

- `validateQuestions.ts`: The main script for validating and auto-correcting "monomios" questions in Supabase.

## Running the script:

```bash
# Audit questions with the default topic "monomios"
npm run audit

# Audit questions with a custom topic
npm run audit -- --topic=another_topic
```

The script will:

1. Connect to your Supabase database
2. Query questions with the specified topic
3. Use DeepSeek Reasoner to validate each question
4. Automatically fix issues where possible
5. Log results to audit.log