import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs'; // Utilizando node:fs para deixar explícito o módulo nativo do Node.js

/* ─── Configuração e Variáveis de Ambiente ────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY as string;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || '10'); // Processa 10 questões por vez por padrão
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || '5'); // Máximo de chamadas concorrentes à API

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

/* ─── Estatísticas e Métricas ─────────────────────────────────────────────── */
const stats = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    apiErrors: 0,
    updateErrors: 0,
    startTime: Date.now(),
    
    printSummary() {
        const duration = (Date.now() - this.startTime) / 1000; // em segundos
        const questionsPerSecond = this.processed / duration;
        
        L(`📊 RESUMO DA EXECUÇÃO:`);
        L(`   Total de questões: ${this.total}`);
        L(`   Processadas: ${this.processed} (${(this.processed/this.total*100).toFixed(1)}%)`);
        L(`   Sucesso: ${this.success}`);
        L(`   Falhas: ${this.failed}`);
        L(`   Puladas: ${this.skipped}`);
        L(`   Erros de API: ${this.apiErrors}`);
        L(`   Erros de atualização: ${this.updateErrors}`);
        L(`   Tempo total: ${duration.toFixed(1)} segundos`);
        L(`   Velocidade: ${questionsPerSecond.toFixed(2)} questões/segundo`);
    }
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

interface ProcessResult {
    question: QuestionRecord;
    success: boolean;
    response?: AICurationResponse | null;
    error?: string;
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

// Função para processar questões em paralelo com limite de concorrência
async function processBatch<T, R>(items: T[], processItem: (item: T) => Promise<R>, maxConcurrent = 5): Promise<R[]> {
    const results: R[] = [];
    const executing: Promise<void>[] = [];
    
    for (const item of items) {
        const p = processItem(item).then(result => {
            results.push(result);
            executing.splice(executing.indexOf(p), 1);
        });
        
        executing.push(p);
        if (executing.length >= maxConcurrent) {
            await Promise.race(executing);
        }
    }
    
    await Promise.all(executing);
    return results;
}

// Divisão de array em blocos de tamanho específico
function chunkArray<T>(array: T[], size: number): T[][] {
    return Array(Math.ceil(array.length / size))
        .fill(0)
        .map((_, index) => array.slice(index * size, (index + 1) * size));
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
    stats.total = data.length;
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
        stats.updateErrors++;
        return false;
    }
    L(`✔️ Questão ID ${questionId} atualizada com sucesso.`);
    return true;
}

// Função para atualizar multiplas questões em batch
async function updateQuestionsInBatch(updates: {id: string, updates: Partial<QuestionRecord>}[]): Promise<number> {
    if (updates.length === 0) return 0;
    
    let successCount = 0;
    // Agrupar por 10 atualizações por vez
    const batches = chunkArray(updates, 10);
    
    for (const batch of batches) {
        try {
            await Promise.all(batch.map(async ({id, updates}) => {
                const success = await updateQuestionInSupabase(id, updates);
                if (success) successCount++;
            }));
        } catch (error: any) {
            L(`❌ Erro ao atualizar lote de questões: ${error?.message || 'Erro desconhecido'}`);
        }
    }
    
    return successCount;
}

/* ─── Interação com a IA ────────────────────────────────────────────────── */
async function getCurationFromAI(question: QuestionRecord): Promise<AICurationResponse | null> {
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
                return null;
            }
            
            const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch && jsonMatch[0]) {
                return JSON.parse(jsonMatch[0]) as AICurationResponse;
            } else {
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
            return null;
        }

        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch && jsonMatch[0]) {
            return JSON.parse(jsonMatch[0]) as AICurationResponse;
        } else {
            return null;
        }
    } catch (error: any) {
        stats.apiErrors++;
        
        // Adiciona retry com um delay para lidar com erros temporários
        if (error?.message?.includes('Bad escaped character in JSON')) {
            try {
                // Abordagem alternativa sem uso de JSON.stringify
                const simplePayload = {
                    statement: "Revisar esta questão de monômio.",
                    context: `Enunciado: ${question.statement_md || ''}
                    Opções: ${question.options ? question.options.join(' | ') : ''}
                    Resposta correta: ${question.correct_option}
                    Solução/dica: ${question.solution_md || ''}`
                };
                
                // Espera 1 segundo antes de tentar novamente (reduzido para melhorar performance)
                await new Promise(resolve => setTimeout(resolve, 1000));
                
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
                    return null;
                }
                
                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    return JSON.parse(jsonMatch[0]) as AICurationResponse;
                }
            } catch (retryError: any) {
                return null;
            }
        }
        
        return null;
    }
}

