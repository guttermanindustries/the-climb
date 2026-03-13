/**
 * THE CLIMB – Daily Question Generator (v4)
 * ------------------------------------------
 * Runs once per day via GitHub Actions.
 * Generates 39 questions per mode (mc + type) and stores in Supabase.
 *
 * v4 improvements:
 * - Topic-level dedup: blocks subjects used in the last 30 days, not just exact question text
 * - Each question now has a `topic` field (1-4 word subject tag)
 * - Each question now has a `difficulty` field (easy / medium / hard)
 * - Difficulty distributed ~35% easy / 40% medium / 25% hard per mode
 * - Dedup window extended from 14 → 30 days
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
const CATEGORY_PLAN = [
  ['Geography',              4],
  ['US History',             4],
  ['Music',                  4],
  ['TV',                     4],
  ['Movies',                 4],
  ['Pro Sports/Players',     4],
  ['College Sports/Players', 4],
  ['Science',                4],
  ['General Knowledge',      3],
  ['History',                3],
  ['Food & Drink',           2],
];

const MODES = ['mc', 'type'];

const MODE_DESC = {
  mc:   'Multiple Choice mode — questions should be answerable by most adults who follow pop culture, sports, and news. The question will be shown with 4 answer choices, so it needs to be specific enough that only one is clearly right. Aim for roughly 60-70% of players getting it right.',
  type: 'Open Answer mode — players type in the answer with autocomplete help. Questions can be slightly more specific than MC, but must still be fair. The answer must be a specific person, place, thing, or short phrase — something a knowledgeable player could reasonably type. Aim for roughly 40-50% of players getting it right.',
};

const DIFFICULTY_DESC = {
  easy:   'EASY — most adults who casually follow pop culture, sports, and news will know this immediately. Target: ~70%+ correct rate.',
  medium: 'MEDIUM — requires some knowledge but is fair for engaged trivia players. Target: ~45-65% correct rate.',
  hard:   'HARD — specific enough that only well-read or enthusiastic fans would know. Still a real fact, not obscure trivia. Target: ~20-40% correct rate.',
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🏔️ The Climb Daily Generator v4 — ${TODAY}\n`);

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

  // ── Topic-based dedup: load last 30 days ──────────────────────────────────
  const { recentTexts, recentTopics } = await loadRecentQuestions();
  console.log(`📑 Loaded ${recentTexts.size} recent question texts for exact dedup`);
  console.log(`🏷️  Loaded ${recentTopics.size} recent topics for subject-level dedup\n`);

  for (const mode of modesToGenerate) {
    try {
      console.log(`  ⏳ Generating ${mode} questions...`);
      const questions = await generateQuestions(mode, recentTexts, recentTopics);
      await storeQuestions(mode, questions);
      console.log(`  ✅ ${mode}: ${questions.length} questions stored\n`);
    } catch (err) {
      console.error(`  ❌ Failed to generate ${mode}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🏁 Done! Today\'s questions are ready.\n');
}

// ── Load recent questions for dedup ──────────────────────────────────────────
async function loadRecentQuestions() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data } = await sb
    .from('daily_questions')
    .select('questions')
    .gte('date', cutoffStr);

  const recentTexts  = new Set();
  const recentTopics = new Set();

  for (const row of (data || [])) {
    for (const q of (row.questions || [])) {
      if (q.question) recentTexts.add(q.question.toLowerCase().trim());
      // Use explicit topic if present; fall back to answer as proxy
      const topic = (q.topic || q.answer || '').trim().toLowerCase();
      if (topic) recentTopics.add(topic);
    }
  }
  return { recentTexts, recentTopics };
}

// ── Generate questions for one mode ──────────────────────────────────────────
async function generateQuestions(mode, recentTexts, recentTopics) {
  const categoryLines = CATEGORY_PLAN.map(([cat, n]) =>
    `- ${cat}: ${n} question${n > 1 ? 's' : ''}`
  ).join('\n');

  // Build blocked topics section
  const topicList = [...recentTopics].sort().map(t => `  • ${t}`).join('\n');
  const blockedTopicsSection = topicList
    ? `\n🚫 BLOCKED TOPICS — These specific subjects, people, events, places, and things were used in the last 30 days. Do NOT generate any question whose answer or subject matter involves ANY item on this list. This is a hard block — even a tangentially related question is not allowed:\n${topicList}\n`
    : '';

  // Also list recent question text as a secondary guard
  const recentList = [...recentTexts].slice(0, 40).map(q => `  • ${q.slice(0, 90)}`).join('\n');
  const recentSection = recentList
    ? `\n📋 RECENTLY USED QUESTIONS (do not repeat or paraphrase):\n${recentList}\n`
    : '';

  const prompt = `You are generating questions for "The Climb", a daily trivia game. Generate exactly 39 trivia questions.

MODE: ${mode.toUpperCase()} — ${MODE_DESC[mode]}

CATEGORY QUOTAS (generate exactly this many per category):
${categoryLines}

DIFFICULTY DISTRIBUTION — each question must be tagged as easy, medium, or hard:
- easy:   ~14 questions — ${DIFFICULTY_DESC.easy}
- medium: ~16 questions — ${DIFFICULTY_DESC.medium}
- hard:   ~9 questions  — ${DIFFICULTY_DESC.hard}
Spread difficulty across ALL categories. Do not cluster all hard questions in one category.
${blockedTopicsSection}${recentSection}
QUALITY RULES — read carefully, these are strict:
1. DIFFICULTY SWEET SPOT: Match the difficulty tag honestly. An "easy" question should be answerable by most casual players. A "hard" question requires genuine specific knowledge.
2. NO TRIVIA TRAPS: Avoid questions where the answer is a common acronym, a basic household brand asked generically, or something so famous it's on every beginner trivia list.
3. FAMOUS BUT INTERESTING: Good questions feel like "oh yeah, I should know that!" — not "everyone knows that" or "nobody knows that."
4. SPECIFIC ANSWERS ONLY: Answers must be a specific person's name, a place, a movie/show/song title, or a short phrase. Never a full sentence. Never yes/no.
5. HISTORY: Stick to famous events/people everyone has heard of (WWII, Civil War, major presidents, etc.). No obscure dates or minor figures.
6. FOOD & DRINK: Only ask about iconic dishes, drinks, or chefs that most Americans would recognize.
7. GEOGRAPHY: Mix US geography with world geography. Capitals, landmarks, rivers, countries.
8. TOPIC UNIQUENESS: Even within today's 39 questions, never ask two questions about the same specific person, event, or subject. Each question must have a unique topic.

OUTPUT FORMAT — return ONLY a raw JSON array of exactly 39 objects, no markdown, no explanation:
[
  {
    "question": "The question text (complete sentence ending in ?)",
    "answer": "Short exact answer — a name, title, place, or brief phrase",
    "category": "Exact category name from the list above",
    "difficulty": "easy or medium or hard",
    "topic": "The specific subject of this question in 1-4 words (e.g. 'Amazon River', 'Freddie Mercury', 'French Revolution', 'Super Bowl LVII'). Used to prevent repeating the same subject in future days.",
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
  if (questions.length > 39) questions = questions.slice(0, 39);
  if (questions.length < 35) throw new Error(`Too few questions: got ${questions.length}, need at least 35`);

  // Validate and normalize each question
  questions.forEach((q, i) => {
    if (!q.question || !q.answer || !q.category || !q.autocomplete) {
      throw new Error(`Question ${i + 1} missing required fields`);
    }
    if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 4) {
      throw new Error(`Question ${i + 1} has insufficient autocomplete options`);
    }
    // Normalize difficulty
    if (!['easy','medium','hard'].includes(q.difficulty)) q.difficulty = 'medium';
    // Ensure topic exists
    if (!q.topic) q.topic = q.answer;
    // Ensure correct answer is first in autocomplete
    const ans = q.answer.toLowerCase().trim();
    const idx = q.autocomplete.findIndex(a => a.toLowerCase().trim() === ans);
    if (idx > 0) { q.autocomplete.splice(idx, 1); q.autocomplete.unshift(q.answer); }
    else if (idx === -1) q.autocomplete.unshift(q.answer);
  });

  // Hard dedup: remove exact text matches AND topic matches from recent history
  let dupeCount = 0;
  questions = questions.filter(q => {
    if (recentTexts.has(q.question.toLowerCase().trim())) { dupeCount++; return false; }
    const topic = (q.topic || q.answer || '').toLowerCase();
    if (recentTopics.has(topic)) { dupeCount++; return false; }
    return true;
  });
  if (dupeCount > 0) console.log(`    ⚠️  Removed ${dupeCount} question(s) matching recent topics/text`);

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
