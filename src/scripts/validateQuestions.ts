import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs';
import path from 'node:path'; // Para caminhos absolutos

import { SYSTEM_PROMPTS, AlgebraticamenteTopic } from '../system-prompts.js';

/* ─── Configuração e Variáveis de Ambiente ────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string; // !! USE A CHAVE SERVICE_ROLE !!

const apiKeys = [
  process.env.DEEPSEEK_API_KEY,
  process.env.DEEPSEEK_API_KEY_2,
  process.env.DEEPSEEK_API_KEY_3,
  process.env.DEEPSEEK_API_KEY_4,
  process.env.DEEPSEEK_API_KEY_5,
].filter(Boolean) as string[];

const BATCH_SIZE = Number(process.env.BATCH_SIZE || '10');
const MAX_CONCURRENCY = Math.min(
  Number(process.env.MAX_CONCURRENCY || '5'),
  apiKeys.length > 0 ? apiKeys.length * 3 : 1 // Garante ao menos 1 se não houver chaves (embora o script pare)
);

const AI_MODEL = 'deepseek-reasoner';
const LOG_FILE = path.resolve(process.cwd(), 'curation-pipeline.log'); // Log na raiz do projeto

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórias.');
  process.exit(1);
}
if (apiKeys.length === 0) {
    console.error('❌ Pelo menos uma DEEPSEEK_API_KEY é obrigatória.');
    process.exit(1);
}

const TOPIC_SEQUENCE: AlgebraticamenteTopic[] = [
  'monomios',
  'binomios',
  'trinomios',
  'fatoracao',
  'produtos_notaveis',
  'polinomios_grau_maior_que_3',
];

const keyStats = {
  calls: new Map<string, number>(),
  errors: new Map<string, number>(),
  lastUsed: new Map<string, number>(),
};
apiKeys.forEach(key => {
  keyStats.calls.set(key, 0);
  keyStats.errors.set(key, 0);
  keyStats.lastUsed.set(key, 0);
});

/* ─── Inicialização dos Clientes ─────────────────────────────────────────── */
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const deepSeekClients = apiKeys.map(
  apiKey => new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1' })
);

function getNextDeepSeekClient(): OpenAI {
    if (apiKeys.length === 0) throw new Error("Nenhuma chave de API DeepSeek configurada.");
    if (deepSeekClients.length === 0) throw new Error("Pool de clientes DeepSeek não inicializado.");

    if (apiKeys.length === 1) {
        const key = apiKeys[0];
        keyStats.calls.set(key, (keyStats.calls.get(key) || 0) + 1);
        keyStats.lastUsed.set(key, Date.now());
        return deepSeekClients[0];
    }

    const sortedKeys = [...apiKeys].sort((a, b) => {
        const errorsA = keyStats.errors.get(a) || 0;
        const errorsB = keyStats.errors.get(b) || 0;
        const lastUsedA = keyStats.lastUsed.get(a) || 0;
        const lastUsedB = keyStats.lastUsed.get(b) || 0;
        if (errorsA !== errorsB) return errorsA - errorsB;
        return lastUsedA - lastUsedB;
    });

    const selectedKey = sortedKeys[0];
    keyStats.calls.set(selectedKey, (keyStats.calls.get(selectedKey) || 0) + 1);
    keyStats.lastUsed.set(selectedKey, Date.now());
    const clientIndex = apiKeys.indexOf(selectedKey);

    if (clientIndex === -1 || !deepSeekClients[clientIndex]) {
        L(`⚠️ Chave selecionada (${selectedKey}) não encontrada. Usando a primeira chave.`);
        if (apiKeys[0] !== selectedKey) {
             keyStats.calls.set(apiKeys[0], (keyStats.calls.get(apiKeys[0]) || 0) + 1);
             keyStats.lastUsed.set(apiKeys[0], Date.now());
        }
        return deepSeekClients[0];
    }
    return deepSeekClients[clientIndex];
}

