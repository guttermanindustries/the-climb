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

// ── Category plan: 36 questions per mode (4 per category × 9 categories) ──────
const CATEGORY_PLAN = [
  ['Geography',              4],
  ['Movies',                 4],
  ['Music',                  4],
  ['TV',                     4],
  ['Pro Sports/Players',     4],
  ['General Knowledge',      4],
  ['US History',             4],
  ['College Sports/Players', 4],
  ['Food & Drink',           4],
];
// Total: 36 per mode

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
  'forrest gump', 'the sopranos', 'sopranos', 'breaking bad', 'walter white', 'heisenberg', 'jesse pinkman',
  'friends', 'the office', 'seinfeld', 'game of thrones', 'the simpsons',
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

// ── Category style guide + gold-standard examples ────────────────────────────
const EXAMPLE_QUESTIONS = `
═══════════════════════════════════════════════════════════
QUESTION STYLE — READ CAREFULLY
═══════════════════════════════════════════════════════════
Every question MUST layer 2–4 clues so a player can reason toward the answer even without knowing it outright. Never ask a single bare fact. The question should produce an "oh yeah, I should have known that!" moment — not "I either knew it or I didn't."

NEVER DO THESE:
• Never name the answer inside the question (e.g. don't ask "What movie features a gladiator?" if the answer is Gladiator)
• Never ask capital cities, basic colors, or anything a child would instantly know
• Never ask "What year did X happen?" as the sole question — year can be a clue, not the entire question
• Never use questions where the answer is a common acronym or basic household brand asked generically
• Never quote song lyrics — describe the song/album/era instead
• Never ask about topics on the blocked list — including in the question text itself

═══════════════════════════════════════════════════════════
CATEGORY STYLE GUIDES (match these examples closely)
═══════════════════════════════════════════════════════════

GEOGRAPHY — America-focused, connect-the-dots reasoning. Layer a geographic fact with a cultural/pop-culture clue.
  ✓ GOOD: "This state, fully in the central time zone, is the largest in the US by land area." (Texas)
  ✓ GOOD: "This small Vermont city, the least populous state capital in the US, is also the only state capital without a McDonald's within city limits." (Montpelier)
  ✗ BAD: "What is the capital of France?" — too obvious, single fact

MOVIES — Connect multiple pop culture touchpoints. "Before they were famous" angles, box office milestones, unexpected cast connections.
  ✓ GOOD: "Jim Carrey had three movies release in 1994 — Ace Ventura, Dumb and Dumber, and this film that also starred an actress who would later play one of Charlie's Angels." (The Mask)
  ✓ GOOD: "This film, nominated for Best Picture at the 2012 Oscars and adapted from a Michael Lewis book, featured Chris Pratt in a minor supporting role." (Moneyball)
  ✓ GOOD: "Ranked among the top 25 highest-grossing films of all time, this 2022 blockbuster was a sequel to a film released 36 years earlier." (Top Gun: Maverick)
  ✗ BAD: "Who directed Jaws?" — single fact, too well known

MUSIC — Pop culture crossover. Connect songs/artists to the broader cultural moment. No lyric quotes — describe the song/era instead.
  ✓ GOOD: "This American Idol winner, who was only 17 when they won Season 10, went on to release country hits including 'Five More Minutes' and 'Damn Strait'." (Scotty McCreery)
  ✓ GOOD: "This rock legend, known for his theatrical makeup and stage persona, had cameo roles in both the horror film Prince of Darkness and the comedy Wayne's World." (Alice Cooper)
  ✗ BAD: "Who sang 'Thriller'?" — single fact, banned topic anyway

TV — Layered clues by default. Use supporting cast, network, era, and run length together. Occasionally a straightforward question is fine if the answer is non-obvious.
  ✓ GOOD: "Jake Johnson, best known for playing Nick Miller, starred in this Fox comedy that ran for 7 seasons starting in 2011." (New Girl)
  ✓ GOOD (straightforward): "This hidden-camera comedy featuring four lifelong friends from Staten Island has aired since 2011 on truTV." (Impractical Jokers)
  ✗ BAD: Anything about Friends, The Office, Seinfeld, Game of Thrones, Breaking Bad — permanently banned

PRO SPORTS/PLAYERS — Reward deeper stats knowledge, not just household names. Connect career milestones across teams.
  ✓ GOOD: "This NBA guard, who began his career with the Chicago Bulls, won the Sixth Man of the Year award three times across different teams and finished his career with the Brooklyn Nets." (Jamal Crawford)
  ✓ GOOD: "This wide receiver, drafted by the Denver Broncos in 2006 out of UCF, played 13 NFL seasons and had seven consecutive 1,000-yard receiving seasons." (Brandon Marshall)
  ✓ GOOD: "This MLB franchise relocated from Montreal to Washington D.C. in 2005, then won their first and only World Series title in 2019." (Washington Nationals)
  ✗ BAD: "How many Super Bowl rings does Tom Brady have?" — overused, too obvious

GENERAL KNOWLEDGE — Fact plus creative twist or unexpected cross-category connection. Reward lateral thinking.
  ✓ GOOD: "The longest bone in the human body shares all but its first letter with a small primate found in Madagascar — name the bone." (Femur → Lemur)
  ✓ GOOD: "This major American city was the site of a world-altering tragedy in 1963 and is also home to an NFL franchise that won back-to-back Super Bowls in the 1990s." (Dallas)
  ✗ BAD: "What city is known for grunge music and coffee?" — too obvious, single-association

US HISTORY — Famous events from the less obvious angle. Connect events to who held office, or test the assumption everyone gets wrong.
  ✓ GOOD: "The Declaration of Independence was signed in 1776, but the US Constitution wasn't ratified until what year?" (1788)
  ✓ GOOD: "This president was in office when the Space Shuttle Challenger broke apart shortly after launch in January 1986." (Ronald Reagan)
  ✓ GOOD: "Who was serving as Vice President of the United States when the Berlin Wall fell in November 1989?" (Dan Quayle)
  ✗ BAD: "Who was the first president of the United States?" — too obvious

COLLEGE SPORTS/PLAYERS — March Madness upsets, international players, connecting college careers to pro success.
  ✓ GOOD: "This 13-seed team from the America East conference, led by Taylor Coppenrath and TJ Sorrentine, pulled off a stunning upset of 4-seed Syracuse in the 2005 NCAA Tournament." (Vermont)
  ✓ GOOD: "This Australian center played college basketball at the University of Utah before being selected with the first overall pick in the 2005 NBA Draft." (Andrew Bogut)
  ✗ BAD: "What school did LeBron James attend?" — he didn't go to college, trap question

FOOD & DRINK — Surprising facts about well-known brands. Little-known product extensions, unexpected origins.
  ✓ GOOD: "This iconic fast food chain, primarily known for burgers and fries, has quietly offered birthday cakes for decades — available at select locations but never advertised on the menu." (McDonald's)
  ✓ GOOD: "Coca-Cola launched this sparkling water brand in 2020 to compete in the growing seltzer market, but it has struggled to gain traction since its debut." (AHA Sparkling Water)
  ✓ GOOD: "In 2024, Pringles released its first-ever puffed snack sold in a bag rather than a can — a bowtie-shaped product named what?" (Pringles Mingles)
  ✗ BAD: "What country did pizza originate in?" — too obvious
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

  const prompt = `You are generating questions for "The Climb", a daily trivia game. Generate exactly 36 trivia questions.

