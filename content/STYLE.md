# Globalpedia content style guide

Audience: curious readers roughly ages 9–13, plus the adults reading alongside them.
Think DK Eyewitness / National Geographic Kids / a great school librarian — **clear, warm,
precise, never dumbed down.**

## Voice
- Write in plain, confident English. Short-to-medium sentences. Concrete nouns and verbs.
- Use real vocabulary (archipelago, monsoon, parliament, glacier) and explain it in-line the
  first time: "a *fjord* — a long, narrow sea inlet carved by ancient glaciers".
- Be specific over generic. "Rice terraces climb the hills like green staircases" beats
  "there is beautiful nature". Every paragraph should teach something a reader could repeat.
- Curious and respectful. No baby talk, no exclamation-mark hype, no "cool!", no rhetorical
  "Did you know?!" openers. Wonder comes from facts, not punctuation.
- Neutral and fair on politics, religion, borders and conflicts. State facts; do not take sides.
  Where a border or name is disputed, say so plainly in one clause.
- Historically honest but age-appropriate: colonialism, slavery, war and dictatorship are named
  clearly and briefly without graphic detail.
- Present tense for how things are; past tense for history. Avoid "currently" (dates content).
- Numbers: round and label as approximate ("about 68 million people", "roughly 550,000 km²").
  Prefer comparisons a kid can picture ("about the size of Texas", "twice the size of the UK").
- No first person, no addressing the reader as "you" more than once per entry, no emojis.
- British vs American spelling: American.

## Structure (must match `CountryContent` in src/core/types.ts)
| field | length | content |
|---|---|---|
| `tagline` | ≤ 8 words, no period | A vivid hook true to the country ("Where two continents meet") |
| `overview` | 2–3 paragraphs (`\n\n` separated), 120–200 words | Where it is, what it is like, what it is known for, how people live today |
| `landAndNature` | 1–2 paragraphs, 70–130 words | Geography, climate, landscapes, notable animals/plants, natural wonders |
| `peopleAndCulture` | 1–2 paragraphs, 70–130 words | Languages, food, music, sports, festivals, daily life, famous people if relevant |
| `history` | 1–2 paragraphs, 80–140 words | Earliest peoples → key turning points → independence/modern era |
| `funFacts` | 4–6 strings, each ≤ 30 words | True, surprising, verifiable. Not repeats of the sections |
| `pronunciation` | optional | Only when the name is commonly mispronounced: "KEE-nyuh" style caps for stress |

## Accuracy
- Only include facts you are confident are true. When unsure of a number, round more or omit.
- Capital and languages must agree with the facts list you were given.
- No living-person gossip; no brand promotion.

## File format
`content/countries/<ISO3>.json`, UTF-8, 2-space indent, keys in the order above, `iso3` first.
Validate with `npm run validate:content` (or `node scripts/validate-content.mjs FRA DEU`).

Example skeleton:
```json
{
  "iso3": "ISL",
  "tagline": "Land of fire and ice",
  "overview": "Iceland is an island nation ... \n\nToday ...",
  "landAndNature": "...",
  "peopleAndCulture": "...",
  "history": "...",
  "funFacts": ["...", "...", "...", "..."],
  "pronunciation": "ICE-land"
}
```