/* ─── Utilitário de Log ──────────────────────────────────────────────────── */
let auditLogStreamInstance: fs.WriteStream | null = null;
const initializeLogStream = (): fs.WriteStream => {
    if (!auditLogStreamInstance) {
        try {
            auditLogStreamInstance = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        } catch (error) {
            console.error(`❌ Falha ao criar/abrir o arquivo de log ${LOG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
            const { Writable } = await import('node:stream'); // Import dinâmico
            auditLogStreamInstance = new Writable({ write: () => {} }); // Stream que não faz nada
        }
    }
    return auditLogStreamInstance;
}

const L = (message: string) => {
  const stream = initializeLogStream();
  const timestampedMessage = `${new Date().toISOString()} • ${message}`;
  console.log(timestampedMessage);
  if (stream && stream.writable) { // Verifica se o stream é gravável
      stream.write(timestampedMessage + '\n');
  }
};

const closeLogStream = () => {
    if (auditLogStreamInstance && auditLogStreamInstance.writable) {
        auditLogStreamInstance.end();
        auditLogStreamInstance = null;
    }
}

/* ─── Estatísticas Globais da Pipeline ─────────────────────────────────── */
const pipelineStats = {
  totalQuestionsProcessedThisRun: 0,
  totalApiSuccess: 0,
  totalApiFailures: 0,
  totalDbUpdates: 0,
  totalDbFailures: 0,
  questionsReclassified: 0,
  startTime: Date.now(),
  printSummary() {
    const duration = (Date.now() - this.startTime) / 1000;
    L('📊 RESUMO GERAL DA PIPELINE DE CURADORIA:');
    L(`   Tempo total de execução: ${duration.toFixed(1)} segundos`);
    L(`   Total de questões processadas (tentativas de chamada à IA): ${this.totalQuestionsProcessedThisRun}`);
    L(`   Sucessos de API (resposta válida recebida e parseada): ${this.totalApiSuccess}`);
    L(`   Falhas de API (erro na chamada, resposta vazia ou JSON inválido): ${this.totalApiFailures}`);
    L(`   Questões atualizadas no DB (com sucesso): ${this.totalDbUpdates}`);
    L(`   Falhas de atualização no DB: ${this.totalDbFailures}`);
    L(`   Questões reclassificadas (mudança de tópico): ${this.questionsReclassified}`);
    L('\n🔑 USO DE CHAVES API (GERAL):');
    apiKeys.forEach((key, index) => {
      const shortKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
      const calls = keyStats.calls.get(key) || 0;
      const errors = keyStats.errors.get(key) || 0;
      const errorRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : '0.0';
      L(`   Chave #${index + 1} (${shortKey}): ${calls} chamadas, ${errors} erros (${errorRate}%)`);
    });
  },
};

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
  isMonomio?: boolean;
  isBinomio?: boolean;
  isTrinomio?: boolean;
  isFatoracao?: boolean;
  isPolinomioGrauMaiorQue3?: boolean;
  isProdutoNotavel?: boolean;
  corrected_topic: AlgebraticamenteTopic | string;
  statement_latex: string;
  options_latex: string[];
  correct_option_index: number;
  hint: string;
  remarks?: string;
}

/* ─── Funções Utilitárias ────────────────────────────────────────────────── */
function sanitizeString(str: string | undefined | null): string {
    if (str === null || str === undefined) return '';
    let text = String(str);
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ''); // Remove caracteres de controle problemáticos primeiro
    text = text.replace(/\\/g, '\\\\');
    text = text.replace(/"/g, '\\"');
    text = text.replace(/\n/g, '\\n');
    text = text.replace(/\r/g, '\\r');
    text = text.replace(/\t/g, '\\t');
    return text;
}

async function processBatch<T, R>(
  items: T[],
  processItem: (item: T) => Promise<R>,
  maxConcurrent = MAX_CONCURRENCY
): Promise<R[]> {
    const results: R[] = [];
    const executing: Promise<void>[] = []; // Store promises that wrap the processing
    let itemIndex = 0;

    const scheduleNext = (): void => {
        if (itemIndex < items.length && executing.length < maxConcurrent) {
            const currentItem = items[itemIndex++];
            const promise = processItem(currentItem)
                .then(result => {
                    results.push(result);
                })
                .catch(error => {
                    L(`❌ Erro no processItem dentro do processBatch para item ${itemIndex -1}: ${error instanceof Error ? error.message : String(error)}`);
                    // Não adiciona ao results para não quebrar a tipagem, mas o erro é logado.
                })
                .finally(() => {
                    const idx = executing.indexOf(promise);
                    if (idx !== -1) executing.splice(idx, 1);
                    scheduleNext(); // Tenta agendar o próximo
                });
            executing.push(promise);
        }
    };

    // Inicia as primeiras tarefas
    for (let k = 0; k < maxConcurrent && k < items.length; k++) {
        scheduleNext();
    }

    // Espera todas as tarefas em execução terminarem
    // Este loop é necessário porque scheduleNext() pode adicionar mais promessas a 'executing'
    while (executing.length > 0 || itemIndex < items.length && results.length < items.length) {
        if (executing.length === 0 && itemIndex < items.length) { // Se não há nada executando mas ainda há itens
            scheduleNext(); // Tenta agendar mais
        }
        if (executing.length > 0) {
            await Promise.race(executing).catch(() => {}); // Espera qualquer um terminar, ignora rejeições aqui pois já são tratadas
        } else {
            break; // Sai se não há mais nada executando nem para executar
        }
    }
    await Promise.allSettled(executing); // Garante que todas as últimas tarefas terminem
    return results;
}


