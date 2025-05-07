import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs'; // Using node:fs for explicit Node.js built-in

/* ─── Environment Variables & Configuration ────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL as string; // Assuming SUPABASE_URL is also in your .env
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY as string; // Specific key for this script's purpose

const AI_MODEL = 'deepseek-reasoner'; // Model used for curation
const LOG_FILE = 'curation-audit.log';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DEEPSEEK_API_KEY) {
    console.error('❌ Missing one or more required environment variables (SUPABASE_URL, SUPABASE_SERVICE_KEY, DEEPSEEK_API_KEY).');
    process.exit(1);
}

/* ─── Clients ──────────────────────────────────────────────── */
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const deepSeekAI = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
});

/* ─── Logging Utility ──────────────────────────────────────── */
const auditLogStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const L = (message: string) => {
    const timestampedMessage = `${new Date().toISOString()} • ${message}`;
    console.log(message); // Also log to console for immediate feedback
    auditLogStream.write(timestampedMessage + '\n');
};

/* ─── AI Prompt ─────────────────────────────────────────────── */
const SYSTEM_PROMPT_MONOMIOS = `
Você está atuando como um agente de curadoria matemática responsável por revisar e corrigir questões classificadas como “monômios”.

Sua função é:
1. Verificar se a questão está corretamente classificada como “monômio” — e ser EXTREMAMENTE RIGOROSO nisso.
2. Corrigir a questão se necessário (enunciado, alternativas, índice correto).
3. Corrigir ou gerar o campo LaTeX do enunciado e das alternativas.
4. Corrigir ou gerar uma dica pedagógica (hint) se estiver ausente.
5. Garantir que tudo esteja consistente e autocontido.
6. Retornar os campos corrigidos em formato estruturado (ver abaixo).

---

CRITÉRIOS RIGOROSOS PARA ACEITAR COMO "QUESTÃO DE MONÔMIOS":

✔️ É monômio apenas se:
• A expressão matemática for um único termo algébrico, como:
  - 5x, -3a², 7xy²/2, -3/4mn³
• OU a operação envolver SOMENTE monômios semelhantes, como:
  - 3x + 2x
  - 7a²b - 4a²b

A operação pode ser:
• multiplicação entre monômios
• divisão entre monômios
• soma ou subtração entre monômios semelhantes
• identificação de grau, coeficiente ou parte literal

❌ NÃO É MONÔMIO SE:
• Envolve termos diferentes (ex: 3x + 2y, x² + x)
• Envolve equações (ex: 3x = 6)
• Envolve avaliação numérica de expressões com mais de um termo (ex: 4a - 2)
• É binômio ou polinômio

---

EXEMPLOS VÁLIDOS:
- “Multiplique os monômios 3a² e -2a³.”
- “Qual o grau do monômio -5x⁴y²?”
- “Calcule 6x³ ÷ 2x.”
- “Some -3ab² com 5ab².”

EXEMPLOS INVÁLIDOS:
- “Qual o valor de 4a - 2 para a = 3?” → binômio
- “Resolva 3x = 9.” → equação
- “Simplifique 2x² + 3x - x².” → polinômio

---

RESPOSTA ESTRUTURADA (JSON):

{
  "isMonomio": true | false,
  "corrected_topic": "monomios" | "binomios" | "avaliacao_alg" | ...,
  "statement_latex": "...",
  "options_latex": ["...", "...", "...", "..."],
  "correct_option_index": 0-3,
  "hint": "...",
  "remarks": "Correção aplicada com base nos critérios acima."
}

⚠️ Não justifique. Apenas corrija. Corrija português, LaTeX e lógica se necessário.
`; // Renamed for clarity if other prompts were to be added

interface QuestionRecord {
    id: string;
    statement_md: string;
    options: string[];
    correct_option: number;
    solution_md?: string; // Optional as per original
    topic: string;
    // Add other fields from your 'questions' table if needed for context or update
}

interface AICurationResponse {
    isMonomio: boolean;
    corrected_topic?: string;
    statement_latex?: string;
    options_latex?: string[];
    correct_option_index?: number;
    hint?: string;
    remarks?: string;
}

