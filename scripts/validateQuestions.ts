import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';

/* ===== ENV ===== */
const SUPABASE_URL  = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY ?? '';
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY    ?? '';

if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_KEY missing');
if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY missing');

/* ===== CLIENTS ===== */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com/v1' });

/* ===== LOG ===== */
const logFile = 'audit.log';
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const log = (msg: string) => { console.log(msg); logStream.write(msg + '\n'); };

/* ===== PROMPT ===== */
const SYSTEM_PROMPT = /* (mesmo texto que você já definiu) */ `...`;

/* ===== MAIN ===== */
const topic = process.argv.find(a => a.startsWith('--topic='))?.split('=')[1] ?? 'monomios';

(async () => {
  log(`🔍 ${new Date().toISOString()} · Topic: ${topic}`);

  const { data: qs, error } = await supabase
    .from('questions')
    .select('*')
    .eq('topic', topic);

  if (error) throw new Error(error.message);
  if (!qs?.length) { log('⚠️ Sem questões encontradas'); return; }

  let badWithoutFix = 0;

  for (const q of qs) {
    log(`\n▶️ Question ${q.id}`);

    const payload = {
      statement:     q.statement_md,
      options:       q.options,
      correct_option:q.correct_option,
      solution:      q.solution_md
    };

    /* --- Chamada ao modelo --- */
    const chat = await ai.chat.completions.create({
      model: 'deepseek-reasoner',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(payload) }
      ]
    });

    const content = chat.choices[0]?.message.content ?? '';
    let res: any;
    try { res = JSON.parse(content); } catch {
      log(`❌ JSON parse error → ${content.slice(0,80)}…`); badWithoutFix++; continue;
    }

    if (res.is_valid) {
      log(`✅ OK – ${res.reason}`);
      continue;
    }

    log(`❌ Inválida – ${res.reason}`);

    const fix: any = {};
    if (res.fixed_correct_option !== null) fix.correct_option = res.fixed_correct_option;
    if (res.fixed_statement_md  !== null) fix.statement_md    = res.fixed_statement_md;
    if (res.fixed_solution_md   !== null) fix.solution_md     = res.fixed_solution_md;

    if (Object.keys(fix).length) {
      const { error: upErr } = await supabase.from('questions').update(fix).eq('id', q.id);
      if (upErr) { log(`🔴 Update error: ${upErr.message}`); badWithoutFix++; }
      else       { log('🔧 Corrigido automaticamente'); }
    } else {
      badWithoutFix++;
    }
  }

  log(`\n🏁 Processadas ${qs.length}; pendentes ${badWithoutFix}`);
  logStream.end();
  if (badWithoutFix) process.exit(1);
})();
