// src/scripts/validateQuestions.ts
// NOVA VERSÃO - PIPELINE DE CURADORIA

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'node:fs';
// Importa os prompts e o tipo do arquivo que criamos no Passo 1
import { SYSTEM_PROMPTS, AlgebraticamenteTopic } from '../system-prompts.js';

/* ─── Configuração e Variáveis de Ambiente ────────────────────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string;

const apiKeys = [
  process.env.DEEPSEEK_API_KEY,
  process.env.DEEPSEEK_API_KEY_2,
  process.env.DEEPSEEK_API_KEY_3,
  process.env.DEEPSEEK_API_KEY_4,
  process.env.DEEPSEEK_API_KEY_5,
].filter(Boolean) as string[];

const BATCH_SIZE = Number(process.env.BATCH_SIZE || '10'); // Padrão 10
const MAX_CONCURRENCY = Math.min(
  Number(process.env.MAX_CONCURRENCY || '5'), // Padrão 5
  apiKeys.length * 3
);

const AI_MODEL = 'deepseek-reasoner';
// Coloca o log na raiz do projeto, fora de src/
const LOG_FILE = './curation-pipeline.log'; // Ajustado para raiz

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || apiKeys.length === 0) {
  console.error(
    '❌ Variáveis de ambiente obrigatórias ausentes (SUPABASE_URL, SUPABASE_SERVICE_KEY, pelo menos uma DEEPSEEK_API_KEY).'
  );
  process.exit(1);
}

// Sequência de processamento dos tópicos
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
  apiKey => new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1' }) // Ajuste baseURL se necessário
);

function getNextDeepSeekClient(): OpenAI {
  const sortedKeys = [...apiKeys].sort((a, b) => {
    const errorDiff = (keyStats.errors.get(a) || 0) - (keyStats.errors.get(b) || 0);
    if (errorDiff !== 0) return errorDiff;
    return (keyStats.lastUsed.get(a) || 0) - (keyStats.lastUsed.get(b) || 0);
  });
  const selectedKey = sortedKeys[0];
  keyStats.calls.set(selectedKey, (keyStats.calls.get(selectedKey) || 0) + 1);
  keyStats.lastUsed.set(selectedKey, Date.now());
  const clientIndex = apiKeys.indexOf(selectedKey);
  if (clientIndex === -1) {
      // Fallback se a chave não for encontrada (improvável, mas seguro)
      L(`⚠️ Chave selecionada ${selectedKey} não encontrada no pool de clientes. Usando a primeira chave.`);
      return deepSeekClients[0];
  }
  return deepSeekClients[clientIndex];
}

/* ─── Utilitário de Log ──────────────────────────────────────────────────── */
// Garante que o stream de log seja criado apenas uma vez
let auditLogStream: fs.WriteStream | null = null;
const initializeLogStream = () => {
    if (!auditLogStream) {
        auditLogStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }
    return auditLogStream;
}

const L = (message: string) => {
  const stream = initializeLogStream();
  const timestampedMessage = `${new Date().toISOString()} • ${message}`;
  console.log(timestampedMessage);
  stream.write(timestampedMessage + '\n');
};