/* ─── Database Functions ───────────────────────────────────── */
async function fetchQuestionsForTopic(topic: string): Promise<QuestionRecord[]> {
    console.log(`\n🔍 Buscando questões para o tópico: ${topic}`);
    const { data, error } = await supabase
        .from('questions')
        .select('*') // Selects all columns
        .eq('topic', topic);

    if (error) {
        L(`❌ Erro ao buscar questões do Supabase para o tópico ${topic}: ${error.message}`);
        throw error; // Propagate error to be caught by main
    }
    if (!data || data.length === 0) {
        L(`⚠️ Nenhuma questão encontrada para o tópico: ${topic}.`);
        return [];
    }
    L(`  ${data.length} questões encontradas para ${topic}.`);
    return data as QuestionRecord[];
}

async function updateQuestionInSupabase(questionId: string, updates: Partial<QuestionRecord>): Promise<boolean> {
    console.log(`  🔄 Atualizando questão ID ${questionId} no Supabase...`);
    const { error } = await supabase
        .from('questions')
        .update(updates)
        .eq('id', questionId);

    if (error) {
        L(`  ❌ Erro ao atualizar questão ID ${questionId} no Supabase: ${error.message}`);
        return false;
    }
    L(`  ✔️ Questão ID ${questionId} atualizada com sucesso.`);
    return true;
}

/* ─── AI Interaction Function ──────────────────────────────── */
async function getCurationFromAI(question: QuestionRecord): Promise<AICurationResponse | null> {
    console.log(`  🧠 Solicitando curadoria da IA para a questão ID ${question.id}...`);
    const payload = {
        statement: question.statement_md,
        options: question.options,
        correct_option: question.correct_option,
        solution: question.solution_md // Ensure your prompt handles if this is undefined
    };

    try {
        const chatCompletion = await deepSeekAI.chat.completions.create({
            model: AI_MODEL,
            temperature: 0, // For deterministic output
            messages: [
                { role: 'system', content: SYSTEM_PROMPT_MONOMIOS },
                { role: 'user', content: JSON.stringify(payload) }
            ],
            response_format: { type: "json_object" } // Requesting JSON output if API supports
        });

        const rawResponse = chatCompletion.choices[0]?.message.content;
        if (!rawResponse) {
            L(`  ❌ Resposta da IA vazia para a questão ID ${question.id}.`);
            return null;
        }

        // Attempt to parse the JSON response
        let curatedData: AICurationResponse;
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/); // Extract JSON if wrapped

        if (jsonMatch && jsonMatch[0]) {
            try {
                 curatedData = JSON.parse(jsonMatch[0]) as AICurationResponse;
                 L(`  🤖 Resposta da IA recebida e parseada para questão ID ${question.id}.`);
                 return curatedData;
            } catch (parseError: any) {
                 L(`  ❌ Erro ao parsear JSON da IA para questão ID ${question.id}: ${parseError.message}. Resposta bruta: ${rawResponse}`);
                 return null;
            }
        } else {
             L(`  ❌ Nenhum JSON válido encontrado na resposta da IA para questão ID ${question.id}. Resposta bruta: ${rawResponse}`);
             return null;
        }

    } catch (apiError: any) {
        L(`  ❌ Erro na API DeepSeek para questão ID ${question.id}: ${apiError.message}`);
        return null;
    }
}


