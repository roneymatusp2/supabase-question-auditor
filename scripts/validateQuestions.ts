import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'fs';

const SUPABASE_URL = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? '';

if (!SUPABASE_KEY || !DEEPSEEK_KEY) process.exit(1);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com/v1' });

const log = fs.createWriteStream('audit.log', { flags: 'a' });
const out = (m: string) => { console.log(m); log.write(m + '\n'); };

const SYSTEM_PROMPT = `<<COLAR AQUI O PROMPT COMPLETO>>`;

const topic =
  process.argv.find(a => a.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

(async () => {
  out(`🔍 ${new Date().toISOString()} • ${topic}`);

  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('topic', topic);

  if (error || !data?.length) { out('sem questões'); process.exit(1); }

  let pending = 0;

  for (const q of data) {
    out(`\n${q.id}`);

    const payload = {
      statement: q.statement_md,
      options: q.options,
      correct_option: q.correct_option,
      solution: q.solution_md,
    };

    const chat = await ai.chat.completions.create({
      model: 'deepseek-reasoner',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const txt = chat.choices[0]?.message.content ?? '';
    let res: any;
    try { res = JSON.parse(txt); } catch { out('json error'); pending++; continue; }

    if (res.is_valid) { out('ok'); continue; }

    const fix: any = {};
    if (res.fixed_correct_option !== null) fix.correct_option = res.fixed_correct_option;
    if (res.fixed_statement_md  !== null) fix.statement_md    = res.fixed_statement_md;
    if (res.fixed_solution_md   !== null) fix.solution_md     = res.fixed_solution_md;

    if (Object.keys(fix).length) {
      const { error } = await supabase.from('questions').update(fix).eq('id', q.id);
      if (error) { out('update fail'); pending++; }
      else out('fixed');
    } else pending++;
  }

  out(`\n${pending} pendentes`);
  log.end();
  process.exit(pending ? 1 : 0);
})();
