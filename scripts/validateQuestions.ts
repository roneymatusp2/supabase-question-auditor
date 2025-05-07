import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'fs';

const SUPABASE_URL = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_KEY || !DEEPSEEK_KEY) {
  console.error('❌ Variáveis de ambiente ausentes.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com/v1' });

const log = fs.createWriteStream('audit.log', { flags: 'a' });
const L = (m: string) => { console.log(m); log.write(m + '\n'); };

const SYSTEM_PROMPT = `<<< COLE O PROMPT COMPLETO AQUI >>>`;

const topic =
  process.argv.find(a => a.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

(async () => {
  L(`🔍 ${new Date().toISOString()} • tópico: ${topic}`);

  const { data: qs, error } = await db.from('questions').select('*').eq('topic', topic);
  if (error) throw error;
  if (!qs?.length) { L('⚠️ Nenhuma questão.'); process.exit(0); }

  let pendentes = 0;

  for (const q of qs) {
    L(`\nID ${q.id}`);

    const payload = {
      statement: q.statement_md,
      options: q.options,
      correct_option: q.correct_option,
      solution: q.solution_md
    };

    const chat = await ai.chat.completions.create({
      model: 'deepseek-reasoner',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    });

    const raw = chat.choices[0]?.message.content ?? '';
    let res: any;
    try { res = JSON.parse(raw); } catch { L('❌ JSON inválido'); pendentes++; continue; }

    if (res.is_valid) { L('✅ ok'); continue; }

    const fix: any = {};
    if (res.fixed_correct_option !== null) fix.correct_option = res.fixed_correct_option;
    if (res.fixed_statement_md !== null)   fix.statement_md   = res.fixed_statement_md;
    if (res.fixed_solution_md  !== null)   fix.solution_md    = res.fixed_solution_md;

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