function chunkArray<T>(array: T[], size: number): T[][] {
  return Array(Math.ceil(array.length / size))
    .fill(null)
    .map((_, index) => array.slice(index * size, (index + 1) * size));
}

/* ─── Funções de Banco de Dados ──────────────────────────────────────────── */
async function fetchQuestionsForCuration(
  topic: AlgebraticamenteTopic,
  limit: number = 0
): Promise<QuestionRecord[]> {
  L(`🔍 Buscando questões para o tópico: ${topic}`);
  let query = supabase.from('questions').select('id, statement_md, options, correct_option, solution_md, topic').eq('topic', topic);
  if (limit > 0) {
    query = query.limit(limit);
  }
  const { data, error, status } = await query;

  if (error) {
    L(`❌ Erro ao buscar questões para ${topic} (Status: ${status}): ${error.message}`);
    if (status === 401 || status === 403) {
        L("   -> Verifique sua SUPABASE_URL e SUPABASE_SERVICE_KEY (precisa ser service_role).");
    }
    throw new Error(`Supabase fetch error: ${error.message}`);
  }
  if (!data) {
     L(`⚠️ Nenhuma questão encontrada (data é null) para o tópico: ${topic}.`);
     return [];
  }
  L(`✔️ ${data.length} questões encontradas para ${topic}.`);
  return data as QuestionRecord[];
}

async function updateQuestionInSupabase(
  questionId: string,
  updates: Partial<QuestionRecord>
): Promise<boolean> {
  if (updates.topic && !TOPIC_SEQUENCE.includes(updates.topic as AlgebraticamenteTopic)) {
      L(`⚠️ IA retornou tópico inválido "${updates.topic}" para ID ${questionId}. Update de tópico será ignorado.`);
      delete updates.topic;
  }

   if (Object.keys(updates).length === 0) {
       L(`ℹ️ Nenhum campo válido para atualizar para ID ${questionId}. Pulando DB update.`);
       return true;
   }

  L(`🔄 Tentando atualizar questão ID ${questionId} com dados: ${JSON.stringify(updates)}`);
  const { error, status } = await supabase
    .from('questions')
    .update(updates)
    .eq('id', questionId);

  if (error) {
    L(`❌ Erro ao atualizar questão ID ${questionId} (Status: ${status}): ${error.message}`);
     if (status === 401 || status === 403) {
        L("   -> Verifique se a SUPABASE_SERVICE_KEY é a 'service_role' key e tem permissão de escrita.");
    }
    pipelineStats.totalDbFailures++;
    return false;
  }
  pipelineStats.totalDbUpdates++;
  L(`✔️ Questão ID ${questionId} atualizada com sucesso.`);
  return true;
}

/* ─── Interação com a IA ────────────────────────────────────────────────── */
function tryParseJsonResponse(jsonString: string, questionId: string, attemptType: string): AICurationResponse | null {
    try {
        const parsed = JSON.parse(jsonString);
        if (
            !parsed || typeof parsed !== 'object' ||
            typeof parsed.corrected_topic !== 'string' || !parsed.corrected_topic ||
            typeof parsed.statement_latex !== 'string' || !parsed.statement_latex ||
            !Array.isArray(parsed.options_latex) || parsed.options_latex.length === 0 ||
            parsed.options_latex.some((opt: any) => typeof opt !== 'string' || !opt) ||
            typeof parsed.correct_option_index !== 'number' ||
            parsed.correct_option_index < 0 || parsed.correct_option_index >= parsed.options_latex.length ||
            typeof parsed.hint !== 'string'
           ) {
            L(`❌ Resposta JSON (${attemptType}) para ${questionId} falhou na validação de estrutura/conteúdo.`);
            return null;
        }
        return parsed as AICurationResponse;
    } catch (e: any) {
        L(`❌ Erro ao parsear JSON (${attemptType}) para ${questionId}: ${e.message}. String: ${jsonString.substring(0,100)}...`);
        return null;
    }
}

