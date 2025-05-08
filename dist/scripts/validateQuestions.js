import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs'; // Utilizando node:fs para deixar explícito o módulo nativo do Node.js
/* ─── Configuração e Variáveis de Ambiente ────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Coleta todas as chaves de API disponíveis do DeepSeek
const apiKeys = [
    process.env.DEEPSEEK_API_KEY,
    process.env.DEEPSEEK_API_KEY_2,
    process.env.DEEPSEEK_API_KEY_3,
    process.env.DEEPSEEK_API_KEY_4,
    process.env.DEEPSEEK_API_KEY_5
].filter(Boolean);
// Aumentando o processamento em paralelo com base no número de chaves disponíveis
const BATCH_SIZE = Number(process.env.BATCH_SIZE || '20'); // Aumentado para 20 questões por lote
const MAX_CONCURRENCY = Math.min(Number(process.env.MAX_CONCURRENCY || '15'), apiKeys.length * 3); // Otimizado para múltiplas chaves
const AI_MODEL = 'deepseek-reasoner';
const LOG_FILE = 'curation-audit.log';
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || apiKeys.length === 0) {
    console.error('❌ Variáveis de ambiente obrigatórias ausentes (SUPABASE_URL, SUPABASE_SERVICE_KEY, pelo menos uma DEEPSEEK_API_KEY).');
    process.exit(1);
}
const keyStats = {
    calls: new Map(),
    errors: new Map(),
    lastUsed: new Map()
};
// Inicializando estatísticas para cada chave
apiKeys.forEach(key => {
    keyStats.calls.set(key, 0);
    keyStats.errors.set(key, 0);
    keyStats.lastUsed.set(key, 0);
});
/* ─── Inicialização dos Clientes ─────────────────────────────────────────── */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// Cria um pool de clientes DeepSeek
const deepSeekClients = apiKeys.map(apiKey => new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com/v1'
}));
// Função para obter o próximo cliente DeepSeek disponível usando um algoritmo de balanceamento
function getNextDeepSeekClient() {
    // Seleciona a chave com menos uso recente e menor número de erros
    const sortedKeys = [...apiKeys].sort((a, b) => {
        // Prioridade para chaves com menos erros
        const errorDiff = (keyStats.errors.get(a) || 0) - (keyStats.errors.get(b) || 0);
        if (errorDiff !== 0)
            return errorDiff;
        // Em seguida, prioridade para chaves menos usadas recentemente
        return (keyStats.lastUsed.get(a) || 0) - (keyStats.lastUsed.get(b) || 0);
    });
    const selectedKey = sortedKeys[0];
    const clientIndex = apiKeys.indexOf(selectedKey);
    // Atualiza estatísticas
    keyStats.calls.set(selectedKey, (keyStats.calls.get(selectedKey) || 0) + 1);
    keyStats.lastUsed.set(selectedKey, Date.now());
    return deepSeekClients[clientIndex];
}
/* ─── Utilitário de Log ──────────────────────────────────────────────────── */
const auditLogStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const L = (message) => {
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
    nonMonomioCount: 0, // Conta questões identificadas incorretamente
    retrySuccess: 0, // Contagem de retentativas bem-sucedidas
    apiKeyUsage: new Map(), // Rastreia uso de cada chave API
    startTime: Date.now(),
    apiCallTimes: [], // Tempos de resposta das chamadas à API
    recordApiCallTime(milliseconds) {
        this.apiCallTimes.push(milliseconds);
    },
    getAvgApiCallTime() {
        if (this.apiCallTimes.length === 0)
            return 0;
        const sum = this.apiCallTimes.reduce((acc, time) => acc + time, 0);
        return sum / this.apiCallTimes.length;
    },
    printSummary() {
        const duration = (Date.now() - this.startTime) / 1000; // em segundos
        const questionsPerSecond = this.processed / duration;
        L(`📊 RESUMO DA EXECUÇÃO:`);
        L(`   Total de questões: ${this.total}`);
        L(`   Processadas: ${this.processed} (${(this.processed / this.total * 100).toFixed(1)}%)`);
        L(`   Sucesso: ${this.success}`);
        L(`   Falhas: ${this.failed}`);
        L(`   Puladas: ${this.skipped}`);
        L(`   Não monômios identificados: ${this.nonMonomioCount}`);
        L(`   Erros de API: ${this.apiErrors}`);
        L(`   Retentativas bem-sucedidas: ${this.retrySuccess}`);
        L(`   Erros de atualização: ${this.updateErrors}`);
        L(`   Tempo total: ${duration.toFixed(1)} segundos`);
        L(`   Tempo médio p/ chamada API: ${this.getAvgApiCallTime().toFixed(2)}ms`);
        L(`   Velocidade: ${questionsPerSecond.toFixed(2)} questões/segundo`);
        // Estatísticas por chave API
        L(`\n📡 USO DE CHAVES API:`);
        apiKeys.forEach((key, index) => {
            const shortKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
            const calls = keyStats.calls.get(key) || 0;
            const errors = keyStats.errors.get(key) || 0;
            const errorRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : '0.0';
            L(`   Chave #${index + 1} (${shortKey}): ${calls} chamadas, ${errors} erros (${errorRate}%)`);
        });
    }
};
/* ─── Prompt da IA para Curadoria ────────────────────────────────────────── */
const SYSTEM_PROMPT_MONOMIOS = `
Você é um revisor matemático especializado, criado para verificar e melhorar questões sobre monômios.

## SUA TAREFA ESPECÍFICA

1. CLASSIFICAÇÃO RIGOROSA: Determine se a questão é REALMENTE sobre monômios conforme critérios abaixo
2. CORREÇÃO COMPLETA: Corrija e aprimore o enunciado, alternativas e solução se necessário
3. FORMATAÇÃO LATEX: Forneça todos os textos formatados em LaTeX adequado
4. RESPOSTA ESTRUTURADA: Retorne EXATAMENTE a estrutura JSON solicitada

## DEFINIÇÃO RIGOROSA DE MONÔMIOS

✅ É MONÔMIO SE E SOMENTE SE:
* É uma expressão algébrica com UM ÚNICO TERMO (ex: 5x, -3a², 7xy²/2)
* OU envolve operações APENAS entre monômios SEMELHANTES (ex: 3x + 2x, 7a²b - 4a²b)

✅ OPERAÇÕES PERMITIDAS EM MONÔMIOS:
* Multiplicação entre monômios (ex: 2x · 3y = 6xy)
* Divisão entre monômios (ex: 6x³ ÷ 2x = 3x²)
* Soma/subtração APENAS entre monômios SEMELHANTES (mesma parte literal)
* Identificação de grau, coeficiente ou parte literal

❌ NÃO É MONÔMIO SE:
* Contém TERMOS DIFERENTES (ex: 3x + 2y, x² + x)
* Contém EQUAÇÕES (ex: 3x = 6)
* Envolve AVALIAÇÃO NUMÉRICA com mais de um termo (ex: 4a - 2)
* É um BINÔMIO ou POLINÔMIO

## EXEMPLOS PARA CALIBRAÇÃO

### ✅ CORRETOS (Monômios)
1. "Multiplique os monômios 3a² e -2a³."
2. "Qual o grau do monômio -5x⁴y²?"
3. "Calcule 6x³ ÷ 2x."
4. "Some -3ab² com 5ab²."
5. "Determine o coeficiente do monômio -7xy²."

### ❌ INCORRETOS (Não são monômios)
1. "Qual o valor de 4a - 2 para a = 3?" → BINÔMIO (dois termos)
2. "Resolva 3x = 9." → EQUAÇÃO
3. "Simplifique 2x² + 3x - x²." → POLINÔMIO
4. "Calcule (3x + 2) quando x = 5." → AVALIAÇÃO DE BINÔMIO
5. "Some 5x + 3y." → TERMOS NÃO SEMELHANTES

## RESPOSTA OBRIGATÓRIA EM JSON

Formato para monômio:
{
  "isMonomio": true,
  "corrected_topic": "monomios",
  "statement_latex": "Enunciado correto com LaTeX",
  "options_latex": ["Alternativa 1", "Alternativa 2", "Alternativa 3", "Alternativa 4"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica para ajudar o aluno"
}

Ou no caso de não ser monômio:
{
  "isMonomio": false,
  "corrected_topic": "binomios",
  "statement_latex": "Enunciado corrigido",
  "options_latex": ["Alternativa corrigida 1", "Alternativa 2", "Alternativa 3", "Alternativa 4"],
  "correct_option_index": 0,
  "hint": "Dica sobre binômios"
}

OBSERVAÇÕES IMPORTANTES:
1. Verifique CUIDADOSAMENTE cada questão pelos critérios acima
2. Não deixe NENHUM campo vazio no JSON
3. SEMPRE forneça o formato JSON válido, sem explicações adicionais
4. Corrija erros de português e de matemática se encontrar
5. Se uma questão não for de monômios, indique o tópico correto que melhor se aplica
`;
/* ─── Funções Utilitárias ────────────────────────────────────────────────── */
// Função para sanitizar strings antes de enviar para a API
function sanitizeString(str) {
    if (!str)
        return '';
    // Remove caracteres de escape problemáticos
    return str
        .replace(/\\(?!["\\/bfnrt])/g, '\\\\') // Escapa barras invertidas solitárias
        .replace(/\n/g, '\\n') // Substitui quebras de linha por \n
        .replace(/\r/g, '\\r') // Substitui retornos de carro por \r
        .replace(/\t/g, '\\t') // Substitui tabs por \t
        .replace(/"/g, '\\"'); // Escapa aspas duplas
}
// Função para sanitizar um objeto completo 
function sanitizeObject(obj) {
    if (typeof obj === 'string') {
        return sanitizeString(obj);
    }
    else if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
    }
    else if (obj && typeof obj === 'object') {
        const result = {};
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
async function processBatch(items, processItem, maxConcurrent = 5) {
    const results = [];
    const executing = [];
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
function chunkArray(array, size) {
    return Array(Math.ceil(array.length / size))
        .fill(0)
        .map((_, index) => array.slice(index * size, (index + 1) * size));
}
/* ─── Funções de Banco de Dados ──────────────────────────────────────────── */
async function fetchQuestionsForTopic(topic) {
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
    return data;
}
async function updateQuestionInSupabase(questionId, updates) {
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
async function updateQuestionsInBatch(updates) {
    if (updates.length === 0)
        return 0;
    let successCount = 0;
    // Agrupar por 10 atualizações por vez
    const batches = chunkArray(updates, 10);
    for (const batch of batches) {
        try {
            await Promise.all(batch.map(async ({ id, updates }) => {
                const success = await updateQuestionInSupabase(id, updates);
                if (success)
                    successCount++;
            }));
        }
        catch (error) {
            L(`❌ Erro ao atualizar lote de questões: ${error?.message || 'Erro desconhecido'}`);
        }
    }
    return successCount;
}
/* ─── Interação com a IA ────────────────────────────────────────────────── */
async function getCurationFromAI(question) {
    // Seleciona a próxima chave API disponível
    const client = getNextDeepSeekClient();
    const selectedKey = client.apiKey;
    const callStartTime = Date.now();
    let curacaoResponse = null;
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
        }
        catch (jsonError) {
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
            // DeepSeek ainda não suporta `response_format` tipo json_object
            const chatCompletion = await client.chat.completions.create({
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
            try {
                curacaoResponse = JSON.parse(rawResponse);
            }
            catch (parseError) {
                // Tenta encontrar um objeto JSON válido na resposta
                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    curacaoResponse = JSON.parse(jsonMatch[0]);
                }
                else {
                    return null;
                }
            }
        }
        {
            // Se o JSON for válido, prossegue com a chamada normal
            // DeepSeek ainda não suporta `response_format` tipo json_object
            const chatCompletion = await client.chat.completions.create({
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
            try {
                curacaoResponse = JSON.parse(rawResponse);
            }
            catch (parseError) {
                // Tenta encontrar um objeto JSON válido na resposta
                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    curacaoResponse = JSON.parse(jsonMatch[0]);
                }
                else {
                    return null;
                }
            }
        }
        // Registra estatísticas da resposta
        if (curacaoResponse) {
            const callDuration = Date.now() - callStartTime;
            stats.recordApiCallTime(callDuration);
            const keyUsage = stats.apiKeyUsage.get(selectedKey) || 0;
            stats.apiKeyUsage.set(selectedKey, keyUsage + 1);
            // Verifica se o tópico da questão está correta
            if (curacaoResponse.isMonomio === false) {
                stats.nonMonomioCount++;
                L(`🔍 Questão ID ${question.id} identificada como não monômio. Tópico sugerido: ${curacaoResponse.corrected_topic || 'não especificado'}`);
            }
            return curacaoResponse;
        }
        return null;
    }
    catch (error) {
        stats.apiErrors++;
        keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
        // Cria um payload simplificado para retry
        const simplePayload = {
            question_id: question.id,
            statement: question.statement_md ? question.statement_md.substring(0, 500) : '',
            options: question.options ? question.options.map(opt => opt.substring(0, 100)) : [],
            correct_option: question.correct_option
        };
        // Multi-estratégia de retry: tenta com outro cliente e payload simplificado
        try {
            // Usa um cliente diferente do inicial
            const backupClient = deepSeekClients.find(c => c.apiKey !== selectedKey) || client;
            // Espera 500ms antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 500));
            // DeepSeek ainda não suporta `response_format` tipo json_object
            const chatCompletion = await backupClient.chat.completions.create({
                model: AI_MODEL,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content: `${SYSTEM_PROMPT_MONOMIOS}\n\nATENÇÃO: Esta é uma tentativa de recuperação. Analise cuidadosamente a questão e responda APENAS em formato JSON válido.`
                    },
                    { role: 'user', content: JSON.stringify(simplePayload) }
                ]
            });
            const rawResponse = chatCompletion.choices[0]?.message.content;
            if (rawResponse) {
                try {
                    curacaoResponse = JSON.parse(rawResponse);
                    stats.retrySuccess++;
                    return curacaoResponse;
                }
                catch (parseError) {
                    // Última tentativa: extrair JSON da resposta
                    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch && jsonMatch[0]) {
                        curacaoResponse = JSON.parse(jsonMatch[0]);
                        stats.retrySuccess++;
                        return curacaoResponse;
                    }
                }
            }
        }
        catch (retryError) {
            L(`💥 Erro fatal na API após retentativa para questão ID ${question.id}: ${retryError?.message}`);
        }
        return null;
    }
}
/* ─── Função para processar uma questão completa ────────────────────────── */
async function processQuestion(question) {
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
    }
    catch (error) {
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
    L('🚀 Iniciando curadoria de questões com múltiplas chaves DeepSeek...');
    L(`⚙️ Configuração: ${apiKeys.length} chaves API disponíveis, MAX_CONCURRENCY=${MAX_CONCURRENCY}, BATCH_SIZE=${BATCH_SIZE}`);
    const topicToCurate = process.argv.find(arg => arg.startsWith('--topic='))?.split('=')[1] ?? 'monomios';
    const maxQuestions = Number(process.argv.find(arg => arg.startsWith('--max='))?.split('=')[1] || '0');
    try {
        // 1. Buscar todas as questões
        let questions = await fetchQuestionsForTopic(topicToCurate);
        if (questions.length === 0) {
            L('🏁 Nenhuma questão a processar.');
            return;
        }
        // Limita o número de questões se especificado
        if (maxQuestions > 0 && questions.length > maxQuestions) {
            L(`⚠️ Limitando processamento às primeiras ${maxQuestions} questões das ${questions.length} encontradas`);
            questions = questions.slice(0, maxQuestions);
            stats.total = questions.length;
        }
        // 2. Dividir em lotes para processamento
        const batches = chunkArray(questions, BATCH_SIZE);
        L(`📦 Dividindo ${questions.length} questões em ${batches.length} lotes de até ${BATCH_SIZE}`);
        // 3. Processar cada lote
        let updateQueue = [];
        let batchIndex = 0;
        let lastProgressUpdate = Date.now();
        for (const batch of batches) {
            batchIndex++;
            const batchStartTime = Date.now();
            L(`🔄 Processando lote ${batchIndex}/${batches.length} (${batch.length} questões)...`);
            // Processa questões em paralelo com limite de concorrência
            const results = await processBatch(batch, processQuestion, MAX_CONCURRENCY);
            // Prepara as atualizações necessárias
            for (const result of results) {
                if (result.success && result.response) {
                    const updates = {};
                    const r = result.response;
                    if (r.corrected_topic)
                        updates.topic = r.corrected_topic;
                    if (r.statement_latex)
                        updates.statement_md = r.statement_latex;
                    if (r.options_latex)
                        updates.options = r.options_latex;
                    if (r.correct_option_index !== undefined)
                        updates.correct_option = r.correct_option_index;
                    if (r.hint)
                        updates.solution_md = r.hint;
                    // Adiciona à fila de atualizações se houver algo para atualizar
                    if (Object.keys(updates).length > 0) {
                        updateQueue.push({ id: result.question.id, updates });
                    }
                    else {
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
            // Calcula métricas do lote
            const batchDuration = (Date.now() - batchStartTime) / 1000;
            const questionsPerSecond = batch.length / batchDuration;
            // Imprime estatísticas parciais a cada lote
            L(`📊 Progresso: ${stats.processed}/${stats.total} questões (${(stats.processed / stats.total * 100).toFixed(1)}%)`);
            L(`⏱️ Lote #${batchIndex}: ${batchDuration.toFixed(1)}s, ${questionsPerSecond.toFixed(2)} questões/s`);
            // A cada 5 minutos, mostra um resumo do uso das chaves API
            if (Date.now() - lastProgressUpdate > 5 * 60 * 1000) {
                L(`\n🔑 Status das chaves API:`);
                apiKeys.forEach((key, index) => {
                    const calls = keyStats.calls.get(key) || 0;
                    const errors = keyStats.errors.get(key) || 0;
                    L(`   Chave #${index + 1}: ${calls} chamadas, ${errors} erros (${calls > 0 ? (errors / calls * 100).toFixed(1) : '0.0'}%)`);
                });
                lastProgressUpdate = Date.now();
            }
        }
    }
    catch (error) {
        L(`❌ Erro fatal: ${error?.message || 'Erro desconhecido'}`);
    }
    finally {
        // Imprime estatísticas completas
        stats.printSummary();
        L('🏁 Curadoria concluída.');
        auditLogStream.end();
    }
}
main();
//# sourceMappingURL=validateQuestions.js.map