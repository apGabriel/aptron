// _flow-voice-privacy.mjs — VOICE-21
// Requires: --init _mock-speech-recognition.js
// "what's on today" is a pure LOCAL read (summarize()) — resolves without
// any localStorage write of its own, so any new key after the flow would be
// attributable to the voice mechanism itself, not an unrelated legitimate
// write (e.g. "log water" would legitimately touch po_water_v1, muddying
// the assertion this test exists to make).
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const snapshotStorage = () => page.evaluate(async () => {
    const ls = Object.keys(localStorage).sort();
    let idb = [];
    try { idb = (await indexedDB.databases()).map((d) => d.name).sort(); } catch (e) { idb = ['n/a']; }
    return { ls, idb };
  });

  const before = await snapshotStorage();
  log('storage before:', JSON.stringify(before));

  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult("what's on today"));
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(300);

  const after = await snapshotStorage();
  log('storage after:', JSON.stringify(after));

  const newLsKeys = after.ls.filter((k) => !before.ls.includes(k));
  const newIdbNames = after.idb.filter((k) => !before.idb.includes(k));
  if (newLsKeys.length) throw new Error('VOICE-21 FAILED: new localStorage key(s) appeared: ' + JSON.stringify(newLsKeys));
  if (newIdbNames.length) throw new Error('VOICE-21 FAILED: new IndexedDB database(s) appeared: ' + JSON.stringify(newIdbNames));

  await shot('voice-21-no-persistence');
  log('ALL PASS: VOICE-21 (no new localStorage/IndexedDB keys after a full voice cycle)');
};