async function getCurationFromAI(
  question: QuestionRecord,
  currentCurationTopic: AlgebraticamenteTopic
): Promise<AICurationResponse | null> {
  const client = getNextDeepSeekClient();
  const selectedKey = client.apiKey;
  pipelineStats.totalQuestionsProcessedThisRun++;

  const payload = {
    statement: sanitizeString(question.statement_md),
    options: question.options?.map(opt => sanitizeString(opt)) ?? [],
    correct_option: question.correct_option,
    solution: sanitizeString(question.solution_md),
    current_topic_being_processed: currentCurationTopic,
  };

  if (!payload.statement || !payload.options || payload.options.length === 0 || payload.options.some(opt => typeof opt !== 'string')) {
      L(`❌ Payload inválido para ID ${question.id} (statement/options). Pulando.`);
      pipelineStats.totalApiFailures++; return null;
  }
  if (typeof payload.correct_option !== 'number' || payload.correct_option < 0 || payload.correct_option >= payload.options.length) {
       L(`❌ Payload inválido para ID ${question.id} (correct_option ${payload.correct_option} vs ${payload.options.length} opções). Pulando.`);
       pipelineStats.totalApiFailures++; return null;
  }

  try {
    const promptToSend = SYSTEM_PROMPTS[currentCurationTopic];
    if (!promptToSend) {
        L(`❌ Prompt não encontrado para o tópico: ${currentCurationTopic}. Pulando ID ${question.id}`);
        pipelineStats.totalApiFailures++; return null;
    }

    L(`🤖 Chamando API para ID ${question.id} (Tópico: ${currentCurationTopic}, Chave: ${selectedKey?.substring(0,4)}...)`);
    const chatCompletion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.05,
      messages: [
        { role: 'system', content: promptToSend },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      response_format: { type: "json_object" },
    });

    const rawResponse = chatCompletion.choices[0]?.message.content;
    if (!rawResponse) {
      L(`⚠️ Resposta vazia da API para ID ${question.id} (Chave: ${selectedKey?.substring(0,4)})`);
      keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
      pipelineStats.totalApiFailures++; return null;
    }

    let jsonResponse = tryParseJsonResponse(rawResponse, question.id, "direto");

    if (!jsonResponse) {
        L(`ℹ️ Tentando extrair JSON de markdown para ID ${question.id}...`);
        const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/m); // Adicionado 'm' para multiline
        if (jsonMatch && jsonMatch[1]) {
            jsonResponse = tryParseJsonResponse(jsonMatch[1], question.id, "markdown extraído");
        } else {
            L(`ℹ️ Nenhum bloco JSON markdown encontrado para ID ${question.id}.`);
        }
    }

    if (!jsonResponse) {
        L(`❌ Falha final ao obter JSON válido para ID ${question.id}. Raw: ${rawResponse.substring(0, 500)}...`);
        keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
        pipelineStats.totalApiFailures++; return null;
    }

    pipelineStats.totalApiSuccess++;
    L(`✅ Resposta JSON válida recebida e parseada para ID ${question.id}`);
    return jsonResponse;

  } catch (apiError: any) {
    let errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
    let statusCode = apiError?.status;
    L(`❌ Erro na API para ID ${question.id} (Status: ${statusCode ?? 'N/A'}): ${errorMessage} (Chave: ${selectedKey?.substring(0,4)})`);
    keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
    pipelineStats.totalApiFailures++; return null;
  }
}

/* ─── Função para processar uma questão completa ────────────────────────── */
interface ProcessResult {
  questionId: string;
  dbUpdateSuccess: boolean;
  apiSuccess: boolean;
  newTopic?: string;
  originalTopic: string;
}

