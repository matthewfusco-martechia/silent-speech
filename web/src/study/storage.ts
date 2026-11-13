/** A separate local database. Never reads the original demo's recordings or public model. */
import { parseStudy, type Study } from './engine';

export interface SavedStudy { id: string; revision: number; data: Study }
export class StudyStorage {
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) { this.db = db; }

  static open(): Promise<StudyStorage> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('airpods-phrase-study-v1', 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Local storage is not responding. Keep this page open and retry.')); }, 5000);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('studies', { keyPath: 'id' });
        request.result.createObjectStore('meta');
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('Cannot open local storage.')); };
      request.onblocked = () => { clearTimeout(timer); reject(new Error('Close other phrase-study tabs, then reload this page.')); };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(new StudyStorage(db));
      };
    });
  }

  load(): Promise<SavedStudy | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['studies', 'meta'], 'readonly');
      let saved: SavedStudy | null = null;
      let failure: unknown;
      const current = tx.objectStore('meta').get('active');
      current.onsuccess = () => {
        if (current.result === undefined) return;
        const request = tx.objectStore('studies').get(current.result);
        request.onsuccess = () => {
          try {
            const envelope = request.result as SavedStudy | undefined;
            if (!envelope || !Number.isInteger(envelope.revision) || envelope.revision < 1 || envelope.id !== current.result) throw new Error('Saved study is incomplete. Existing data has been preserved.');
            const data = parseStudy(envelope.data);
            if (data.id !== envelope.id) throw new Error('Saved study identity mismatch.');
            saved = { ...envelope, data };
          } catch (e) { failure = e; tx.abort(); }
        };
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Could not read the saved study.'));
    });
  }

  /** Atomic compare-and-save: another tab cannot silently overwrite this session. */
  save(data: Study, previousRevision: number): Promise<SavedStudy> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['studies', 'meta'], 'readwrite');
      const store = tx.objectStore('studies');
      let failure: Error | null = null;
      const revision = previousRevision + 1;
      const read = store.get(data.id);
      read.onsuccess = () => {
        const current = read.result as SavedStudy | undefined;
        if ((current?.revision ?? 0) !== previousRevision) {
          failure = new Error('This study changed in another tab. Export this take, then reload.'); tx.abort(); return;
        }
        store.put({ id: data.id, revision, data });
        tx.objectStore('meta').put(data.id, 'active');
      };
      tx.oncomplete = () => resolve({ id: data.id, revision, data });
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('This take is not saved. Retry saving or export before closing.'));
    });
  }
}
