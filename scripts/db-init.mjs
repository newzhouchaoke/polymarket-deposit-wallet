import { dbPath, initSchema, openDatabase } from "./db.js";

const db = openDatabase();
initSchema(db);
db.close();

console.log(`数据库已初始化：${dbPath}`);
