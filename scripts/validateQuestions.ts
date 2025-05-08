import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs'; // Utilizando node:fs para deixar explícito o módulo nativo do Node.js

/* ─── Configuração e Variáveis de Ambiente ────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY as string;

const AI_MODEL = 'deepseek-reasoner';
const LOG_FILE = 'curation-audit.log';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DEEPSEEK_API_KEY) {
    console.error('❌ Variáveis de ambiente obrigatórias ausentes (SUPABASE_URL, SUPABASE_SERVICE_KEY, DEEPSEEK_API_KEY).');
    process.exit(1);
}

/* ─── Inicialização dos Clientes ─────────────────────────────────────────── */
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const deepSeekAI = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
});

/* ─── Utilitário de Log ──────────────────────────────────────────────────── */
const auditLogStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const L = (message: string) => {
    const timestampedMessage = `${new Date().toISOString()} • ${message}`;
    console.log(timestampedMessage); // Log no console
    auditLogStream.write(timestampedMessage + '\n'); // Log em arquivo
};

/* ─── Prompt da IA para Curadoria ────────────────────────────────────────── */
const SYSTEM_PROMPT_MONOMIOS = `
Você está atuando como um agente de curadoria matemática responsável por revisar e corrigir questões classificadas como “monômios”...

[Conteúdo completo do prompt foi mantido aqui]
`;

/* ─── Interfaces para Tipagem ────────────────────────────────────────────── */
interface QuestionRecord {
    id: string;
    statement_md: string;
    options: string[];
    correct_option: number;
    solution_md?: string;
    topic: string;
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

/* ─── Funções de Banco de Dados ──────────────────────────────────────────── */
async function fetchQuestionsForTopic(topic: string): Promise<QuestionRecord[]> {
    L(`🔍 Buscando questões para o tópico: ${topic}`);
    const { data, error } = await supabase
        .from('questions')
        .select('*')
        .eq('topic', topic);

    if (error) {
        L(`❌ Erro ao buscar questões: ${error.message}`);
        throw error;
    }
    if (!data || data.length === 0) {
        L(`⚠️ Nenhuma questão encontrada para o tópico: ${topic}.`);
        return [];
    }
    L(`✔️ ${data.length} questões encontradas.`);
    return data as QuestionRecord[];
}

async function updateQuestionInSupabase(questionId: string, updates: Partial<QuestionRecord>): Promise<boolean> {
    L(`🔄 Atualizando questão ID ${questionId}...`);
    const { error } = await supabase
        .from('questions')
        .update(updates)
        .eq('id', questionId);

    if (error) {
        L(`❌ Erro ao atualizar questão ID ${questionId}: ${error.message}`);
        return false;
    }
    L(`✔️ Questão ID ${questionId} atualizada com sucesso.`);
    return true;
}

/* ─── Interação com a IA ────────────────────────────────────────────────── */
async function getCurationFromAI(question: QuestionRecord): Promise<AICurationResponse | null> {
    L(`🤖 Solicitando curadoria para a questão ID ${question.id}...`);
    const payload = {
        statement: question.statement_md,
        options: question.options,
        correct_option: question.correct_option,
        solution: question.solution_md
    };

    try {
        const chatCompletion = await deepSeekAI.chat.completions.create({
            model: AI_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT_MONOMIOS },
                { role: 'user', content: JSON.stringify(payload) }
            ]
        });

        const rawResponse = chatCompletion.choices[0]?.message.content;
        if (!rawResponse) {
            L(`❌ Resposta da IA vazia para a questão ID ${question.id}.`);
            return null;
        }

        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch && jsonMatch[0]) {
            return JSON.parse(jsonMatch[0]) as AICurationResponse;
        } else {
            L(`❌ Resposta inválida recebida: ${rawResponse}`);
            return null;
        }
    } catch (error) {
        L(`❌ Erro na API DeepSeek: ${error.message}`);
        return null;
    }
}

/* ─── Execução Principal ────────────────────────────────────────────────── */
async function main() {
    L('🚀 Iniciando curadoria de questões...');
    const topicToCurate = process.argv.find(arg => arg.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

    try {
        const questions = await fetchQuestionsForTopic(topicToCurate);
        if (questions.length === 0) {
            L('🏁 Nenhuma questão a processar.');
            return;
        }

        for (const question of questions) {
            const curationResponse = await getCurationFromAI(question);
            if (!curationResponse) continue;

            const updates: Partial<QuestionRecord> = {};
            if (curationResponse.corrected_topic) updates.topic = curationResponse.corrected_topic;
            if (curationResponse.statement_latex) updates.statement_md = curationResponse.statement_latex;
            if (curationResponse.options_latex) updates.options = curationResponse.options_latex;
            if (curationResponse.correct_option_index !== undefined) updates.correct_option = curationResponse.correct_option_index;
            if (curationResponse.hint) updates.solution_md = curationResponse.hint;

            await updateQuestionInSupabase(question.id, updates);
        }
    } catch (error) {
        L(`❌ Erro fatal: ${error.message}`);
    } finally {
        L('🏁 Curadoria concluída.');
        auditLogStream.end();
    }
}

main();
