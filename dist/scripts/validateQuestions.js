/**
 * Script: validateQuestions.ts
 *
 * Function:
 * 1. Read questions from the "questions" table in Supabase (e.g., topic = "monomio").
 * 2. For each question, call the DeepSeek API (via OpenAI) to suggest corrections.
 * 3. Update the question in Supabase.
 * 4. Log corrections to the curation-audit.log file.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs';
import path from 'node:path';
/* ──────────────────────────────────────────────────────────────────────────────
   1) ENVIRONMENT VARIABLES AND CONFIGURATIONS
   ────────────────────────────────────────────────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const AI_MODEL = 'deepseek-reasoner'; // or another model name on DeepSeek
const LOG_FILE = 'curation-audit.log'; // log file name
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DEEPSEEK_API_KEY) {
    console.error('❌ Required environment variables missing (SUPABASE_URL, SUPABASE_SERVICE_KEY, DEEPSEEK_API_KEY)');
    process.exit(1);
}
/* ──────────────────────────────────────────────────────────────────────────────
   2) INITIALIZATION OF CLIENTS (SUPABASE AND "OPENAI" for DEEPSEEK)
   ────────────────────────────────────────────────────────────────────────────── */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// OpenAI is used to hit the "DeepSeek" route when we define baseURL to https://api.deepseek.com/v1
// and pass `apiKey: DEEPSEEK_API_KEY`.
const deepSeekAI = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    // If you need to override the OpenAI base URL, do so:
    baseURL: 'https://api.deepseek.com/v1',
});
/* ──────────────────────────────────────────────────────────────────────────────
   3) MAIN FUNCTION: Fetch, Validate/Fix and Update
   ────────────────────────────────────────────────────────────────────────────── */
async function main() {
    console.log('==== Starting Question Validation (monomios) ====');
    // (Optional) Delete old LOG
    // fs.unlinkSync(LOG_FILE); // if you always want to overwrite
    // 3.1) Fetch questions from Supabase with "topic = monomio" (example)
    //     Adjust according to your table and columns (assuming the table is called "questions")
    const { data: questions, error } = await supabase
        .from('questions')
        .select('*')
        .eq('topic', 'monomio')
        .limit(20); // Example: get only 20
    if (error) {
        log(`Error fetching questions from Supabase: ${error.message}`);
        process.exit(1);
    }
    if (!questions || questions.length === 0) {
        log('No monomio questions found. Ending.');
        return;
    }
    log(`Found ${questions.length} question(s) with topic="monomio". Starting analysis...`);
    // 3.2) For each question, call the DeepSeek API to fix it
    for (const question of questions) {
        try {
            // Build prompt or "messages" for deepseek
            const userPrompt = buildPrompt(question);
            // Make the call
            const response = await deepSeekAI.chat.completions.create({
                model: AI_MODEL, // "deepseek-reasoner" or another
                messages: [
                    {
                        role: 'system',
                        content: `You are a system that adjusts and validates algebra questions about monomials. Return in JSON format.`
                    },
                    {
                        role: 'user',
                        content: userPrompt,
                    },
                ],
                temperature: 0.5,
                max_tokens: 500,
            });
            const content = response.choices?.[0]?.message?.content || '';
            if (!content) {
                log(`[ID: ${question.id}] Empty response from DeepSeek. Skipping...`);
                continue;
            }
            // Try to parse the JSON that DeepSeek returns
            const { correctedStatement, correctedSolution } = parseDeepSeekJSON(content);
            // 3.3) Update in Supabase if there was actually a correction
            if (correctedStatement !== question.statement_md || correctedSolution !== question.solution_md) {
                // Example: set `statement_md` and `solution_md` with the corrections
                const { error: updateError } = await supabase
                    .from('questions')
                    .update({
                    statement_md: correctedStatement,
                    solution_md: correctedSolution,
                    updated_at: new Date().toISOString(), // if you have this column
                })
                    .eq('id', question.id);
                if (updateError) {
                    log(`[ID: ${question.id}] ERROR updating Supabase: ${updateError.message}`);
                }
                else {
                    log(`[ID: ${question.id}] OK - Correction applied!`);
                }
            }
            else {
                // No correction
                log(`[ID: ${question.id}] No changes needed.`);
            }
        }
        catch (err) {
            log(`[ID: ${question.id}] Failed to process: ${err.message}`);
        }
    }
    log('==== End of validation! ====');
}
/* ──────────────────────────────────────────────────────────────────────────────
   4) HELPER FUNCTIONS
   ────────────────────────────────────────────────────────────────────────────── */
// Builds a prompt with the current question, asking DeepSeek to review and fix it
function buildPrompt(q) {
    return `
We have a monomial question, with statement:
"${q.statement_md}"

Solution:
"${q.solution_md || '[no solution]'}"

Please check if there are errors in the formulation (both statement and solution).
If there are problems, fix them. 
Return JSON with keys:
{
  "correctedStatement": "...",
  "correctedSolution": "..."
}
`;
}
// Parses the JSON returned by the model
// The DeepSeek API (via OpenAI) may come with extra text, so we use regex or a try-catch
function parseDeepSeekJSON(content) {
    // Try direct parsing
    try {
        const parsed = JSON.parse(content);
        return {
            correctedStatement: parsed.correctedStatement || '',
            correctedSolution: parsed.correctedSolution || '',
        };
    }
    catch {
        // If it fails, try to extract via regex
        const match = content.match(/({[\s\S]*})/);
        if (match) {
            const obj = JSON.parse(match[0]);
            return {
                correctedStatement: obj.correctedStatement || '',
                correctedSolution: obj.correctedSolution || '',
            };
        }
        // If it still fails, return original
        return { correctedStatement: '', correctedSolution: '' };
    }
}
// Function to log to file and also print to console
function log(msg) {
    console.log(msg);
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(path.join(process.cwd(), LOG_FILE), line);
}
/* ──────────────────────────────────────────────────────────────────────────────
   5) EXECUTION
   ────────────────────────────────────────────────────────────────────────────── */
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=validateQuestions.js.map