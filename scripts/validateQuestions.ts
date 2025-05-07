import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'fs';

/* ─── Credenciais ───────────────────────────────────────────── */
const SUPABASE_URL = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_KEY || !DEEPSEEK_KEY) {
  console.error('❌ Variáveis de ambiente ausentes.');
  process.exit(1);
}

/* ─── Clientes ──────────────────────────────────────────────── */
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com/v1' });

/* ─── Log simplificado ──────────────────────────────────────── */
const log = fs.createWriteStream('audit.log', { flags: 'a' });
const L = (m: string) => { console.log(m); log.write(m + '\n'); };

/* ─── Prompt do DeepSeek ────────────────────────────────────── */
const SYSTEM_PROMPT = `
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
`;

const topic = process.argv.find(a => a.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

/* ─── Execução principal ────────────────────────────────────── */
(async () => {
  L(`🔍 ${new Date().toISOString()} • tópico: ${topic}`);

  const { data: qs, error } = await db
    .from('questions')
    .select('*')
    .eq('topic', topic);

  if (error) throw error;
  if (!qs?.length) { L('⚠️ Nenhuma questão.'); process.exit(0); }

  let pendentes = 0;

  for (const q of qs) {
    L(`\nID ${q.id}`);

    const payload = {
      statement:      q.statement_md,
      options:        q.options,
      correct_option: q.correct_option,
      solution:       q.solution_md
    };

    const chat = await ai.chat.completions.create({
      model: 'deepseek-reasoner',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(payload) }
      ]
    });

    const raw = chat.choices[0]?.message.content ?? '';
    let res: any;
    try { res = JSON.parse(raw); } catch {
      L('❌ JSON inválido'); pendentes++; continue;
    }

    if (res.isMonomio !== true) { L('⛔ reprovada'); pendentes++; continue; }

    const fix: any = {};
    if (res.corrected_topic)                fix.topic           = res.corrected_topic;
    if (res.statement_latex)                fix.statement_md    = res.statement_latex;
    if (res.options_latex)                  fix.options         = res.options_latex;
    if (res.correct_option_index !== null)  fix.correct_option  = res.correct_option_index;
    if (res.hint)                            fix.hints           = [res.hint];

    if (Object.keys(fix).length) {
      const { error } = await db.from('questions').update(fix).eq('id', q.id);
      if (error) { L(`❌ update: ${error.message}`); pendentes++; }
      else       { L('🔧 corrigido'); }
    } else pendentes++;
  }

  L(`\n🏁 ${qs.length} processadas • ${pendentes} pendentes`);
  log.end();
  process.exit(pendentes ? 1 : 0);
})();