/* ─── Função para processar uma questão completa ────────────────────────── */
async function processQuestion(question: QuestionRecord): Promise<ProcessResult> {
    L(`🤖 Solicitando curadoria para a questão ID ${question.id}...`);
    stats.processed++;
    
    try {
        const curationResponse = await getCurationFromAI(question);
        if (!curationResponse) {
            stats.failed++;
            return { question, success: false, error: 'Resposta da IA vazia ou inválida' };
        }

        stats.success++;
        return { 
            question, 
            success: true, 
            response: curationResponse
        };
    } catch (error: any) {
        stats.failed++;
        return { 
            question, 
            success: false, 
            error: error?.message || 'Erro desconhecido' 
        };
    }
}

/* ─── Execução Principal ────────────────────────────────────────────────── */
async function main() {
    L('🚀 Iniciando curadoria de questões...');
    const topicToCurate = process.argv.find(arg => arg.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

    try {
        // 1. Buscar todas as questões
        const questions = await fetchQuestionsForTopic(topicToCurate);
        if (questions.length === 0) {
            L('🏁 Nenhuma questão a processar.');
            return;
        }

        // 2. Dividir em lotes para processamento
        const batches = chunkArray(questions, BATCH_SIZE);
        L(`📦 Dividindo ${questions.length} questões em ${batches.length} lotes de até ${BATCH_SIZE}`);

        // 3. Processar cada lote
        let updateQueue: {id: string, updates: Partial<QuestionRecord>}[] = [];
        let batchIndex = 0;
        
        for (const batch of batches) {
            batchIndex++;
            L(`🔄 Processando lote ${batchIndex}/${batches.length} (${batch.length} questões)...`);
            
            // Processa questões em paralelo com limite de concorrência
            const results = await processBatch(batch, processQuestion, MAX_CONCURRENCY);
            
            // Prepara as atualizações necessárias
            for (const result of results) {
                if (result.success && result.response) {
                    const updates: Partial<QuestionRecord> = {};
                    const r = result.response;
                    
                    if (r.corrected_topic) updates.topic = r.corrected_topic;
                    if (r.statement_latex) updates.statement_md = r.statement_latex;
                    if (r.options_latex) updates.options = r.options_latex;
                    if (r.correct_option_index !== undefined) updates.correct_option = r.correct_option_index;
                    if (r.hint) updates.solution_md = r.hint;
                    
                    // Adiciona à fila de atualizações se houver algo para atualizar
                    if (Object.keys(updates).length > 0) {
                        updateQueue.push({ id: result.question.id, updates });
                    } else {
                        stats.skipped++;
                    }
                }
            }
            
            // Aplica as atualizações em lote a cada 50 questões ou no final de um lote
            if (updateQueue.length >= 50 || batchIndex === batches.length) {
                L(`💾 Aplicando ${updateQueue.length} atualizações no Supabase...`);
                await updateQuestionsInBatch(updateQueue);
                updateQueue = [];
            }
            
            // Imprime estatísticas parciais a cada lote
            L(`📊 Progresso: ${stats.processed}/${stats.total} questões (${(stats.processed/stats.total*100).toFixed(1)}%)`);
        }
        
    } catch (error: any) {
        L(`❌ Erro fatal: ${error?.message || 'Erro desconhecido'}`);
    } finally {
        // Imprime estatísticas completas
        stats.printSummary();
        L('🏁 Curadoria concluída.');
        auditLogStream.end();
    }
}

main();