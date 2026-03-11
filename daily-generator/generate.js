/**
 * THE CLIMB — Daily Question Generator (v3)
 * ----------------------------------------
 * Runs once per day via GitHub Actions.
 * Generates 39 questions per mode (mc + type) and stores in Supabase.
 *
 * Improvements in v3:
 * - Removed Viral Internet + Brands & Products (high bad-question rate)
 * - Boosted Geography, US History, Music, TV (low bad-question rate)
 * - Much stronger quality guardrails in prompts
 * - Deduplication: avoids questions from the last 14 days
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

if (!ANTHROPIC_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing environment variables. Check your .env file.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const TODAY = new Date().toISOString().slice(0, 10);

// ── Category plan: 39 questions per mode ──────────────────────────────────────
// Based on quality review: Geography/US History/Music/TV are our best categories.
// Brands & Products (67% bad) and Viral Internet (65% bad) have been removed.
//
// Format: [category, questionCount]
const CATEGORY_PLAN = [
  ['Geography',              4],  // 8% bad rate  — our best category
  ['US History',             4],  // 8% bad rate  — excellent
  ['Music',                  4],  // 22% bad rate — very reliable
  ['TV',                     4],  // 28% bad rate — strong
  ['Movies',                 4],  // 36% bad rate — good
  ['Pro Sports/Players',     4],  // 35% bad rate — good
  ['College Sports/Players', 4],  // 33% bad rate — good
  ['Science',                4],  // 36% bad rate — good
  ['General Knowledge',      3],  // 47% bad rate — keep with tighter prompting
  ['History',                3],  // 57% bad rate — keep, narrowed to famous events
  ['Food & Drink',           2],  // 59% bad rate — minimal, keep well-known only
];
// Total: 4+4+4+4+4+4+4+4+3+3+2 = 40 → trim 1 in prompt = 39

const MODES = ['mc', 'type'];

const MODE_DESC = {
  mc:   'Multiple Choice mode — questions should be answerable by most adults who follow pop culture, sports, and news. The question will be shown with 4 answer choices, so it needs to be specific enough that only one is clearly right. Aim for roughly 60-70% of players getting it right.',
  type: 'Open Answer mode — players type in the answer with autocomplete help. Questions can be slightly more specific than MC, but must still be fair. The answer must be a specific person, place, thing, or short phrase — something a knowledgeable player could reasonably type. Aim for roughly 40-50% of players getting it right.',
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎯 The Climb Daily Generator v3 — ${TODAY}\n`);

  // Check which modes still need generating today
  const { data: existing } = await sb
    .from('daily_questions')
    .select('mode')
    .eq('date', TODAY);

  const existingModes = (existing || []).map(r => r.mode);
  const modesToGenerate = MODES.filter(m => !existingModes.includes(m));

  if (modesToGenerate.length === 0) {
    console.log('✅ Already generated for today. Nothing to do.');
    return;
  }

  // Load recent questions for dedup (last 14 days)
  const recentQTexts = await loadRecentQuestions();
  console.log(`🔍 Loaded ${recentQTexts.size} recent questions for dedup\n`);

  for (const mode of modesToGenerate) {
    try {
      console.log(`  ⏳ Generating ${mode} questions...`);
      const questions = await generateQuestions(mode, recentQTexts);
      await storeQuestions(mode, questions);
      console.log(`  ✅ ${mode}: ${questions.length} questions stored\n`);
    } catch (err) {
      console.error(`  ❌ Failed to generate ${mode}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🏆 Done! Today\'s questions are ready.\n');
}

// ── Load recent questions for dedup ──────────────────────────────────────────
async function loadRecentQuestions() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data } = await sb
    .from('daily_questions')
    .select('questions')
    .gte('date', cutoffStr);

  const texts = new Set();
  for (const row of (data || [])) {
    for (const q of (row.questions || [])) {
      if (q.question) texts.add(q.question.toLowerCase().trim());
    }
  }
  return texts;
}

// ── Generate questions for one mode ──────────────────────────────────────────
async function generateQuestions(mode, recentQTexts) {
  // Build the category list with counts
  const categoryLines = CATEGORY_PLAN.map(([cat, n]) =>
    `- ${cat}: ${n} question${n > 1 ? 's' : ''}`
  ).join('\n');

  // Build dedup hint (last 14 days question snippets, max 60 listed)
  const recentList = [...recentQTexts].slice(0, 60).map(q => `  • ${q.slice(0, 80)}`).join('\n');
  const dedupSection = recentList
    ? `\nAVOID repeating or closely paraphrasing any of these recently used questions:\n${recentList}\n`
    : '';

  const prompt = `You are generating questions for "The Climb", a daily trivia game. Generate exactly 39 trivia questions.

MODE: ${mode.toUpperCase()} — ${MODE_DESC[mode]}

CATEGORY QUOTAS (generate exactly this many per category):
${categoryLines}

${dedupSection}

QUALITY RULES — read carefully, these are strict:
1. DIFFICULTY SWEET SPOT: Not too easy, not too obscure. Ask yourself: "Would a reasonably well-read adult who follows sports/news/pop culture know this?" If yes for most adults → good. If only a superfan or specialist would know → too obscure, try something else.
2. NO TRIVIA TRAPS: Avoid questions where the answer is a common acronym (FOMO, LOL, GOAT), a basic household brand name asked generically (e.g. "What company makes iPhone?"), or something so famous it's on every trivia list.
3. FAMOUS BUT INTERESTING: Good questions feel like "oh yeah, I should know that!" — not "everyone knows that" or "nobody knows that."
4. SPECIFIC ANSWERS ONLY: Answers must be a specific person's name, a place, a movie/show/song title, or a short phrase. Never a full sentence. Never yes/no.
5. HISTORY category: Stick to famous events/people everyone has heard of (WWII, Civil War, major presidents, etc.). No obscure dates or minor figures.
6. FOOD & DRINK category: Only ask about iconic, famous foods, drinks, dishes, or chefs that most Americans would recognize.
7. GEOGRAPHY: Mix US geography with world geography. Capitals, famous landmarks, rivers, countries — not obscure villages or minor peaks.
8. NO DUPLICATES: Do not repeat or closely paraphrase any recently used question listed above.

OUTPUT FORMAT — return ONLY a raw JSON array of exactly 39 objects, no markdown, no explanation:
[
  {
    "question": "The question text (complete sentence ending in ?)",
    "answer": "Short exact answer — a name, title, place, or brief phrase",
    "category": "Exact category name from the list above",
    "autocomplete": ["correct answer", "plausible wrong 1", "plausible wrong 2", "plausible wrong 3", "plausible wrong 4", "plausible wrong 5", "plausible wrong 6", "plausible wrong 7", "plausible wrong 8", "plausible wrong 9", "plausible wrong 10", "plausible wrong 11", "plausible wrong 12", "plausible wrong 13", "plausible wrong 14", "plausible wrong 15", "plausible wrong 16", "plausible wrong 17", "plausible wrong 18", "plausible wrong 19"]
  }
]

AUTOCOMPLETE rules:
- autocomplete[0] MUST be the correct answer
- The other 19 entries are plausible-but-wrong answers from the same category (e.g. other athletes, other countries, other movies)
- Do NOT include obviously wrong answers — they should all seem plausible to make the game challenging`;

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5-20251101',
    max_tokens: 12000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content.map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();

  let questions;
  try {
    questions = JSON.parse(clean);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}\nRaw: ${clean.slice(0, 200)}`);
  }

  if (!Array.isArray(questions)) throw new Error('Response is not an array');

  // Trim to 39 if AI returned slightly more
  if (questions.length > 39) questions = questions.slice(0, 39);
  if (questions.length < 35) throw new Error(`Too few questions: got ${questions.length}, need at least 35`);

  // Validate each question
  questions.forEach((q, i) => {
    if (!q.question || !q.answer || !q.category || !q.autocomplete) {
      throw new Error(`Question ${i + 1} missing required fields`);
    }
    if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 4) {
      throw new Error(`Question ${i + 1} has insufficient autocomplete options`);
    }
    // Ensure correct answer is first in autocomplete
    const ans = q.answer.toLowerCase().trim();
    const first = (q.autocomplete[0] || '').toLowerCase().trim();
    if (first !== ans) {
      // Move correct answer to front if it's elsewhere in the list
      const idx = q.autocomplete.findIndex(a => a.toLowerCase().trim() === ans);
      if (idx > 0) {
        q.autocomplete.splice(idx, 1);
        q.autocomplete.unshift(q.answer);
      } else {
        q.autocomplete.unshift(q.answer);
      }
    }
  });

  // Flag any duplicates from recent history
  let dupeCount = 0;
  questions = questions.filter(q => {
    const key = q.question.toLowerCase().trim();
    if (recentQTexts.has(key)) { dupeCount++; return false; }
    return true;
  });
  if (dupeCount > 0) console.log(`    ⚠️  Removed ${dupeCount} duplicate question(s)`);

  return questions;
}

// ── Store in Supabase ─────────────────────────────────────────────────────────
async function storeQuestions(mode, questions) {
  const { error } = await sb
    .from('daily_questions')
    .upsert({
      date: TODAY,
      mode,
      questions,
      generated_at: new Date().toISOString()
    }, { onConflict: 'date,mode' });

  if (error) throw new Error(`Supabase error: ${error.message}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
