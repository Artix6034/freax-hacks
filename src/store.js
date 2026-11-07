import { mkdir, readFile, writeFile, rename, readdir,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError } from './domain.js';

export class Store {
  constructor(directory,{renameFile=rename}={}) { this.directory = directory; this.queue = Promise.resolve(); this.renameFile=renameFile; }
  async init() { await mkdir(this.directory, { recursive: true }); }
  path(id) {
    if (!/^(?:checklists|[0-9a-f-]{36})$/.test(id)) throw new InputError('Некорректный ID.');
    return join(this.directory, `${id}.json`);
  }
  async read(id) {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw new InputError('Запись не найдена.', 404); throw e; }
  }
  async write(id, value) {
    const file = this.path(id), temp = `${file}.${randomUUID()}.tmp`;
    try{
      await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      // Windows readers/indexers can briefly lock the destination. Retry only
      // the atomic rename, never unlink the previous good file or repeat AI.
      for(let attempt=0;;attempt++){
        try{await this.renameFile(temp,file);break;}
        catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=7)throw e;
          await new Promise(ok=>setTimeout(ok,Math.min(25*2**attempt,400)));}
      }
    }finally{try{await unlink(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    return value;
  }
  transaction(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async list() {
    const files = (await readdir(this.directory)).filter(n => /^[0-9a-f-]{36}\.json$/.test(n));
    const records = await Promise.all(files.map(n => this.read(n.slice(0, -5))));
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
