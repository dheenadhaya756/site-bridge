// Daily spending cap for every Gemini call (chat and site scans).
// Spend is counted from the real token usage Gemini reports, priced with GEMINI_PRICE_* and
// USD_INR, and kept in data/spend.json so a restart doesn't reset it. A call is refused
// before it is made if it could take today's spend over DAILY_BUDGET_INR.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.stateDir, 'spend.json');
const OUTPUT_RESERVE = 2048; // output tokens assumed for a call before it runs

// The day rolls over at midnight India time
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

let state = { day: today(), inr: 0, calls: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (saved.day === state.day) state = { ...state, ...saved };
} catch { /* first run */ }

function roll() {
  const d = today();
  if (state.day !== d) state = { day: d, inr: 0, calls: 0 };
}
function save() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state)); } catch { /* read-only disk */ }
}

export const costInr = (input, output) => ((input / 1e6) * config.priceIn + (output / 1e6) * config.priceOut) * config.usdInr;

export class BudgetError extends Error {
  constructor() {
    super(`Today's AI budget of ₹${config.dailyBudgetInr} is used up. It resets at midnight IST, or raise DAILY_BUDGET_INR in .env.`);
    this.code = 'BUDGET';
  }
}

/** Throws BudgetError if a request of this size could take today's spend over the cap. */
export function reserve(requestChars) {
  roll();
  if (!(config.dailyBudgetInr > 0)) return;
  const worst = costInr(Math.ceil(requestChars / 3), OUTPUT_RESERVE);
  if (state.inr + worst > config.dailyBudgetInr) {
    console.warn(`[budget] refused a call: ₹${state.inr.toFixed(2)} of ₹${config.dailyBudgetInr} used today`);
    throw new BudgetError();
  }
}

/** Records the real cost of a finished call. */
export function record(input, output) {
  roll();
  const inr = costInr(input, output);
  state.inr += inr;
  state.calls += 1;
  save();
  return inr;
}

export function spend() {
  roll();
  return { day: state.day, inr: Math.round(state.inr * 100) / 100, calls: state.calls, budget: config.dailyBudgetInr };
}
