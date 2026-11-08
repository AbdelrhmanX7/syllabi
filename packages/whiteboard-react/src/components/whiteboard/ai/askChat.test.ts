import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  askPrompt,
  chatContextPrompt,
  chatStorageKey,
  CHAT_MAX_TURNS,
  CHAT_PROMPT_MAX,
  CHAT_REF_MAX,
  clearChat,
  expandQuestion,
  inkFollowUpQuestion,
  placeTurn,
  readAnswerLength,
  readChat,
  storableBlocks,
  summarizeQuestion,
  turnQuestion,
  writeAnswerLength,
  writeChat,
} from './askChat';
import { clampPanelPosition, clampPanelSize, placedPanelStyle, placedPanelWidth, readPanelPosition, writePanelPosition } from './panelDrag';

import type { AskChatTurn, ChatStorage } from './askChat';

function memoryStorage(limit = Infinity): ChatStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();

  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length > limit) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
}

const turn = (n: number, extra: Partial<AskChatTurn> = {}): AskChatTurn => ({
  id: `t${n}`,
  at: n,
  action: 'custom',
  question: `question ${n}`,
  text: `answer ${n}`,
  blocks: [{ type: 'paragraph', text: `answer ${n}` }],
  ...extra,
});

test('the thread key is per board and page, with fallbacks', () => {
  assert.equal(chatStorageKey('b1', 'p1'), 'wb-ai-chat:b1:p1');
  assert.equal(chatStorageKey(undefined, null), 'wb-ai-chat:board:page');
  assert.notEqual(chatStorageKey('b1', 'p1'), chatStorageKey('b1', 'p2'));
});

test('a thread round-trips and clears', () => {
  const storage = memoryStorage();
  const key = chatStorageKey('b', 'p');

  writeChat(storage, key, [turn(1), turn(2)]);
  assert.deepEqual(readChat(storage, key).map((t) => t.id), ['t1', 't2']);
  clearChat(storage, key);
  assert.deepEqual(readChat(storage, key), []);
});

test('reading garbage or a missing storage gives an empty thread', () => {
  const storage = memoryStorage();

  storage.setItem('k', '{not json');
  assert.deepEqual(readChat(storage, 'k'), []);
  storage.setItem('k', JSON.stringify([{ nope: 1 }, turn(3)]));
  assert.deepEqual(readChat(storage, 'k').map((t) => t.id), ['t3']);
  assert.deepEqual(readChat(null, 'k'), []);
  assert.deepEqual(readChat({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined, removeItem: () => undefined }, 'k'), []);
});

test('only the newest turns are kept', () => {
  const storage = memoryStorage();
  const kept = writeChat(storage, 'k', Array.from({ length: CHAT_MAX_TURNS + 5 }, (_, i) => turn(i)));

  assert.equal(kept.length, CHAT_MAX_TURNS);
  assert.equal(kept[0].id, 't5');
});

test('a full storage drops the oldest turns, never throws', () => {
  const storage = memoryStorage(900);
  const kept = writeChat(storage, 'k', Array.from({ length: 12 }, (_, i) => turn(i)));

  assert.ok(kept.length > 0 && kept.length < 12);
  assert.equal(kept[kept.length - 1].id, 't11');
  assert.deepEqual(readChat(storage, 'k').map((t) => t.id), kept.map((t) => t.id));
});

test('inline pictures are not stored', () => {
  const blocks = storableBlocks([
    { type: 'image', src: 'data:image/png;base64,AAAA' },
    { type: 'image', src: 'https://cdn/x.png' },
    { type: 'paragraph', text: 'hi' },
  ]);

  assert.deepEqual(blocks.map((b) => b.type), ['image', 'paragraph']);
});

