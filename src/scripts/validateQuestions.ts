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
Você está atuando como um agente de curadoria matemática responsável por revisar e corrigir questões classificadas como "monômios".

Sua função é:
1. Verificar se a questão está corretamente classificada como "monômio" — e ser EXTREMAMENTE RIGOROSO nisso.
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
- "Multiplique os monômios 3a² e -2a³."
- "Qual o grau do monômio -5x⁴y²?"
- "Calcule 6x³ ÷ 2x."
- "Some -3ab² com 5ab²."

EXEMPLOS INVÁLIDOS:
- "Qual o valor de 4a - 2 para a = 3?" → binômio
- "Resolva 3x = 9." → equação
- "Simplifique 2x² + 3x - x²." → polinômio

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

/* ─── Funções Utilitárias ────────────────────────────────────────────────── */

// Função para sanitizar strings antes de enviar para a API
function sanitizeString(str: string): string {
    if (!str) return '';
    
    // Remove caracteres de escape problemáticos
    return str
        .replace(/\\(?!["\\/bfnrt])/g, '\\\\') // Escapa barras invertidas solitárias
        .replace(/\n/g, '\\n')                 // Substitui quebras de linha por \n
        .replace(/\r/g, '\\r')                 // Substitui retornos de carro por \r
        .replace(/\t/g, '\\t')                 // Substitui tabs por \t
        .replace(/"/g, '\\"');                 // Escapa aspas duplas
}

// Função para sanitizar um objeto completo 
function sanitizeObject(obj: any): any {
    if (typeof obj === 'string') {
        return sanitizeString(obj);
    } else if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
    } else if (obj && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                result[key] = sanitizeObject(obj[key]);
            }
        }
        return result;
    }
    return obj;
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
    
    try {
        // Cria um payload sanitizado para evitar problemas de JSON
        const sanitizedPayload = {
            statement: sanitizeObject(question.statement_md),
            options: sanitizeObject(question.options),
            correct_option: question.correct_option,
            solution: sanitizeObject(question.solution_md)
        };

        // Verifica se o JSON é válido antes de enviar
        try {
            JSON.stringify(sanitizedPayload);
        } catch (jsonError: any) {
            L(`⚠️ Erro ao criar JSON válido para a questão ID ${question.id}: ${jsonError?.message}`);
            
            // Usa uma abordagem mais rigorosa de sanitização como fallback
            const fallbackPayload = {
                statement: typeof question.statement_md === 'string' 
                    ? question.statement_md.replace(/[\u0000-\u001F\u007F-\u009F\\"]/g, '')
                    : '',
                options: Array.isArray(question.options)
                    ? question.options.map(opt => typeof opt === 'string' 
                        ? opt.replace(/[\u0000-\u001F\u007F-\u009F\\"]/g, '')
                        : '')
                    : [],
                correct_option: question.correct_option,
                solution: typeof question.solution_md === 'string'
                    ? question.solution_md.replace(/[\u0000-\u001F\u007F-\u009F\\"]/g, '')
                    : ''
            };
            
            // Tenta novamente com o payload de fallback
            const chatCompletion = await deepSeekAI.chat.completions.create({
                model: AI_MODEL,
                temperature: 0,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT_MONOMIOS },
                    { role: 'user', content: JSON.stringify(fallbackPayload) }
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
        }
        
        // Se o JSON for válido, prossegue com a chamada normal
        const chatCompletion = await deepSeekAI.chat.completions.create({
            model: AI_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT_MONOMIOS },
                { role: 'user', content: JSON.stringify(sanitizedPayload) }
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
    } catch (error: any) {
        L(`❌ Erro na API DeepSeek: ${error?.message || 'Erro desconhecido'}`);
        
        // Adiciona retry com um delay para lidar com erros temporários
        if (error?.message?.includes('Bad escaped character in JSON')) {
            L(`⏳ Tentando novamente com método alternativo para a questão ID ${question.id}...`);
            try {
                // Abordagem alternativa sem uso de JSON.stringify
                const simplePayload = {
                    statement: "Revisar esta questão de monômio.",
                    context: `Enunciado: ${question.statement_md || ''}
                    Opções: ${question.options ? question.options.join(' | ') : ''}
                    Resposta correta: ${question.correct_option}
                    Solução/dica: ${question.solution_md || ''}`
                };
                
                // Espera 2 segundos antes de tentar novamente
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const chatCompletion = await deepSeekAI.chat.completions.create({
                    model: AI_MODEL,
                    temperature: 0,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT_MONOMIOS },
                        { role: 'user', content: JSON.stringify(simplePayload) }
                    ]
                });
                
                const rawResponse = chatCompletion.choices[0]?.message.content;
                if (!rawResponse) {
                    L(`❌ Retry: Resposta da IA vazia para a questão ID ${question.id}.`);
                    return null;
                }
                
                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    return JSON.parse(jsonMatch[0]) as AICurationResponse;
                } else {
                    L(`❌ Retry: Resposta inválida recebida: ${rawResponse}`);
                    return null;
                }
            } catch (retryError: any) {
                L(`❌ Retry falhou para a questão ID ${question.id}: ${retryError?.message || 'Erro desconhecido'}`);
                return null;
            }
        }
        
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
    } catch (error: any) {
        L(`❌ Erro fatal: ${error?.message || 'Erro desconhecido'}`);
    } finally {
        L('🏁 Curadoria concluída.');
        auditLogStream.end();
    }
}

main();