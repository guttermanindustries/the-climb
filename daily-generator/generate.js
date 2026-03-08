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
    const validated = await validateQuestions(allQuestions);

    for (const mode of modesNeeded) {
      if (validated[mode]) {
        await storeQuestions(mode, validated[mode]);
        console.log(`  ✅ ${mode}: ${validated[mode].length} questions stored`);
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
      easy:   'EASY — First round of a good pub quiz. A casual fan should get it, but it should NOT be embarrassingly obvious. Ask about a specific detail of a famous thing — not the famous thing itself. BAD examples (too easy): "What sport does LeBron James play?", "What country is the Eiffel Tower in?", "Who sang Thriller?". GOOD examples: a specific record, a supporting character, a famous tagline, a notable "first", a well-known but not totally obvious fact. Target: 55-70% of adults get it right.',
      medium: 'MEDIUM — requires real knowledge. About half of players will know. Mix popular and slightly deeper facts. The answer should make someone say "oh right!" not "never heard of that." Target: 30-45% of adults get it right. MUST use completely different topics/people/events than the easy questions.',
      hard:   'HARD — only trivia enthusiasts will know. The ANSWER itself must be obscure — not just the question framing. If the answer is a household name (e.g. "Michael Jordan", "The Beatles", "Apple"), it is NOT hard enough. Ask about deep cuts: backup players, B-side tracks, minor characters, specific stats, niche records, forgotten figures. Target: 5-20% of adults get it right. MUST use completely different topics/people/events than easy and medium.'
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
7. AUTOCOMPLETE POOL: Generate a large pool of 20 autocomplete options per question. Include the correct answer plus 19 plausible wrong answers that are all thematically related (same sport, same era, same genre, same domain). The goal: when a player types a few letters, they see many plausible options — the correct answer should be buried among real-sounding alternatives, NOT obvious. Examples: if the answer is a QB, include 19 other QBs. If the answer is a movie, include 19 other movies in the same genre/era. Do NOT scatter the correct answer — just make sure it's in the list somewhere. Mix in options that share letters/substrings with the correct answer so filtering feels natural.
8. NO YEAR ANSWERS: Never write a question where the answer is a year (e.g. "1969", "2003"). Questions asking "what year did X happen?" are forbidden. Focus on names, places, people, things, and titles instead.
9. DIFFICULTY SELF-CHECK: Before finalizing each question, ask yourself — "Would a random adult on the street know this?" Easy=probably yes, Medium=maybe, Hard=probably not. For HARD specifically: if the answer is a mega-famous name that anyone would recognize (a #1 all-time athlete, a globally iconic brand, a song everyone knows), rewrite the question or replace it. The answer must be genuinely obscure.
10. NO EASY ANSWERS IN HARD: Scan your hard questions before submitting. If any hard answer is something like "Michael Jordan", "The Beatles", "Shakespeare", "Nike", "New York", "Tom Hanks" — it is not hard enough. Replace it.

═══════════════════════════════════════════
STYLE GUIDE — Write questions with personality and specificity
═══════════════════════════════════════════
Study these example questions carefully. Match their tone: punchy, conversational, specific, and occasionally playful. These are the gold standard for how questions should feel.

GREAT STYLE EXAMPLES (do NOT reuse these exact questions):

[Pro Sports/Players]
"Muhammad Ali took on who in what they called the 'Thrilla in Manila'?" → Joe Frazier
"Floyd Mayweather's Top-3 selling PPVs include fights with Manny Pacquiao and Conor McGregor — who's the third?" → Oscar De La Hoya
"In 2003, this Canadian golfer became the first left-handed player to win the Masters." → Mike Weir

[College Sports/Players]
"Stewart Cink won his first Major by defeating what golfer in a playoff at the 2009 Open Championship?" → Tom Watson
"Loyola-Chicago was the last 11-seed to make the NCAA Final Four — what 11-seed did it before them?" → Virginia Commonwealth

[Music]
"Bernie Taupin is an English lyricist best known for his long-term collaboration with what musician?" → Elton John
"Alkaline Trio frontman Matt Skiba joined what band in 2015?" → blink-182

[Movies]
"A symbol of what animal was on the back of Ryan Gosling's jacket in the movie Drive?" → Scorpion
"'Christmas with the Kranks' is based on the 2001 novel 'Skipping Christmas' by what author?" → John Grisham

[TV]
"Adam Savage and Jamie Hyneman are the co-hosts of what popular television show?" → MythBusters
"Joseph Gordon-Levitt played a character named Tommy on what sitcom that ran from 1996 through 2001?" → 3rd Rock from the Sun

[Geography]
"Ljubljana is the capital of what European country?" → Slovenia
"Valletta is the capital of what island nation in the Mediterranean?" → Malta

[History]
"English King Harold II was defeated at the Battle of Hastings by what Norman leader?" → William the Conqueror
"King Leonidas of Sparta met defeat at what famous ancient battle?" → Thermopylae

[Science]
"The gall! This internal organ's main functions include assisting digestion and regulating blood sugar." → Pancreas
"These ductless glands release hormones directly into the bloodstream." → Endocrine glands

[Brands & Products]
"This soda, introduced in 1893, was originally called Brad's Drink." → Pepsi
"Buffalo Wild Wings goes by the nickname BW3 — what did the third 'W' originally stand for?" → Weck

[Food & Drink]
"This fruit-flavored alcoholic beverage was founded in 2005 by three Ohio State fraternity members." → Four Loko
"Ossobuco is made with vegetables, white wine, broth, and what specific protein?" → Veal shank

[US History]
"In 1975, Jimmy Hoffa is believed to have disappeared in what U.S. state?" → Michigan
"Who was the last U.S. President from the Democratic-Republican party?" → John Quincy Adams

[Viral Internet / General Knowledge]
"Candace Payne went viral in 2016 for a Facebook video of herself wearing what costume?" → Chewbacca mask
"Robert Galbraith is a pen name for what enormously famous author?" → J.K. Rowling

WHAT MAKES THESE GREAT:
- They use clever setups ("The gall!", "Long hair, don't care!") to add personality
- They give a rich, specific scenario rather than just "who/what is X"
- They reward people who truly know their stuff — not Googlers
- Answers are crisp: one name, one word, one short phrase
- Questions feel like they come from a human who loves trivia, not a textbook

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
      "autocomplete": ["correct answer", "plausible wrong 1", "plausible wrong 2", "...19 total options, all thematically related"]
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
      if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 10) {
        throw new Error(`${mode} question ${i + 1} has insufficient autocomplete options (got ${q.autocomplete.length}, need 10+)`);
      }
    });
  }

  return parsed;
}

