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

// ── Generate all questions — one API call per mode to avoid token limits ───────
async function generateAllQuestions(modes) {
  const DIFFICULTY_DESC = {
    easy:   'EASY — First round of a good pub quiz. A casual fan should get it, but it should NOT be embarrassingly obvious. Ask about a specific detail of a famous thing — not the famous thing itself. BAD examples (too easy): "What sport does LeBron James play?", "What country is the Eiffel Tower in?", "Who sang Thriller?". GOOD examples: a specific record, a supporting character, a famous tagline, a notable "first", a well-known but not totally obvious fact. Target: 55-70% of adults get it right.',
    medium: 'MEDIUM — requires real knowledge. About half of players will know. Mix popular and slightly deeper facts. The answer should make someone say "oh right!" not "never heard of that." Target: 30-45% of adults get it right.',
    hard:   'HARD — only trivia enthusiasts will know. The ANSWER itself must be obscure — not just the question framing. If the answer is a household name (e.g. "Michael Jordan", "The Beatles", "Apple"), it is NOT hard enough. Ask about deep cuts: backup players, B-side tracks, minor characters, specific stats, niche records, forgotten figures. Target: 5-20% of adults get it right.'
  };

  const STYLE_EXAMPLES = `[Pro Sports/Players]
"Muhammad Ali took on who in what they called the 'Thrilla in Manila'?" → Joe Frazier
"Floyd Mayweather's Top-3 selling PPVs include fights with Manny Pacquiao and Conor McGregor — who's the third?" → Oscar De La Hoya

[College Sports/Players]
"Loyola-Chicago was the last 11-seed to make the NCAA Final Four — what 11-seed did it before them?" → Virginia Commonwealth

[Music]
"Bernie Taupin is an English lyricist best known for his long-term collaboration with what musician?" → Elton John
"Alkaline Trio frontman Matt Skiba joined what band in 2015?" → blink-182

[Movies]
"A symbol of what animal was on the back of Ryan Gosling's jacket in the movie Drive?" → Scorpion

[TV]
"Joseph Gordon-Levitt played a character named Tommy on what sitcom that ran from 1996 through 2001?" → 3rd Rock from the Sun

[Geography]
"Ljubljana is the capital of what European country?" → Slovenia

[History]
"English King Harold II was defeated at the Battle of Hastings by what Norman leader?" → William the Conqueror

[Science]
"The gall! This internal organ's main functions include assisting digestion and regulating blood sugar." → Pancreas

[Brands & Products]
"Buffalo Wild Wings goes by the nickname BW3 — what did the third 'W' originally stand for?" → Weck

[Food & Drink]
"Ossobuco is made with vegetables, white wine, broth, and what specific protein?" → Veal shank

[US History]
"In 1975, Jimmy Hoffa is believed to have disappeared in what U.S. state?" → Michigan

[Viral Internet / General Knowledge]
"Robert Galbraith is a pen name for what enormously famous author?" → J.K. Rowling`;

  const totalPerMode = CATEGORIES.length * QS_PER_CATEGORY; // 39

  const allQuestions = {};
  const generatedSoFar = [];  // Track topics used to prevent overlap across modes

  for (const mode of modes) {
    console.log(`  ⏳ Generating ${mode} questions...`);

    const overlapWarning = generatedSoFar.length > 0
      ? `\nAVOID OVERLAP: Do NOT reuse any person, team, movie, show, song, event, or topic that already appeared in: ${generatedSoFar.join(', ')} sets.`
      : '';

    const prompt = `You are generating daily trivia questions for "The Climb," a daily trivia game.
Today's date: ${TODAY}

HOW THE GAME WORKS: Players see 3 random category choices at each of 10 rungs and pick one to answer.
Generate exactly ${totalPerMode} ${mode.toUpperCase()} trivia questions (${QS_PER_CATEGORY} per category × ${CATEGORIES.length} categories).

Difficulty: ${DIFFICULTY_DESC[mode]}${overlapWarning}

Categories (use exactly these names):
${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n')}

═══════════════════════════════════════════
CRITICAL ACCURACY RULES (strictly enforce):
═══════════════════════════════════════════
1. FACTUAL CERTAINTY: Only write questions you are 100% certain are correct. If there is any doubt about a fact — especially sports championships, election results, award winners, or records from 2023 onward — do NOT use it. Stick to well-established facts.
2. NO ANSWER IN QUESTION: The answer word or phrase must NEVER appear anywhere in the question text.
3. VARIETY WITHIN CATEGORY: The ${QS_PER_CATEGORY} questions within each category must cover different sub-topics.
4. HINTS MUST NOT REVEAL THE ANSWER: The hint should give useful context but must not contain the answer or any part of it.
5. SHORT ANSWERS: Answers must be a name, word, number, or very short phrase — never a full sentence.
6. AUTOCOMPLETE POOL: Generate exactly 20 autocomplete options per question. Include the correct answer plus 19 plausible wrong answers that are all thematically related (same sport, same era, same genre, same domain). The correct answer must be buried among real-sounding alternatives — NOT obvious. Mix in options that share letters/substrings with the correct answer so filtering feels natural.
7. NO YEAR ANSWERS: Never write a question where the answer is a year. Focus on names, places, people, things, and titles instead.
8. DIFFICULTY SELF-CHECK: Before finalizing each question, ask yourself — "Would a random adult on the street know this?" Easy=probably yes, Medium=maybe, Hard=probably not.
9. NO EASY ANSWERS IN HARD: For hard questions, if the answer is something like "Michael Jordan", "The Beatles", "Shakespeare", "Nike", "New York", "Tom Hanks" — it is not hard enough. Replace it.
10. QUESTION ACCURACY: All facts INSIDE the question text must be accurate — including positions, roles, nationalities, and titles. Do not call a QB a "running back", a singer a "rapper", etc.

STYLE GUIDE — match this tone: punchy, conversational, specific, occasionally playful:
${STYLE_EXAMPLES}

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Return ONLY a raw JSON array. No markdown, no explanation, no code fences. No wrapper object.
The array must have exactly ${totalPerMode} question objects (${QS_PER_CATEGORY} per category, all ${CATEGORIES.length} categories):
[
  {
    "question": "Question text here?",
    "answer": "Exact short answer",
    "hint": "A useful contextual clue that does not reveal the answer",
    "category": "Category name from the list above",
    "autocomplete": ["correct answer", "wrong 1", "wrong 2", "...20 total, all thematically related"]
  }
]`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 12000,  // 39 questions × 20 autocomplete options per mode
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content.map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed) || parsed.length !== totalPerMode) {
      throw new Error(`Expected ${totalPerMode} ${mode} questions, got ${parsed?.length}`);
    }
    parsed.forEach((q, i) => {
      if (!q.question || !q.answer || !q.hint || !q.autocomplete) {
        throw new Error(`${mode} question ${i + 1} missing required fields`);
      }
      if (!Array.isArray(q.autocomplete) || q.autocomplete.length < 10) {
        throw new Error(`${mode} question ${i + 1} has insufficient autocomplete options (got ${q.autocomplete.length}, need 10+)`);
      }
    });

    allQuestions[mode] = parsed;
    generatedSoFar.push(mode);
    console.log(`  ✅ ${mode}: ${parsed.length} questions generated`);
  }

  return allQuestions;
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