test('a retried answer takes its turn\'s place; anything else is appended', () => {
  const thread = [turn(1), turn(2), turn(3)];
  const again = turn(4, { question: 'question 3' });

  assert.deepEqual(placeTurn(thread, again, 't3').map((entry) => entry.id), ['t1', 't2', 't4']);
  assert.deepEqual(placeTurn(thread, again, 't2').map((entry) => entry.id), ['t1', 't4', 't3']);
  // No turn to replace (the retried run had failed, or the thread was cleared): appended.
  assert.deepEqual(placeTurn(thread, again, null).map((entry) => entry.id), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(placeTurn(thread, again, 'gone').map((entry) => entry.id), ['t1', 't2', 't3', 't4']);
  assert.equal(thread.length, 3);
});

test('a chip turn is described in words', () => {
  assert.equal(turnQuestion({ action: 'solve', question: '' }, 'en'), 'Solve what I circled.');
  assert.equal(turnQuestion({ action: 'custom', question: ' why? ' }, 'en'), 'why?');
});

test('no earlier turns = the question alone', () => {
  assert.equal(chatContextPrompt([], ' what is x? ', 'en'), 'what is x?');
});

test('a follow-up carries earlier turns in order, with what was read off the picture', () => {
  const prompt = chatContextPrompt([turn(1, { action: 'solve', question: '', transcript: '2x = 4' }), turn(2)], 'and why?', 'en');

  assert.match(prompt, /Me: Solve what I circled\.\nWhat I circled \(as read\): 2x = 4\nYou: answer 1/);
  assert.ok(prompt.indexOf('answer 1') < prompt.indexOf('answer 2'));
  assert.ok(prompt.trimEnd().endsWith('My follow-up question: and why?'));
});

test('the prompt never passes the routes\' 2000-character cap, and keeps the newest turns', () => {
  const long = (n: number) => turn(n, { question: 'q'.repeat(900) + ` ask${n}`, transcript: 't'.repeat(900), text: 'x'.repeat(3000) + ` end${n}` });
  const turns = Array.from({ length: 30 }, (_, i) => long(i));

  const prompt = chatContextPrompt(turns, 'w'.repeat(5000), 'en');

  assert.ok(prompt.length <= CHAT_PROMPT_MAX, `${prompt.length}`);
  assert.ok(prompt.includes('Me: '));

  const short = chatContextPrompt([turn(1), turn(2), turn(3)], 'q', 'en', 200);

  assert.ok(short.length <= 200);
  assert.ok(!short.includes('question 1'));
  assert.ok(short.includes('question 3'));
  // No room for any history: just the question.
  assert.equal(chatContextPrompt([long(1)], 'why?', 'en', 150), 'why?');
});

const BIG = (n: number) => turn(n, { question: 'q'.repeat(900) + ` ask${n}`, transcript: 't'.repeat(900), quote: 'r'.repeat(900), text: 'x'.repeat(3000) + ` end${n}` });

test('«Short» closes the prompt with a brevity line and still fits the cap', () => {
  assert.equal(chatContextPrompt([], 'why?', 'en', CHAT_PROMPT_MAX, { short: true }), 'why?\n\nKeep it short: only the key steps and the final answer, in a few lines. Do not restate the question.');

  const turns = Array.from({ length: 30 }, (_, i) => BIG(i));

  const plain = chatContextPrompt(turns, 'w'.repeat(5000), 'en');
  const brief = chatContextPrompt(turns, 'w'.repeat(5000), 'en', CHAT_PROMPT_MAX, { short: true, quote: 'z'.repeat(5000) });

  assert.ok(brief.length <= CHAT_PROMPT_MAX, `${brief.length}`);
  assert.ok(brief.endsWith('Do not restate the question.'));
  // The brevity line's room comes out of the history, not the question.
  assert.ok(plain.length <= CHAT_PROMPT_MAX);

  // A tiny budget: the brevity line survives, the history goes.
  const tiny = chatContextPrompt([turn(1)], 'why?', 'en', 200, { short: true });

  assert.ok(tiny.length <= 200);
  assert.ok(tiny.startsWith('why?'));
  assert.ok(!tiny.includes('answer 1'));
});

test('a quoted part leads the question, clipped to one line', () => {
  const prompt = chatContextPrompt([turn(1)], 'and the units?', 'en', CHAT_PROMPT_MAX, { quote: ' F = m\n  a ' });

  assert.ok(prompt.endsWith('My follow-up question: About this part: "F = m a"\nand the units?'));
  assert.ok(chatContextPrompt([], '', 'en', CHAT_PROMPT_MAX, { quote: 'F = m × a' }).startsWith('About this part: "F = m × a"'));

  const long = chatContextPrompt([], 'q', 'en', CHAT_PROMPT_MAX, { quote: 'y'.repeat(2000) });

  assert.ok(long.length < CHAT_REF_MAX + 40, `${long.length}`);
});

test('an earlier turn\'s quote reads back in the history; old turns without one still parse', () => {
  const prompt = chatContextPrompt([turn(1, { quote: 'step 2' })], 'ok?', 'en');

  assert.match(prompt, /Me: question 1\nAbout: step 2\nYou: answer 1/);

  const storage = memoryStorage();
  const old = { id: 'o', at: 1, action: 'solve', question: '', text: 'a', blocks: [] };

  storage.setItem('k', JSON.stringify([old, { ...old, id: 'q', quote: 'x' }, { ...old, id: 'b', quote: 7 }]));

  const read = readChat(storage, 'k');

  assert.deepEqual(read.map((t) => t.quote), [undefined, 'x', undefined]);
  assert.ok(!('quote' in read[0]));
});

test('«Explain more» asks about the selection with the thread behind it', () => {
  const prompt = chatContextPrompt([turn(1)], expandQuestion('en'), 'en', CHAT_PROMPT_MAX, { quote: 'the second step' });

  assert.ok(prompt.includes('You: answer 1'));
  assert.ok(prompt.endsWith('About this part: "the second step"\nExplain this part in more detail.'));
});

test('«Summarize» is a follow-up about the last answer', () => {
  const prompt = chatContextPrompt([turn(1), turn(2)], summarizeQuestion('en'), 'en', CHAT_PROMPT_MAX, { short: true });

  assert.ok(prompt.includes('You: answer 2'));
  assert.ok(prompt.includes('My follow-up question: Summarize your last answer'));
  assert.ok(prompt.length <= CHAT_PROMPT_MAX);
});

test('a new circled picture: typed text is the question, else «check what I wrote next»', () => {
  assert.equal(inkFollowUpQuestion('  is this right? ', 'en'), 'is this right?');
  assert.equal(inkFollowUpQuestion('', 'en'), 'Check what I wrote next in what I circled, and continue.');

  const turns = [turn(1, { action: 'solve', question: '', transcript: '2x = 4' })];
  const prompt = askPrompt(turns, 'custom', inkFollowUpQuestion('', 'en'), 'en', { short: true, quote: 'x = 2' });

  assert.ok(prompt);
  assert.match(prompt, /What I circled \(as read\): 2x = 4/);
  assert.match(prompt, /About this part: "x = 2"\nCheck what I wrote next/);
  assert.ok(prompt.length <= CHAT_PROMPT_MAX);
  assert.ok((askPrompt(Array.from({ length: 30 }, (_, i) => BIG(i)), 'custom', 'w'.repeat(5000), 'en', { short: true, quote: 'z'.repeat(3000) }) ?? '').length <= CHAT_PROMPT_MAX);
});

test('a chip carries the thread once the page has turns; a bare chip on a fresh thread sends nothing', () => {
  assert.equal(askPrompt([], 'solve', '', 'en'), undefined);
  assert.equal(askPrompt([], 'solve', '', 'en', { short: true }), 'Solve what I circled.\n\nKeep it short: only the key steps and the final answer, in a few lines. Do not restate the question.');

  const prompt = askPrompt([turn(1)], 'explain', '', 'en');

  assert.ok(prompt?.includes('You: answer 1'));
  assert.ok(prompt?.endsWith('My follow-up question: Explain what I circled.'));
  assert.equal(askPrompt([], 'custom', ' why? ', 'en'), 'why?');
});

test('the answer length is remembered, Short by default', () => {
  const storage = memoryStorage();

  assert.equal(readAnswerLength(storage), 'short');
  assert.equal(readAnswerLength(null), 'short');
  writeAnswerLength(storage, 'detailed');
  assert.equal(readAnswerLength(storage), 'detailed');
  storage.setItem('wb-ai-answer-length', 'huge');
  assert.equal(readAnswerLength(storage), 'short');
});

test('the panel goes anywhere; only its header is kept on screen', () => {
  const area = { width: 1000, height: 700 };

  // Inside: untouched, even at the very top where the chrome sits.
  assert.deepEqual(clampPanelPosition({ left: 100, top: 0 }, 384, area), { left: 100, top: 0 });
  // Half off the start edge and low on the screen: allowed while 96 px of the header stays.
  assert.deepEqual(clampPanelPosition({ left: -200, top: 600 }, 384, area), { left: -200, top: 600 });
  // Too far: the grip stays reachable — 96 px in from either side, the header row above the bottom.
  assert.deepEqual(clampPanelPosition({ left: -1000, top: -50 }, 384, area), { left: -288, top: 0 });
  assert.deepEqual(clampPanelPosition({ left: 2000, top: 2000 }, 384, area), { left: 904, top: 656 });
  assert.deepEqual(clampPanelPosition({ left: Number.NaN, top: Number.NaN }, 384, area), { left: 0, top: 0 });
});

test('a resized panel stays between the minimum and the screen', () => {
  const area = { width: 1000, height: 700 };

  assert.deepEqual(clampPanelSize({ width: 100, height: 50 }, area), { width: 260, height: 200 });
  assert.deepEqual(clampPanelSize({ width: 5000, height: 5000 }, area), { width: 1000, height: 700 });
  assert.deepEqual(clampPanelSize({ width: 500.4, height: 420.6 }, area), { width: 500, height: 421 });
});

test('a placed panel keeps a dragged size; a natural one is capped at the room below its top', () => {
  const area = { width: 1000, height: 700 };

  assert.deepEqual(placedPanelStyle({ left: 20, top: 100 }, area), { left: 20, top: 100, width: 384, maxHeight: 592 });
  assert.equal(placedPanelStyle({ left: 20, top: 640 }, area).maxHeight, 200);
  assert.deepEqual(placedPanelStyle({ left: 20, top: 100, width: 500, height: 300 }, area), { left: 20, top: 100, width: 500, maxHeight: 300 });
  assert.equal(placedPanelStyle({ left: 8, top: 8 }, { width: 360, height: 700 }).width, 344);
});

test('a placed panel is the phone sheet width on a phone, the desktop card otherwise', () => {
  assert.equal(placedPanelWidth(390), 374);
  assert.equal(placedPanelWidth(1280), 384);
  assert.equal(placedPanelWidth(660), 384);
});

test('the panel position is remembered, and bad values are ignored', () => {
  const storage = memoryStorage();

  assert.equal(readPanelPosition(storage), null);
  writePanelPosition(storage, { left: 10.4, top: 20.6 });
  assert.deepEqual(readPanelPosition(storage), { left: 10, top: 21 });
  writePanelPosition(storage, { left: 5, top: 6, width: 480.2, height: 360.7 });
  assert.deepEqual(readPanelPosition(storage), { left: 5, top: 6, width: 480, height: 361 });
  storage.setItem('wb-ai-panel-pos', '{"left":"x"}');
  assert.equal(readPanelPosition(storage), null);
  assert.equal(readPanelPosition(null), null);
});