async function processSingleQuestion(
  question: QuestionRecord,
  currentCurationTopic: AlgebraticamenteTopic
): Promise<ProcessResult> {
  L(`⚙️ Iniciando processamento para ID ${question.id} (Tópico Original: ${question.topic}) com foco em ${currentCurationTopic}`);

  const aiResponse = await getCurationFromAI(question, currentCurationTopic);

  if (!aiResponse) {
    return {
        questionId: question.id,
        dbUpdateSuccess: false,
        apiSuccess: false,
        originalTopic: question.topic
    };
  }

  const updates: Partial<QuestionRecord> = {
    topic: aiResponse.corrected_topic,
    statement_md: aiResponse.statement_latex,
    options: aiResponse.options_latex,
    correct_option: aiResponse.correct_option_index,
    solution_md: aiResponse.hint,
  };

  const originalTopic = question.topic;
  const finalTopic = updates.topic;

  if (finalTopic && originalTopic !== finalTopic) {
    L(`↪️ Questão ID ${question.id} reclassificada de "${originalTopic}" para "${finalTopic}" pela IA.`);
    pipelineStats.questionsReclassified++;
  }

  const updateSuccess = await updateQuestionInSupabase(question.id, updates);

  return {
    questionId: question.id,
    dbUpdateSuccess: updateSuccess,
    apiSuccess: true,
    newTopic: finalTopic,
    originalTopic: originalTopic,
  };
}

/* ─── Execução Principal da Pipeline ───────────────────────────────────── */
async function mainPipeline() {
  L('🚀 Iniciando PIPELINE DE CURADORIA DE QUESTÕES...');
  L(`⚙️ Configuração: ${apiKeys.length} chaves API, Concorrência Máx: ${MAX_CONCURRENCY}, Tamanho Lote Processamento: ${BATCH_SIZE}`);
  L(`🏷️ Sequência de Tópicos: ${TOPIC_SEQUENCE.join(' → ')}`);

  const args = process.argv.slice(2).reduce((acc, arg) => {
      const [key, value] = arg.split('=');
      if (key.startsWith('--')) {
          acc[key.substring(2)] = value === undefined ? true : value;
      }
      return acc;
  }, {} as Record<string, string | boolean>);

  const maxQuestionsPerTopic = parseInt(String(args['max_per_topic'] || '0'), 10);
  if (maxQuestionsPerTopic > 0) {
    L(`🚦 Limitando a ${maxQuestionsPerTopic} questões por tópico para este run.`);
  }

  for (const currentTopic of TOPIC_SEQUENCE) {
    L(`\n🚧 Iniciando processamento para o TÓPICO ATUAL: ${currentTopic} 🚧`);

    let questionsToProcess: QuestionRecord[] = [];
    try {
        questionsToProcess = await fetchQuestionsForCuration(currentTopic, maxQuestionsPerTopic);
    } catch (fetchError) {
        L(`❌ Falha crítica ao buscar questões para ${currentTopic}. Pulando este tópico.`);
        continue;
    }

    if (questionsToProcess.length === 0) {
      L(`🏁 Nenhuma questão para processar no tópico ${currentTopic}. Avançando...`);
      continue;
    }

    const questionBatches = chunkArray(questionsToProcess, BATCH_SIZE);
    L(`📦 Dividindo ${questionsToProcess.length} questões de ${currentTopic} em ${questionBatches.length} lotes de até ${BATCH_SIZE}`);

    let processedCountInTopic = 0;
    let dbUpdateSuccessCountInTopic = 0;
    let apiSuccessCountInTopic = 0;

    for (let i = 0; i < questionBatches.length; i++) {
      const batchItems = questionBatches[i];
      L(`🔄 Processando lote ${i + 1}/${questionBatches.length} do tópico ${currentTopic} (${batchItems.length} questões)...`);

      const batchResults = await processBatch(
        batchItems,
        (question) => processSingleQuestion(question, currentTopic),
        MAX_CONCURRENCY
      );

      processedCountInTopic += batchItems.length;
      batchResults.forEach(result => {
          if (result.apiSuccess) apiSuccessCountInTopic++;
          if (result.dbUpdateSuccess) dbUpdateSuccessCountInTopic++;
      });

      L(`📊 Lote ${i + 1} concluído. Questões no lote: ${batchItems.length}. Sucesso API/Parse: ${batchResults.filter(r=>r.apiSuccess).length}. Sucesso DB Update: ${batchResults.filter(r=>r.dbUpdateSuccess).length}.`);
    }
    L(`✅ Tópico ${currentTopic} concluído. Total processado: ${processedCountInTopic}. Sucesso API/Parse: ${apiSuccessCountInTopic}. Sucesso DB Update: ${dbUpdateSuccessCountInTopic}.`);
  }

  L('\n🏁 PIPELINE DE CURADORIA FINALIZADA 🏁');
  pipelineStats.printSummary();
  closeLogStream();
}

// Executa a pipeline principal
mainPipeline().catch(error => {
  L(`❌ ERRO FATAL NA PIPELINE: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
  pipelineStats.printSummary();
  closeLogStream();
  process.exit(1);
});