/* ─── Main Execution ───────────────────────────────────────── */
async function main() {
    L('🚀 Iniciando script de curadoria de questões...');

    const topicToCurate = process.argv.find(arg => arg.startsWith('--topic='))?.split('=')[1] ?? 'monomios';
    L(`  Tópico alvo para curadoria: ${topicToCurate}`);

    let questionsProcessed = 0;
    let questionsUpdated = 0;
    let questionsSkippedOrFailed = 0;

    try {
        const questions = await fetchQuestionsForTopic(topicToCurate);

        if (questions.length === 0) {
            L('🏁 Nenhuma questão para processar. Encerrando.');
            return;
        }

        for (const q of questions) {
            L(`\nProcessing Question ID: ${q.id} (Tópico Original: ${q.topic})`);
            questionsProcessed++;

            const curationResponse = await getCurationFromAI(q);

            if (!curationResponse) {
                L(`  ⚠️ Curadoria falhou ou foi pulada para a questão ID ${q.id}.`);
                questionsSkippedOrFailed++;
                continue;
            }

            if (curationResponse.isMonomio !== true) {
                L(`  ⛔ Questão ID ${q.id} reprovada pela IA (não é monômio ou outro critério). Remarks: ${curationResponse.remarks || 'N/A'}`);
                // Optionally, update the topic or add a flag if it's misclassified
                if (curationResponse.corrected_topic && curationResponse.corrected_topic !== q.topic) {
                    L(`    Original topic: ${q.topic}, IA suggested topic: ${curationResponse.corrected_topic}. Updating topic.`);
                    await updateQuestionInSupabase(q.id, { topic: curationResponse.corrected_topic });
                    // Consider if other fields should be nulled or marked for review
                }
                questionsSkippedOrFailed++;
                continue;
            }

            const updates: Partial<QuestionRecord> & { hints?: string[] } = {}; // Use QuestionRecord for type safety

            if (curationResponse.corrected_topic) {
                updates.topic = curationResponse.corrected_topic;
            }
            if (curationResponse.statement_latex) {
                updates.statement_md = curationResponse.statement_latex; // Assuming statement_md stores LaTeX
            }
            if (curationResponse.options_latex) {
                updates.options = curationResponse.options_latex; // Assuming options stores LaTeX
            }
            if (curationResponse.correct_option_index !== undefined && curationResponse.correct_option_index !== null) {
                updates.correct_option = curationResponse.correct_option_index;
            }
            if (curationResponse.hint) {
                // The first script saves hints as an array in a 'hints' column.
                // Your 'questions' table schema might need a 'hints' column (e.g., TEXT[] or JSONB).
                // If you have a `hints` column that expects an array:
                updates.hints = [curationResponse.hint];
                // If you don't have a 'hints' column or it's a single text field, adjust accordingly.
                // For now, I'll assume you might add a 'hints' text[] column based on the first script.
            }

            if (Object.keys(updates).length > 0) {
                L(`  🛠️ Aplicando correções para a questão ID ${q.id}: ${JSON.stringify(updates)}`);
                if (await updateQuestionInSupabase(q.id, updates)) {
                    questionsUpdated++;
                } else {
                    questionsSkippedOrFailed++;
                }
            } else {
                L(`  👍 Nenhuma correção necessária para a questão ID ${q.id} (já conforme).`);
            }
             // Optional delay if making many sequential API calls not managed by OpenAI client's rate limiting
            // await new Promise(resolve => setTimeout(resolve, 200)); // Example: 200ms delay
        }

    } catch (error: any) {
        L(`❌ Erro fatal durante a execução principal: ${error.message}`);
        process.exitCode = 1; // Indicate failure
    } finally {
        L(`\n🏁 Processamento de Curadoria Concluído 🏁`);
        L(`  Total de Questões Encontradas: ${questionsProcessed}`);
        L(`  Questões Atualizadas com Sucesso: ${questionsUpdated}`);
        L(`  Questões Puladas/Falharam na Atualização ou Reprovadas: ${questionsSkippedOrFailed}`);
        L(`  Log de auditoria completo em: ${LOG_FILE}`);
        auditLogStream.end();
        if (questionsSkippedOrFailed > 0 && questionsProcessed > 0) {
             process.exitCode = 1; // Indicate partial failure if some items were skipped/failed
        }
    }
}

main().catch(e => {
    // This catch is for unhandled promise rejections from main itself, though try/finally in main should handle most.
    L(`❌ Erro não tratado no nível superior do script: ${e instanceof Error ? e.message : String(e)}`);
    auditLogStream.end(); // Ensure log is closed
    process.exit(1);
});
