/**
 * THE CLIMB — Daily Question Generator
 * ----------------------------------------
 * Run this script once per day (e.g. midnight via cron or GitHub Actions).
 * It calls the Claude API to generate 39 questions per difficulty (3 per category),
 * then stores them in Supabase so all players get the same question pool.
 * Players see 3 random category choices per rung and pick one to answer.
 *
 * Setup: npm install @anthropic-ai/sdk @supabase/supabase-js dotenv
 * Run:   node generate.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ── Config (set these in .env file) ──────────────────────────────────────────
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

// 13 categories × 3 questions each = 39 per mode
const CATEGORIES = [
  'Pro Sports/Players', 'College Sports/Players', 'Music', 'Movies', 'TV',
  'Geography', 'History', 'Science', 'Brands & Products',
  'Viral Internet', 'General Knowledge', 'Food & Drink', 'US History'
];
const QS_PER_CATEGORY = 3; // Questions per category per mode

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎯 The Climb Daily Generator — ${TODAY}\n`);

  // Check if today's questions already exist
  const { data: existing } = await sb
    .from('daily_questions')
    .select('mode')
    .eq('date', TODAY);

  const existingModes = (existing || []).map(r => r.mode);
  const modesNeeded = ['easy', 'medium', 'hard'].filter(m => !existingModes.includes(m));

  if (modesNeeded.length === 0) {
    console.log('✅ Today\'s questions already generated. Nothing to do.');
    return;
  }

  console.log(`📝 Generating questions for: ${modesNeeded.join(', ')}\n`);
  console.log('  ⏳ Generating all questions in one pass (prevents overlap)...');

  try {
    const allQuestions = await generateAllQuestions(modesNeeded);

    for (const mode of modesNeeded) {
      if (allQuestions[mode]) {
        await storeQuestions(mode, allQuestions[mode]);
        console.log(`  ✅ ${mode}: ${allQuestions[mode].length} questions stored`);
      }
    }
  } catch (err) {
    console.error('  ❌ Generation failed:', err.message);
    process.exit(1);
  }

  console.log('\n🏆 All done! Today\'s questions are ready.\n');
}

// ── Generate all questions in one call to prevent topic overlap ───────────────
async function generateAllQuestions(modes) {
  const modesSection = modes.map(mode => {
    const desc = {
      easy:   'EASY — questions a typical adult can answer. Think: iconic movies, famous athletes, basic history, household brand names. Should feel achievable.',
      medium: 'MEDIUM — requires real knowledge. About half of players will know. Mix popular and slightly deeper facts. MUST use completely different topics/people/events than the easy questions.',
      hard:   'HARD — only trivia enthusiasts will know. Specific records, exact years, niche facts, deep cuts. MUST use completely different topics/people/events than easy and medium.'
    }[mode];
    return `### ${mode.toUpperCase()} SET\n${desc}`;
  }).join('\n\n');

  const totalPerMode = CATEGORIES.length * QS_PER_CATEGORY; // 39

  const prompt = `You are generating daily trivia questions for "The Climb," a daily trivia game.
Today's date: ${TODAY}

HOW THE GAME WORKS: Players see 3 random category choices at each of 10 rungs and pick one to answer.
So each difficulty needs a POOL of ${totalPerMode} questions (${QS_PER_CATEGORY} per category × ${CATEGORIES.length} categories).

Generate ${modes.length * totalPerMode} trivia questions total — ${totalPerMode} per difficulty set.
Each set must include EXACTLY ${QS_PER_CATEGORY} questions per category, covering all ${CATEGORIES.length} categories.

Categories (use exactly these names):
${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Difficulty sets needed:
${modesSection}

═══════════════════════════════════════════
CRITICAL ACCURACY RULES (strictly enforce):
═══════════════════════════════════════════
1. FACTUAL CERTAINTY: Only write questions you are 100% certain are correct. If there is any doubt about a fact — especially sports championships, election results, award winners, or records from 2023 onward — do NOT use it. Stick to well-established facts.
2. NO ANSWER IN QUESTION: The answer word or phrase must NEVER appear anywhere in the question text. Read back every question to verify this before including it.
3. NO OVERLAP: Each difficulty set must use entirely different topics, people, events, and facts — even within the same category. Do not reuse any person, team, movie, show, song, or event across difficulty sets.
4. VARIETY WITHIN CATEGORY: The ${QS_PER_CATEGORY} questions within each category in a set must cover different sub-topics (e.g. for Music: not 3 questions about the same artist).
5. HINTS MUST NOT REVEAL THE ANSWER: The hint should give useful context that narrows down the answer — but must not contain the answer or any part of it. Good hints reference related facts, time period, genre, or context.
6. SHORT ANSWERS: Answers must be a name, word, number, or very short phrase — never a full sentence.
7. ANSWER VARIANTS: In autocomplete, include natural alternate phrasings a player might type.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Return ONLY a raw JSON object with mode keys. No markdown, no explanation, no code fences.
Each mode's array must have exactly ${totalPerMode} question objects (${QS_PER_CATEGORY} per category, all ${CATEGORIES.length} categories represented):
{
  "easy": [
    {
      "question": "Question text here?",
      "answer": "Exact short answer",
      "hint": "A useful contextual clue that does not reveal the answer",
      "category": "Category name from the list above",
      "autocomplete": ["correct answer", "alternate phrasing", "plausible wrong answer 1", "plausible wrong answer 2"]
    }
  ],
  "medium": [ ... ${totalPerMode} questions ... ],
  "hard": [ ... ${totalPerMode} questions ... ]
}

Only include keys for the difficulty sets requested: ${modes.join(', ')}.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',  // Sonnet: better accuracy for trivia facts
    max_tokens: 16000,  // 39 questions × 3 modes needs more tokens
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content.map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  const expectedCount = CATEGORIES.length * QS_PER_CATEGORY; // 39

  // Validate each mode
  for (const mode of modes) {
    const qs = parsed[mode];
    if (!Array.isArray(qs) || qs.length !== expectedCount) {
      throw new Error(`Expected ${expectedCount} ${mode} questions, got ${qs?.length}`);
    }
    qs.forEach((q, i) => {
      if (!q.question || !q.answer || !q.hint || !q.autocomplete) {
        throw new Error(`${mode} question ${i + 1} missing required fields`);
      }
      if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 3) {
        throw new Error(`${mode} question ${i + 1} has insufficient autocomplete options`);
      }
    });
  }

  return parsed;
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