MODE: ${mode.toUpperCase()} — ${MODE_DESC[mode]}

CATEGORY QUOTAS (generate exactly this many per category):
${categoryLines}

DIFFICULTY DISTRIBUTION — each question must be tagged as easy, medium, or hard:
- easy:   ~9 questions  — ${DIFFICULTY_DESC.easy}
- medium: ~18 questions — ${DIFFICULTY_DESC.medium}
- hard:   ~9 questions  — ${DIFFICULTY_DESC.hard}
Spread difficulty across ALL categories. Do not cluster all hard questions in one category.
${EXAMPLE_QUESTIONS}
${blockedTopicsSection}${recentSection}
QUALITY RULES — read carefully, these are strict:
1. LAYERED CLUES: Every question must follow the style guide above — multiple embedded context clues, never a bare one-fact question.
2. DIFFICULTY SWEET SPOT: Match the difficulty tag honestly. An "easy" question should be answerable by most casual players. A "hard" question requires genuine specific knowledge.
3. NO TRIVIA TRAPS: Avoid questions where the answer is a common acronym, a basic household brand asked generically, or something so famous it's on every beginner trivia list.
4. FAMOUS BUT INTERESTING: Good questions feel like "oh yeah, I should know that!" — not "everyone knows that" or "nobody knows that."
5. SPECIFIC ANSWERS ONLY: Answers must be a specific person's name, a place, a movie/show/song title, or a short phrase. Never a full sentence. Never yes/no.
6. TOPIC UNIQUENESS: Never ask two questions about the same specific person, event, or subject. Each question must have a unique topic.
7. AVOID OVERUSED TRIVIA: Do not ask about subjects that appear constantly in bar trivia (e.g., "What is the largest planet?", "Who painted the Mona Lisa?"). Find fresh angles.

OUTPUT FORMAT — return ONLY a raw JSON array of exactly 36 objects, no markdown, no explanation:
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
  if (questions.length > 37) questions = questions.slice(0, 37);
  if (questions.length < 27) throw new Error(`Too few questions: got ${questions.length}, need at least 27`);

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
  // allBlocked already declared above (topics + answers + permanent bans)

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
    // 4. Question text itself mentions a banned topic (catches "In Breaking Bad, Walter White...")
    if (isBlocked(q.question))                             { dupeCount++; return false; }
    // 5. Answer appears verbatim in the question text (e.g. "What film starred Russell Crowe as a Gladiator?" → "Gladiator")
    const ansLower = (q.answer || '').toLowerCase().trim();
    if (ansLower.length >= 4 && q.question.toLowerCase().includes(ansLower)) { dupeCount++; return false; }
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