const closeLogStream = () => {
    if (auditLogStream) {
        auditLogStream.end();
        auditLogStream = null; // Reset for potential future runs in the same process (if applicable)
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
    L(`   Total de questões processadas (chamadas à IA): ${this.totalQuestionsProcessedThisRun}`);
    L(`   Sucessos de API: ${this.totalApiSuccess}`);
    L(`   Falhas de API: ${this.totalApiFailures}`);
    L(`   Questões atualizadas no DB: ${this.totalDbUpdates}`);
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

// Interface unificada para a resposta da IA, cobrindo todos os tópicos
interface AICurationResponse {
  isMonomio?: boolean;
  isBinomio?: boolean;
  isTrinomio?: boolean;
  isFatoracao?: boolean;
  isPolinomioGrauMaiorQue3?: boolean;
  isProdutoNotavel?: boolean;

  // Campos OBRIGATÓRIOS que a IA deve retornar
  corrected_topic: AlgebraticamenteTopic | string; // Idealmente um dos nossos tópicos
  statement_latex: string;
  options_latex: string[];
  correct_option_index: number;
  hint: string;
  remarks?: string; // Opcional
}

/* ─── Funções Utilitárias ────────────────────────────────────────────────── */
function sanitizeString(str: string | undefined | null): string {
  if (!str) return '';
  // Tentativa de ser mais seguro para LaTeX e JSON
  return str
    .replace(/\\/g, '\\\\') // Escapa TODAS as barras invertidas primeiro
    .replace(/"/g, '\\"')   // Escapa aspas duplas
    .replace(/\n/g, '\\n')  // Escapa nova linha
    .replace(/\r/g, '\\r')  // Escapa carriage return
    .replace(/\t/g, '\\t'); // Escapa tabulação
}

async function processBatch<T, R>(
  items: T[],
  processItem: (item: T) => Promise<R>,
  maxConcurrent = MAX_CONCURRENCY
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];
  let i = 0;

  const runNext = async (item: T, p: Promise<void>) => {
    try {
      const result = await processItem(item);
      results.push(result);
    } catch (error) {
      L(`❌ Erro processando item no lote: ${error instanceof Error ? error.message : String(error)}`);
      // Decide se quer adicionar um resultado de erro ou pular
      // results.push({ success: false, error: String(error) } as unknown as R); // Exemplo
    } finally {
      // Remove a promessa concluída (ou falhada)
      const index = executing.findIndex(existingP => existingP === p);
      if (index > -1) {
          executing.splice(index, 1);
      }
      // Inicia o próximo item se houver
      if (i < items.length) {
          const nextItem = items[i++];
          const nextP = new Promise<void>((resolve) => {
            runNext(nextItem, nextP).then(resolve);
          });
          executing.push(nextP);
      }
    }
  };

  // Inicia a concorrência inicial
  while (i < items.length && executing.length < maxConcurrent) {
      const item = items[i++];
      const p = new Promise<void>((resolve) => {
        runNext(item, p).then(resolve);
      });
      executing.push(p);
  }

  // Espera todas as promessas serem resolvidas
  await Promise.allSettled(executing); // Use allSettled para garantir que tudo termine mesmo com rejeições

  // Pode haver promessas restantes se o loop inicial não preencheu a concorrência
  // e as primeiras tarefas terminaram muito rápido. Garante que tudo seja esperado.
  while(executing.length > 0){
      await Promise.allSettled(executing);
  }


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
  let query = supabase.from('questions').select('*').eq('topic', topic);
  if (limit > 0) {
    query = query.limit(limit);
  }
  const { data, error } = await query;

  if (error) {
    L(`❌ Erro ao buscar questões para ${topic}: ${error.message}`);
    throw error; // Re-lança para ser pego pelo handler principal
  }
  if (!data || data.length === 0) {
    L(`⚠️ Nenhuma questão encontrada para o tópico: ${topic}.`);
    return [];
  }
  L(`✔️ ${data.length} questões encontradas para ${topic}.`);
  return data as QuestionRecord[];
}

async function updateQuestionInSupabase(
  questionId: string,
  updates: Partial<QuestionRecord>
): Promise<boolean> {
  // Garante que o tópico seja um dos válidos ou um string genérico se a IA falhar
  if (updates.topic && !TOPIC_SEQUENCE.includes(updates.topic as AlgebraticamenteTopic)) {
      L(`⚠️ IA retornou tópico inválido "${updates.topic}" para ID ${questionId}. Mantendo o tópico original ou o padrão.`);
      // Decide o que fazer: manter o original, ou setar um padrão? Por segurança, vamos remover o update de tópico.
      delete updates.topic;
      if (Object.keys(updates).length === 0) {
          L(`ℹ️ Nenhum outro campo para atualizar para ID ${questionId} após remover tópico inválido.`);
          return true; // Considera sucesso pois não havia nada válido para atualizar
      }
  }


  L(`🔄 Atualizando questão ID ${questionId} com dados: ${JSON.stringify(updates)}`);
  const { error } = await supabase
    .from('questions')
    .update(updates)
    .eq('id', questionId);

  if (error) {
    L(`❌ Erro ao atualizar questão ID ${questionId}: ${error.message}`);
    pipelineStats.totalDbFailures++;
    return false;
  }
  pipelineStats.totalDbUpdates++;
  L(`✔️ Questão ID ${questionId} atualizada com sucesso.`);
  return true;
}

/* ─── Interação com a IA ────────────────────────────────────────────────── */
async function getCurationFromAI(
  question: QuestionRecord,
  currentCurationTopic: AlgebraticamenteTopic
): Promise<AICurationResponse | null> {
  const client = getNextDeepSeekClient();
  const selectedKey = client.apiKey;
  pipelineStats.totalQuestionsProcessedThisRun++;

  const payload = {
    statement: sanitizeString(question.statement_md),
    options: question.options.map(opt => sanitizeString(opt)),
    correct_option: question.correct_option,
    solution: sanitizeString(question.solution_md),
    current_topic_being_processed: currentCurationTopic,
  };

  // Validação simples do payload antes de enviar
  if (!payload.statement || !payload.options || payload.options.some(opt => typeof opt !== 'string')) {
      L(`❌ Payload inválido para ID ${question.id} antes de chamar a API. Pulando.`);
      pipelineStats.totalApiFailures++; // Considera como falha de API
      return null;
  }


  try {
    const promptToSend = SYSTEM_PROMPTS[currentCurationTopic];
    if (!promptToSend) {
        L(`❌ Prompt não encontrado para o tópico: ${currentCurationTopic}. Pulando questão ID ${question.id}`);
        pipelineStats.totalApiFailures++;
        return null;
    }

    L(`🤖 Chamando API para ID ${question.id} (Tópico: ${currentCurationTopic}, Chave: ${selectedKey?.substring(0,4)}...)`);
    const chatCompletion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: promptToSend },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      response_format: { type: "json_object" },
    });

    const rawResponse = chatCompletion.choices[0]?.message.content;
    if (!rawResponse) {
      L(`⚠️ Resposta vazia da API para questão ID ${question.id} (Chave: ${selectedKey?.substring(0,4)})`);
      keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
      pipelineStats.totalApiFailures++;
      return null;
    }

    try {
      const jsonResponse = JSON.parse(rawResponse) as AICurationResponse;
      // Validação mais robusta da resposta JSON
      if (
          !jsonResponse ||
          typeof jsonResponse !== 'object' ||
          typeof jsonResponse.corrected_topic !== 'string' ||
          typeof jsonResponse.statement_latex !== 'string' ||
          !Array.isArray(jsonResponse.options_latex) ||
          jsonResponse.options_latex.some(opt => typeof opt !== 'string') ||
          typeof jsonResponse.correct_option_index !== 'number' ||
          typeof jsonResponse.hint !== 'string'
         ) {
          L(`❌ Resposta JSON inválida ou incompleta da IA para ${question.id}: Campos obrigatórios ausentes ou tipos incorretos.`);
          L(`   Resposta recebida: ${rawResponse.substring(0, 300)}...`);
          keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
          pipelineStats.totalApiFailures++;
          return null;
      }
      pipelineStats.totalApiSuccess++;
      L(`✅ Resposta JSON válida recebida para ID ${question.id}`);
      return jsonResponse;
    } catch (parseError: any) {
      L(`❌ Erro ao parsear JSON da IA para questão ID ${question.id}: ${parseError.message} (Chave: ${selectedKey?.substring(0,4)})`);
      L(`   Raw response: ${rawResponse.substring(0, 500)}...`);
      keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
      pipelineStats.totalApiFailures++;
      return null;
    }
  } catch (apiError: any) {
    // Trata erros específicos da API (rate limit, auth, etc.)
    let errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
    if (apiError.status) { // OpenAI errors often have a status code
        errorMessage = `Status ${apiError.status}: ${errorMessage}`;
    }
    L(`❌ Erro na API para questão ID ${question.id}: ${errorMessage} (Chave: ${selectedKey?.substring(0,4)})`);
    keyStats.errors.set(selectedKey, (keyStats.errors.get(selectedKey) || 0) + 1);
    pipelineStats.totalApiFailures++;
    return null;
  }
}

