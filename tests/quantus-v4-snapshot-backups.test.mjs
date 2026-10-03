import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('const snapshotBackups = (() => {');
assert.ok(start > 0);
const { backupKeysToPrune, writeSnapshotBackup, readSnapshotBackup } = new Function(
  html.slice(start, html.indexOf('async function idbBackup(data, label)', start)) + ';return snapshotBackups;')();
const old = 1788700000000, now = 1790995000000;

test('new recovery copies survive 25 alphabetically later old merge backups', async () => {
  const indexedDB = new IDBFactory();
  for (let i=0;i<25;i++) await writeSnapshotBackup({ stale:true }, 'pre_push_merge_'+(old+i), { indexedDB, now:()=>old+i });
  const current = { dailyBriefing: { routines:[{id:'routine',archived:true,archivedByUser:true}],
    dailyLog:{'2026-10-03':{notes:'MORGENPRÜFSTAND',notesUpdatedAt:'2026-10-03T02:05:48.327Z'}} } };
  const receipt = await writeSnapshotBackup(current,'localStorage_overflow',{indexedDB,now:()=>now});
  assert.equal(receipt.committed,true);
  // Reopen the database after the returned promise: transaction must be committed.
  assert.deepEqual(await readSnapshotBackup('localStorage_overflow',{indexedDB}),current);
  assert.deepEqual(await readSnapshotBackup(receipt.id,{indexedDB,exactKey:true}),current);
  assert.equal(await readSnapshotBackup('pre_push_merge_'+old,{indexedDB}),null);
});

test('retention uses age, reserves each recovery source and preserves unknown key formats', () => {
  const keys=['foreign_import','periodic_'+old,'before_close_'+(old+1),'localStorage_overflow_'+(old+2),
    ...Array.from({length:30},(_,i)=>'pre_merge_'+(now+i))];
  const prune=backupKeysToPrune(keys);
  assert.equal(prune.length,8);
  assert.ok(!prune.includes('foreign_import'));
  assert.ok(!prune.some(k=>/^(periodic|before_close|localStorage_overflow)_/.test(k)));
  assert.ok(prune.includes('pre_merge_'+now));
  assert.ok(!prune.includes('pre_merge_'+(now+29)));
});

test('label restore returns newest exact label and reads only the chosen snapshot payload', async () => {
  const indexedDB=new IDBFactory();
  await writeSnapshotBackup({version:1},'periodic',{indexedDB,now:()=>old});
  await writeSnapshotBackup({version:2},'periodic',{indexedDB,now:()=>now});
  await writeSnapshotBackup({foreign:true},'periodic_extra',{indexedDB,now:()=>now+1});
  const proto=(await import('fake-indexeddb')).IDBObjectStore.prototype;
  const originalAll=proto.getAll,originalGet=proto.get;let reads=0;
  proto.getAll=function(){throw Error('Must not materialize every backup');};
  proto.get=function(...args){reads++;return originalGet.apply(this,args);};
  try {
    assert.deepEqual(await readSnapshotBackup('periodic',{indexedDB}),{version:2});
    assert.equal(reads,1);
    assert.equal(await readSnapshotBackup('missing',{indexedDB}),null);
    assert.equal(reads,1);
  } finally {proto.getAll=originalAll;proto.get=originalGet;}
});

test('aborted snapshot write rejects instead of reporting durable retention', async () => {
  const indexedDB=new IDBFactory();
  const proto=(await import('fake-indexeddb')).IDBObjectStore.prototype, put=proto.put;
  proto.put=function(...args){const req=put.apply(this,args);this.transaction.abort();return req;};
  try { await assert.rejects(writeSnapshotBackup({draft:'keep'},'before_close',{indexedDB,now:()=>now})); }
  finally {proto.put=put;}
  assert.equal(await readSnapshotBackup('before_close',{indexedDB}),null);
});
