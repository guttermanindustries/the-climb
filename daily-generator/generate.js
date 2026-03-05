/**
 * THE CLIMB — Daily Question Generator
 * ----------------------------------------
 * Run this script once per day (e.g. midnight via cron or GitHub Actions).
 * It calls the Claude API to generate 30 questions (10 per difficulty),
 * then stores them in Supabase so all players get the same questions.
 *
 * Setup: npm install @anthropic-ai/sdk @supabase/supabase-js dotenv
 * Run:   node generate.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ── Config (set these in .env file) ──────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY; // Use SERVICE key here (not anon)

if (!ANTHROPIC_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing environment variables. Check your .env file.');
  console.error('   Required: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Constants ─────────────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const CATEGORIES = [
  'Pop Culture', 'Sports', 'Music', 'Movies', 'TV',
  'History', 'Geography', 'Science', 'Food & Drink', 'Tech & Innovation'
];

const MODES = ['easy', 'medium', 'hard'];

const DIFFICULTY_DESC = {
  easy:   'accessible — most adults will know this. Focus on mainstream pop culture, famous people, basic history, major sports.',
  medium: 'moderate — about 50% of people will know this. Mix of well-known and slightly obscure facts.',
  hard:   'challenging — only trivia enthusiasts will know. Specific records, years, niche facts, deeper cuts.'
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎯 The Climb Daily Generator — ${TODAY}\n`);

  // Check if today's questions already exist
  const { data: existing } = await sb
    .from('daily_questions')
    .select('mode')
    .eq('date', TODAY);

  const existingModes = (existing || []).map(r => r.mode);
  const modesToGenerate = MODES.filter(m => !existingModes.includes(m));

  if (modesToGenerate.length === 0) {
    console.log('✅ Today\'s questions already generated. Nothing to do.');
    return;
  }

  console.log(`📝 Generating questions for: ${modesToGenerate.join(', ')}\n`);
  
  for (const mode of modesToGenerate) {
    try {
      console.log(`  ⏳ Generating ${mode} questions...`);
      const questions = await generateQuestions(mode);
      await storeQuestions(mode, questions);
      console.log(`  ✅ ${mode}: ${questions.length} questions stored\n`);
    } catch (err) {
      console.error(`  ❌ Failed to generate ${mode}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🏆 All done! Today\'s questions are ready.\n');
}

// ── Generate 10 questions for a mode ────────────────────────────────────────────
async function generateQuestions(mode) {
  const prompt = `Generate exactly 10 trivia questions for a daily trivia game.

Difficulty: ${mode} (${DIFFICULTY_DESC[mode]})
Date: ${TODAY}

Categories — one question per category, in this order:
${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Return ONLY a raw JSON array of exactly 10 objects. No markdown, no explanation:
[
  {
    "question": "The question text",
    "answer": "Short exact answer (name, word, or brief phrase — never a full sentence)",
    "hint": "A helpful clue that doesn't give it away",
    "category": "Category name from the list above",
    "autocomplete": ["correct answer", "alternate spelling or variant", "plausible wrong answer", "plausible wrong answer", "related term"]
  }
]

Important rules:
- autocomplete[0] MUST be the correct answer
- Answers must be specific names, places, or short phrases
- No yes/no questions
- Vary question styles: who, what, where, when, which
- Make questions genuinely interesting and fun
- ${mode === 'hard' ? 'For hard: go deep — specific stats, years, niche figures, record holders.' : ''}
- ${mode === 'easy' ? 'For easy: think Wordle-level accessibility. Should feel winnable.' : ''}`;

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-6',  // Use Opus for best quality daily questions
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content.map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const questions = JSON.parse(clean);

  if (!Array.isArray(questions) || questions.length !== 10) {
    throw new Error(`Expected 10 questions, got ${questions?.length}`);
  }

  // Validate each question
  questions.forEach((q, i) => {
    if (!q.question || !q.answer || !q.hint || !q.autocomplete) {
      throw new Error(`Question ${i + 1} is missing required fields`);
    }
    if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 3) {
      throw new Error(`Question ${i + 1} has insufficient autocomplete options`);
    }
  });

  return questions;
}

// ── Store in Supabase ─────────────────────────────────────────────────────────
async function storeQuestions(mode, questions) {
  const { error } = await sb
    .from('daily_questions')
    .upsert({
      date: TODAY,
      mode: mode,
      questions: questions,
      generated_at: new Date().toISOString()
    }, {
      onConflict: 'date,mode'
    });

  if (error) throw new Error(`Supabase error: ${error.message}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