/* ─── Função para processar uma questão completa ────────────────────────── */
interface ProcessResult {
  questionId: string;
  success: boolean; // Indica se a atualização no DB foi bem-sucedida
  newTopic?: string;
  originalTopic: string;
  apiSuccess: boolean; // Indica se a chamada à API e o parse foram bem-sucedidos
}

async function processSingleQuestion(
  question: QuestionRecord,
  currentCurationTopic: AlgebraticamenteTopic
): Promise<ProcessResult> {
  L(`⚙️ Iniciando processamento para ID ${question.id} (Tópico Original: ${question.topic}) com foco em ${currentCurationTopic}`);

  const aiResponse = await getCurationFromAI(question, currentCurationTopic);

  if (!aiResponse) {
    // Falha na API ou no parse
    return {
        questionId: question.id,
        success: false, // DB update não ocorreu
        originalTopic: question.topic,
        apiSuccess: false
    };
  }

  // API e parse OK, agora prepara e tenta o update no DB
  const updates: Partial<QuestionRecord> = {
    topic: aiResponse.corrected_topic, // A validação extra está em updateQuestionInSupabase
    statement_md: aiResponse.statement_latex,
    options: aiResponse.options_latex,
    correct_option: aiResponse.correct_option_index,
    solution_md: aiResponse.hint,
  };

  if (question.topic !== updates.topic && updates.topic) {
    L(`↪️ Questão ID ${question.id} reclassificada de "${question.topic}" para "${updates.topic}" pela IA.`);
    pipelineStats.questionsReclassified++;
  }

  const updateSuccess = await updateQuestionInSupabase(question.id, updates);

  return {
    questionId: question.id,
    success: updateSuccess, // Sucesso do DB update
    newTopic: updates.topic,
    originalTopic: question.topic,
    apiSuccess: true // API e parse foram OK
  };
}