// ── Validate questions with a second fact-check API pass ─────────────────────
async function validateQuestions(allQuestions) {
  // Flatten all Q&A pairs with mode + index for tracking
  const flat = [];
  for (const [mode, qs] of Object.entries(allQuestions)) {
    qs.forEach((q, i) => flat.push({
      mode, index: i,
      question: q.question,
      answer: q.answer,
      category: q.category
    }));
  }

  const prompt = `You are a strict trivia fact-checker. Your only job is to verify factual accuracy.

Review each question and answer below. Check ALL of the following for each item:
1. Is the stated answer definitively, unambiguously correct?
2. Is there only ONE reasonable correct answer (not multiple valid answers)?
3. Are ALL factual claims INSIDE the question text accurate? (e.g. if the question says "running back" but the person is actually a quarterback, that is an error in the question itself — flag it)
4. Are positions, roles, titles, nationalities, and other descriptors in the question text correct for the named person or subject?

Common error to watch for: question text describes someone with the wrong position/role/title (e.g. calling a QB a "running back", calling a singer a "rapper", calling a director an "actor"). These must be flagged even if the answer itself is technically correct.

Return a JSON array containing ONLY items that have problems. For each problem item include:
- "mode": the difficulty mode (easy/medium/hard)
- "index": the 0-based index number
- "action": "fix" if you can correct it (wrong answer OR fixable question text), or "remove" if the question is too broken to fix
- "corrected_answer": the correct answer string (only when the answer itself is wrong)
- "corrected_question": the corrected question text (only when the question text contains the error)
- "reason": one sentence explaining exactly what is wrong

If everything is correct, do NOT include it — only flag real errors.
Return an empty array [] if everything checks out.
Return ONLY raw JSON — no markdown, no code fences, no explanation.

Questions to verify:
${JSON.stringify(flat, null, 2)}`;

  console.log('  ⏳ Running fact-check validation pass...');
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content.map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();

  let issues;
  try {
    issues = JSON.parse(clean);
  } catch (e) {
    console.warn('  ⚠️  Validator returned unparseable JSON — skipping validation pass');
    return allQuestions;
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    console.log('  ✅ Fact-check passed — all answers verified');
    return allQuestions;
  }

  console.log(`  🔍 Fact-check found ${issues.length} issue(s):`);
  const toRemove = new Set();

  for (const issue of issues) {
    const { mode, index, action, corrected_answer, corrected_question, reason } = issue;
    if (!allQuestions[mode] || !allQuestions[mode][index]) continue;
    const q = allQuestions[mode][index];

    if (action === 'fix') {
      if (corrected_answer) {
        console.log(`    🔧 [${mode}][${index}] Answer fixed: "${q.answer}" → "${corrected_answer}" — ${reason}`);
        allQuestions[mode][index].answer = corrected_answer;
        // Ensure corrected answer appears in autocomplete
        if (!allQuestions[mode][index].autocomplete.includes(corrected_answer)) {
          allQuestions[mode][index].autocomplete[0] = corrected_answer;
        }
      }
      if (corrected_question) {
        console.log(`    🔧 [${mode}][${index}] Question fixed: "${q.question}" → "${corrected_question}" — ${reason}`);
        allQuestions[mode][index].question = corrected_question;
      }
    } else if (action === 'remove') {
      console.log(`    🗑️  [${mode}][${index}] Removed: "${q.question}" — ${reason}`);
      toRemove.add(`${mode}:${index}`);
    }
  }

  // Filter out removed questions
  for (const mode of Object.keys(allQuestions)) {
    allQuestions[mode] = allQuestions[mode].filter((_, i) => !toRemove.has(`${mode}:${i}`));
  }

  return allQuestions;
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
