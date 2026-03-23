/**
 * THE CLIMB – Daily Question Generator (v6.1)
 * ------------------------------------------
 * Runs once per day via GitHub Actions.
 * Generates 51 questions per mode (mc + type) and stores in Supabase.
 *
 * v6.1 improvements over v6:
 * - 51 questions per mode (was 39) — enough buffer to cover 10 rungs × 3 options across 3 difficulty tiers
 * - 21-day topic/answer dedup window (was 14) — much better cross-day variety
 * - allBlocked cross-check: topic vs answers AND answer vs topics — catches Forrest Gump-style mismatches
 * - Substring matching in dedup filter (≥5 chars) — catches "The Sopranos" vs "Sopranos"
 * - Permanent ban list for chronically overused trivia topics
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const FORCE_REGEN    = process.env.FORCE_REGEN === 'true';

if (!ANTHROPIC_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing environment variables. Check your .env file.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const TODAY = new Date().toISOString().slice(0, 10);

// ── Category plan: 51 questions per mode ──────────────────────────────────────
const CATEGORY_PLAN = [
  ['Geography',              5],
  ['US History',             5],
  ['Music',                  5],
  ['TV',                     5],
  ['Movies',                 5],
  ['Pro Sports/Players',     5],
  ['College Sports/Players', 5],
  ['Science',                5],
  ['General Knowledge',      5],
  ['History',                4],
  ['Food & Drink',           3],
];
// Total: 52 (model may produce 51-52; we accept 48-52 and slice to 51 max)

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

// ── Topics permanently banned (chronically overused in trivia) ─────────────────
const PERMANENT_BAN = new Set([
  'forrest gump', 'the sopranos', 'sopranos', 'breaking bad', 'friends',
  'the office', 'seinfeld', 'game of thrones', 'the simpsons',
  'tom hanks', 'michael jordan', 'lebron james', 'babe ruth',
  'titanic', 'the godfather', 'star wars', 'jeopardy',
  'michael jackson', 'beatles', 'elvis presley', 'elvis',
  'mount everest', 'amazon river', 'nile river',
]);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🏔️ The Climb Daily Generator v6.1 — ${TODAY}\n`);
  if (FORCE_REGEN) console.log('⚡ FORCE_REGEN=true — will overwrite existing questions\n');

  const { data: existing } = await sb
    .from('daily_questions')
    .select('mode, questions')
    .eq('date', TODAY);

  const existingModes = (existing || []).map(r => r.mode);
  const modesToGenerate = FORCE_REGEN ? MODES : MODES.filter(m => !existingModes.includes(m));

  if (modesToGenerate.length === 0) {
    console.log('✅ Already generated for today. Nothing to do.');
    return;
  }

  const dedup = await loadRecentQuestions();
  console.log(`📑 Loaded ${dedup.texts.size} recent question texts`);
  console.log(`🏷️  Loaded ${dedup.topics.size} recent topics`);
  console.log(`📝 Loaded ${dedup.answers.size} recent answers\n`);

  for (const mode of modesToGenerate) {
    try {
      console.log(`  ⏳ Generating ${mode} questions...`);
      const questions = await generateQuestions(mode, dedup);
      await storeQuestions(mode, questions);
      console.log(`  ✅ ${mode}: ${questions.length} questions stored\n`);

      // Add this mode's questions to dedup so next mode won't repeat them
      for (const q of questions) {
        if (q.question) dedup.texts.add(q.question.toLowerCase().trim());
        if (q.answer)   dedup.answers.add(q.answer.toLowerCase().trim());
        const topic = (q.topic || q.answer || '').toLowerCase().trim();
        if (topic) dedup.topics.add(topic);
      }
      console.log(`  🔒 Added ${mode} topics to block list for remaining modes\n`);

    } catch (err) {
      console.error(`  ❌ Failed to generate ${mode}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🏁 Done! Today\'s questions are ready.\n');
}

// ── Gold-standard example questions (Jeopardy-style templates) ───────────────
const EXAMPLE_QUESTIONS = `
QUESTION STYLE — "Jeopardy-style" with embedded context clues:
Every question must contain 2-4 context clues that help players reason toward the answer even if they don't know it outright. Never ask a bare one-fact question like "What team did X play for?" Instead, layer in details: the year, co-stars, stats, a description of the logo/mascot, a teammate, a plot element — anything that gives multiple hooks. The question should make a player think "oh yeah, I should have known that!" not "I either knew it or I didn't."

BAD (no context clues):  "What channel broadcasts the NCAA tournament alongside CBS?"
GOOD (Jeopardy-style):   "Along with CBS, three cable channels will have live coverage of Round 1 of the NCAA tournament: TNT, TBS, and this channel."

BAD (no context clues):  "What movie starred Christina Ricci and Devon Sawa?"
GOOD (Jeopardy-style):   "With Malachi Pearson voicing the Ghost and Devon Sawa playing the human version, this 1995 supernatural fantasy comedy also starring Christina Ricci grossed over $250 million."

BAD (no context clues):  "What school did Marshall Henderson play for?"
GOOD (Jeopardy-style):   "Marshall Henderson led the SEC in 2013 with over 20 points per game for this school."

BAD (no context clues):  "What show featured a smoke monster?"
GOOD (Jeopardy-style):   "This show debuted in the early 2000s and characters ran into polar bears, black smoke and mystery in a jungle."

BAD (no context clues):  "What point guard won a title with the Heat?"
GOOD (Jeopardy-style):   "After playing HS basketball with Randy Moss, this Point Guard went to college, became a Top 10 pick, had a Top 5 Assists season with Memphis, and won a title with the Heat."

BAD (no context clues):  "What NFL team drafted Josh Johnson?"
GOOD (Jeopardy-style):   "With 23 stints across 14 NFL teams, this NFC team drafted QB Josh Johnson in the 5th Round of the 2008 Draft, and he'd make his debut start with them in 2009."

CATEGORY-SPECIFIC STYLE TIPS:
- Pro Sports/Players & College Sports/Players: Include stat, year, team context, and/or a famous connection (teammate, rival, coach). Never just "who played for X?"
- Movies: Include year, at least one cast member, genre, and a production detail (box office, director, studio).
- TV: Describe plot elements, setting, or characters — never just name the show directly in the question.
- Music: Include era, genre, a collaborator or label, and a hit song or album detail.
- Geography: Give 2 geographic clues (e.g. river + country, size ranking + continent).
- History & US History: Include the year or era, the stakes or outcome, and at least one named figure.
- Science: Include a discovery context, the scientist's nationality or era, and the practical application.
- General Knowledge: Give at least 2 descriptive clues about the subject.
- Food & Drink: Describe origin, appearance, or a famous chef/restaurant connection alongside the food itself.
`;

// ── Load recent questions for dedup ──────────────────────────────────────────
async function loadRecentQuestions() {
  // Exact question text: block for 30 days
  const cutoff30 = new Date();
  cutoff30.setDate(cutoff30.getDate() - 30);
  const cutoffStr30 = cutoff30.toISOString().slice(0, 10);

  // Topics & answers: block for 21 days (was 14 — extended to reduce repeats)
  const cutoff21 = new Date();
  cutoff21.setDate(cutoff21.getDate() - 21);
  const cutoffStr21 = cutoff21.toISOString().slice(0, 10);

  const { data: data30 } = await sb
    .from('daily_questions')
    .select('date, questions')
    .gte('date', cutoffStr30);

  const texts   = new Set(); // 30-day exact text block
  const topics  = new Set(); // 21-day topic block
  const answers = new Set(); // 21-day answer block

  for (const row of (data30 || [])) {
    const isRecent = row.date >= cutoffStr21;
    for (const q of (row.questions || [])) {
      if (q.question) texts.add(q.question.toLowerCase().trim());
      if (isRecent) {
        if (q.answer) answers.add(q.answer.toLowerCase().trim());
        const topic = (q.topic || q.answer || '').trim().toLowerCase();
        if (topic) topics.add(topic);
      }
    }
  }
  return { texts, topics, answers };
}

// ── Generate questions for one mode ──────────────────────────────────────────
async function generateQuestions(mode, dedup) {
  const categoryLines = CATEGORY_PLAN.map(([cat, n]) =>
    `- ${cat}: ${n} question${n > 1 ? 's' : ''}`
  ).join('\n');

  // Merge topics + answers into one blocked set, plus permanent bans
  const allBlocked = new Set([...dedup.topics, ...dedup.answers, ...PERMANENT_BAN]);
  const topicList = [...allBlocked].sort().map(t => `  • ${t}`).join('\n');
  const blockedTopicsSection = topicList
    ? `\n🚫 BLOCKED TOPICS & ANSWERS — These were used recently OR are permanently banned. Do NOT generate any question whose answer OR topic involves ANY item on this list:\n${topicList}\n`
    : '';

  const recentList = [...dedup.texts].slice(0, 40).map(q => `  • ${q.slice(0, 90)}`).join('\n');
  const recentSection = recentList
    ? `\n📋 RECENTLY USED QUESTIONS (do not repeat or paraphrase):\n${recentList}\n`
    : '';

  const prompt = `You are generating questions for "The Climb", a daily trivia game. Generate exactly 51 trivia questions.

MODE: ${mode.toUpperCase()} — ${MODE_DESC[mode]}

CATEGORY QUOTAS (generate exactly this many per category):
${categoryLines}

DIFFICULTY DISTRIBUTION — each question must be tagged as easy, medium, or hard:
- easy:   ~18 questions — ${DIFFICULTY_DESC.easy}
- medium: ~22 questions — ${DIFFICULTY_DESC.medium}
- hard:   ~11 questions  — ${DIFFICULTY_DESC.hard}
Spread difficulty across ALL categories. Do not cluster all hard questions in one category.
${EXAMPLE_QUESTIONS}
${blockedTopicsSection}${recentSection}
QUALITY RULES — read carefully, these are strict:
1. JEOPARDY STYLE: Every question must follow the Jeopardy-style format described above — multiple embedded context clues, never a bare one-fact question.
2. DIFFICULTY SWEET SPOT: Match the difficulty tag honestly. An "easy" question should be answerable by most casual players. A "hard" question requires genuine specific knowledge.
3. NO TRIVIA TRAPS: Avoid questions where the answer is a common acronym, a basic household brand asked generically, or something so famous it's on every beginner trivia list.
4. FAMOUS BUT INTERESTING: Good questions feel like "oh yeah, I should know that!" — not "everyone knows that" or "nobody knows that."
5. SPECIFIC ANSWERS ONLY: Answers must be a specific person's name, a place, a movie/show/song title, or a short phrase. Never a full sentence. Never yes/no.
6. HISTORY: Stick to famous events/people everyone has heard of (WWII, Civil War, major presidents, etc.). No obscure dates or minor figures.
7. FOOD & DRINK: Only ask about iconic dishes, drinks, or chefs that most Americans would recognize — nothing regional or obscure.
8. GEOGRAPHY: Mix US geography with world geography. Capitals, landmarks, rivers, countries.
9. TOPIC UNIQUENESS: Even within today's 51 questions, never ask two questions about the same specific person, event, or subject. Each question must have a unique topic.
10. AVOID OVERUSED TRIVIA: Do not ask about subjects that appear constantly in bar trivia (e.g., "What is the largest planet?", "Who painted the Mona Lisa?"). Find fresh angles.

OUTPUT FORMAT — return ONLY a raw JSON array of exactly 51 objects, no markdown, no explanation:
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
    max_tokens: 16000,
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
  if (questions.length > 52) questions = questions.slice(0, 52);
  if (questions.length < 28) throw new Error(`Too few questions: got ${questions.length}, need at least 28`);

  // Validate and normalize each question
  questions.forEach((q, i) => {
    if (!q.question || !q.answer || !q.category || !q.autocomplete) {
      throw new Error(`Question ${i + 1} missing required fields`);
    }
    if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 4) {
      throw new Error(`Question ${i + 1} has insufficient autocomplete options`);
    }
    if (!['easy','medium','hard'].includes(q.difficulty)) q.difficulty = 'medium';
    if (!q.topic) q.topic = q.answer;
    const ans = q.answer.toLowerCase().trim();
    const idx = q.autocomplete.findIndex(a => a.toLowerCase().trim() === ans);
    if (idx > 0) { q.autocomplete.splice(idx, 1); q.autocomplete.unshift(q.answer); }
    else if (idx === -1) q.autocomplete.unshift(q.answer);
  });

  // ── Cross-matched dedup with substring matching ───────────────────────────
  // allBlocked = topics + answers + permanent bans (all 3 sets merged)
  const allBlocked = new Set([...dedup.topics, ...dedup.answers, ...PERMANENT_BAN]);

  // Returns true if str matches anything in allBlocked (exact OR substring for strings ≥5 chars)
  const isBlocked = (str) => {
    if (!str) return false;
    const s = str.toLowerCase().trim();
    if (allBlocked.has(s)) return true;
    // Substring check: block if any banned term (≥5 chars) appears in str, or str appears in a banned term (≥5 chars)
    for (const blocked of allBlocked) {
      if (blocked.length >= 5 && (s.includes(blocked) || blocked.includes(s))) return true;
    }
    return false;
  };

  let dupeCount = 0;
  questions = questions.filter(q => {
    // 1. Exact question text match (30-day block)
    if (dedup.texts.has(q.question.toLowerCase().trim()))  { dupeCount++; return false; }
    // 2. Answer blocked (cross-matched against topics + answers + bans, with substring)
    if (isBlocked(q.answer))                               { dupeCount++; return false; }
    // 3. Topic blocked (cross-matched against topics + answers + bans, with substring)
    const topic = (q.topic || q.answer || '').toLowerCase().trim();
    if (isBlocked(topic))                                  { dupeCount++; return false; }
    return true;
  });

  if (dupeCount > 0) console.log(`    ⚠️  Removed ${dupeCount} question(s) that matched recent topics`);

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
