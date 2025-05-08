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
        L(`\n🔑 USO DE CHAVES API:`);
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
// Prompts para diferentes tópicos matemáticos
const SYSTEM_PROMPTS = {
    monomios: `
# SISTEMA DE VALIDAÇÃO MATEMÁTICA: ESPECIALISTA EM MONÔMIOS

Você é um revisor matemático especializado em álgebra, contratado para um sistema de validação automática de questões sobre monômios na plataforma educacional Algebraticamente.

## FLUXO DE ANÁLISE OBRIGATÓRIO

1. ⚖️ CLASSIFICAÇÃO RIGOROSA - Analise a estrutura matemática segundo os critérios exatos abaixo
2. 🔍 VERIFICAÇÃO DETALHADA - Inspecione enunciado, alternativas e solução completamente  
3. 📝 CORREÇÃO PRECISA - Aplique as correções necessárias mantendo o nível pedagógico
4. 📊 RESPOSTA ESTRUTURADA - Retorne APENAS o formato JSON especificado

## DEFINIÇÃO RIGOROSA DE MONÔMIOS

### ✓ CRITÉRIOS PARA SER MONÔMIO:

**EXPRESSÃO ÚNICA:**
* Expressão algébrica com UM ÚNICO TERMO (ex: 5x, -3a², 7xy²/2)
* Formato geral: a·x^n, onde a é o coeficiente numérico e x^n é a parte literal

**OPERAÇÕES VÁLIDAS:**
* Multiplicação entre monômios: 2x · 3y = 6xy
* Divisão entre monômios: 6x³ ÷ 2x = 3x²
* Soma/subtração APENAS entre monômios SEMELHANTES: 3x + 2x = 5x
* Identificação de propriedades: grau, coeficiente, parte literal

### ✗ CRITÉRIOS DE EXCLUSÃO:

**NÃO É MONÔMIO SE:**
* Contém termos com partes literais diferentes: 3x + 2y, x² + x
* Contém equações: 3x = 6
* É uma expressão com múltiplos termos (binômio/polinômio): 2x + 3
* Envolve avaliação numérica de expressões não-monômiais: valor de (4a - 2) para a = 3

## EXEMPLOS PARA CALIBRAÇÃO

### MONÔMIOS VÁLIDOS:
* "Multiplique 3a² por -2a³." ✓
* "Qual o grau do monômio -5x⁴y²?" ✓
* "Calcule 6x³ ÷ 2x." ✓
* "Some os monômios semelhantes: -3ab² + 5ab²." ✓
* "Determine o coeficiente de -7xy²." ✓

### NÃO SÃO MONÔMIOS:
* "Qual o valor de 4a - 2 para a = 3?" ✗ (BINÔMIO)
* "Resolva 3x = 9." ✗ (EQUAÇÃO)
* "Simplifique 2x² + 3x - x²." ✗ (POLINÔMIO)
* "Calcule (3x + 2) quando x = 5." ✗ (AVALIAÇÃO DE BINÔMIO)
* "Some 5x + 3y." ✗ (TERMOS NÃO SEMELHANTES)

## FORMATO DE RESPOSTA OBRIGATÓRIO (APENAS JSON)

### Para questões sobre monômios:
\`\`\`json
{
  "isMonomio": true,
  "corrected_topic": "monomios",
  "statement_latex": "Enunciado correto com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica clara sobre o conceito de monômios presente na questão"
}
\`\`\`

### Para questões que NÃO são sobre monômios:
\`\`\`json
{
  "isMonomio": false,
  "corrected_topic": "tópico_correto",
  "statement_latex": "Enunciado corrigido com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica sobre o tópico correto"
}
\`\`\`

## DIRETRIZES CRÍTICAS

1. NUNCA gere texto fora do formato JSON solicitado
2. Use a formatação LaTeX apropriada para todos os símbolos matemáticos
3. Corrija quaisquer erros de português ou matemáticos encontrados
4. Se uma questão não for sobre monômios, indique o tópico matemático correto mais específico (ex: "binomios", "equacoes_1grau", "polinomios", etc.)
5. Avalie RIGOROSAMENTE cada questão conforme os critérios de classificação descritos
`,
    polinomios: `
# SISTEMA DE VALIDAÇÃO MATEMÁTICA: ESPECIALISTA EM POLINÔMIOS

Você é um revisor matemático especializado em álgebra, contratado para um sistema de validação automática de questões sobre polinômios na plataforma educacional Algebraticamente.

## FLUXO DE ANÁLISE OBRIGATÓRIO

1. ⚖️ CLASSIFICAÇÃO RIGOROSA - Analise a estrutura matemática segundo os critérios exatos abaixo
2. 🔍 VERIFICAÇÃO DETALHADA - Inspecione enunciado, alternativas e solução completamente  
3. 📝 CORREÇÃO PRECISA - Aplique as correções necessárias mantendo o nível pedagógico
4. 📊 RESPOSTA ESTRUTURADA - Retorne APENAS o formato JSON especificado

## DEFINIÇÃO RIGOROSA DE POLINÔMIOS

### ✓ CRITÉRIOS PARA SER POLINÔMIO:

**EXPRESSÃO ALGÉBRICA:**
* Soma de monômios com diferentes partes literais ou expoentes (ex: 3x² + 2x - 5)
* Formato geral: a₁x^n + a₂x^(n-1) + ... + aₙ₋₁x + aₙ, onde a₁, a₂, ..., aₙ são os coeficientes

**OPERAÇÕES VÁLIDAS:**
* Soma e subtração de polinômios
* Multiplicação de polinômios
* Divisão de polinômios
* Fatoração de polinômios
* Cálculo de raízes (zeros) de polinômios
* Operações com polinômios em forma fatorada

### ✗ CRITÉRIOS DE EXCLUSÃO:

**NÃO É POLINÔMIO SE:**
* Envolve expressões transcendentais (sin, cos, log, etc.)
* Contém variáveis no denominador não fatoráveis (expressões racionais)
* Possui expoentes negativos ou fracionários não simplificáveis
* Inclui expressões com variáveis em radicais não simplificáveis

## EXEMPLOS PARA CALIBRAÇÃO

### POLINÔMIOS VÁLIDOS:
* "Fatore o polinômio: x² - 4x + 4" ✓
* "Resolva a equação: 2x² + 3x - 5 = 0" ✓
* "Simplifique: (x² + 2x) + (3x² - x + 1)" ✓
* "Encontre as raízes de x³ - 3x² + 3x - 1 = 0" ✓
* "Multiplique os polinômios: (x+2)(x-3)" ✓

### NÃO SÃO POLINÔMIOS:
* "Resolva: sin(x) + x² = 0" ✗ (EXPRESSÃO TRANSCENDENTAL)
* "Simplifique: 1/(x²-1)" ✗ (EXPRESSÃO RACIONAL)
* "Calcule: √x + x²" ✗ (RADICAL COM VARIÁVEL)
* "Resolva: x^(-1) + 2 = 0" ✗ (EXPOENTE NEGATIVO NÃO SIMPLIFICÁVEL)

## FORMATO DE RESPOSTA OBRIGATÓRIO (APENAS JSON)

### Para questões sobre polinômios:
\`\`\`json
{
  "isPolinomio": true,
  "corrected_topic": "polinomios",
  "statement_latex": "Enunciado correto com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica clara sobre o conceito de polinômios presente na questão"
}
\`\`\`

### Para questões que NÃO são sobre polinômios:
\`\`\`json
{
  "isPolinomio": false,
  "corrected_topic": "tópico_correto",
  "statement_latex": "Enunciado corrigido com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica sobre o tópico correto"
}
\`\`\`

## DIRETRIZES CRÍTICAS

1. NUNCA gere texto fora do formato JSON solicitado
2. Use a formatação LaTeX apropriada para todos os símbolos matemáticos
3. Corrija quaisquer erros de português ou matemáticos encontrados
4. Se uma questão não for sobre polinômios, indique o tópico matemático correto mais específico (ex: "monomios", "equacoes_1grau", "funcoes", etc.)
5. Avalie RIGOROSAMENTE cada questão conforme os critérios de classificação descritos
`,
    funcoes: `
# SISTEMA DE VALIDAÇÃO MATEMÁTICA: ESPECIALISTA EM FUNÇÕES

Você é um revisor matemático especializado em análise matemática, contratado para um sistema de validação automática de questões sobre funções na plataforma educacional Algebraticamente.

## FLUXO DE ANÁLISE OBRIGATÓRIO

1. ⚖️ CLASSIFICAÇÃO RIGOROSA - Analise a estrutura matemática segundo os critérios exatos abaixo
2. 🔍 VERIFICAÇÃO DETALHADA - Inspecione enunciado, alternativas e solução completamente  
3. 📝 CORREÇÃO PRECISA - Aplique as correções necessárias mantendo o nível pedagógico
4. 📊 RESPOSTA ESTRUTURADA - Retorne APENAS o formato JSON especificado

## DEFINIÇÃO RIGOROSA DE FUNÇÕES

### ✓ CRITÉRIOS PARA SER FUNÇÃO:

**CONCEITO MATEMÁTICO:**
* Relação entre dois conjuntos onde cada elemento do domínio está associado a exatamente um elemento do contradomínio
* Representada por f: A → B, onde A é o domínio e B é o contradomínio
* Expressa por equações, gráficos, tabelas ou diagramas

**TÓPICOS VÁLIDOS SOBRE FUNÇÕES:**
* Domínio, imagem e contradomínio
* Funções injetoras, sobrejetoras e bijetoras
* Composição de funções e função inversa
* Funções polinomiais (lineares, quadráticas, etc.)
* Funções exponenciais e logarítmicas
* Funções trigonométricas
* Limites, continuidade e derivadas de funções
* Crescimento, decrescimento e extremos de funções

### ✗ CRITÉRIOS DE EXCLUSÃO:

**NÃO É FUNÇÃO SE:**
* É apenas uma expressão sem contexto de relação entre conjuntos
* Trata-se apenas de equações sem conceito de correspondência
* Aborda apenas operações com polinômios sem tratá-los como funções
* Refere-se a conceitos mais específicos como sequências ou séries sem contexto funcional

## EXEMPLOS PARA CALIBRAÇÃO

### FUNÇÕES VÁLIDAS:
* "Determine o domínio da função f(x) = 1/(x-2)" ✓
* "Encontre a função inversa de f(x) = 3x + 1" ✓
* "Calcule o valor de f(2) se f(x) = x² - 3x + 4" ✓
* "Esboce o gráfico da função f(x) = |x - 1|" ✓
* "Determine os intervalos onde a função f(x) = x³ - 3x² é crescente" ✓

### NÃO SÃO FUNÇÕES:
* "Resolva a equação x² - 4 = 0" ✗ (EQUAÇÃO SEM CONTEXTO FUNCIONAL)
* "Calcule o produto dos polinômios (x+1)(x-2)" ✗ (APENAS OPERAÇÃO COM POLINÔMIOS)
* "Determine o 5º termo da PA: 3, 7, 11, 15, ..." ✗ (SEQUÊNCIA SEM CONTEXTO FUNCIONAL)
* "Simplifique a expressão (x² + 3x)/(x + 3)" ✗ (EXPRESSÃO ALGÉBRICA SEM CONTEXTO DE FUNÇÃO)

## FORMATO DE RESPOSTA OBRIGATÓRIO (APENAS JSON)

### Para questões sobre funções:
\`\`\`json
{
  "isFuncao": true,
  "corrected_topic": "funcoes",
  "statement_latex": "Enunciado correto com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica clara sobre o conceito de funções presente na questão"
}
\`\`\`

### Para questões que NÃO são sobre funções:
\`\`\`json
{
  "isFuncao": false,
  "corrected_topic": "tópico_correto",
  "statement_latex": "Enunciado corrigido com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica sobre o tópico correto"
}
\`\`\`

## DIRETRIZES CRÍTICAS

1. NUNCA gere texto fora do formato JSON solicitado
2. Use a formatação LaTeX apropriada para todos os símbolos matemáticos
3. Corrija quaisquer erros de português ou matemáticos encontrados
4. Se uma questão não for sobre funções, indique o tópico matemático correto mais específico (ex: "equacoes", "polinomios", "trigonometria", etc.)
5. Avalie RIGOROSAMENTE cada questão conforme os critérios de classificação descritos
`,
    geometria: `
# SISTEMA DE VALIDAÇÃO MATEMÁTICA: ESPECIALISTA EM GEOMETRIA

Você é um revisor matemático especializado em geometria, contratado para um sistema de validação automática de questões sobre geometria na plataforma educacional Algebraticamente.

## FLUXO DE ANÁLISE OBRIGATÓRIO

1. ⚖️ CLASSIFICAÇÃO RIGOROSA - Analise a estrutura matemática segundo os critérios exatos abaixo
2. 🔍 VERIFICAÇÃO DETALHADA - Inspecione enunciado, alternativas e solução completamente  
3. 📝 CORREÇÃO PRECISA - Aplique as correções necessárias mantendo o nível pedagógico
4. 📊 RESPOSTA ESTRUTURADA - Retorne APENAS o formato JSON especificado

## DEFINIÇÃO RIGOROSA DE GEOMETRIA

### ✓ CRITÉRIOS PARA SER GEOMETRIA:

**ÁREAS ABRANGIDAS:**
* Geometria plana (figuras bidimensionais)
* Geometria espacial (figuras tridimensionais)
* Geometria analítica (uso de coordenadas e equações)
* Trigonometria (relações em triângulos)
* Transformações geométricas (reflexão, rotação, translação)

**TÓPICOS VÁLIDOS:**
* Cálculo de áreas, perímetros, volumes e superfícies
* Ângulos, retas, planos e suas relações
* Propriedades de figuras geométricas (triângulos, quadriláteros, polígonos, círculos)
* Semelhança e congruência de figuras
* Teoremas geométricos (Pitágoras, Tales, etc.)
* Coordenadas no plano cartesiano
* Equações de retas, circunferências, parábolas, etc.

### ✗ CRITÉRIOS DE EXCLUSÃO:

**NÃO É GEOMETRIA SE:**
* Trata apenas de operações algébricas sem contexto geométrico
* É puramente aritmético sem relação com medidas ou formas
* Aborda exclusivamente funções sem interpretação geométrica
* Refere-se a conceitos estatísticos ou probabilísticos sem contexto espacial

## EXEMPLOS PARA CALIBRAÇÃO

### GEOMETRIA VÁLIDA:
* "Calcule a área de um triângulo de base 4cm e altura 5cm" ✓
* "Determine o volume de um cubo de aresta 3cm" ✓
* "Encontre a equação da reta que passa pelos pontos (1,2) e (3,4)" ✓
* "Calcule a distância entre os pontos A(2,3) e B(5,7)" ✓
* "Verifique se os triângulos ABC e DEF são semelhantes" ✓

### NÃO É GEOMETRIA:
* "Resolva a equação 2x + 3 = 7" ✗ (PURAMENTE ALGÉBRICO)
* "Calcule 15% de 80" ✗ (PURAMENTE ARITMÉTICO)
* "Determinar o domínio da função f(x) = √x" ✗ (FUNÇÃO SEM CONTEXTO GEOMÉTRICO)
* "Calcule a probabilidade de obter cara ao lançar uma moeda" ✗ (PROBABILIDADE)

## FORMATO DE RESPOSTA OBRIGATÓRIO (APENAS JSON)

### Para questões sobre geometria:
\`\`\`json
{
  "isGeometria": true,
  "corrected_topic": "geometria",
  "statement_latex": "Enunciado correto com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica clara sobre o conceito geométrico presente na questão"
}
\`\`\`

### Para questões que NÃO são sobre geometria:
\`\`\`json
{
  "isGeometria": false,
  "corrected_topic": "tópico_correto",
  "statement_latex": "Enunciado corrigido com formatação LaTeX apropriada",
  "options_latex": ["Alternativa 1 corrigida", "Alternativa 2 corrigida", "Alternativa 3 corrigida", "Alternativa 4 corrigida"],
  "correct_option_index": 0,
  "hint": "Dica pedagógica sobre o tópico correto"
}
\`\`\`

## DIRETRIZES CRÍTICAS

1. NUNCA gere texto fora do formato JSON solicitado
2. Use a formatação LaTeX apropriada para todos os símbolos matemáticos
3. Corrija quaisquer erros de português ou matemáticos encontrados
4. Se uma questão não for sobre geometria, indique o tópico matemático correto mais específico (ex: "algebra", "aritmetica", "estatistica", etc.)
5. Avalie RIGOROSAMENTE cada questão conforme os critérios de classificação descritos
`
};
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
async function getCurationFromAI(question, prompt) {
    // Seleciona a próxima chave API disponível
    const client = getNextDeepSeekClient();
    const selectedKey = client.apiKey;
    const callStartTime = Date.now();
    let aiResponse = null;
    // Objeto para rastrear tentativas e erros
    const attempts = {
        count: 0,
        maxAttempts: 3, // Máximo de tentativas
        usedKeys: new Set([selectedKey]), // Conjunto de chaves já utilizadas
        errors: [], // Lista de erros para diagnóstico
        successfulKey: null // Chave que eventualmente teve sucesso
    };
    // Função interna para tentar processar a questão com diferentes níveis de payload e chaves
    async function attemptProcessing(currentClient, payloadLevel) {
        attempts.count++;
        if (attempts.count > attempts.maxAttempts) {
            L(`⚠️ Número máximo de tentativas (${attempts.maxAttempts}) atingido para questão ID ${question.id}`);
            return null;
        }
        // Prepara o payload baseado no nível solicitado
        let payload;
        try {
            if (payloadLevel === 'full') {
                // Payload completo com todos os campos
                payload = {
                    statement: sanitizeObject(question.statement_md),
                    options: sanitizeObject(question.options),
                    correct_option: question.correct_option,
                    solution: sanitizeObject(question.solution_md)
                };
            }
            else if (payloadLevel === 'reduced') {
                // Payload reduzido com campos principais e tamanho controlado
                payload = {
                    question_id: question.id,
                    statement: question.statement_md ? question.statement_md.substring(0, 500) : '',
                    options: question.options ? question.options.map(opt => opt.substring(0, 100)) : [],
                    correct_option: question.correct_option,
                    solution: question.solution_md ? question.solution_md.substring(0, 200) : ''
                };
            }
            else {
                // Payload mínimo apenas com informações essenciais
                payload = {
                    statement: question.statement_md ? question.statement_md.substring(0, 300).replace(/[\u0000-\u001F\u007F-\u009F\\"]/g, '') : '',
                    options: question.options ? question.options.map(opt => typeof opt === 'string' ? opt.substring(0, 50).replace(/[\u0000-\u001F\u007F-\u009F\\"]/g, '') : '') : [],
                    correct_option: question.correct_option
                };
            }
            // Testa que o JSON é válido
            JSON.stringify(payload);
        }
        catch (error) {
            const jsonError = error;
            // Cria um payload ultra simplificado em caso de erro
            L(`⚠️ Erro ao criar JSON para a questão ID ${question.id}, usando payload ultra simples`);
            attempts.errors.push(`JSON Error: ${jsonError.message}`);
            payload = {
                question: question.statement_md ?
                    question.statement_md.substring(0, 200).replace(/[^\w\s.,?!]/g, '') :
                    'Questão indisponível'
            };
        }
        // Configurações específicas baseadas no nível do payload
        const promptConfig = {
            full: { appendix: '', temperature: 0 },
            reduced: {
                appendix: '\n\nATENÇÃO: Esta é uma tentativa de recuperação. Analise cuidadosamente a questão e responda APENAS em formato JSON válido.',
                temperature: 0
            },
            minimal: {
                appendix: '\n\nATENÇÃO CRÍTICA: Esta é uma tentativa final de recuperação após erros. É IMPERATIVO que sua resposta seja ESTRITAMENTE um objeto JSON válido com os campos obrigatórios, sem explicações ou texto adicional.',
                temperature: 0.3 // Ligeiramente maior para tentar uma abordagem diferente
            }
        };
        try {
            // Adiciona delay crescente entre as tentativas
            const delayMs = attempts.count > 1 ? (attempts.count - 1) * 300 : 0;
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            // Faz a chamada para a API com configurações ajustadas por nível
            const chatCompletion = await currentClient.chat.completions.create({
                model: AI_MODEL,
                temperature: promptConfig[payloadLevel].temperature,
                messages: [
                    {
                        role: 'system',
                        content: prompt + promptConfig[payloadLevel].appendix
                    },
                    { role: 'user', content: JSON.stringify(payload) }
                ]
            });
            // Registra a chave usada com sucesso
            attempts.successfulKey = currentClient.apiKey;
            const rawResponse = chatCompletion.choices[0]?.message.content;
            if (!rawResponse) {
                attempts.errors.push('Empty API response');
                L(`⚠️ Resposta vazia da API para a questão ID ${question.id} (tentativa ${attempts.count})`);
                return null;
            }
            // Estratégia em camadas para extrair o JSON da resposta
            let jsonResponse = null;
            // Nível 1: Tentativa direta de parse
            try {
                jsonResponse = JSON.parse(rawResponse);
                return jsonResponse;
            }
            catch (error) {
                const parseError = error;
                attempts.errors.push(`JSON Parse Error L1: ${parseError.message}`);
                // Nível 2: Busca por padrão de objeto JSON na resposta
                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    try {
                        jsonResponse = JSON.parse(jsonMatch[0]);
                        return jsonResponse;
                    }
                    catch (error) {
                        const nestedError = error;
                        attempts.errors.push(`JSON Parse Error L2: ${nestedError.message}`);
                        // Nível 3: Extração agressiva de JSON, removendo caracteres problemáticos
                        try {
                            // Remove caracteres problemáticos que possam ter sido introduzidos
                            const cleanedJson = jsonMatch[0]
                                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Controle
                                .replace(/[^\x20-\x7E]/g, '') // Apenas ASCII
                                .replace(/\\(?!["\\/bfnrt])/g, '\\\\') // Escapa barras
                                .replace(/([^\\])"/g, '$1\\"') // Escapa aspas
                                .replace(/^[^{]*/, '') // Remove prefixo
                                .replace(/[^}]*$/, ''); // Remove sufixo
                            jsonResponse = JSON.parse(`{${cleanedJson.substring(1, cleanedJson.length - 1)}}`);
                            return jsonResponse;
                        }
                        catch (error) {
                            const finalError = error;
                            attempts.errors.push(`JSON Parse Error L3: ${finalError.message}`);
                        }
                    }
                }
            }
            // Se chegou aqui, todas as tentativas de parse falharam
            L(`❌ Não foi possível extrair JSON da resposta para questão ID ${question.id} (tentativa ${attempts.count})`);
            return null;
        }
        catch (apiError) {
            attempts.errors.push(`API Error: ${apiError.message}`);
            L(`❌ Erro na API para questão ID ${question.id} (tentativa ${attempts.count}): ${apiError.message}`);
            return null;
        }
    }
    // Estratégia de tentativas com diferentes chaves e níveis de payload
    try {
        // Primeira tentativa - chave inicial, payload completo
        aiResponse = await attemptProcessing(client, 'full');
        // Segunda tentativa - chave diferente, payload reduzido
        if (!aiResponse && deepSeekClients.length > 1) {
            // Escolhe uma chave diferente da inicial
            const backupKeys = apiKeys.filter(key => !attempts.usedKeys.has(key));
            if (backupKeys.length > 0) {
                // Seleciona a chave com menor número de erros
                const nextKey = [...backupKeys].sort((a, b) => (keyStats.errors.get(a) || 0) - (keyStats.errors.get(b) || 0))[0];
                const backupClient = deepSeekClients[apiKeys.indexOf(nextKey)];
                attempts.usedKeys.add(nextKey);
                L(`🔄 Tentando novamente para questão ID ${question.id} com chave de backup...`);
                aiResponse = await attemptProcessing(backupClient, 'reduced');
            }
        }
        // Terceira tentativa - outra chave ou a mesma se necessário, payload mínimo
        if (!aiResponse) {
            // Escolhe qualquer chave disponível ou reutiliza a última como último recurso
            const lastResortKeys = apiKeys.filter(key => !attempts.usedKeys.has(key));
            const lastKey = lastResortKeys.length > 0 ? lastResortKeys[0] : apiKeys[0];
            const lastClient = deepSeekClients[apiKeys.indexOf(lastKey)];
            attempts.usedKeys.add(lastKey);
            L(`⚠️ Última tentativa para questão ID ${question.id} com payload mínimo...`);
            aiResponse = await attemptProcessing(lastClient, 'minimal');
        }
        // Registra a chave que eventualmente teve sucesso
        if (aiResponse && attempts.successfulKey) {
            const keyUsage = stats.apiKeyUsage.get(attempts.successfulKey) || 0;
            stats.apiKeyUsage.set(attempts.successfulKey, keyUsage + 1);
            if (attempts.count > 1) {
                stats.retrySuccess++;
                L(`✅ Sucesso após ${attempts.count} tentativas para questão ID ${question.id}`);
            }
            // Verifica se a questão foi identificada como não sendo do tópico correto
            const topicChecks = {
                'monomios': aiResponse.isMonomio === false,
                'polinomios': aiResponse.isPolinomio === false,
                'funcoes': aiResponse.isFuncao === false,
                'geometria': aiResponse.isGeometria === false
            };
            // Obtém o campo de verificação para o tópico atual
            let currentTopic = 'monomios';
            for (const key in SYSTEM_PROMPTS) {
                if (SYSTEM_PROMPTS[key] === prompt) {
                    currentTopic = key;
                    break;
                }
            }
            if (topicChecks[currentTopic]) {
                stats.nonMonomioCount++; // Mantemos o nome da variável para compatibilidade
                L(`🔍 Questão ID ${question.id} identificada como não sendo de ${currentTopic}. Tópico sugerido: ${aiResponse.corrected_topic || 'não especificado'}`);
            }
        }
        else {
            // Se todas as tentativas falharam, incrementa contadores de erro
            for (const key of attempts.usedKeys) {
                keyStats.errors.set(key, (keyStats.errors.get(key) || 0) + 1);
            }
            stats.apiErrors++;
            // Log detalhado dos erros encontrados
            L(`💥 Falha total após ${attempts.count} tentativas para questão ID ${question.id}. Erros: ${attempts.errors.join(' | ')}`);
        }
        // Registra tempo total da operação
        const callDuration = Date.now() - callStartTime;
        stats.recordApiCallTime(callDuration);
        return aiResponse;
    }
    catch (catastrophicError) {
        // Registra erro catastrófico que escapou de todos os handlers
        stats.apiErrors++;
        L(`💥 Erro catastrófico para questão ID ${question.id}: ${catastrophicError.message}`);
        return null;
    }
}
/* ─── Função para processar uma questão completa ────────────────────────── */
async function processQuestion(question, prompt) {
    L(`🤖 Solicitando curadoria para a questão ID ${question.id}...`);
    stats.processed++;
    try {
        const curationResponse = await getCurationFromAI(question, prompt);
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
    // Verifica se o tópico é suportado
    // Verifica se o tópico é uma chave válida do objeto SYSTEM_PROMPTS
    if (!(topicToCurate in SYSTEM_PROMPTS)) {
        L(`⚠️ Tópico "${topicToCurate}" não encontrado nos prompts disponíveis. Tópicos suportados: ${Object.keys(SYSTEM_PROMPTS).join(', ')}`);
        L(`⚠️ Usando prompt para "monomios" como fallback.`);
    }
    // Seleciona o prompt adequado para o tópico, com typecasting seguro
    const selectedPrompt = (topicToCurate in SYSTEM_PROMPTS)
        ? SYSTEM_PROMPTS[topicToCurate]
        : SYSTEM_PROMPTS['monomios'];
    L(`📚 Usando prompt específico para o tópico: ${topicToCurate}`);
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
            const results = await processBatch(batch, (question) => processQuestion(question, selectedPrompt), MAX_CONCURRENCY);
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