/* ─── Execução Principal da Pipeline ───────────────────────────────────── */
async function mainPipeline() {
  L('🚀 Iniciando PIPELINE DE CURADORIA DE QUESTÕES...');
  L(`⚙️ Configuração: ${apiKeys.length} chaves API, Concorrência Máx: ${MAX_CONCURRENCY}, Tamanho Lote Processamento: ${BATCH_SIZE}`);
  L(`🏷️ Sequência de Tópicos: ${TOPIC_SEQUENCE.join(' → ')}`);

  // Leitura de argumentos da linha de comando (ex: --max_per_topic=5)
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
        continue; // Pula para o próximo tópico
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
      const batch = questionBatches[i];
      L(`🔄 Processando lote ${i + 1}/${questionBatches.length} do tópico ${currentTopic} (${batch.length} questões)...`);

      const batchResults = await processBatch(
        batch,
        (question) => processSingleQuestion(question, currentTopic),
        MAX_CONCURRENCY
      );

      // Contabiliza resultados do lote
      processedCountInTopic += batch.length; // Contamos todas as tentativas de processamento
      batchResults.forEach(result => {
          if (result.apiSuccess) apiSuccessCountInTopic++;
          if (result.success) dbUpdateSuccessCountInTopic++; // Sucesso = DB update OK
      });

      L(`📊 Lote ${i + 1} concluído. Questões no lote: ${batch.length}. Sucesso API/Parse: ${batchResults.filter(r=>r.apiSuccess).length}. Sucesso DB Update: ${batchResults.filter(r=>r.success).length}.`);
    }
    L(`✅ Tópico ${currentTopic} concluído. Total processado: ${processedCountInTopic}. Sucesso API/Parse: ${apiSuccessCountInTopic}. Sucesso DB Update: ${dbUpdateSuccessCountInTopic}.`);
  }

  L('\n🏁 PIPELINE DE CURADORIA FINALIZADA 🏁');
  pipelineStats.printSummary();
  closeLogStream(); // Fecha o stream de log
}

// Executa a pipeline principal
mainPipeline().catch(error => {
  L(`❌ ERRO FATAL NA PIPELINE: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error); // Log completo do erro no console
  pipelineStats.printSummary();
  closeLogStream();
  process.exit(1); // Termina com código de erro
});
