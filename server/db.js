require('./loadEnv');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Add the Supabase Postgres URI to server/.env');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    max: 10
});

function toPgPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

function mysqlToPg(sql) {
    let s = sql;
    s = s.replace(/DATE_SUB\(CURDATE\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, (_, n) => `CURRENT_DATE - INTERVAL '${n} days'`);
    s = s.replace(/CURDATE\(\)/gi, 'CURRENT_DATE');
    s = s.replace(/YEARWEEK\(([a-zA-Z0-9_.]+),\s*1\)/gi, "to_char($1, 'IYYY-IW')");
    s = s.replace(/\bYEAR\(([a-zA-Z0-9_.]+)\)/gi, 'EXTRACT(YEAR FROM $1)');
    s = s.replace(/\bMONTH\(([a-zA-Z0-9_.]+)\)/gi, 'EXTRACT(MONTH FROM $1)');
    s = s.replace(/\bDATE\(([a-zA-Z0-9_.]+)\)/gi, '($1)::date');
    s = s.replace(/\sLIKE\s/gi, ' ILIKE ');
    return s;
}

function coerceParams(params = []) {
    return params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

async function run(sql, params = []) {
    let text = mysqlToPg(sql);
    const isInsert = /^\s*insert\s+/i.test(text);
    if (isInsert && !/returning\s+/i.test(text)) {
        text = `${text.replace(/;\s*$/, '')} RETURNING id`;
    }
    text = toPgPlaceholders(text);
    const result = await pool.query(text, coerceParams(params));
    if (isInsert) {
        const insertId = result.rows[0] && result.rows[0].id;
        return [{ insertId, affectedRows: result.rowCount, rowCount: result.rowCount }];
    }
    return [result.rows, { rowCount: result.rowCount, affectedRows: result.rowCount }];
}

const adapter = {
    execute: run,
    query: run,
    connect: () => pool.connect(),
    end: () => pool.end(),
    // Raw pg pool for libraries that need one (the session store).
    pool
};

module.exports = adapter;
