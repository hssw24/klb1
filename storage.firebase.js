// storage.firebase.js
// Firestore (compat) helper API used by index.html and admin.html
// Erwartet: firebase.initializeApp(...) wurde bereits auf der Seite aufgerufen.

(function(){
  if (!window.firebase || !firebase.firestore) {
    console.error('Firebase not loaded');
    window.kbStorage = {
      loadMeta: async ()=>({ courses:[], subjects:[], teachers:[] }),
      saveMeta: async ()=>({ ok:false, reason:'firebase missing' }),
      loadEntries: async ()=>[],
      addEntry: async ()=>({ ok:false, reason:'firebase missing' }),
      updateEntry: async ()=>({ ok:false, reason:'firebase missing' }),
      deleteEntryById: async ()=>({ ok:false }),
      toggleLockEntry: async ()=>({ ok:false }),
      ensureDefaults: async ()=>{},
      getStudentsForCourse: async ()=>[]
    };
    return;
  }

  const db = firebase.firestore();
  const META_DOC = 'kb_meta';
  const META_COLL = 'meta';
  const ENTRIES_COLL = 'entries';

  // --- Meta ---
  async function loadMeta(){
    try {
      const snap = await db.collection(META_COLL).doc(META_DOC).get();
      if (!snap.exists) return { courses:[], subjects:[], teachers:[] };
      return snap.data() || { courses:[], subjects:[], teachers:[] };
    } catch (err) {
      console.error('loadMeta error', err);
      return { courses:[], subjects:[], teachers:[] };
    }
  }

  async function saveMeta(meta){
    try {
      await db.collection(META_COLL).doc(META_DOC).set(meta, { merge: true });
      return { ok: true };
    } catch (err) {
      console.error('saveMeta error', err);
      return { ok: false, reason: err.message || String(err) };
    }
  }

  // --- Entries (unverändert, inkl. deterministische ID-Logik falls du sie nutzt) ---
  function makeEntryId(entry) {
    const safe = (s='') => String(s || '').trim().replace(/\s+/g,'_').replace(/[^A-Za-z0-9_\-]/g,'');
    return `${safe(entry.course)}__${safe(entry.date)}__${safe(entry.hour)}`;
  }

  async function loadEntries(){
    try {
      const snap = await db.collection(ENTRIES_COLL).orderBy('date').orderBy('hour').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('loadEntries error', err);
      try {
        const snap2 = await db.collection(ENTRIES_COLL).get();
        return snap2.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (err2) {
        console.error('loadEntries fallback error', err2);
        return [];
      }
    }
  }

  async function addEntry(entry){
    try {
      const id = makeEntryId(entry);
      const docRef = db.collection(ENTRIES_COLL).doc(id);
      const res = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (snap.exists) return { ok: false, reason: 'duplicate' };
        tx.set(docRef, entry);
        return { ok: true, id };
      });
      return res;
    } catch (err) {
      console.error('addEntry error', err);
      return { ok: false, reason: err.message || String(err) };
    }
  }

  async function updateEntry(oldId, data){
    try {
      if (!oldId) return { ok: false, reason: 'missing id' };
      const oldRef = db.collection(ENTRIES_COLL).doc(oldId);
      const oldSnap = await oldRef.get();
      if (!oldSnap.exists) return { ok: false, reason: 'not found' };
      const current = oldSnap.data() || {};
      if (current.locked) return { ok: false, reason: 'locked' };

      const newId = makeEntryId(data);
      const newRef = db.collection(ENTRIES_COLL).doc(newId);

      if (newId === oldId) {
        await oldRef.update(data);
        return { ok: true };
      }

      const result = await db.runTransaction(async (tx) => {
        const targetSnap = await tx.get(newRef);
        if (targetSnap.exists) return { ok: false, reason: 'duplicate_target' };
        const checkOld = await tx.get(oldRef);
        if (!checkOld.exists) return { ok: false, reason: 'not_found_during_tx' };
        const oldData = checkOld.data() || {};
        if (oldData.locked) return { ok: false, reason: 'locked' };
        tx.set(newRef, Object.assign({}, oldData, data));
        tx.delete(oldRef);
        return { ok: true, id: newId };
      });

      return result;
    } catch (err) {
      console.error('updateEntry error', err);
      return { ok: false, reason: err.message || String(err) };
    }
  }

  async function deleteEntryById(id){
    try {
      await db.collection(ENTRIES_COLL).doc(id).delete();
      return { ok: true };
    } catch (err) {
      console.error('deleteEntryById error', err);
      return { ok: false, reason: err.message || String(err) };
    }
  }

  async function toggleLockEntry(id){
    try {
      const docRef = db.collection(ENTRIES_COLL).doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return { ok: false, reason: 'not found' };
      const current = snap.data() || {};
      await docRef.update({ locked: !current.locked });
      return { ok: true };
    } catch (err) {
      console.error('toggleLockEntry error', err);
      return { ok: false, reason: err.message || String(err) };
    }
  }

  // --- Courses / Students helpers (meta.courses is array of {id,name,students:[], timetable:{mon:[],...}}) ---
  async function getStudentsForCourse(courseId){
    try {
      const meta = await loadMeta();
      const c = (meta.courses || []).find(x => x.id === courseId);
      return c ? (c.students || []) : [];
    } catch (err) {
      console.error('getStudentsForCourse error', err);
      return [];
    }
  }

  async function addCourse(name, students){
    try {
      const meta = await loadMeta();
      meta.courses = meta.courses || [];
      const id = name.replace(/\s+/g,'').toUpperCase();
      if (meta.courses.find(c=>c.id === id)) return { ok:false, reason:'exists' };
      const timetable = {
        mon:['','','','','',''],
        tue:['','','','','',''],
        wed:['','','','','',''],
        thu:['','','','','',''],
        fri:['','','','','','']
      };
      meta.courses.push({ id, name, students: students || [], timetable });
      await saveMeta(meta);
      return { ok:true, id };
    } catch (err) {
      console.error('addCourse error', err);
      return { ok:false, reason: err.message || String(err) };
    }
  }

  async function deleteCourse(id){
    try {
      const meta = await loadMeta();
      meta.courses = (meta.courses || []).filter(c => c.id !== id);
      await saveMeta(meta);
      return { ok:true };
    } catch (err) {
      console.error('deleteCourse error', err);
      return { ok:false, reason: err.message || String(err) };
    }
  }

  // ensure defaults: create meta doc if missing and ensure timetable exists for each course
  async function ensureDefaults(){
    try {
      const meta = await loadMeta();
      let changed = false;
      if (!meta.courses) { meta.courses = []; changed = true; }
      if (!meta.subjects) { meta.subjects = []; changed = true; }
      if (!meta.teachers) { meta.teachers = []; changed = true; }

      // ensure timetable for each course
      (meta.courses || []).forEach(c=>{
        if (!c.timetable) {
          c.timetable = {
            mon:['','','','','',''],
            tue:['','','','','',''],
            wed:['','','','','',''],
            thu:['','','','','',''],
            fri:['','','','','','']
          };
          changed = true;
        } else {
          // ensure arrays length 6 for each day
          ['mon','tue','wed','thu','fri'].forEach(d=>{
            if (!Array.isArray(c.timetable[d]) || c.timetable[d].length !== 6) {
              c.timetable[d] = c.timetable[d] && Array.isArray(c.timetable[d]) ? c.timetable[d].slice(0,6) : ['', '', '', '', '', ''];
              while (c.timetable[d].length < 6) c.timetable[d].push('');
              changed = true;
            }
          });
        }
      });

      if (changed) await saveMeta(meta);
      return { ok:true };
    } catch (err) {
      console.error('ensureDefaults error', err);
      return { ok:false, reason: err.message || String(err) };
    }
  }

  // expose API
  window.kbStorage = {
    loadMeta,
    saveMeta,
    loadEntries,
    addEntry,
    updateEntry,
    deleteEntryById,
    toggleLockEntry,
    getStudentsForCourse,
    addCourse,
    deleteCourse,
    ensureDefaults
  };
})();

(function(global){
  if (!global.kbStorage) global.kbStorage = {};

  const db = firebase.firestore();
  const storage = firebase.storage();

  global.kbStorage.listAttachmentsForEntry = async function(entryId){
    if(!entryId) return [];
    try {
      const col = db.collection('entries').doc(entryId).collection('attachments');
      const snap = await col.orderBy('uploadedAt','desc').get();
      const items = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name || d.id,
          url: data.url || '',
          uploadedAt: data.uploadedAt || null,
          uploadedBy: data.uploadedBy || null,
          meta: data.meta || {}
        };
      });
      return items;
    } catch (err) {
      console.error('listAttachmentsForEntry error', err);
      throw err;
    }
  };

  global.kbStorage.addAttachmentMeta = async function(entryId, metaObj){
    if(!entryId || !metaObj || !metaObj.name || !metaObj.url) {
      return { ok:false, reason: 'missing_parameters' };
    }
    try {
      const col = db.collection('entries').doc(entryId).collection('attachments');
      const payload = Object.assign({
        name: metaObj.name,
        url: metaObj.url,
        uploadedAt: metaObj.uploadedAt || Date.now(),
        uploadedBy: metaObj.uploadedBy || null,
        meta: metaObj.meta || {}
      }, {});
      const docRef = await col.add(payload);
      return { ok:true, id: docRef.id };
    } catch (err) {
      console.error('addAttachmentMeta error', err);
      return { ok:false, reason: err.message || 'firestore_error' };
    }
  };

  global.kbStorage.deleteAttachment = async function(entryId, filenameOrDocId){
    if(!entryId || !filenameOrDocId) return { ok:false, reason:'missing_parameters' };
    try {
      const attachmentsCol = db.collection('entries').doc(entryId).collection('attachments');

      let docSnap = null;
      try {
        const maybeDoc = await attachmentsCol.doc(filenameOrDocId).get();
        if (maybeDoc.exists) docSnap = maybeDoc;
      } catch(e){ /* ignore */ }

      if (!docSnap) {
        const q = await attachmentsCol.where('name','==', filenameOrDocId).limit(1).get();
        if (!q.empty) docSnap = q.docs[0];
      }

      if (!docSnap) {
        try {
          const ref = storage.ref().child(`attachments/${entryId}/${filenameOrDocId}`);
          await ref.delete();
          return { ok:true };
        } catch (err) {
          console.warn('deleteAttachment: no metadata doc and firebase delete failed', err);
          return { ok:false, reason: 'not_found_or_delete_failed' };
        }
      }

      const data = docSnap.data();
      const name = data.name;
      const url = data.url || '';
      const isCloudinary = url.includes('res.cloudinary.com');

      if (!isCloudinary && name) {
        try {
          const ref = storage.ref().child(`attachments/${entryId}/${name}`);
          await ref.delete();
        } catch (err) {
          console.warn('deleteAttachment: firebase storage delete failed', err);
        }
      } else if (isCloudinary) {
        console.info('deleteAttachment: Cloudinary asset detected; metadata will be removed. For full deletion implement server-side Cloudinary API call.');
      }

      await attachmentsCol.doc(docSnap.id).delete();
      return { ok:true };
    } catch (err) {
      console.error('deleteAttachment error', err);
      return { ok:false, reason: err.message || 'delete_failed' };
    }
  };

  global.kbStorage.loadEntry = async function(entryId){
    if(!entryId) return null;
    try {
      const doc = await db.collection('entries').doc(entryId).get();
      if(!doc.exists) return null;
      return Object.assign({ id: doc.id }, doc.data());
    } catch (err) {
      console.error('loadEntry error', err);
      return null;
    }
  };

})(window);
